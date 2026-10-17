import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { buildProductMasterPlan, hash } from './lib/productMasterPlan.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const migrationName = '20261017170000_product_packaging';
const productFields = 'id, title, barcode, "caseBarcode", "caseSize", "packetSize", "retailSize"';
const quote = name => `"${name.replaceAll('"', '""')}"`;

export async function readMaster(db) {
  const products = (await db.query(`SELECT ${productFields} FROM "Product" ORDER BY id`)).rows;
  const exists = (await db.query(`SELECT to_regclass('public."ProductPackaging"') IS NOT NULL AS present`)).rows[0].present;
  const packaging = exists ? (await db.query('SELECT * FROM "ProductPackaging" ORDER BY "caseGtin"')).rows : [];
  return { products, packaging, exists };
}

// Full-row hashes include columns not represented by Prisma, including legacy stock.
export async function preservationFingerprint(db) {
  const related = (await db.query(`SELECT DISTINCT c.relname AS name FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid WHERE k.contype='f' AND k.confrelid IN ('"Product"'::regclass, '"ProductAtShop"'::regclass) AND c.relname <> 'ProductPackaging' ORDER BY name`)).rows.map(r => r.name);
  const tables = [...new Set(['Product', 'Shop', 'PriceTier', ...related])];
  const result = {};
  for (const table of tables) {
    const row = table === 'Product' ? `(to_jsonb(t) - ARRAY['caseBarcode','caseSize','packetSize'])` : 'to_jsonb(t)';
    result[table] = (await db.query(`SELECT count(*)::int AS count, md5(coalesce(string_agg(h, '' ORDER BY h), '')) AS digest FROM (SELECT md5(${row}::text) AS h FROM ${quote(table)} t) x`)).rows[0];
  }
  return result;
}

export async function applyPlan(db, plan) {
  // Set-based, parameterized writes. No Product creation, deletion or supplier price writes.
  if (plan.creates.length) {
    const inserted = await db.query(`INSERT INTO "ProductPackaging" (id, "productId", "caseBarcode", "caseGtin", "unitsPerCase", "packageSize", "packageSizeKey", packing, source, "sourceReferences") SELECT id, "productId", "caseBarcode", "caseGtin", "unitsPerCase", "packageSize", "packageSizeKey", packing, source, "sourceReferences" FROM jsonb_to_recordset($1::jsonb) AS x(id text, "productId" text, "caseBarcode" text, "caseGtin" text, "unitsPerCase" int, "packageSize" text, "packageSizeKey" text, packing text, source text, "sourceReferences" jsonb)`, [JSON.stringify(plan.creates)]);
    if (inserted.rowCount !== plan.creates.length) throw new Error('Packaging write count mismatch');
  }
  if (plan.updates.length) {
    const updated = await db.query(`UPDATE "Product" p SET "caseBarcode"=CASE WHEN x.changes ? 'caseBarcode' THEN x.changes->>'caseBarcode' ELSE p."caseBarcode" END, "caseSize"=CASE WHEN x.changes ? 'caseSize' THEN x.changes->>'caseSize' ELSE p."caseSize" END, "packetSize"=CASE WHEN x.changes ? 'packetSize' THEN x.changes->>'packetSize' ELSE p."packetSize" END FROM jsonb_to_recordset($1::jsonb) AS x("productId" text, changes jsonb) WHERE p.id=x."productId"`, [JSON.stringify(plan.updates)]);
    if (updated.rowCount !== plan.updates.length) throw new Error('Product write count mismatch');
  }
}

async function writeReport(file, report) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(report, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
}

export async function main(argv = process.argv.slice(2)) {
  const value = flag => argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : undefined;
  const apply = argv.includes('--apply');
  const source = path.resolve(value('--source') || path.join(root, '../data_product/redneval_products.json'));
  const reportPath = path.resolve(value('--report') || path.join(root, 'reports/product-master', `${apply ? 'apply' : 'dry-run'}-${new Date().toISOString().replaceAll(':','-')}.json`));
  const input = await fs.readFile(source, 'utf8');
  const document = JSON.parse(input);
  if (!Array.isArray(document.products) || !document.products.length) throw new Error('Expected a nonempty products array');
  const sourceSha256 = hash(input);
  const reviewed = apply && value('--reviewed-report') ? JSON.parse(await fs.readFile(path.resolve(value('--reviewed-report')), 'utf8')) : null;
  if (apply && (!reviewed || reviewed.mode !== 'dry-run' || reviewed.sourceSha256 !== sourceSha256)) throw new Error('Apply requires --reviewed-report from a dry-run of this exact source');
  const sql = await fs.readFile(path.join(root, 'prisma/migrations', migrationName, 'migration.sql'), 'utf8');
  if (apply && reviewed.migration?.checksum !== hash(sql)) throw new Error('Migration changed since dry-run; create a fresh dry-run report');
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 15000 });
  let committed = false;
  try {
    await db.connect();
    await db.query(apply ? 'BEGIN ISOLATION LEVEL REPEATABLE READ' : 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await db.query("SET LOCAL lock_timeout = '5s'");
    await db.query("SET LOCAL statement_timeout = '120s'");
    if (apply) await db.query('LOCK TABLE "Product" IN SHARE ROW EXCLUSIVE MODE');
    const state = await readMaster(db);
    if (apply && state.exists) await db.query('LOCK TABLE "ProductPackaging" IN SHARE ROW EXCLUSIVE MODE');
    const plan = buildProductMasterPlan(document.products, state.products, state.packaging);
    const planSha256 = hash({ creates: plan.creates, updates: plan.updates });
    const snapshotSha256 = hash({ products: state.products, packaging: state.packaging });
    const report = { mode: apply ? 'apply' : 'dry-run', generatedAt: new Date().toISOString(), source, sourceSha256, sourceCoverageComplete: document.metadata?.extraction_complete ?? false, migration: { name: migrationName, presentBefore: state.exists, checksum: hash(sql) }, snapshotSha256, planSha256, ...plan };
    if (!apply) { await db.query('COMMIT'); await writeReport(reportPath, report); }
    else {
      if (reviewed.planSha256 !== planSha256 || reviewed.snapshotSha256 !== snapshotSha256) throw new Error('Database or plan changed since dry-run; create a fresh dry-run report');
      const before = await preservationFingerprint(db);
      // Durable before-values and exact intended inserts exist before the first mutation.
      await writeReport(`${reportPath}.before.json`, { ...report, preservation: before });
      const ledger = (await db.query('SELECT checksum, finished_at, rolled_back_at FROM _prisma_migrations WHERE migration_name=$1 AND rolled_back_at IS NULL', [migrationName])).rows;
      if (ledger.length > 1 || (ledger.length && (!ledger[0].finished_at || ledger[0].checksum !== hash(sql)))) throw new Error('Unexpected migration ledger state');
      if (!state.exists) {
        if (ledger.length) throw new Error('Migration recorded but table absent');
        await db.query(sql);
        await db.query(`INSERT INTO _prisma_migrations (id,checksum,finished_at,migration_name,started_at,applied_steps_count) VALUES ($1,$2,now(),$3,now(),1)`, [randomUUID(), hash(sql), migrationName]);
      } else if (!ledger.length) throw new Error('Packaging table exists without reviewed migration ledger; manual schema inspection required');
      await applyPlan(db, plan);
      const afterState = await readMaster(db);
      const rerun = buildProductMasterPlan(document.products, afterState.products, afterState.packaging);
      if (rerun.creates.length || rerun.updates.length) throw new Error('Idempotency verification failed');
      const after = await preservationFingerprint(db);
      if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error('Product identity, relationships, inventory or pricing preservation failed');
      const expected = new Map(plan.updates.map(u => [u.productId, u]));
      const beforeProducts = new Map(state.products.map(p => [p.id, p]));
      for (const p of afterState.products) {
        const original = beforeProducts.get(p.id);
        if (JSON.stringify({ ...original, ...expected.get(p.id)?.changes }) !== JSON.stringify(p)) throw new Error('Unexpected Product field change');
      }
      report.verification = { preservationUnchanged: true, before, after, rerunCreates: rerun.creates.length, rerunUpdates: rerun.updates.length, productCount: afterState.products.length, packagingCount: afterState.packaging.length };
      report.migration.appliedNow = !state.exists;
      report.migration.ledgerRecorded = true;
      // Write validation evidence before commit too, so a later I/O error is distinguishable.
      await writeReport(`${reportPath}.validated.json`, report);
      await db.query('COMMIT'); committed = true;
      await writeReport(reportPath, { ...report, committed: true });
    }
    console.log(JSON.stringify({ reportPath, mode: report.mode, migration: report.migration, summary: plan.summary, ...(report.verification && { verification: report.verification }) }, null, 2));
  } catch (error) {
    if (!committed) await db.query('ROLLBACK').catch(() => {});
    // Never disclose DATABASE_URL or database row values in errors.
    console.error(JSON.stringify({ code: error.code || 'PRODUCT_MASTER_FAILED', message: error.code ? 'Database operation failed; inspect private logs if needed' : error.message, committed, reportPath }));
    process.exitCode = 1;
  } finally { await db.end(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
