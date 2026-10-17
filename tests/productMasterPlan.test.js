import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildProductMasterPlan, packageSize } from '../scripts/lib/productMasterPlan.js';
import { gtin, barcodeAliases } from '../src/services/productBarcodes.js';

const unit = '5010511482313', caseCode = '5010511040445';
const product = (extra = {}) => ({ id: 'existing', title: 'Existing title', barcode: unit, caseBarcode: null, caseSize: null, packetSize: null, retailSize: null, ...extra });
const record = (extra = {}) => ({ record_id: 'source1', rcode: 'R14159', unit_barcode: unit, unit_barcodes: [unit], case_barcode: caseCode, case_barcodes: [caseCode], packing: '12 x 120g', unit_size: '120g', pack_quantity: 12, pack_quantity_raw: '12', errors: [], ...extra });
const plan = (rows = [record()], products = [product()], packaging = []) => buildProductMasterPlan(rows, products, packaging);

test('GTINs retain zeroes; only valid lengths/check digits gain equivalent aliases', () => {
  assert.equal(gtin('05010511482313'), gtin(unit));
  assert.equal(gtin(5010511482313), null);
  for (const invalid of ['R14159', '12345', '5010511482314', '00000000', '5.010511482313e12']) assert.equal(gtin(invalid), null);
  assert.ok(barcodeAliases(unit).includes('05010511482313'));
  assert.deepEqual(barcodeAliases('legacy-id'), ['legacy-id']);
});
test('unit barcode alone matches; supplier codes, input barcode, titles and case-only products never do', () => {
  const result = plan([record({ input_barcode: caseCode, rcode: 'existing', product_name: 'Unrelated title' })]);
  assert.equal(result.creates[0].productId, 'existing');
  const unmatched = plan([record()], [product({ barcode: caseCode, title: record().product_name })]);
  assert.equal(unmatched.creates.length, 0);
  assert.ok(unmatched.unresolved[0].reasons.includes('no_existing_unit_match'));
});
test('equivalent barcode collisions quarantine all matches instead of preferring exact strings', () => {
  const result = plan([record()], [product(), product({ id: 'duplicate', barcode: `0${unit}` })]);
  assert.equal(result.creates.length, 0);
  assert.ok(result.unresolved[0].reasons.includes('duplicate_database_unit_gtin'));
});
test('duplicate source records collapse and a rerun has zero changes', () => {
  const first = plan([record(), record({ record_id: 'copy' })]);
  assert.equal(first.creates.length, 1);
  assert.equal(first.creates[0].sourceReferences.length, 2);
  const second = plan([record(), record({ record_id: 'copy' })], [product(first.updates[0].changes)], first.creates);
  assert.equal(second.creates.length, 0);
  assert.equal(second.updates.length, 0);
});
test('distinct case configurations coexist without selecting an arbitrary legacy default', () => {
  const result = plan([record(), record({ case_barcode: '5000382114994', case_barcodes: ['5000382114994'], pack_quantity: 6, pack_quantity_raw: '6', packing: '6 x 120g' })]);
  assert.equal(result.creates.length, 2);
  assert.deepEqual(result.creates.map(p => p.unitsPerCase).sort((a,b) => a-b), [6,12]);
  assert.equal(result.updates[0].changes.caseBarcode, undefined);
  assert.equal(result.updates[0].changes.caseSize, undefined);
});
test('same case code with different quantities is wholly quarantined', () => {
  const result = plan([record(), record({ pack_quantity: 6, pack_quantity_raw: '6', packing: '6 x 120g' })]);
  assert.equal(result.creates.length, 0);
  assert.ok(result.unresolved.every(r => r.reasons.includes('conflicting_source_case_configurations')));
});
test('shared source case barcode, existing case owner and unit-code collisions are blocked', () => {
  assert.equal(plan([record(), record({ unit_barcode: '5000382114987', unit_barcodes: ['5000382114987'] })]).creates.length, 0);
  assert.equal(plan([record()], [product(), product({ id: 'other', barcode: '5000382114987', caseBarcode: caseCode })]).creates.length, 0);
  assert.equal(plan([record()], [product(), product({ id: 'case-as-unit', barcode: caseCode })]).creates.length, 0);
});
test('missing barcodes and invalid checksums never create incomplete packaging', () => {
  for (const value of [null, '', 'R1234', '5010511040446']) assert.equal(plan([record({ case_barcode: value, case_barcodes: value ? [value] : [] })]).creates.length, 0);
});
test('nested saleable packs preserve the inner expression and do not multiply unit counts', () => {
  const result = plan([record({ unit_size: '4x330ml', packing: '6 x 4x330ml', pack_quantity: 6, pack_quantity_raw: '6' })]);
  assert.equal(result.creates[0].unitsPerCase, 6);
  assert.equal(result.creates[0].packageSize, '4x330ml');
  assert.equal(packageSize('1LTR'), packageSize('1000ml'));
  for (const raw of ['6x12', '6.5', 'six', null]) assert.equal(plan([record({ pack_quantity_raw: raw })]).creates.length, 0);
  assert.equal(plan([record({ packing: '6 x 120g' })]).creates.length, 0);
  assert.equal(packageSize('1.2x4Kg'), null);
});
test('existing valid values and prior case configurations are never overwritten', () => {
  const original = product({ caseBarcode: '5000382114994', caseSize: '6', packetSize: '120g', retailSize: 'keep' });
  const result = plan([record()], [original]);
  assert.equal(result.updates.length, 0);
  assert.equal(result.creates.length, 1);
  const conflict = plan([record()], [product()], [{ ...result.creates[0], unitsPerCase: 7 }]);
  assert.equal(conflict.creates.length, 0);
  assert.ok(conflict.unresolved[0].reasons.includes('existing_packaging_conflict'));
});
test('different source unit sizes and known database size conflicts are quarantined', () => {
  assert.equal(plan([record(), record({ unit_size: '100g', packing: '12 x 100g' })]).creates.length, 0);
  assert.equal(plan([record()], [product({ packetSize: '100g' })]).creates.length, 0);
});
test('source prices are excluded from proposed database writes and provenance', () => {
  const result = plan([record({ wholesale_price: 123, printed_price: { amount: 456 } })]);
  const writes = JSON.stringify({ creates: result.creates, updates: result.updates });
  assert.equal(/wholesale_price|printed_price|"rrp"|"price"/.test(writes), false);
});
