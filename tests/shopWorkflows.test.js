import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { getPrisma, resetDatabase, seedBase, startApp } from './helpers/harness.js';

let db, app, seed, owner, otherOwner, employee, writer, admin, listId;

const request = async (method, path, token, body) => app.request(method, path, { token, body });
const expect = (response, status) => assert.equal(response.status, status, JSON.stringify(response.body));

before(async () => {
  await resetDatabase();
  db = await getPrisma();
  seed = await seedBase(db);
  app = await startApp();
  owner = (await app.login('alpha-owner@shop.test', seed.password)).token;
  otherOwner = (await app.login('bravo-owner@shop.test', seed.password)).token;
  admin = (await app.login('admin@company.test', seed.password)).token;
  const created = await request('POST', '/employees', owner, {
    name: 'List Writer', email: 'list-writer@shop.test', password: 'Secret123',
    permissions: ['feature.lists.write'],
  });
  expect(created, 201);
  employee = created.body.employee;
  writer = (await app.login('list-writer@shop.test', 'Secret123')).token;
  assert.ok(owner && otherOwner && writer && admin);
});

after(async () => {
  await app?.close();
  await db?.$disconnect();
});

test('write-only shop employee creates a list and adds three cases in one request', async () => {
  const me = await request('GET', '/auth/me', writer);
  expect(me, 200);
  assert.deepEqual(me.body.user.shopAccess.permissions, ['feature.lists', 'feature.lists.write']);
  const created = await request('POST', '/lists', writer, { name: 'Employee restock' });
  expect(created, 201);
  listId = created.body.id;
  const added = await request('POST', '/lists/addProduct', writer, {
    listId, productId: seed.product.id, quantity: 3, isUrgent: true, inHandStock: 4,
  });
  expect(added, 200);
  assert.equal(added.body.data.quantity, 3);
  const detail = await request('GET', `/lists/${listId}`, writer);
  expect(detail, 200);
  assert.equal(detail.body.products.length, 1);
  assert.equal(detail.body.products[0].quantity, 3);
  assert.equal(detail.body.products[0].isUrgent, true);
  assert.equal(detail.body.products[0].inHandStock, 4);
  const cannotEdit = await request('PUT', '/lists/updateQuantity', writer, {
    listId, listProductId: added.body.data.listProductId, quantity: 5,
  });
  expect(cannotEdit, 403);
  assert.equal(cannotEdit.body.level, 'edit');
});

test('concurrent additions preserve the sum and do not create duplicate logical products', async () => {
  const responses = await Promise.all([2, 4, 6].map(quantity => request('POST', '/lists/addProduct', writer, {
    listId, productId: seed.product.id, quantity,
  })));
  responses.forEach(response => expect(response, 200));
  const rows = await db.listProduct.findMany({ where: { listId } });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].quantity, 15);
  for (const quantity of [0, -1, 1.5, '3', 2147483648]) {
    expect(await request('POST', '/lists/addProduct', writer, { listId, productId: seed.product.id, quantity }), 400);
  }
  assert.equal((await db.listProduct.findFirst({ where: { listId } })).quantity, 15);
});

test('lists and employees remain current without the retired list-cache dependency', async () => {
  const cache = (await import('../src/services/cacheService.js')).default;
  const methods = ['invalidateUserLists', 'invalidateListDetail', 'invalidateAllUserListCache', 'cacheUserLists'];
  const old = Object.fromEntries(methods.map(key => [key, cache[key]]));
  methods.forEach(key => { cache[key] = async () => { throw new Error('Obsolete list cache unavailable'); }; });
  try {
    const tracked = await request('POST', `/shop/copy-list/${listId}`, owner);
    expect(tracked, 200);
    const lists = await request('GET', '/lists', owner);
    expect(lists, 200);
    const summary = lists.body.lists.find(row => row.id === listId);
    assert.deepEqual([summary.name, summary.itemCount, summary.isShared, summary.copiedFromName],
      ['Employee restock', 1, true, 'List Writer']);
    assert.ok(summary.createdAt && summary.updatedAt);
    assert.equal('products' in summary, false);
    const employees = await request('GET', '/employees', owner);
    expect(employees, 200);
    const listedEmployee = employees.body.employees.find(row => row.id === employee.id);
    assert.equal(listedEmployee.listCount, 1);
    const employeeLists = await request('GET', `/employees/${employee.id}/lists`, owner);
    expect(employeeLists, 200);
    assert.equal(employeeLists.body.lists.find(row => row.id === listId).copiedByMe, true);
    const renamed = await request('PUT', `/lists/${listId}/rename`, owner, { name: 'Shared restock' });
    expect(renamed, 200);
    const refreshed = await request('GET', '/lists', writer);
    assert.equal(refreshed.body.lists.find(row => row.id === listId).name, 'Shared restock');
    const created = await request('POST', '/lists', owner, { name: 'Owner restock' });
    expect(created, 201);
    expect(await request('DELETE', `/lists/${created.body.id}`, owner), 200);
  } finally {
    methods.forEach(key => { cache[key] = old[key]; });
  }
});

test('product search, detail, barcode and list prices load for the employee', async () => {
  const search = await request('GET', '/products/search?q=cola', writer);
  expect(search, 200);
  assert.ok(search.body.data.some(row => row.id === seed.product.id));
  const product = await request('GET', `/products/${seed.product.id}`, writer);
  expect(product, 200);
  assert.equal(product.body.data.id, seed.product.id);
  expect(await request('GET', `/products/barcode/${seed.product.barcode}`, writer), 200);
  const prices = await request('GET', `/lists/${listId}/lowest-prices`, writer);
  expect(prices, 200);
  assert.ok(prices.body.data.some(shop => shop.items.some(item => item.productId === seed.product.id)));
});

test('employee access changes apply immediately and management cannot cross shops', async () => {
  expect(await request('GET', '/employees', writer), 403);
  expect(await request('GET', `/employees/${employee.id}/lists`, otherOwner), 404);
  expect(await request('GET', `/lists/${listId}`, otherOwner), 404);
  expect(await request('POST', `/shop/copy-list/${listId}`, otherOwner), 403);
  expect(await request('PUT', `/employees/${employee.id}`, otherOwner, { name: 'Forbidden' }), 404);
  expect(await request('POST', '/lists/addProduct', otherOwner, { listId, productId: seed.product.id }), 404);
  expect(await request('PUT', `/employees/${employee.id}`, owner, { permissions: ['feature.lists'] }), 200);
  expect(await request('POST', '/lists', writer, { name: 'Forbidden draft' }), 403);
  expect(await request('GET', '/lists', writer), 200);
  expect(await request('PUT', `/employees/${employee.id}`, owner, {
    permissions: ['feature.lists', 'feature.lists.write', 'feature.lists.edit'],
  }), 200);
  expect(await request('PUT', `/lists/${listId}/rename`, writer, { name: 'Editable restock' }), 200);
  const row = await db.listProduct.findFirst({ where: { listId } });
  expect(await request('PUT', '/lists/updateQuantity', writer, { listId, listProductId: row.id, quantity: 8 }), 200);
  expect(await request('PUT', '/lists/updateQuantity', writer, { listId, listProductId: row.id, quantity: 1.5 }), 400);
  expect(await request('PUT', '/lists/togglePurchased', writer, { listId, listProductId: row.id }), 200);
  const detail = await request('GET', `/lists/${listId}`, writer);
  assert.deepEqual([detail.body.products[0].quantity, detail.body.products[0].isPurchased], [8, true]);
  expect(await request('PATCH', `/employees/${employee.id}/status`, owner, { status: 'INACTIVE' }), 200);
  expect(await request('GET', '/lists', writer), 401);
  assert.equal(await db.listProduct.count({ where: { listId } }), 1, 'deactivation preserves saved list items');
  expect(await request('PATCH', `/employees/${employee.id}/status`, owner, { status: 'ACTIVE' }), 200);
  writer = (await app.login('list-writer@shop.test', 'Secret123')).token;
  expect(await request('GET', `/lists/${listId}`, writer), 200);
});

test('summary preserves legacy admin-owned lists and distinguishes typed IDs and shop scopes', async () => {
  const adminList = await db.list.create({ data: {
    name: 'Legacy company list', description: '', creatorType: 'ADMIN', adminId: seed.admin.id, shopId: seed.a.shop.id,
  } });
  const otherList = await request('POST', '/lists', otherOwner, { name: 'Other shop' });
  expect(otherList, 201);
  const adminLists = await request('GET', '/lists', admin);
  expect(adminLists, 200);
  assert.ok(adminLists.body.lists.some(row => row.id === adminList.id));
  assert.ok(!adminLists.body.lists.some(row => row.id === listId || row.id === otherList.body.id));
  const mine = await request('GET', '/lists', writer);
  assert.ok(!mine.body.lists.some(row => row.id === adminList.id || row.id === otherList.body.id));
  const tracked = await request('GET', '/lists', owner);
  assert.equal(tracked.body.lists.filter(row => row.id === listId).length, 1);
});
