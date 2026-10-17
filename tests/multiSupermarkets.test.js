import fs from 'node:fs';
import path from 'node:path';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { getPrisma, resetDatabase, seedBase, startApp } from './helpers/harness.js';
import { buildListScopePlan, collectListScopeFacts, applyListScopePlan, recoverListScopeRun } from '../scripts/lib/listScopeMigration.js';
let db, app, seed, token, shopB, employeeToken, listA, listB;
const request = (method, url, shopId, body, extra = {}) => app.request(method, url, { token, shopId, body, ...extra });
before(async () => { await resetDatabase(); db = await getPrisma(); seed = await seedBase(db); app = await startApp(); token = (await app.login(seed.a.owner.email, seed.password)).token; });
after(async () => { await app?.close(); await db?.$disconnect(); });
test('second shop creation is transactional and concurrent/lost-response retries create exactly one shop', async () => {
  const customers = await db.customer.count(), shops = await db.shop.count(), prices = await db.productAtShop.findMany();
  const headers = { 'Idempotency-Key': 'second_supermarket_request_01' };
  const results = await Promise.all(Array.from({ length: 4 }, () => request('POST', '/shop/supermarkets', seed.a.shop.id, { name: 'City Convenience Store', address: 'London' }, { headers })));
  assert.equal(results.filter((r) => r.status === 201).length, 1, JSON.stringify(results));
  assert.equal(results.filter((r) => r.status === 200).length, 3);
  shopB = results[0].body.shop;
  assert.ok(results.every((r) => r.body.shop.id === shopB.id));
  assert.equal(await db.customer.count(), customers); assert.equal(await db.shop.count(), shops + 1);
  assert.deepEqual(await db.productAtShop.findMany(), prices); assert.ok(shopB.groupChatId);
  assert.equal((await request('POST', '/shop/supermarkets', seed.a.shop.id, { name: 'Changed name' }, { headers })).status, 409);
});
test('directory, default, and explicit selection require verified CUSTOMER ownership', async () => {
  const directory = await request('GET', '/shop/supermarkets');
  assert.equal(directory.status, 200);
  assert.deepEqual(new Set(directory.body.supermarkets.map((s) => s.id)), new Set([seed.a.shop.id, shopB.id]));
  assert.equal(directory.body.canCreateAdditional, true);
  assert.equal((await request('GET', '/expiry', seed.wholesale.id)).status, 403);
  assert.equal((await request('GET', '/expiry', seed.b.shop.id)).status, 403);
  assert.equal((await request('PUT', `/shop/supermarkets/${shopB.id}/default`, seed.a.shop.id)).status, 200);
  assert.equal((await request('GET', '/shop/my-shop')).body.shop.id, shopB.id);
  assert.equal((await request('GET', '/shop/my-shop', seed.a.shop.id)).body.shop.id, seed.a.shop.id);
  assert.equal((await db.customer.findUnique({ where: { id: seed.a.owner.id } })).shopId, seed.a.shop.id);
});
test('lists, Collect Mode and retail stock are isolated; supplier prices and stock remain unchanged', async () => {
  listA = (await request('POST', '/lists', seed.a.shop.id, { name: 'Alpha order' })).body;
  listB = (await request('POST', '/lists', shopB.id, { name: 'City order' })).body;
  assert.ok(listA.id && listB.id);
  const prices = await db.productAtShop.findMany();
  const added = await request('POST', '/lists/addProduct', seed.a.shop.id, { listId: listA.id, productId: seed.product.id, inHandStock: 7 });
  assert.ok([200, 201].includes(added.status), JSON.stringify(added));
  const detail = (await request('GET', `/lists/${listA.id}`, seed.a.shop.id)).body;
  assert.equal(detail.products[0].inHandStock, 7);
  await request('POST', '/lists/addProduct', shopB.id, { listId: listB.id, productId: seed.product.id, inHandStock: 2 });
  assert.equal((await request('GET', `/lists/${listB.id}`, shopB.id)).body.products[0].inHandStock, 2);
  assert.deepEqual(await db.productAtShop.findMany(), prices);
  assert.equal((await request('GET', '/lists', seed.a.shop.id)).body.lists.length, 1);
  assert.equal((await request('GET', '/lists', shopB.id)).body.lists[0].id, listB.id);
  for (const [method, url, body] of [
    ['GET', `/lists/${listA.id}`], ['DELETE', `/lists/${listA.id}`],
    ['POST', '/lists/addProduct', { listId: listA.id, productId: seed.product.id }],
    ['PUT', '/lists/togglePurchased', { listId: listA.id, listProductId: detail.products[0].id }],
    ['PUT', '/lists/moveToList', { listId: listB.id, listProductId: detail.products[0].id, targetListId: listA.id }],
  ]) assert.equal((await request(method, url, shopB.id, body)).status, 404, url);
  assert.equal((await request('PUT', '/lists/togglePurchased', seed.a.shop.id, { listId: listA.id, listProductId: detail.products[0].id })).status, 200);
  const moved = await request('PUT', '/lists/markOutOfStock', seed.a.shop.id, { listId: listA.id, listProductId: detail.products[0].id });
  assert.equal(moved.status, 200, JSON.stringify(moved));
  assert.equal((await db.list.findUnique({ where: { id: moved.body.targetListId } })).shopId, seed.a.shop.id);
});
test('employee access is explicit per shop, feature-specific, and never grants creation or company access', async () => {
  const created = await request('POST', '/employees', seed.a.shop.id, { name: 'Team member', email: 'team@multi.test', password: 'Passw0rd!' });
  assert.equal(created.status, 201); const employee = created.body.employee;
  employeeToken = (await app.login('team@multi.test', 'Passw0rd!')).token;
  assert.equal((await request('GET', '/employees', shopB.id)).body.employees.length, 0);
  assert.equal((await request('POST', '/shop/supermarkets', seed.a.shop.id, { name: 'Cannot own', userType: 'CUSTOMER' }, { token: employeeToken, headers: { 'Idempotency-Key': 'employee_forbidden_key' } })).status, 403);
  assert.equal((await request('GET', '/expiry', shopB.id, undefined, { token: employeeToken })).status, 403);
  const eligible = await request('GET', '/employees/assignable', shopB.id);
  assert.ok(eligible.body.employees.some((e) => e.id === employee.id));
  const assigned = await request('POST', '/employees/assign', shopB.id, { employeeId: employee.id, permissions: ['feature.lists'] });
  assert.equal(assigned.status, 200, JSON.stringify(assigned));
  assert.equal((await db.empolyee.findUnique({ where: { id: employee.id } })).shopId, seed.a.shop.id);
  const directory = await request('GET', '/shop/supermarkets', undefined, undefined, { token: employeeToken });
  assert.equal(directory.body.supermarkets.length, 2); assert.equal(directory.body.canCreateAdditional, false);
  assert.ok(directory.body.supermarkets.every((s) => s.employeeCount === undefined));
  assert.equal((await request('GET', '/expiry', seed.a.shop.id, undefined, { token: employeeToken })).status, 200);
  assert.equal((await request('GET', '/expiry', shopB.id, undefined, { token: employeeToken })).status, 403);
  assert.equal((await request('POST', '/lists', shopB.id, { name: 'No write' }, { token: employeeToken })).status, 403);
  assert.equal((await request('GET', '/lists', shopB.id, undefined, { token: employeeToken })).status, 200);
  assert.equal((await request('GET', '/getallemploy', seed.a.shop.id, undefined, { token: employeeToken })).status, 403);
});
test('operational records and history IDs never cross supermarkets', async () => {
  const fridge = await db.fridge.create({ data: { name: 'Alpha fridge', shopId: seed.a.shop.id } });
  await db.fridgeTemperatureLog.create({ data: { fridgeId: fridge.id, temperature: 4, entryType: 'MORNING', recordedById: seed.a.owner.id, recordedByType: 'CUSTOMER' } });
  const area = await db.cleaningArea.create({ data: { name: 'Alpha cleaning', shopId: seed.a.shop.id } });
  await db.cleaningLog.create({ data: { cleaningAreaId: area.id, completedById: seed.a.owner.id, completedByType: 'CUSTOMER' } });
  await db.expiryProduct.create({ data: { productId: seed.product.id, shopId: seed.a.shop.id, expiryDate: new Date(), addedById: seed.a.owner.id, addedByType: 'CUSTOMER' } });
  const incident = await db.incidentLog.create({ data: { shopId: seed.a.shop.id, incidentAt: new Date(), description: 'Alpha incident', createdById: seed.a.owner.id, createdByType: 'CUSTOMER' } });
  await db.task.create({ data: { title: 'Alpha task', shopId: seed.a.shop.id, createdById: seed.a.owner.id } });
  for (const [url, field] of [['/fridges', 'fridges'], ['/fridges/all-logs?fridgeId=' + fridge.id, 'logs'], ['/cleaning/areas', 'areas'], ['/cleaning/history?areaId=' + area.id, 'logs'], ['/expiry', 'products'], ['/tasks', 'tasks'], ['/incidents', 'logs']]) {
    const res = await request('GET', url, shopB.id);
    assert.equal(res.status, 200, url + JSON.stringify(res.body)); assert.deepEqual(res.body[field], [], url);
  }
  assert.equal((await request('POST', `/fridges/${fridge.id}/logs`, shopB.id, { temperature: 5, entryType: 'MORNING' })).status, 404);
  assert.equal((await request('POST', `/cleaning/complete/${area.id}`, shopB.id, {})).status, 404);
  assert.equal((await request('DELETE', `/incidents/${incident.id}`, shopB.id)).status, 404);
  assert.equal((await request('GET', '/expiry', seed.a.shop.id)).body.products.length, 1);
});
test('company supplier endpoints cannot mutate or transfer into customer shops', async () => {
  const adminToken = (await app.login(seed.admin.email, seed.password)).token;
  for (const [method, url, body] of [['PUT', `/editShop/${shopB.id}`, { name: 'Wrong', address: '', mobile: '' }], ['DELETE', `/shops/${shopB.id}`], ['GET', `/getshop/${shopB.id}`], ['POST', '/shop/transfer-products', { sourceShopId: seed.wholesale.id, targetShopId: shopB.id, productIds: [seed.product.id] }]]) {
    assert.equal((await app.request(method, url, { token: adminToken, body })).status, 404, url);
  }
  assert.equal((await db.shop.findUnique({ where: { id: shopB.id } })).name, shopB.name);
});
test('list backfill preserves data, reports ambiguity, and supports repeatable apply and recovery', async () => {
  const legacy = await db.list.create({ data: { name: 'Original Bravo list', description: 'Preserve me', customerId: seed.b.owner.id } });
  const ambiguous = await db.list.create({ data: { name: 'Unknown origin', description: '', customerId: seed.a.owner.id } });
  const plan = buildListScopePlan(await collectListScopeFacts(db));
  assert.equal(plan.changes.find((c) => c.listId === legacy.id).shopId, seed.b.shop.id);
  assert.ok(plan.reviews.some((r) => r.listId === ambiguous.id));
  const run = await applyListScopePlan(db, plan);
  const migrated = await db.list.findUnique({ where: { id: legacy.id } });
  assert.deepEqual({ ...migrated, shopId: null }, legacy);
  assert.equal(buildListScopePlan(await collectListScopeFacts(db)).changes.length, 0);
  await assert.rejects(applyListScopePlan(db, plan), /changed since dry run/);
  await recoverListScopeRun(db, run.id);
  assert.deepEqual(await db.list.findUnique({ where: { id: legacy.id } }), legacy);
});

test('company supermarket directory is separate, searchable, permission-controlled and auditable', async () => {
  const adminToken = (await app.login(seed.admin.email, seed.password)).token;
  assert.equal((await request('GET', '/admin/supermarkets')).status, 403);
  assert.equal((await request('GET', '/admin/supermarkets', undefined, undefined, { token: employeeToken })).status, 403);
  const result = await app.request('GET', '/admin/supermarkets?search=City&sort=name&direction=asc', { token: adminToken });
  assert.equal(result.status, 200, JSON.stringify(result));
  assert.deepEqual(result.body.supermarkets.map((s) => s.id), [shopB.id]);
  assert.equal(result.body.supermarkets[0].owners[0].id, seed.a.owner.id);
  const details = await app.request('GET', `/admin/supermarkets/${shopB.id}`, { token: adminToken });
  assert.equal(details.status, 200); assert.equal(details.body.employeeCount, 1);
  assert.equal(details.body.statistics.lists, 1);
  assert.equal((await app.request('GET', `/admin/supermarkets/${seed.wholesale.id}`, { token: adminToken })).status, 404);
  assert.equal(await db.supermarketAdminAccessLog.count({ where: { actorId: seed.admin.id, action: 'DETAIL_VIEW', supermarketId: shopB.id } }), 1);
  const customerView = await app.request('GET', `/admin/customers/${seed.a.owner.id}/employees?shopId=${shopB.id}`, { token: adminToken });
  assert.equal(customerView.status, 200);
});

test('waste, age records, payouts, shifts, certificates and private photos remain shop-scoped', async () => {
  const shopId = seed.a.shop.id;
  const actor = { createdById: seed.a.owner.id, createdByType: 'CUSTOMER' };
  await db.wasteRecord.create({ data: { shopId, ...actor, itemName: 'Alpha waste', quantityWasted: 1, originalPrice: 2, finalPrice: 0, totalLoss: 2, disposedBy: 'Owner', disposedAt: new Date() } });
  await db.ageRestrictedRecord.create({ data: { shopId, ...actor, requestedAt: new Date(), childGender: 'MALE', productCategory: 'Restricted', productName: 'Test', recordedBy: 'Owner' } });
  await db.ageRestrictionRecord.create({ data: { shopId, ...actor, occurredAt: new Date(), description: 'Alpha age record' } });
  await db.supplierPayoutRecord.create({ data: { shopId, ...actor, supplier: 'Supplier', amount: 20, recordedBy: 'Owner' } });
  await db.shiftSheetRecord.create({ data: { shopId, ...actor, shiftDate: new Date(), cashTotal: 10, cardTotal: 15, totalSales: 25, recordedBy: 'Owner' } });
  await db.shopCertificate.create({ data: { shopId, ...actor, type: 'HYGIENE', imagePath: '/tmp/paymi-test-certificate.jpg' } });
  for (const url of ['/waste', '/age-restricted-records', '/age-restriction-records', '/supplier-payouts', '/shift-sheet', '/certificates']) {
    const a = await request('GET', url, shopId), b = await request('GET', url, shopB.id);
    assert.equal(a.status, 200, url + JSON.stringify(a)); assert.equal(b.status, 200, url + JSON.stringify(b));
    const rows = (result) => result.body.records ?? result.body.certificates;
    assert.equal(rows(a).length, 1, url); assert.deepEqual(rows(b), [], url);
  }
  const filename = `private-test-${Date.now()}.jpg`;
  const file = path.resolve('uploads/incidents', filename); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, 'test photo');
  try {
    await db.incidentLog.create({ data: { shopId, ...actor, incidentAt: new Date(), description: 'Private photo', imageUrl: `/uploads/incidents/${filename}` } });
    assert.equal((await request('GET', `/uploads/incidents/${filename}`, shopId)).status, 200);
    assert.equal((await request('GET', `/uploads/incidents/${filename}`, shopB.id)).status, 404);
    assert.equal((await app.request('GET', `/uploads/incidents/${filename}`)).status, 401);
  } finally { fs.rmSync(file, { force: true }); }
});
