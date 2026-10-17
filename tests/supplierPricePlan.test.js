import { test } from 'node:test';
import assert from 'node:assert/strict';
import { money, bestwayBarcode, buildSupplierPricePlan, SUPPLIERS } from '../scripts/lib/supplierPricePlan.js';
import { getEffectivePrice, presentSupplierPrice } from '../src/services/supplierPricing.js';
import { gtin } from '../src/services/productBarcodes.js';

const unit = '5010511482313';
const fixture = () => ({
  shops:Object.values(SUPPLIERS).map(s => ({ ...s,shopType:'WHOLESALE' })),
  products:[{ id:'p', barcode:unit, packetSize:'120g', rrp:null }],
  packaging:[{ id:'case12', productId:'p', caseGtin:gtin('5010511040445'), unitsPerCase:12, packageSizeKey:'120g' }],
  prices:[], tiers:[], promotions:[],
});
const row = (overrides = {}) => ({ supplier:'DHAMECHA', ref:{ file:'source',row:1 }, barcode:unit, code:gtin(unit), status:'found', regularPrice:'8.49', currentPrice:'4.79', rrp:'1.15', units:12, unitSize:'120g', packDisplay:'12 x 120g', observedAt:'2026-09-22T00:00:00.000Z', evidence:{ promotion:true, rawPricing:{ original_price_2:'9.99', promo_price:null } }, inputProblems:[], ...overrides });
const plan = (rows, state = fixture()) => buildSupplierPricePlan({ records:rows, sourceUnresolved:[] },state);

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
test('newer prices and existing manual promotions survive older imports', () => {
  const s = fixture(); s.prices.push({ id:'old',shopId:SUPPLIERS.DHAMECHA.id,productId:'p',price:'8.49',updatedAt:'2026-10-01T00:00:00Z' });
  assert.equal(plan([row()],s).updates.length,0); assert.ok(plan([row()],s).summary.reasonCounts.newer_existing_supplier_price);
  s.prices[0].updatedAt='2026-01-01T00:00:00Z'; s.prices[0].offerPrice='4.50';
  assert.ok(plan([row()],s).summary.reasonCounts.existing_promotion_preserved);
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
