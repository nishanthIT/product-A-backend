import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { getPrisma, resetDatabase, seedBase, startApp } from './helpers/harness.js';

// Exercise the real controllers used by the shared list screen, including the
// virtual ID passed by search/scanner and original row IDs used by collect mode.
let db, app, seed, owner, other, editor, employee, supplier2, productSequence = 0;
const call = (method, path, body, token = owner) => app.request(method, path, { token, body });
const ok = (result, status = 200) => assert.equal(result.status, status, JSON.stringify(result.body));
const virtual = (row, extra = {}) => ({ listId: 'out-of-stock', listProductId: row.id, ...extra });
const getRow = id => db.listProduct.findUniqueOrThrow({ where: { id } });

before(async () => {
  await resetDatabase(); db = await getPrisma(); seed = await seedBase(db); app = await startApp();
  owner = (await app.login(seed.a.owner.email, seed.password)).token;
  other = (await app.login(seed.b.owner.email, seed.password)).token;
  supplier2 = await db.shop.create({ data: { name: seed.wholesale.name, address: 'Second depot', mobile: 'test', shopType: 'WHOLESALE' } });
  const added = await call('POST', '/employees', {
    name: 'OOS Editor', email: 'oos-editor@shop.test', password: seed.password,
    permissions: ['feature.lists.write', 'feature.lists.edit'],
  });
  ok(added, 201); employee = added.body.employee;
  editor = (await app.login(employee.email, seed.password)).token;
});
after(async () => { await app?.close(); await db?.$disconnect(); });

async function fixture({ token = owner, quantity = 4 } = {}) {
  const product = await db.product.create({ data: { title: `OOS workflow ${++productSequence}`, barcode: `500000009${String(productSequence).padStart(4, '0')}` } });
  const atFirst = await db.productAtShop.create({ data: { productId: product.id, shopId: seed.wholesale.id, price: 1 } });
  const atSecond = await db.productAtShop.create({ data: { productId: product.id, shopId: supplier2.id, price: 2 } });
  const list = await call('POST', '/lists', { name: `Restock workflow ${productSequence}` }, token); ok(list, 201);
  const added = await call('POST', '/lists/addProduct', { listId: list.body.id, productId: product.id, quantity }, token); ok(added);
  const row = await getRow(added.body.data.listProductId);
  return { product, atFirst, atSecond, listId: list.body.id, row };
}

async function mark(f, token = owner) {
  const moved = await call('PUT', '/lists/markOutOfStock', { listId: f.listId, listProductId: f.row.id }, token);
  ok(moved); return moved.body.targetListId;
}

test('normal list → Out of Stock → edit/collect/uncollect/change supplier → original list uses ordinary endpoints', async () => {
  const f = await fixture(); const physicalId = await mark(f);
  const read = await call('GET', '/lists/out-of-stock'); ok(read);
  assert.equal(read.body.id, 'out-of-stock'); assert.equal(read.body.isOutOfStockCollection, true);
  const item = read.body.products.find(row => row.id === f.row.id);
  assert.equal(item.listId, physicalId); assert.equal(item.outOfStockSourceListId, f.listId);
  assert.equal(item.shopId, seed.wholesale.id);

  ok(await call('PUT', '/lists/updateQuantity', virtual(f.row, { quantity: 7 })));
  ok(await call('PUT', '/lists/toggleUrgent', virtual(f.row)));
  ok(await call('PUT', '/lists/togglePurchased', virtual(f.row)));
  assert.deepEqual([(await getRow(f.row.id)).quantity, (await getRow(f.row.id)).isUrgent, (await getRow(f.row.id)).isPurchased], [7, true, true]);
  ok(await call('PUT', '/lists/togglePurchased', virtual(f.row)));
  assert.equal((await getRow(f.row.id)).isPurchased, false);
  ok(await call('PUT', '/lists/changeShop', virtual(f.row, { productAtShopId: f.atSecond.id })));
  const regrouped = await call('GET', '/lists/out-of-stock'); ok(regrouped);
  const changed = regrouped.body.products.find(row => row.id === f.row.id);
  assert.equal(changed.shopId, supplier2.id); assert.equal(changed.outOfStockSourceListId, f.listId);
  ok(await call('PUT', '/lists/moveToList', virtual(f.row, { targetListId: changed.outOfStockSourceListId })));
  const returned = await getRow(f.row.id);
  assert.equal(returned.listId, f.listId); assert.equal(returned.outOfStockSourceListId, null);
  assert.equal(returned.productAtShopId, f.atSecond.id); assert.equal(returned.quantity, 7); assert.equal(returned.isUrgent, true);
  const detail = await call('GET', `/lists/${f.listId}`); ok(detail);
  assert.equal(detail.body.products.find(row => row.id === f.row.id).quantity, 7);
  assert.equal((await call('GET', '/lists/out-of-stock')).body.products.some(row => row.id === f.row.id), false);
});

test('search/scanner additions to the virtual list never increment a moved item or its original list', async () => {
  const f = await fixture(); const physicalId = await mark(f);
  const originalAgain = await call('POST', '/lists/addProduct', { listId: f.listId, productId: f.product.id, quantity: 6 }); ok(originalAgain);
  const added = await call('POST', '/lists/addProduct', { listId: 'out-of-stock', productId: f.product.id, quantity: 2, isUrgent: true, inHandStock: 3 }); ok(added);
  const addedAgain = await call('POST', '/lists/addProduct', { listId: 'out-of-stock', productId: f.product.id, quantity: 3 }); ok(addedAgain);
  assert.equal(addedAgain.body.data.listProductId, added.body.data.listProductId);
  assert.notEqual(added.body.data.listProductId, f.row.id);
  const direct = await getRow(added.body.data.listProductId);
  assert.equal(direct.listId, physicalId); assert.equal(direct.quantity, 5); assert.equal(direct.outOfStockSourceListId, null);
  assert.equal((await getRow(f.row.id)).quantity, 4);
  assert.equal((await getRow(originalAgain.body.data.listProductId)).quantity, 6);
  const collection = await call('GET', '/lists/out-of-stock'); ok(collection);
  assert.equal(collection.body.products.find(row => row.id === direct.id).inHandStock, 3);
  const returned = await call('PUT', '/lists/moveToList', virtual(f.row, { targetListId: f.listId })); ok(returned);
  assert.equal(returned.body.merged, true, 'an explicit return follows the normal list quantity merge');
  assert.equal((await getRow(originalAgain.body.data.listProductId)).quantity, 10);
  assert.equal((await getRow(originalAgain.body.data.listProductId)).outOfStockSourceListId, null);
  assert.equal((await getRow(direct.id)).quantity, 5, 'returning an originated item leaves direct additions alone');
});

test('supplier changes and exact removal preserve identical products from different original lists', async () => {
  const f = await fixture(); const physicalId = await mark(f);
  const source2 = await call('POST', '/lists', { name: 'Different original list' }); ok(source2, 201);
  const sameProduct = await call('POST', '/lists/addProduct', { listId: source2.body.id, productId: f.product.id, quantity: 9 }); ok(sameProduct);
  const row2 = await getRow(sameProduct.body.data.listProductId);
  ok(await call('PUT', '/lists/markOutOfStock', { listId: source2.body.id, listProductId: row2.id }));
  ok(await call('PUT', '/lists/changeShop', virtual(f.row, { productAtShopId: f.atSecond.id })));
  ok(await call('PUT', '/lists/changeShop', virtual(row2, { productAtShopId: f.atSecond.id })));
  const distinct = await db.listProduct.findMany({ where: { listId: physicalId, productAtShopId: f.atSecond.id } });
  assert.equal(distinct.length, 2); assert.deepEqual(new Set(distinct.map(row => row.outOfStockSourceListId)), new Set([f.listId, source2.body.id]));
  ok(await call('DELETE', '/lists/removeProduct', virtual(f.row, { productId: f.product.id })));
  assert.equal(await db.listProduct.findUnique({ where: { id: f.row.id } }), null);
  assert.equal((await getRow(row2.id)).quantity, 9);
  ok(await call('PUT', '/lists/moveToList', virtual(row2, { targetListId: source2.body.id })));
  assert.equal((await getRow(row2.id)).listId, source2.body.id);
});

test('legacy items have no invented origin and can still move to a selected ordinary list', async () => {
  const f = await fixture();
  const legacy = await db.list.create({ data: { name: 'Out of Stock · Legacy depot', description: '', customerId: seed.a.owner.id, shopId: seed.a.shop.id } });
  const old = await db.listProduct.create({ data: { listId: legacy.id, productAtShopId: f.atSecond.id, quantity: 8 } });
  const read = await call('GET', '/lists/out-of-stock'); ok(read);
  assert.equal(read.body.products.find(row => row.id === old.id).outOfStockSourceListId, null);
  ok(await call('PUT', '/lists/moveToList', virtual(old, { targetListId: f.listId })));
  assert.equal((await getRow(old.id)).listId, f.listId);
  assert.equal((await getRow(old.id)).quantity, 8);
  assert.equal(await db.list.count({ where: { id: legacy.id } }), 1);
});

test('alternate moves to real Out of Stock list IDs preserve original rows, origins and authorization', async () => {
  const f = await fixture();
  const legacy = await db.list.create({ data: { name: 'Out of Stock · Alternate target', description: '', customerId: seed.a.owner.id, shopId: seed.a.shop.id } });
  const old = await db.listProduct.create({ data: { listId: legacy.id, productAtShopId: f.atFirst.id, quantity: 9 } });
  const before = await db.listProduct.count();
  ok(await call('PUT', '/lists/moveToList', { listId: f.listId, listProductId: f.row.id, targetListId: legacy.id }, other), 404);
  const moved = await call('PUT', '/lists/moveToList', { listId: f.listId, listProductId: f.row.id, targetListId: legacy.id }); ok(moved);
  assert.equal(moved.body.merged, false);
  assert.equal((await getRow(f.row.id)).listId, legacy.id);
  assert.equal((await getRow(f.row.id)).outOfStockSourceListId, f.listId);
  assert.equal((await getRow(old.id)).quantity, 9); assert.equal((await getRow(old.id)).outOfStockSourceListId, null);
  assert.equal(await db.listProduct.count(), before);
  const canonical = await call('POST', '/lists/addProduct', { listId: 'out-of-stock', productId: f.product.id }); ok(canonical);
  const canonicalId = (await getRow(canonical.body.data.listProductId)).listId;
  ok(await call('PUT', '/lists/moveToList', virtual(f.row, { targetListId: canonicalId })));
  assert.equal((await getRow(f.row.id)).outOfStockSourceListId, f.listId, 'moving between backing lists keeps the original ordinary list');
  ok(await call('PUT', '/lists/moveToList', virtual(old, { targetListId: canonicalId })));
  assert.equal((await getRow(old.id)).outOfStockSourceListId, null, 'a legacy backing list is never invented as an origin');
  ok(await call('PUT', '/lists/moveToList', virtual(f.row, { targetListId: f.listId })));
  assert.equal((await getRow(f.row.id)).listId, f.listId); assert.equal((await getRow(f.row.id)).quantity, 4);
});

test('concurrent supplier changes merge the same origin atomically without losing quantities', async () => {
  const f = await fixture();
  const extra = await Promise.all([5, 6].map(quantity => db.listProduct.create({ data: { listId: f.listId, productAtShopId: f.atFirst.id, quantity } })));
  const rows = [f.row, ...extra];
  const marked = await Promise.all(rows.map(row => call('PUT', '/lists/markOutOfStock', { listId: f.listId, listProductId: row.id })));
  marked.forEach(result => ok(result));
  const moved = await Promise.all(rows.map(row => call('PUT', '/lists/changeShop', virtual(row, { productAtShopId: f.atSecond.id }))));
  moved.forEach(result => ok(result));
  const remaining = await db.listProduct.findMany({ where: { listId: marked[0].body.targetListId, productAtShopId: f.atSecond.id, outOfStockSourceListId: f.listId } });
  assert.equal(remaining.length, 1); assert.equal(remaining[0].quantity, 15);
  assert.equal(await db.listProduct.count({ where: { productAtShopId: f.atFirst.id } }), 0);
  ok(await call('PUT', '/lists/moveToList', virtual(remaining[0], { targetListId: f.listId })));
  assert.equal((await getRow(remaining[0].id)).quantity, 15);
});

test('overflow rejects supplier and original-list merges without modifying either item', async () => {
  const f = await fixture(); const physicalId = await mark(f);
  const target = await db.listProduct.create({ data: { listId: physicalId, productAtShopId: f.atSecond.id, outOfStockSourceListId: f.listId, quantity: 2147483647 } });
  const beforeSource = await getRow(f.row.id);
  ok(await call('PUT', '/lists/changeShop', virtual(f.row, { productAtShopId: f.atSecond.id })), 400);
  assert.deepEqual(await getRow(f.row.id), beforeSource); assert.deepEqual(await getRow(target.id), target);
  const original = await db.listProduct.create({ data: { listId: f.listId, productAtShopId: f.atFirst.id, quantity: 2147483647 } });
  ok(await call('PUT', '/lists/moveToList', virtual(f.row, { targetListId: f.listId })), 400);
  assert.deepEqual(await getRow(f.row.id), beforeSource); assert.deepEqual(await getRow(original.id), original);
});

test('virtual writes require the exact authorized row and preserve employee read/write/edit boundaries', async () => {
  const privateFixture = await fixture(); await mark(privateFixture);
  const own = await fixture({ token: editor }); await mark(own, editor);
  ok(await call('PUT', '/lists/updateQuantity', virtual(own.row, { quantity: 6 }), editor));
  ok(await call('PUT', '/lists/updateQuantity', virtual(privateFixture.row, { quantity: 99 }), editor), 404);
  ok(await call('PUT', '/lists/updateQuantity', virtual(own.row, { quantity: 99 }), other), 404);
  ok(await call('PUT', '/lists/moveToList', virtual(own.row, { targetListId: privateFixture.listId }), editor), 404);
  const count = await db.listProduct.count();
  ok(await call('DELETE', '/lists/removeProduct', { listId: 'out-of-stock', productId: own.product.id }, editor), 400);
  assert.equal(await db.listProduct.count(), count, 'ambiguous virtual removals never delete several matching products');
  ok(await call('PUT', `/employees/${employee.id}`, { permissions: ['feature.lists'] }));
  ok(await call('GET', '/lists/out-of-stock', undefined, editor));
  ok(await call('POST', '/lists/addProduct', { listId: 'out-of-stock', productId: own.product.id }, editor), 403);
  ok(await call('PUT', '/lists/togglePurchased', virtual(own.row), editor), 403);
  assert.equal((await getRow(own.row.id)).quantity, 6);
  ok(await call('PUT', `/employees/${employee.id}`, { permissions: ['feature.lists.write', 'feature.lists.edit'] }));
});

test('tracked source lists can be edited and untracked without deleting the owner’s saved items', async () => {
  const f = await fixture();
  const legacy = await db.list.create({ data: { name: 'Out of Stock · Shared depot', description: '', customerId: seed.a.owner.id, shopId: seed.a.shop.id } });
  const row = await db.listProduct.create({ data: { listId: legacy.id, productAtShopId: f.atFirst.id, quantity: 5 } });
  await db.trackedList.create({ data: { listId: legacy.id, userId: employee.id, userType: 'EMPLOYEE' } });
  assert.ok((await call('GET', '/lists/out-of-stock', undefined, editor)).body.products.some(item => item.id === row.id));
  ok(await call('PUT', '/lists/updateQuantity', virtual(row, { quantity: 7 }), editor));
  ok(await call('DELETE', `/lists/${legacy.id}`, undefined, editor), 403);
  ok(await call('DELETE', `/lists/${legacy.id}/untrack`, undefined, editor));
  assert.equal((await getRow(row.id)).quantity, 7);
  assert.ok(!(await call('GET', '/lists/out-of-stock', undefined, editor)).body.products.some(item => item.id === row.id));
  ok(await call('PUT', '/lists/togglePurchased', virtual(row), editor), 404);
  assert.ok((await call('GET', '/lists/out-of-stock')).body.products.some(item => item.id === row.id));
});

test('owner deletes a real Out of Stock list normally and a later add creates a valid new destination', async () => {
  const added = await call('POST', '/lists/addProduct', { listId: 'out-of-stock', productId: seed.product.id }, other); ok(added);
  const row = await getRow(added.body.data.listProductId); const originalListId = row.listId;
  const before = await db.listProduct.count();
  ok(await call('DELETE', '/lists/out-of-stock', undefined, other), 404);
  assert.equal(await db.listProduct.count(), before, 'no blanket deletion through a display-only ID');
  ok(await call('DELETE', `/lists/${originalListId}`, undefined, owner), 404);
  ok(await call('DELETE', `/lists/${originalListId}`, undefined, other));
  assert.equal(await db.list.findUnique({ where: { id: originalListId } }), null);
  assert.equal(await db.listProduct.findUnique({ where: { id: row.id } }), null);
  assert.deepEqual((await call('GET', '/lists/out-of-stock', undefined, other)).body.products, []);
  const next = await call('POST', '/lists/addProduct', { listId: 'out-of-stock', productId: seed.product.id, quantity: 2 }, other); ok(next);
  const recreated = await getRow(next.body.data.listProductId);
  assert.notEqual(recreated.listId, originalListId); assert.equal(recreated.quantity, 2);
  assert.equal((await db.list.findUniqueOrThrow({ where: { id: recreated.listId } })).name, 'Out of Stock');
});
