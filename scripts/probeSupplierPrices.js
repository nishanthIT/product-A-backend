// Read-only checks of the committed database plus the real scan/comparison handlers
// and the frontend ranking engine. No production login or test-account creation.
import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import pg from 'pg';
import { hash } from './lib/productMasterPlan.js';
import { readSupplierSources,buildSupplierPricePlan,stableJson,SUPPLIERS } from './lib/supplierPricePlan.js';
import { readSupplierState,verifySupplierState,preservationFingerprint,migrationName } from './importSupplierPrices.js';
import { getEffectivePrice } from '../src/services/supplierPricing.js';
import { buildPurchaseOptions } from '../../paymi_v2/src/features/compare/engine.ts';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const value=flag=>process.argv.includes(flag)?process.argv[process.argv.indexOf(flag)+1]:undefined;
const appliedPath=path.resolve(value('--applied-report')||path.join(root,'reports/supplier-prices/apply-2026-10-17.json'));
const reportPath=path.resolve(value('--report')||path.join(root,'reports/supplier-prices',`verification-${new Date().toISOString().replaceAll(':','-')}.json`));
const applied=JSON.parse(await fs.readFile(appliedPath)), before=JSON.parse(await fs.readFile(`${appliedPath}.before.json`));
assert.equal(applied.committed,true);
const supplier=(value('--supplier')||applied.supplier||'').toUpperCase()||null;
if(supplier) assert.ok(SUPPLIERS[supplier]);
const relevant=applied.accepted.filter(a=>!supplier||a.supplier===supplier);
const db=new pg.Client({connectionString:process.env.DATABASE_URL,connectionTimeoutMillis:15000});
const report={checkedAt:new Date().toISOString(),readOnly:true,supplier,probes:[],visualBrowserVerification:'unavailable_no_connected_browser'};
const invoke=async(handler,req)=>{let status=200,body;await handler({params:{},query:{},...req},{status(v){status=v;return this;},json(v){body=v;return this;}});return{status,body};};
try {
  await db.connect();await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  const state=await readSupplierState(db), source=await readSupplierSources(path.join(root,'../data_suppliers'),{supplier});
  assert.equal(source.sourceHash,supplier && !applied.supplier ? hash(applied.manifest.filter(f=>f.supplier===supplier)) : applied.sourceHash);
  verifySupplierState(before.state,state,applied);
  assert.equal(stableJson(before.preservation),stableJson(await preservationFingerprint(db)));
  const rerun=buildSupplierPricePlan(source,state,supplier?{[supplier]:SUPPLIERS[supplier]}:SUPPLIERS);
  for(const key of ['creates','updates','tierCreates','rrpUpdates']) assert.equal(rerun[key].length,0,key);
  assert.equal(rerun.accepted.length,relevant.length);
  report.rerunWrites=0;report.acceptedPrices=rerun.accepted.length;
  for(const a of relevant) {
    const base=state.prices.find(p=>p.id===a.productAtShopId);
    assert.ok(base);assert.equal(base.shopId,SUPPLIERS[a.supplier].id);assert.equal(base.productId,a.productId);
    const stored=a.type==='base'?base:state.tiers.find(t=>t.productAtShopId===base.id&&t.quantity===a.units);
    assert.ok(stored);assert.equal(Number(stored.price),Number(a.price));assert.equal(stored.packagingId,a.packagingId);
    assert.equal(a.type==='base'?stored.unitsPerPack:stored.quantity,a.units);
    if(a.supplier==='DHAMECHA') assert.equal(Number(stored.offerPrice),Number(a.currentPrice));
  }
  report.exactDatabasePricesChecked=relevant.length;
  const migrationSql=await fs.readFile(path.join(root,'prisma/migrations',migrationName,'migration.sql'),'utf8');
  report.migration=(await db.query('SELECT migration_name,checksum,finished_at,rolled_back_at FROM _prisma_migrations WHERE migration_name=$1',[migrationName])).rows;
  assert.equal(report.migration.length,1);assert.equal(report.migration[0].checksum,hash(migrationSql));assert.ok(report.migration[0].finished_at);assert.equal(report.migration[0].rolled_back_at,null);
  report.preservation={existingProductIdsInventoryRelationships:true,nonTargetPricesIncludingActiveHub:true,promotions:true};
  report.counts={products:state.products.length,packaging:state.packaging.length,supplierPrices:state.prices.length,tiers:state.tiers.length,...(supplier&&{selectedSupplierPrices:state.prices.filter(p=>p.shopId===SUPPLIERS[supplier].id).length})};
  await db.query('COMMIT');
  const {getProductComparison}=await import('../src/routes/compareRoutes.js');
  const {getProductByBarcode}=await import('../src/controller/addProduct.js');
  const dh=relevant.filter(p=>p.supplier==='DHAMECHA');
  const bw=relevant.filter(p=>p.supplier==='BESTWAY');
  const bwTierProducts=new Set(bw.filter(p=>p.type==='case_tier').map(p=>p.productId));
  const productIds=[...new Set([...dh.filter(p=>p.units>1).slice(0,4).map(p=>p.productId),...dh.filter(p=>p.units===1).slice(0,2).map(p=>p.productId),...bw.filter(p=>p.type==='case_tier').slice(0,4).map(p=>p.productId),...bw.filter(p=>p.type==='base'&&p.units>1).slice(0,2).map(p=>p.productId),...bw.filter(p=>p.type==='base'&&p.units===1&&!bwTierProducts.has(p.productId)).slice(0,2).map(p=>p.productId)])];
  for(const productId of productIds) {
    const comparison=await invoke(getProductComparison,{params:{id:productId}});assert.equal(comparison.status,200);
    const options=buildPurchaseOptions(comparison.body);
    for(let i=1;i<options.length;i++) assert.ok(options[i-1].effectiveUnitPrice<=options[i].effectiveUnitPrice);
    for(const a of relevant.filter(a=>a.productId===productId)) {
      const shop=comparison.body.shops.find(s=>s.productAtShopId===a.productAtShopId);
      const stored=state.prices.find(p=>p.id===a.productAtShopId);
      if(stored.outOfStock) {assert.equal(shop,undefined);continue;}
      assert.ok(shop);
      const option=options.find(o=>o.productAtShopId===a.productAtShopId&&o.kind===(a.type==='base'?'single':'tier')&&o.unitsIncluded===a.units);
      assert.ok(option);
      const expected=a.type==='base'?getEffectivePrice(stored).price:Number(a.price);
      assert.equal(option.packagePrice,expected);assert.equal(option.effectiveUnitPrice,expected/a.units);
      if(a.type==='base') {assert.equal(shop.price,Number(a.price));assert.equal(shop.effectivePrice,expected);assert.equal(option.hasActiveOffer,getEffectivePrice(stored).hasActiveOffer);}
      if(a.type==='case_tier') {assert.equal(option.hasActiveOffer,false);assert.equal(option.offerExpiryDate,null);assert.ok(option.label.startsWith(`Case of ${a.units}`));}
      report.probes.push({endpoint:'compare + frontend engine',productId,shopId:shop.shopId,units:a.units,packagePrice:option.packagePrice,unitPrice:option.effectiveUnitPrice,label:option.label,hasActiveOffer:option.hasActiveOffer});
    }
    const product=state.products.find(p=>p.id===productId);
    const unitScan=await invoke(getProductByBarcode,{params:{barcode:product.barcode}});assert.equal(unitScan.status,200);assert.equal(unitScan.body.data.id,productId);
    for(const a of relevant.filter(a=>a.productId===productId&&a.type==='base')) {
      const stored=state.prices.find(p=>p.id===a.productAtShopId);
      const shop=unitScan.body.data.shops.find(s=>s.productAtShopId===a.productAtShopId);
      if(stored.outOfStock) {assert.equal(shop,undefined);continue;}
      assert.ok(shop);assert.equal(shop.price,getEffectivePrice(stored).price);assert.equal(shop.unitsPerPack,a.units);
      assert.equal(shop.unitPrice,getEffectivePrice(stored).price/a.units);
    }
    report.probes.push({endpoint:'unit barcode scan',productId,barcode:product.barcode,status:unitScan.status});
    const configurations=state.packaging.filter(p=>p.productId===productId);
    for(const pack of configurations) {
      const scan=await invoke(getProductByBarcode,{params:{barcode:pack.caseBarcode}});assert.equal(scan.status,200);assert.equal(scan.body.data.matchedPackaging.id,pack.id);
      for(const shop of scan.body.data.shops) {
        const base=state.prices.find(p=>p.id===shop.productAtShopId),tier=state.tiers.find(t=>t.productAtShopId===base.id&&t.packagingId===pack.id);
        const expected=base.packagingId===pack.id ? getEffectivePrice(base).price : tier?Number(tier.price):null;
        assert.equal(shop.price,expected);assert.equal(shop.unitsPerPack,pack.unitsPerCase);
      }
      report.probes.push({endpoint:'case barcode scan',productId,barcode:pack.caseBarcode,packagingId:pack.id,units:pack.unitsPerCase,status:scan.status});
    }
  }
  const ambiguous=applied.unresolved.find(r=>(!supplier||r.supplier===supplier)&&r.reasons.includes('ambiguous_product_match'));
  if(ambiguous) {
    const scan=await invoke(getProductByBarcode,{params:{barcode:ambiguous.barcode}});assert.equal(scan.status,409);
    report.probes.push({endpoint:'ambiguous barcode scan',barcode:ambiguous.barcode,status:scan.status,expectedConflict:true});
  }
  report.valid=true;await fs.mkdir(path.dirname(reportPath),{recursive:true});await fs.writeFile(reportPath,JSON.stringify(report,null,2)+'\n',{mode:0o600,flag:'wx'});
  console.log(JSON.stringify({reportPath,valid:true,counts:report.counts,rerunWrites:0,acceptedPrices:report.acceptedPrices,apiAndFrontendProbes:report.probes.length},null,2));
} catch(error) {
  await db.query('ROLLBACK').catch(()=>{});
  console.error(JSON.stringify({code:error.code||'SUPPLIER_VERIFICATION_FAILED',message:error.code?'Read-only verification failed':error.message}));process.exitCode=1;
} finally {await db.end();}
