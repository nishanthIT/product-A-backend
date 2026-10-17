import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { getPrisma, resetDatabase, seedBase, startApp } from './helpers/harness.js';

let db, app, seed, owner, other, source, first, second, canonicalId, legacy, legacyRow;
const call = (method, path, body, token = owner) => app.request(method, path, { token, body });
const ok = (res, code = 200) => assert.equal(res.status, code, JSON.stringify(res.body));
before(async () => {
  await resetDatabase(); db = await getPrisma(); seed = await seedBase(db); app = await startApp();
  owner = (await app.login(seed.a.owner.email, seed.password)).token;
  other = (await app.login(seed.b.owner.email, seed.password)).token;
  source = await db.list.create({ data: { name: 'Restock', description: '', customerId: seed.a.owner.id, shopId: seed.a.shop.id } });
  const supplier2 = await db.shop.create({ data: { name: seed.wholesale.name, address: 'Another depot', mobile: 'test', shopType: 'WHOLESALE' } });
  const supply1 = await db.productAtShop.findFirst({ where: { productId: seed.product.id } });
  const supply2 = await db.productAtShop.create({ data: { productId: seed.product.id, shopId: supplier2.id, price: 2 } });
  first = await db.listProduct.create({ data: { listId: source.id, productAtShopId: supply1.id, quantity: 3, isUrgent: true } });
  second = await db.listProduct.create({ data: { listId: source.id, productAtShopId: supply2.id, quantity: 5 } });
  legacy = await db.list.create({ data: { name: 'Out of Stock · Old Supplier', description: 'Existing saved list', customerId: seed.a.owner.id, shopId: seed.a.shop.id } });
  legacyRow = await db.listProduct.create({ data: { listId: legacy.id, productAtShopId: supply1.id, quantity: 9, isPurchased: true } });
  await db.supermarketProductState.create({ data: { shopId: seed.a.shop.id, productId: seed.product.id, inHandStock: 7 } });
});
after(async () => { await app?.close(); await db?.$disconnect(); });

test('concurrent unavailable items from different suppliers use one list and preserve row IDs and quantities', async () => {
  const results = await Promise.all([first, second].map(row => call('PUT', '/lists/markOutOfStock', { listId: source.id, listProductId: row.id })));
  results.forEach(res => ok(res));
  canonicalId = results[0].body.targetListId;
  assert.equal(results[1].body.targetListId, canonicalId);
  assert.equal(await db.list.count({ where: { name: 'Out of Stock', customerId: seed.a.owner.id, shopId: seed.a.shop.id } }), 1);
  for (const before of [first, second]) {
    const after = await db.listProduct.findUnique({ where: { id: before.id } });
    assert.equal(after.listId, canonicalId);
    assert.equal(after.productAtShopId, before.productAtShopId);
    assert.equal(after.quantity, before.quantity);
    assert.equal(after.isUrgent, before.isUrgent);
  }
  assert.equal(await db.listProduct.count(), 3);
});

test('consolidated read includes legacy and new supplier groups without rewriting history', async () => {
  const beforeLists = await db.list.findMany({ orderBy: { id: 'asc' } });
  const beforeItems = await db.listProduct.findMany({ orderBy: { id: 'asc' } });
  const result = await call('GET', '/lists/out-of-stock'); ok(result);
  assert.equal(result.body.name, 'Out of Stock');
  assert.deepEqual(new Set(result.body.products.map(row => row.id)), new Set([first.id, second.id, legacyRow.id]));
  assert.equal(new Set(result.body.products.map(row => row.shopId)).size, 2, 'same-name suppliers stay distinct by ID');
  assert.equal(result.body.products.find(row => row.id === legacyRow.id).listId, legacy.id);
  assert.equal(result.body.products.find(row => row.id === first.id).listId, canonicalId);
  assert.ok(result.body.products.every(row => row.inHandStock === 7));
  const overview = await call('GET', '/lists'); ok(overview);
  assert.equal(overview.body.lists.find(list => list.id === canonicalId).itemCount, 2,
    'supplier rows count separately even for the same logical product');
  assert.equal(overview.body.lists.find(list => list.id === legacy.id).itemCount, 1);
  assert.deepEqual(await db.list.findMany({ orderBy: { id: 'asc' } }), beforeLists);
  assert.deepEqual(await db.listProduct.findMany({ orderBy: { id: 'asc' } }), beforeItems);
  ok(await call('GET', `/lists/${legacy.id}`)); // Existing links still work.
});

test('collection preserves existing account, tracking, shop and read/edit permissions', async () => {
  const foreign = await call('GET', '/lists/out-of-stock', undefined, other); ok(foreign);
  assert.deepEqual(foreign.body.products, []);
  ok(await call('PUT', '/lists/updateQuantity', { listId: canonicalId, listProductId: first.id, quantity: 8 }, other), 404);
  const added = await call('POST', '/employees', { name: 'Reader', email: 'oos-reader@shop.test', password: 'Passw0rd!', permissions: ['feature.lists'] }); ok(added, 201);
  const employee = (await app.login('oos-reader@shop.test', 'Passw0rd!')).token;
  const privateLists = await call('GET', '/lists/out-of-stock', undefined, employee); ok(privateLists);
  assert.deepEqual(privateLists.body.products, [], 'same workspace does not grant private list access');
  await db.trackedList.create({ data: { listId: legacy.id, userId: added.body.employee.id, userType: 'EMPLOYEE' } });
  const tracked = await call('GET', '/lists/out-of-stock', undefined, employee); ok(tracked);
  assert.deepEqual(tracked.body.products.map(row => row.id), [legacyRow.id]);
  ok(await call('PUT', '/lists/updateQuantity', { listId: legacy.id, listProductId: legacyRow.id, quantity: 2 }, employee), 403);
  ok(await call('PUT', `/employees/${added.body.employee.id}`, { permissions: [] }));
  ok(await call('GET', '/lists/out-of-stock', undefined, employee), 403);
});

test('original item IDs support editing, collecting and moving back to an ordinary list', async () => {
  ok(await call('PUT', '/lists/updateQuantity', { listId: canonicalId, listProductId: first.id, quantity: 4 }));
  ok(await call('PUT', '/lists/togglePurchased', { listId: canonicalId, listProductId: first.id }));
  const collected = await call('GET', '/lists/out-of-stock'); ok(collected);
  const row = collected.body.products.find(item => item.id === first.id);
  assert.equal(row.quantity, 4); assert.equal(row.isPurchased, true);
  ok(await call('PUT', '/lists/markOutOfStock', { listId: canonicalId, listProductId: first.id }), 400);
  ok(await call('PUT', '/lists/moveToList', { listId: canonicalId, listProductId: first.id, targetListId: source.id }));
  const after = await call('GET', '/lists/out-of-stock'); ok(after);
  assert.equal(after.body.products.some(item => item.id === first.id), false);
  assert.equal((await db.listProduct.findUnique({ where: { id: first.id } })).listId, source.id);
  assert.equal(await db.listProduct.count(), 3);
});
