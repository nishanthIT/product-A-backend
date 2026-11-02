import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { money, bestwayBarcode, bestwayIdentity, buildSupplierPricePlan, readSupplierSources, SUPPLIERS } from '../scripts/lib/supplierPricePlan.js';
import { getEffectivePrice, presentSupplierPrice } from '../src/services/supplierPricing.js';
import { gtin } from '../src/services/productBarcodes.js';

const unit = '5010511482313';
const fixture = () => ({
  shops:Object.values(SUPPLIERS).map(s => ({ ...s,shopType:'WHOLESALE' })),
  products:[{ id:'p', barcode:unit, packetSize:'120g', rrp:null }],
  packaging:[{ id:'case12', productId:'p', caseGtin:gtin('5010511040445'), unitsPerCase:12, packageSizeKey:'120g' }],
  prices:[], tiers:[], promotions:[],
});
const row = (overrides = {}) => ({ supplier:'DHAMECHA', sourceProductId:146688, productName:'Source product name', ref:{ file:'source',row:1 }, barcode:unit, code:gtin(unit), status:'found', regularPrice:'8.49', currentPrice:'4.79', rrp:'1.15', units:12, unitSize:'120g', packDisplay:'12 x 120g', observedAt:'2026-09-22T00:00:00.000Z', evidence:{ promotion:true, rawPricing:{ original_price_2:'9.99', promo_price:null } }, inputProblems:[], ...overrides });
const plan = (rows, state = fixture()) => buildSupplierPricePlan({ records:rows, sourceUnresolved:[] },state);

test('Dhamecha source loading does not parse or require Bestway datasets',async () => {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'dhamecha-only-'));
  try {
    await fs.mkdir(path.join(dir,'Dhamecha'));await fs.mkdir(path.join(dir,'bestway'));
    await fs.writeFile(path.join(dir,'Dhamecha/products.jsonl'),JSON.stringify({result:{barcode:unit,product_id:1,product_name:'Test',status:'found'}}));
    await fs.writeFile(path.join(dir,'bestway/unrelated.json'),'not valid JSON');
    const source=await readSupplierSources(dir,{supplier:'DHAMECHA'});
    assert.equal(source.records.length,1);assert.equal(source.records[0].supplier,'DHAMECHA');
    assert.equal(source.manifest.find(f=>f.supplier==='BESTWAY').excluded,true);
  } finally {await fs.rm(dir,{recursive:true,force:true});}
});

test('money rejects absent, zero, negative, fractional-penny and malformed values without guessing', () => {
  assert.equal(money('1.15000'),'1.15'); assert.equal(money('8'),'8.00');
  for (const bad of [null,undefined,0,-1,'£1.20','1,200','NaN','Infinity','1.159',true,'1e2']) assert.equal(money(bad),null);
});
test('Bestway reads actual retail barcodes and rejects conflicting fields, supplier IDs and invalid GTINs', () => {
  assert.equal(bestwayBarcode({ barcodes:[{ label:'Retail EAN',value:unit }], barcode:unit }).code,gtin(unit));
  assert.equal(bestwayBarcode({ barcodes:{ retail_barcode:unit } }).code,gtin(unit));
  assert.equal(bestwayBarcode({ retail_barcode:unit }).code,gtin(unit));
  assert.equal(bestwayBarcode({ barcode:unit }).code,gtin(unit));
  assert.equal(bestwayBarcode({ barcodes:[],barcode:unit,product_code:unit }).code,null);
  assert.equal(bestwayBarcode({ barcodes:[{ label:'Retail EAN',value:unit }],barcode:'5010511040445' }).code,null);
  assert.equal(bestwayBarcode({ barcode:'123456' }).code,null);
});
test('Bestway validates source product IDs independently of master barcodes', () => {
  assert.equal(bestwayIdentity({url:'https://www.bestwaywholesale.co.uk/product/807771-1'}).id,'807771-1');
  assert.equal(bestwayIdentity({product_code:'807771',sku:'807771-1'}).id,'807771-1');
  assert.equal(bestwayIdentity({product_code:'807771',sku:'999999-1'}).reason,'conflicting_product_ids');
  assert.equal(bestwayIdentity({sku:'807771-1',url:'https://www.bestwaywholesale.co.uk/product/807771-9'}).reason,'conflicting_product_ids');
  assert.equal(bestwayIdentity({url:'https://unrelated.invalid/product/807771-1'}).reason,'invalid_product_id');
  assert.equal(bestwayIdentity({product_code:'NOT-A-BARCODE'}).reason,'invalid_product_id');
  assert.equal(bestwayIdentity({barcode:unit,product_name:'Product'}).id,null);
});
test('all four Bestway exports reuse exact checkpoint identity and reject missing/conflicting identities and price bases',async () => {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'bestway-identity-'));
  const flat={product_name:'Source product',barcode:unit,wholesale_price:'0.60',currency:'GBP',pack_size:'120g',pack_display:'120g × 1'};
  const detail={...flat,name:flat.product_name,product_code:'123456',sku:'123456-1',url:'https://www.bestwaywholesale.co.uk/product/123456-1',barcodes:[{label:'Retail EAN',value:unit}],units_per_priced_pack:1,import_ready:true};
  try {
    await fs.mkdir(path.join(dir,'bestway'));await fs.mkdir(path.join(dir,'Dhamecha'));
    await fs.writeFile(path.join(dir,'Dhamecha/ignored.json'),'invalid JSON must remain unparsed');
    const write=async (details) => {
      for(const [name,data] of Object.entries({'one.json':[flat],'two.json':[flat],'three.json':[flat],'checkpoint.json':{products:details}})) await fs.writeFile(path.join(dir,'bestway',name),JSON.stringify(data));
      return readSupplierSources(dir,{supplier:'BESTWAY'});
    };
    const source=await write([detail]);
    assert.equal(source.records.length,4);assert.equal(source.records.filter(r=>r.identityBasis==='exact_checkpoint_projection').length,3);
    assert.ok(source.records.every(r=>r.sourceProductId==='123456-1'));
    const p=buildSupplierPricePlan(source,fixture(),{BESTWAY:SUPPLIERS.BESTWAY});
    assert.equal(p.creates.length,1);assert.equal(p.summary.duplicateSourceRowsCollapsed,3);
    const missing=await write([]);
    assert.equal(buildSupplierPricePlan(missing,fixture(),{BESTWAY:SUPPLIERS.BESTWAY}).summary.reasonCounts.missing_product_id,3);
    const conflicting=await write([detail,{...detail,product_code:'654321',sku:'654321-1',url:'https://www.bestwaywholesale.co.uk/product/654321-1'}]);
    assert.equal(conflicting.records.filter(r=>r.inputProblems.includes('ambiguous_source_identity')).length,3);
    const invalid=await write([{...detail,name:null,product_name:null},{...detail,pack_display:'120g × 12 × 1',wholesale_price:'6.00'},{...detail,pack_display:'120g × 12',units_per_priced_pack:1,wholesale_price:'6.00'},{...detail,wholesale_price:null}]);
    const rejected=buildSupplierPricePlan(invalid,fixture(),{BESTWAY:SUPPLIERS.BESTWAY});
    assert.equal(rejected.creates.length,0);
    for(const reason of ['missing_product_id','missing_product_name','conflicting_pack_fields','missing_or_invalid_price']) assert.ok(rejected.summary.reasonCounts[reason]);
  } finally {await fs.rm(dir,{recursive:true,force:true});}
});
test('Dhamecha preserves original, current, null promo and alternate raw values; duplicate rows collapse', () => {
  const p = plan([row(),row({ ref:{ file:'duplicate',row:2 } })]);
  assert.equal(p.creates.length,1); assert.equal(p.summary.duplicateSourceRowsCollapsed,1);
  assert.equal(p.creates[0].price,'8.49'); assert.equal(p.creates[0].offerPrice,'4.79');
  assert.equal(p.creates[0].offerExpiryDate,null); assert.equal(p.creates[0].unitsPerPack,12); assert.equal(p.creates[0].packagingId,'case12');
  assert.equal(p.creates[0].sourcePricing.records[0].rawPricing.original_price_2,'9.99');
  assert.equal(p.creates[0].sourcePricing.records[0].rawPricing.promo_price,null);
});
test('missing quantities never infer case size; verified retail RRP can independently fill a missing value', () => {
  const p = plan([row({ units:null,packDisplay:null })]);
  assert.equal(p.creates.length,0); assert.equal(p.rrpUpdates.length,1); assert.ok(p.summary.reasonCounts.ambiguous_packaging);
});
test('Dhamecha requires both a source product ID and a nonblank product name, including for RRP', () => {
  for(const invalid of [{sourceProductId:null},{productName:null},{productName:'  '}]) {
    const p=plan([row(invalid)]);
    assert.equal(p.creates.length,0);assert.equal(p.rrpUpdates.length,0);
    assert.ok(p.unresolved[0].reasons.some(r=>r.startsWith('missing_product_')));
  }
});
test('a single-supplier plan cannot write another supplier even when given mixed audit input', () => {
  const p=buildSupplierPricePlan({records:[row(),row({supplier:'BESTWAY',currentPrice:null})],sourceUnresolved:[]},fixture(),{DHAMECHA:SUPPLIERS.DHAMECHA});
  assert.equal(p.creates.length,1);assert.equal(p.creates[0].shopId,SUPPLIERS.DHAMECHA.id);
  assert.deepEqual(Object.keys(p.summary.suppliers),['DHAMECHA']);
});
test('unknown/mismatched cases, ambiguous identities and different duplicate prices are quarantined', () => {
  assert.equal(plan([row({ units:6, packDisplay:'6 x 120g' })]).creates.length,0);
  const s = fixture(); s.products.push({ id:'duplicate',barcode:'0'+unit });
  assert.equal(plan([row()],s).creates.length,0); assert.equal(plan([row()],s).rrpUpdates.length,0);
  assert.equal(plan([row(),row({ currentPrice:'4.89' })]).creates.length,0);
});
test('a legacy case alias on another product blocks a unit match and any RRP write', () => {
  const s=fixture();s.products.push({id:'legacy-owner',caseBarcode:unit,barcode:'5010511040445'});
  const p=plan([row()],s);
  assert.equal(p.creates.length,0);assert.equal(p.rrpUpdates.length,0);
  assert.equal(p.summary.reasonCounts.ambiguous_product_match,1);
});
test('verified case configuration wins over legacy scalar size; unit-size conflicts are rejected', () => {
  const s = fixture(); s.products[0].packetSize='200g';
  assert.equal(plan([row()],s).creates.length,1);
  assert.equal(plan([row({ units:1,packDisplay:'1x120g' })],s).creates.length,0);
});
test('Bestway retains unit and case wholesale prices without creating promotional pricing', () => {
  const p = plan([row({ supplier:'BESTWAY',units:1,currentPrice:null,rrp:null,regularPrice:'0.60' }),row({ supplier:'BESTWAY',currentPrice:null,rrp:null,regularPrice:'6.00' })]);
  assert.equal(p.creates.length,1); assert.equal(p.creates[0].price,'0.60'); assert.equal(p.creates[0].offerPrice,null); assert.equal(p.creates[0].offerPriceSource,null);
  assert.equal(p.tierCreates.length,1); assert.equal(p.tierCreates[0].quantity,12); assert.equal(p.tierCreates[0].price,'6.00');
});
test('Bestway updates a verified existing unit price while retaining its identity, offers and independent case tiers', () => {
  const s=fixture();s.prices.push({id:'existing-bestway',productId:'p',shopId:SUPPLIERS.BESTWAY.id,price:'0.70',unitsPerPack:1,offerPrice:'0.50',offerExpiryDate:'2030-01-01T00:00:00Z',updatedAt:'2026-01-01T00:00:00Z'});
  const p=plan([row({supplier:'BESTWAY',units:1,regularPrice:'0.60',currentPrice:null,rrp:null}),row({supplier:'BESTWAY',regularPrice:'6.00',currentPrice:null,rrp:null})],s);
  assert.equal(p.creates.length,0);assert.equal(p.updates[0].id,'existing-bestway');
  assert.equal(p.updates[0].data.price,'0.60');assert.equal(p.updates[0].data.offerPrice,'0.50');assert.equal(p.updates[0].data.offerExpiryDate,'2030-01-01T00:00:00Z');
  assert.equal(p.tierCreates[0].price,'6.00');assert.equal(p.tierCreates[0].packagingId,'case12');
});
test('newer prices and existing manual promotions survive older imports', () => {
  const s = fixture(); s.prices.push({ id:'old',shopId:SUPPLIERS.DHAMECHA.id,productId:'p',price:'8.49',updatedAt:'2026-10-01T00:00:00Z' });
  assert.equal(plan([row()],s).updates.length,0); assert.ok(plan([row()],s).summary.reasonCounts.newer_existing_supplier_price);
  s.prices[0].updatedAt='2026-01-01T00:00:00Z'; s.prices[0].offerPrice='4.50';
  assert.ok(plan([row()],s).summary.reasonCounts.existing_promotion_preserved);
});
test('a verified unit price cannot be overwritten by a Dhamecha case price', () => {
  const s=fixture();s.prices.push({id:'unit-price',shopId:SUPPLIERS.DHAMECHA.id,productId:'p',price:'0.99',unitsPerPack:1,updatedAt:'2026-01-01T00:00:00Z'});
  const p=plan([row()],s);assert.equal(p.updates.length,0);
  assert.equal(p.summary.reasonCounts.existing_pricing_basis_mismatch,1);
});
test('JSONB key order does not cause duplicate updates; rerun is a no-op', () => {
  const s = fixture(), p = plan([row()],s);
  const reverse = value => value && typeof value === 'object' ? Array.isArray(value) ? value.map(reverse) : Object.fromEntries(Object.keys(value).reverse().map(k => [k,reverse(value[k])])) : value;
  s.prices = p.creates.map(reverse); s.products[0].rrp='1.15';
  const again = plan([row()],s); assert.equal(again.creates.length,0); assert.equal(again.updates.length,0); assert.equal(again.accepted.length,1);
});
test('RRP conflicts do not overwrite the master and existing valid RRP is preserved', () => {
  const s = fixture(); assert.equal(plan([row(),row({ rrp:'1.25' })],s).rrpUpdates.length,0);
  s.products[0].rrp='1.99'; assert.equal(plan([row()],s).rrpUpdates.length,0);
});
test('selector respects expiry and explicit current source without inventing a discount for null promotions', () => {
  const now = new Date('2026-10-17'), base = { price:8.49, offerPrice:4.79, unitsPerPack:12 };
  assert.equal(getEffectivePrice(base,now).price,8.49);
  assert.equal(getEffectivePrice({ ...base,offerExpiryDate:'2026-11-01' },now).price,4.79);
  assert.equal(getEffectivePrice({ ...base,offerExpiryDate:'2026-09-01' },now).price,8.49);
  const imported = getEffectivePrice({ ...base,offerPriceSource:'DHAMECHA_CURRENT',sourcePricing:{ promotion:null } },now);
  assert.equal(imported.price,4.79); assert.equal(imported.hasActiveOffer,false); assert.equal(imported.unitPrice,4.79/12);
  assert.equal(getEffectivePrice({ ...base,offerPriceSource:'DHAMECHA_CURRENT',sourcePricing:{ promotion:true } },now).hasActiveOffer,true);
});
test('case scanning selects the linked case total and never substitutes a different case or unit price', () => {
  const row = { id:'p',shopId:'s',price:0.6,unitsPerPack:1,priceTiers:[{ quantity:12,price:6,packagingId:'case12' }] };
  const scan = presentSupplierPrice(row,{ id:'case12',unitsPerCase:12,packageSize:'120g' });
  assert.equal(scan.price,6); assert.equal(scan.unitPrice,0.5); assert.equal(scan.unitsPerPack,12);
  assert.equal(presentSupplierPrice(row,{ id:'othercase',unitsPerCase:6 }).price,null);
  assert.equal(presentSupplierPrice(row).price,0.6);
});
