import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { getPrisma, resetDatabase, seedBase, startApp } from './helpers/harness.js';

let db, app, seed, owner, other, employee, worker, reader;
const expect = (response, status = 200) => assert.equal(response.status, status, JSON.stringify(response.body));
const request = (method, path, token = owner, body) => app.request(method, path, { token, body });
before(async () => {
  await resetDatabase(); db = await getPrisma(); seed = await seedBase(db); app = await startApp();
  owner = (await app.login(seed.a.owner.email, seed.password)).token;
  other = (await app.login(seed.b.owner.email, seed.password)).token;
  for (const [name, permissions] of [
    ['worker', ['feature.fridges.write', 'feature.age_records.write', 'feature.age_records.edit']],
    ['reader', ['feature.fridges', 'feature.age_records']],
  ]) {
    const created = await request('POST', '/employees', owner, { name, email: `${name}@tools.test`, password: 'Secret123', permissions });
    expect(created, 201);
    const token = (await app.login(`${name}@tools.test`, 'Secret123')).token;
    if (name === 'worker') { worker = token; employee = created.body.employee; } else reader = token;
  }
});
after(async () => { await app?.close(); await db?.$disconnect(); });

test('employee saves -23 freezer and positive fridge readings; warm freezer alarms are saved, not rejected', async () => {
  const freezer = await request('POST', '/fridges', owner, { name: 'Synthetic Freezer', hasFreezer: true, minSafeTemp: -25, maxSafeTemp: -18, freezerMinSafeTemp: -25, freezerMaxSafeTemp: -18 });
  expect(freezer, 201);
  const id = freezer.body.fridge.id;
  const cold = await request('POST', `/fridges/${id}/logs`, worker, { temperature: '-23', entryType: 'MORNING', compartment: 'FREEZER' });
  expect(cold, 201); assert.equal(Number(cold.body.log.temperature), -23); assert.equal(cold.body.log.isAlert, false);
  const warm = await request('POST', `/fridges/${id}/logs`, worker, { temperature: '+4', entryType: 'EVENING', compartment: 'FREEZER' });
  expect(warm, 201); assert.equal(Number(warm.body.log.temperature), 4); assert.equal(warm.body.log.isAlert, true);
  expect(await request('POST', `/fridges/${id}/logs`, worker, { temperature: -24, entryType: 'MORNING', compartment: 'FREEZER' }), 400);
  const logs = await request('GET', `/fridges/${id}/logs`, worker); expect(logs);
  assert.deepEqual(logs.body.logs.map(log => Number(log.temperature)).sort((a,b) => a-b), [-23, 4]);
  const today = await request('GET', '/fridges/today-status', worker); expect(today);
  assert.equal(Number(today.body.fridges.find(f => f.id === id).morningFreezerTemp), -23);
  expect(await request('GET', `/fridges/${id}/logs`, other), 404);
  const fridge = await request('POST', '/fridges', owner, { name: 'Synthetic Fridge', minSafeTemp: 0, maxSafeTemp: 8 }); expect(fridge, 201);
  expect(await request('POST', `/fridges/${fridge.body.fridge.id}/logs`, worker, { temperature: '3,5', entryType: 'MORNING', compartment: 'FRIDGE' }), 201);
  expect(await request('POST', `/fridges/${fridge.body.fridge.id}/logs`, reader, { temperature: 4, entryType: 'EVENING', compartment: 'FRIDGE' }), 403);
  for (const invalid of ['', '-', '−', '23abc', '1,2,3', true, null]) expect(await request('POST', `/fridges/${fridge.body.fridge.id}/logs`, worker, { temperature: invalid, entryType: 'EVENING', compartment: 'FRIDGE' }), 400);
  expect(await request('PUT', `/fridges/${id}`, owner, { freezerMinSafeTemp: '−24,5', freezerMaxSafeTemp: '-18' }));
  const saved = await db.fridge.findUnique({ where: { id } }); assert.equal(Number(saved.freezerMinSafeTemp), -24.5);
});

test('category suggestions combine existing catalog with shop-local saved names and never overwrite global taxonomy', async () => {
  await db.category.create({ data: { name: 'Alcohol' } });
  await db.product.update({ where: { id: seed.product.id }, data: { category: 'Soft Drinks' } });
  const before = await request('GET', '/age-restriction-records/categories', worker); expect(before);
  assert.ok(before.body.categories.includes('Alcohol')); assert.ok(before.body.categories.includes('Soft Drinks'));
  const created = await request('POST', '/age-restriction-records', worker, { occurredAt: new Date().toISOString(), description: 'Synthetic ID check', productCategory: ' Local department ', productName: seed.product.title });
  expect(created, 201); assert.equal(created.body.record.productCategory, 'Local department'); assert.equal(created.body.record.productName, seed.product.title);
  const refreshed = await request('GET', '/age-restriction-records/categories', worker); expect(refreshed); assert.ok(refreshed.body.categories.includes('Local department'));
  const otherCategories = await request('GET', '/age-restriction-records/categories', other); expect(otherCategories); assert.ok(!otherCategories.body.categories.includes('Local department'));
  assert.equal(await db.category.count(), 1);
  const edited = await request('PUT', `/age-restriction-records/${created.body.record.id}`, worker, { productCategory: 'Alcohol', productName: null }); expect(edited);
  assert.equal(edited.body.record.productCategory, 'Alcohol'); assert.equal(edited.body.record.productName, null);
  const reread = await request('GET', '/age-restriction-records', worker); expect(reread);
  assert.equal(reread.body.records.find(r => r.id === created.body.record.id).productCategory, 'Alcohol');
  expect(await request('PUT', `/age-restriction-records/${created.body.record.id}`, other, { productCategory: 'Unauthorized' }), 404);
});

test('product selector searches catalogue names/barcodes, filters categories, and excludes another shop private products', async () => {
  const privateProduct = await db.product.create({ data: { title: 'Private product', category: 'Private category', shops: { create: { shopId: seed.b.shop.id, price: 1 } } } });
  const search = await request('GET', '/age-restriction-records/products?q=cola&category=soft%20drinks', worker); expect(search);
  assert.equal(search.body.products[0].id, seed.product.id);
  const barcode = await request('GET', `/age-restriction-records/products?q=${seed.product.barcode}`, worker); expect(barcode); assert.equal(barcode.body.products[0].id, seed.product.id);
  const all = await request('GET', '/age-restriction-records/products', worker); expect(all); assert.ok(!all.body.products.some(p => p.id === privateProduct.id));
  const categories = await request('GET', '/age-restriction-records/categories', worker); assert.ok(!categories.body.categories.includes('Private category'));
  expect(await request('GET', `/age-restriction-records/products?q=${'a'.repeat(201)}`, worker), 400);
});

test('age-record lookups require current membership and feature permission; read-only users cannot save new categories', async () => {
  expect(await request('GET', '/age-restriction-records/categories', reader));
  expect(await request('POST', '/age-restriction-records', reader, { occurredAt: new Date().toISOString(), description: 'Unauthorized write', productCategory: 'Should not exist' }), 403);
  await db.shopEmployeeMembership.updateMany({ where: { employeeId: employee.id }, data: { permissions: ['feature.fridges'] } });
  for (const endpoint of ['categories', 'products']) expect(await request('GET', `/age-restriction-records/${endpoint}`, worker), 403);
  expect(await app.request('GET', '/age-restriction-records/categories'), 401);
});
