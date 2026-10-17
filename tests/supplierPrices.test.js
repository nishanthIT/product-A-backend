import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import pg from 'pg';
import { getPrisma, resetDatabase, seedBase, startApp } from './helpers/harness.js';
import { gtin } from '../src/services/productBarcodes.js';
import { SUPPLIERS,readSupplierSources,buildSupplierPricePlan } from '../scripts/lib/supplierPricePlan.js';
import { readSupplierState,applySupplierPlan,preservationFingerprint } from '../scripts/importSupplierPrices.js';

const unit='5010511482313', case12='5010511040445', case6='5000382114994';
let db,sql,seed,app,token,adminToken,product,dh,protectedPrice,dir,source,employee;
const run = args => execFileSync(process.execPath,['scripts/importSupplierPrices.js','--source',source,...args],{ cwd:process.cwd(),env:{...process.env,DATABASE_URL:process.env.TEST_DATABASE_URL},encoding:'utf8' });
const report = async name => JSON.parse(await fs.readFile(path.join(dir,name)));
const request = (method,url,body,useToken=token) => app.request(method,url,{token:useToken,body});

before(async () => {
  await resetDatabase(); db=await getPrisma(); seed=await seedBase(db);
  employee=await db.empolyee.create({data:{name:'Supplier editor',email:'supplier@test.invalid',phoneNo:'test-supplier-editor',password:seed.passwordHash}});
  for (const shop of Object.values(SUPPLIERS)) await db.shop.create({data:{...shop,address:'test',mobile:'test',shopType:'WHOLESALE'}});
  product=await db.product.create({data:{title:'Verified supplier fixture',barcode:unit,packetSize:'120g'}});
  for (const [code,count] of [[case12,12],[case6,6]]) await db.productPackaging.create({data:{id:`case${count}`,productId:product.id,caseBarcode:code,caseGtin:gtin(code),unitsPerCase:count,packageSize:'120g',packageSizeKey:'120g',packing:`${count} x 120g`,source:'TEST',sourceReferences:[]}});
  dh=await db.productAtShop.create({data:{productId:product.id,shopId:SUPPLIERS.DHAMECHA.id,price:8.49,inHandStock:17,card_aiel_number:'A4',updatedAt:new Date('2026-01-01')}});
  protectedPrice=await db.productAtShop.create({data:{productId:product.id,shopId:seed.wholesale.id,price:7.77,inHandStock:23,offerPrice:6.66,offerExpiryDate:new Date('2030-01-01')}});
  await db.supermarketProductState.create({data:{productId:product.id,shopId:seed.a.shop.id,inHandStock:11}});
  sql=new pg.Client({connectionString:process.env.TEST_DATABASE_URL});await sql.connect();
  // Recreate the pre-import schema, then test the actual additive SQL and ledger.
  await sql.query('ALTER TABLE "ProductAtShop" DROP COLUMN "packagingId", DROP COLUMN "unitsPerPack", DROP COLUMN "pricedUnitSize", DROP COLUMN "sourcePricing", DROP COLUMN "priceObservedAt", DROP COLUMN "offerPriceSource"');
  await sql.query('ALTER TABLE "PriceTier" DROP COLUMN "packagingId", DROP COLUMN "sourcePricing", DROP COLUMN "priceObservedAt"');
  await sql.query('CREATE TABLE _prisma_migrations (id varchar(36) PRIMARY KEY,checksum varchar(64) NOT NULL,finished_at timestamptz,migration_name varchar(255) NOT NULL,logs text,rolled_back_at timestamptz,started_at timestamptz NOT NULL DEFAULT now(),applied_steps_count integer NOT NULL DEFAULT 0)');
  dir=await fs.mkdtemp(path.join(os.tmpdir(),'paymi-supplier-test-'));source=path.join(dir,'sources');
  for (const folder of ['Dhamecha','bestway','ActiveHub_CostCutter']) await fs.mkdir(path.join(source,folder),{recursive:true});
  await fs.writeFile(path.join(source,'Dhamecha/products.jsonl'),JSON.stringify({result:{status:'found',barcode:unit,product_id:'NOT-A-BARCODE',pricing:{original_price_1:'8.49',product_price:'4.79',original_price_2:'9.99',rrp:'1.15000',promo_price:null,promo_percentage:null},packaging:{pack_count:12,unit_size:'120g',pack_size:'12 x 120g'},web_metadata:{promotion:true}},evidence:{request:{barcode:unit,depot:4},response:{barcode:unit,captured_at:'2026-09-22T00:00:00Z'}}})+'\n');
  const bw=(count,price) => ({barcode:unit,barcodes:[{label:'Retail EAN',value:unit}],product_code:'NOT-A-BARCODE',pack_size:'120g',pack_display:`120g × ${count}`,units_per_priced_pack:count,currency:'GBP',wholesale_price:price,observed_at_utc:'2026-09-22T00:00:00Z',import_ready:true});
  const b=[bw(1,'0.60'),bw(12,'6.00'),bw(6,'3.30')];
  for (const [file,data] of Object.entries({'one.json':b.slice(0,2),'two.json':b.slice(2),'three.json':[],'checkpoint.json':{products:b,unresolved_products:[],status:'stopped'}})) await fs.writeFile(path.join(source,'bestway',file),JSON.stringify(data));
  await fs.writeFile(path.join(source,'ActiveHub_CostCutter/ignored.json'),JSON.stringify({products:[{barcode:unit,price:999}]}));
});
after(async () => {await app?.close();await sql?.end();await db?.$disconnect();});

test('dry-run is read-only; reviewed apply migrates atomically, preserves existing IDs and stock, and reruns without writes',async () => {
  run(['--report',path.join(dir,'dry.json')]);const dry=await report('dry.json');
  assert.equal(dry.manifest.length,6);assert.equal(dry.migration.presentBefore,false);
  assert.equal(dry.creates.length,1);assert.equal(dry.updates.length,1);assert.equal(dry.tierCreates.length,2);assert.equal(dry.rrpUpdates.length,1);
  assert.equal((await sql.query('SELECT count(*)::int n FROM _prisma_migrations')).rows[0].n,0);
  run(['--apply','--reviewed-report',path.join(dir,'dry.json'),'--report',path.join(dir,'apply.json')]);
  const applied=await report('apply.json');assert.equal(applied.committed,true);assert.equal(applied.verification.rerunWrites,0);
  const price=await db.productAtShop.findUnique({where:{id:dh.id}});
  assert.equal(price.price.toString(),'8.49');assert.equal(price.offerPrice.toString(),'4.79');assert.equal(price.offerExpiryDate,null);assert.equal(price.unitsPerPack,12);
  assert.equal(price.inHandStock,17);assert.equal(price.card_aiel_number,'A4');
  assert.deepEqual(await db.productAtShop.findUnique({where:{id:protectedPrice.id}}),protectedPrice);
  assert.equal((await db.supermarketProductState.findFirst({where:{productId:product.id}})).inHandStock,11);
  run(['--report',path.join(dir,'rerun.json')]);const rerun=await report('rerun.json');
  for(const k of ['creates','updates','tierCreates','rrpUpdates']) assert.equal(rerun[k].length,0,k);
  run(['--apply','--reviewed-report',path.join(dir,'rerun.json'),'--report',path.join(dir,'rerun-apply.json')]);
  assert.equal(await db.priceTier.count(),2);assert.equal((await sql.query('SELECT count(*)::int n FROM _prisma_migrations')).rows[0].n,1);
  app=await startApp();token=(await app.login(seed.a.owner.email,seed.password)).token;adminToken=(await app.login(seed.admin.email,seed.password)).token;
});
test('stale reviewed reports are rejected before any write',async () => {
  run(['--report',path.join(dir,'stale.json')]);await db.product.update({where:{id:product.id},data:{title:'Changed title'}});
  assert.throws(()=>run(['--apply','--reviewed-report',path.join(dir,'stale.json'),'--report',path.join(dir,'bad-apply.json')]),/Database or plan changed/);
  assert.equal(await db.priceTier.count(),2);
});
test('authenticated comparison exposes original/current Dhamecha and all Bestway case tiers',async () => {
  const result=await request('GET',`/products/${product.id}/compare`);assert.equal(result.status,200);
  const d=result.body.shops.find(s=>s.shopId===SUPPLIERS.DHAMECHA.id), b=result.body.shops.find(s=>s.shopId===SUPPLIERS.BESTWAY.id);
  assert.equal(d.price,8.49);assert.equal(d.effectivePrice,4.79);assert.equal(d.unitsPerPack,12);assert.equal(d.hasActiveOffer,true);assert.equal(d.offerExpiryDate,null);
  assert.equal(b.price,0.6);assert.equal(b.offerPrice,null);assert.equal(b.hasActiveOffer,false);assert.equal(b.priceTiers.length,2);
  assert.deepEqual(b.priceTiers.map(t=>[t.quantity,t.price,t.packagingId]),[[6,3.3,'case6'],[12,6,'case12']]);
  const price=await request('GET',`/price-reports/product/${product.id}/shop/${SUPPLIERS.DHAMECHA.id}/price`);assert.equal(price.status,200);assert.equal(price.body.price,4.79);
});
test('unit and case scanners resolve identity and select only the exact case price',async () => {
  for(const [barcode,expectedDh,expectedBw] of [[unit,4.79,0.6],[case12,4.79,6],[case6,null,3.3]]) {
    const r=await request('GET',`/products/barcode/${barcode}`);assert.equal(r.status,200);assert.equal(r.body.data.id,product.id);
    assert.equal(r.body.data.shops.find(s=>s.shopId===SUPPLIERS.DHAMECHA.id).price,expectedDh);
    assert.equal(r.body.data.shops.find(s=>s.shopId===SUPPLIERS.BESTWAY.id).price,expectedBw);
  }
});
test('manual supplier price edit clears imported-current selection and cannot be reverted by the older source',async () => {
  const updated=await request('PUT',`/shop/${SUPPLIERS.DHAMECHA.id}/updateProductPrice`,{productId:product.id,price:7.5,employeeId:employee.id},adminToken);
  assert.equal(updated.status,200);
  const r=await request('GET',`/products/${product.id}/compare`),d=r.body.shops.find(s=>s.shopId===SUPPLIERS.DHAMECHA.id);
  assert.equal(d.effectivePrice,7.5);assert.equal(d.isSupplierCurrentPrice,false);assert.equal(d.unitsPerPack,12);
  run(['--report',path.join(dir,'manual-preserved.json')]);const p=await report('manual-preserved.json');assert.equal(p.updates.length,0);assert.equal(p.summary.reasonCounts.newer_existing_supplier_price,1);
});
test('legacy-alias repair withdraws only the unused newly imported row and refuses a stock change',async () => {
  const barcode=Array.from({length:10},(_,n)=>`999000000001${n}`).find(gtin);
  const target=await db.product.create({data:{title:'Ambiguous legacy alias',barcode,packetSize:'120g'}});
  await db.product.update({where:{id:seed.product.id},data:{caseBarcode:barcode}});
  await fs.writeFile(path.join(source,'bestway/three.json'),JSON.stringify([{barcode,pack_size:'120g',pack_display:'120g × 1',currency:'GBP',wholesale_price:'1.25',observed_at_utc:'2026-09-22T00:00:00Z'}]));
  const state=await readSupplierState(sql),sources=await readSupplierSources(source);
  // Simulate the historical matcher which failed to inspect legacy case aliases.
  const oldPlan=buildSupplierPricePlan(sources,{...state,products:state.products.map(p=>p.id===seed.product.id?{...p,caseBarcode:null}:p)});
  assert.equal(oldPlan.creates.length,1);assert.equal(oldPlan.creates[0].productId,target.id);
  const original=path.join(dir,'legacy-import.json');
  await fs.writeFile(`${original}.before.json`,JSON.stringify({state,preservation:await preservationFingerprint(sql)}));
  await applySupplierPlan(sql,oldPlan);
  await fs.writeFile(original,JSON.stringify({...oldPlan,sourceDir:source,sourceHash:sources.sourceHash,committed:true}));
  const repair=extra=>execFileSync(process.execPath,['scripts/withdrawAmbiguousSupplierPrices.js','--applied-report',original,...extra],{cwd:process.cwd(),env:{...process.env,DATABASE_URL:process.env.TEST_DATABASE_URL},encoding:'utf8'});
  const dry=path.join(dir,'withdraw-dry.json');repair(['--report',dry]);
  const createdId=oldPlan.creates[0].id;await db.productAtShop.update({where:{id:createdId},data:{inHandStock:1}});
  assert.throws(()=>repair(['--apply','--reviewed-report',dry,'--report',path.join(dir,'refused.json'),'--final-report',path.join(dir,'refused-final.json')]));
  assert.ok(await db.productAtShop.findUnique({where:{id:createdId}}));
  await db.productAtShop.update({where:{id:createdId},data:{inHandStock:null}});
  repair(['--apply','--reviewed-report',dry,'--report',path.join(dir,'withdraw.json'),'--final-report',path.join(dir,'withdraw-final.json')]);
  assert.equal(await db.productAtShop.findUnique({where:{id:createdId}}),null);
  assert.equal(await db.product.count({where:{id:target.id}}),1);assert.equal(await db.priceTier.count(),2);
});
