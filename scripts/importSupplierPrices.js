import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import pg from 'pg';
import { hash } from './lib/productMasterPlan.js';
import { readSupplierSources, buildSupplierPricePlan, stableJson, SUPPLIERS } from './lib/supplierPricePlan.js';

// Prisma DateTime uses UTC timestamps without a SQL timezone. pg otherwise
// interprets OID 1114 in the importing machine's timezone, breaking reruns.
pg.types.setTypeParser(1114, value => new Date(value.replace(' ','T')+'Z'));

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const migrationName = '20261017180000_supplier_pack_prices';
export const packagingMigrationName = '20261017210000_packaging_without_outer_barcode';
const quote = name => `"${name.replaceAll('"', '""')}"`;
const priceColumns = { price:'numeric', offerPrice:'numeric', offerExpiryDate:'timestamp', packagingId:'text', unitsPerPack:'int', pricedUnitSize:'text', sourcePricing:'jsonb', priceObservedAt:'timestamp', offerPriceSource:'text' };
const newPriceFields = ['packagingId','unitsPerPack','pricedUnitSize','sourcePricing','priceObservedAt','offerPriceSource'];
const newTierFields = ['packagingId','sourcePricing','priceObservedAt'];
const plannedWrites = plan => ({ productCreates:plan.productCreates??[],packagingCreates:plan.packagingCreates??[],creates:plan.creates, updates:plan.updates, tierCreates:plan.tierCreates, rrpUpdates:plan.rrpUpdates });
const writeCount = plan => Object.values(plannedWrites(plan)).reduce((sum,rows)=>sum+rows.length,0);

export async function readSupplierState(db) {
  const result = {};
  for (const [key, query] of Object.entries({
    shops:'SELECT id,name,"shopType" FROM "Shop" ORDER BY id',
    products:'SELECT id,title,barcode,"caseBarcode","caseSize","packetSize","retailSize",rrp FROM "Product" ORDER BY id',
    packaging:'SELECT * FROM "ProductPackaging" ORDER BY id',
    prices:'SELECT * FROM "ProductAtShop" ORDER BY id',
    tiers:'SELECT * FROM "PriceTier" ORDER BY id',
    promotions:'SELECT * FROM "ProductPromotion" ORDER BY id',
  })) result[key] = (await db.query(query)).rows;
  return result;
}

export async function preservationFingerprint(db, additions = {}) {
  const related = (await db.query(`SELECT DISTINCT c.relname AS name FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid WHERE k.contype='f' AND k.confrelid IN ('"Product"'::regclass, '"ProductAtShop"'::regclass) ORDER BY name`)).rows.map(r => r.name);
  const result = {};
  for (const table of [...new Set(['Product','Shop','ProductPackaging',...related])].filter(t => !['ProductAtShop','PriceTier'].includes(t))) {
    const row = table === 'Product' ? "(to_jsonb(t) - 'rrp')" : 'to_jsonb(t)';
    const excluded=(table==='Product'?additions.productCreates:table==='ProductPackaging'?additions.packagingCreates:[])||[];
    const where=excluded.length?' WHERE NOT (t.id = ANY($1::text[]))':'';
    result[table] = (await db.query(`SELECT count(*)::int count, md5(coalesce(string_agg(h,'' ORDER BY h),'')) digest FROM (SELECT md5(${row}::text) h FROM ${quote(table)} t${where}) x`,excluded.length?[excluded.map(r=>r.id)]:[])).rows[0];
  }
  return result;
}

async function insertRows(db, table, columns, rows) {
  if (!rows.length) return;
  const names = Object.keys(columns).map(quote).join(',');
  const types = Object.entries(columns).map(([key,type]) => `${quote(key)} ${type}`).join(',');
  const result = await db.query(`INSERT INTO ${quote(table)} (${names}) SELECT ${names} FROM jsonb_to_recordset($1::jsonb) AS x(${types})`, [JSON.stringify(rows)]);
  assert.equal(result.rowCount, rows.length);
}

export async function applySupplierPlan(db, plan) {
  await insertRows(db,'Product',{id:'text',title:'text',barcode:'text',packetSize:'text',caseBarcode:'text',caseSize:'text',retailSize:'text',rrp:'numeric'},plan.productCreates||[]);
  await insertRows(db,'ProductPackaging',{id:'text',productId:'text',caseBarcode:'text',caseGtin:'text',unitsPerCase:'int',packageSize:'text',packageSizeKey:'text',packing:'text',source:'text',sourceReferences:'jsonb'},plan.packagingCreates||[]);
  await insertRows(db,'ProductAtShop',{ id:'text',shopId:'text',productId:'text',...priceColumns },plan.creates);
  if (plan.updates.length) {
    const types = Object.entries(priceColumns).map(([key,type]) => `${quote(key)} ${type}`).join(',');
    const assignments = Object.keys(priceColumns).map(key => `${quote(key)}=x.${quote(key)}`).join(',');
    const result = await db.query(`UPDATE "ProductAtShop" p SET ${assignments}, "updatedAt"=now() FROM jsonb_to_recordset($1::jsonb) AS x(id text,${types}) WHERE p.id=x.id`, [JSON.stringify(plan.updates.map(row => ({ id:row.id, ...row.data })))]);
    assert.equal(result.rowCount, plan.updates.length);
  }
  await insertRows(db,'PriceTier',{ id:'text',productAtShopId:'text',quantity:'int',price:'numeric',packagingId:'text',sourcePricing:'jsonb',priceObservedAt:'timestamp' },plan.tierCreates);
  if (plan.rrpUpdates.length) {
    const result = await db.query(`UPDATE "Product" p SET rrp=x.rrp FROM jsonb_to_recordset($1::jsonb) AS x("productId" text,rrp numeric) WHERE p.id=x."productId" AND p.rrp IS NULL`, [JSON.stringify(plan.rrpUpdates)]);
    assert.equal(result.rowCount, plan.rrpUpdates.length);
  }
}

export function verifySupplierState(before, after, plan) {
  const without = (row, fields) => Object.fromEntries(Object.entries(row).filter(([key]) => !fields.includes(key)));
  const expectedUpdates = new Map(plan.updates.map(p => [p.id,p]));
  const priceAfter = new Map(after.prices.map(p => [p.id,p]));
  assert.equal(after.prices.length, before.prices.length + plan.creates.length);
  for (const original of before.prices) {
    const updated = priceAfter.get(original.id);
    assert.ok(updated, 'Existing supplier identity deleted');
    const fields = expectedUpdates.has(original.id) ? [...Object.keys(priceColumns),'updatedAt'] : newPriceFields;
    assert.equal(stableJson(without(original,fields)),stableJson(without(updated,fields)), 'Unplanned supplier price, relationship or inventory change');
    if (!expectedUpdates.has(original.id)) for (const key of newPriceFields) assert.equal(stableJson(original[key] ?? null), stableJson(updated[key] ?? null));
  }
  assert.equal(after.tiers.length, before.tiers.length + plan.tierCreates.length);
  const tiers = new Map(after.tiers.map(t => [t.id,t]));
  for (const tier of before.tiers) {
    assert.equal(stableJson(without(tier,newTierFields)), stableJson(without(tiers.get(tier.id),newTierFields)));
    for (const key of newTierFields) assert.equal(stableJson(tier[key] ?? null),stableJson(tiers.get(tier.id)[key] ?? null));
  }
  const rrpChanges = new Map(plan.rrpUpdates.map(p => [p.productId,p.rrp]));
  const products = new Map(after.products.map(p => [p.id,p]));
  assert.equal(after.products.length, before.products.length+(plan.productCreates?.length||0));
  for(const p of plan.productCreates||[]) assert.equal(stableJson(products.get(p.id)),stableJson(p),'Created master differs from reviewed product');
  for (const p of before.products) {
    const updated = products.get(p.id);
    if (rrpChanges.has(p.id)) {
      assert.equal(p.rrp,null);
      assert.equal(Number(updated.rrp),Number(rrpChanges.get(p.id)));
      assert.equal(stableJson({ ...p,rrp:null }),stableJson({ ...updated,rrp:null }));
    } else assert.equal(stableJson(p),stableJson(updated));
  }
  assert.equal(after.packaging.length,before.packaging.length+(plan.packagingCreates?.length||0));
  const packages=new Map(after.packaging.map(p=>[p.id,p]));
  for(const p of before.packaging) assert.equal(stableJson(p),stableJson(packages.get(p.id)));
  for(const p of plan.packagingCreates||[]) assert.equal(stableJson(without(packages.get(p.id),['createdAt'])),stableJson(p),'Created packaging differs from reviewed configuration');
  assert.equal(stableJson(before.promotions),stableJson(after.promotions));
  for (const p of after.prices.filter(p => p.packagingId)) {
    const pack = after.packaging.find(c => c.id === p.packagingId);
    assert.ok(pack && pack.productId === p.productId && pack.unitsPerCase === p.unitsPerPack, 'Supplier case mismatch');
  }
  for (const t of after.tiers.filter(t => t.packagingId)) {
    const p = priceAfter.get(t.productAtShopId), pack = after.packaging.find(c => c.id === t.packagingId);
    assert.ok(pack && pack.productId === p.productId && pack.unitsPerCase === t.quantity, 'Tier case mismatch');
  }
}

const writeReport = async (file, report) => {
  await fs.mkdir(path.dirname(file), { recursive:true });
  await fs.writeFile(file, JSON.stringify(report,null,2)+'\n',{ mode:0o600, flag:'wx' });
};

export async function main(argv = process.argv.slice(2)) {
  const value = flag => argv.includes(flag) ? argv[argv.indexOf(flag)+1] : undefined;
  const apply = argv.includes('--apply');
  const supplier = (value('--supplier') || 'DHAMECHA').toUpperCase();
  if (!SUPPLIERS[supplier] || argv.filter(v => v === '--supplier').length > 1) throw new Error('Select exactly one supported supplier: DHAMECHA, BESTWAY or COSTCUTTER');
  const selectedSuppliers = { [supplier]:SUPPLIERS[supplier] };
  const sourceDir = path.resolve(value('--source') || path.join(root,'../data_suppliers'));
  const reportPath = path.resolve(value('--report') || path.join(root,'reports/supplier-prices',`${apply ? 'apply' : 'dry-run'}-${new Date().toISOString().replaceAll(':','-')}.json`));
  const source = await readSupplierSources(sourceDir, { supplier });
  const reviewed = apply && value('--reviewed-report') ? JSON.parse(await fs.readFile(path.resolve(value('--reviewed-report')))) : null;
  const sql = await fs.readFile(path.join(root,'prisma/migrations',migrationName,'migration.sql'),'utf8');
  const packagingSql=supplier==='COSTCUTTER'?await fs.readFile(path.join(root,'prisma/migrations',packagingMigrationName,'migration.sql'),'utf8'):null;
  if (apply && (!reviewed || reviewed.mode !== 'dry-run' || reviewed.supplier !== supplier || reviewed.sourceHash !== source.sourceHash || reviewed.migration.checksum !== hash(sql))) throw new Error('Apply requires a reviewed dry-run of the exact source and migration');
  if(apply&&packagingSql&&reviewed.packagingMigration?.checksum!==hash(packagingSql)) throw new Error('Apply requires the reviewed Costcutter packaging migration');
  const db = new pg.Client({ connectionString:process.env.DATABASE_URL, connectionTimeoutMillis:15000 });
  let committed = false;
  try {
    await db.connect();
    await db.query(apply ? 'BEGIN ISOLATION LEVEL REPEATABLE READ' : 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await db.query("SET LOCAL lock_timeout='5s'");
    await db.query("SET LOCAL statement_timeout='120s'");
    if (apply) await db.query('LOCK TABLE "Product", "ProductPackaging", "ProductAtShop", "PriceTier" IN SHARE ROW EXCLUSIVE MODE');
    const state = await readSupplierState(db);
    const present = (await db.query(`SELECT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='ProductAtShop' AND column_name='offerPriceSource') present`)).rows[0].present;
    const plan = buildSupplierPricePlan(source,state,selectedSuppliers);
    const report = { mode:apply ? 'apply' : 'dry-run', supplier, generatedAt:new Date().toISOString(), sourceDir, sourceHash:source.sourceHash, manifest:source.manifest, migration:{ name:migrationName, checksum:hash(sql), presentBefore:present }, snapshotHash:hash(state), planHash:hash(plannedWrites(plan)), ...plan };
    if(packagingSql) {
      const nullable=(await db.query(`SELECT count(*)=2 AND bool_and(is_nullable='YES') present FROM information_schema.columns WHERE table_schema='public' AND table_name='ProductPackaging' AND column_name IN ('caseBarcode','caseGtin')`)).rows[0].present;
      report.packagingMigration={name:packagingMigrationName,checksum:hash(packagingSql),presentBefore:nullable};
    }
    if (apply) {
      if (reviewed.snapshotHash !== report.snapshotHash || reviewed.planHash !== report.planHash) throw new Error('Database or plan changed since dry-run; generate a fresh report');
      const fingerprint = await preservationFingerprint(db);
      await writeReport(`${reportPath}.before.json`,{ ...report, state, preservation:fingerprint });
      const ledger = (await db.query('SELECT checksum,finished_at,rolled_back_at FROM _prisma_migrations WHERE migration_name=$1 AND rolled_back_at IS NULL',[migrationName])).rows;
      if (ledger.length > 1 || (ledger.length && (!ledger[0].finished_at || ledger[0].checksum !== hash(sql)))) throw new Error('Unexpected migration ledger state');
      if (!present) {
        if (ledger.length) throw new Error('Migration recorded without matching schema');
        await db.query(sql);
        await db.query('INSERT INTO _prisma_migrations (id,checksum,finished_at,migration_name,started_at,applied_steps_count) VALUES ($1,$2,now(),$3,now(),1)',[randomUUID(),hash(sql),migrationName]);
      } else if (!ledger.length) throw new Error('Supplier schema exists without the reviewed migration ledger');
      if(packagingSql) {
        const rows=(await db.query('SELECT checksum,finished_at FROM _prisma_migrations WHERE migration_name=$1 AND rolled_back_at IS NULL',[packagingMigrationName])).rows;
        if(rows.length>1||(rows.length&&(!rows[0].finished_at||rows[0].checksum!==hash(packagingSql)))) throw new Error('Unexpected Costcutter packaging migration ledger');
        if(!report.packagingMigration.presentBefore) {
          if(rows.length) throw new Error('Packaging migration recorded without matching schema');
          await db.query(packagingSql);
          await db.query('INSERT INTO _prisma_migrations (id,checksum,finished_at,migration_name,started_at,applied_steps_count) VALUES ($1,$2,now(),$3,now(),1)',[randomUUID(),hash(packagingSql),packagingMigrationName]);
        } else if(!rows.length) throw new Error('Nullable packaging schema lacks reviewed migration ledger');
        report.packagingMigration.appliedNow=!report.packagingMigration.presentBefore;
      }
      await applySupplierPlan(db,plan);
      const after = await readSupplierState(db);
      verifySupplierState(state,after,plan);
      const rerun = buildSupplierPricePlan(source,after,selectedSuppliers);
      assert.equal(writeCount(rerun),0,'Rerun is not idempotent');
      assert.equal(rerun.accepted.length,plan.accepted.length,'Rerun reclassified accepted prices');
      assert.equal(stableJson(fingerprint),stableJson(await preservationFingerprint(db,plan)),'Product identity or relationship preservation failed');
      report.verification = { unchangedExistingIdentitiesInventoryRelationships:true, nonTargetSupplierPricesUnchanged:true, promotionsUnchanged:true, productCount:after.products.length, packagingCount:after.packaging.length, supplierPriceCount:after.prices.length, tierCount:after.tiers.length, rerunWrites:writeCount(rerun), acceptedPrices:plan.accepted.length };
      report.migration.appliedNow = !present;
      await writeReport(`${reportPath}.validated.json`,report);
    }
    await db.query('COMMIT'); committed = apply;
    await writeReport(reportPath,{ ...report, committed });
    console.log(JSON.stringify({ reportPath, mode:report.mode, supplier, committed, migration:report.migration, packagingMigration:report.packagingMigration, summary:plan.summary, verification:report.verification },null,2));
  } catch(error) {
    if (!committed) await db.query('ROLLBACK').catch(() => {});
    if (error.code === 'ERR_ASSERTION') await writeReport(`${reportPath}.error.json`, { code:error.code, message:error.message, stack:error.stack, expected:error.expected, actual:error.actual }).catch(() => {});
    console.error(JSON.stringify({ code:error.code || 'SUPPLIER_IMPORT_FAILED', message:error.code ? 'Supplier database operation failed; transaction rolled back unless committed is true' : error.message, committed, reportPath }));
    process.exitCode = 1;
  } finally { await db.end(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
