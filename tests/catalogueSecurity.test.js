import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { getPrisma, resetDatabase, seedBase, startApp, createCompanyStaff } from './helpers/harness.js';
let db, app, seed, ownerToken, adminToken;
before(async () => {
  await resetDatabase(); db = await getPrisma(); seed = await seedBase(db); app = await startApp();
  ownerToken = (await app.login(seed.a.owner.email, seed.password)).token;
  adminToken = (await app.login(seed.admin.email, seed.password)).token;
  assert.ok(ownerToken); assert.ok(adminToken);
  await db.product.update({ where: { id: seed.product.id }, data: { productUrl: 'https://private-source.invalid/internal-import' } });
  await db.productAtShop.updateMany({ where: { productId: seed.product.id }, data: { sourcePricing: { internalSupplierCredential: 'do-not-expose' } } });
  await db.productAtShop.create({ data: { productId: seed.product.id, shopId: seed.b.shop.id, price: 0.01 } });
});
after(async () => { await app?.close(); await db?.$disconnect(); });

test('every catalogue lookup variant and administrative export requires authentication', async () => {
  for (const route of [`/products/${seed.product.id}`, `/products/barcode/${seed.product.barcode}`, '/products/search?q=cola', `/products/${seed.product.id}/compare`, `/products/${seed.product.id}/pack-options`, `/products/${seed.product.id}/price-tiers`, '/categories', `/shop/${seed.wholesale.id}/product-ids`]) {
    assert.equal((await app.request('GET', route)).status, 401, route);
  }
});
test('pack comparison and cheapest-price tiers exclude other customers retail prices', async () => {
  const tiers = await app.request('GET', `/products/${seed.product.id}/price-tiers`, { token: ownerToken });
  assert.equal(tiers.status, 200); assert.equal(tiers.body.basePrice, 1.25); assert.equal(tiers.body.shopName, seed.wholesale.name);
  const options = await app.request('GET', `/products/${seed.product.id}/pack-options`, { token: ownerToken });
  assert.equal(options.status, 200); assert.equal(options.body.options[0].price, 1.25); assert.equal(options.body.options[0].availableInShops, 1);
});
test('catalogue responses omit import provenance while preserving product and supplier prices', async () => {
  for (const route of [`/products/${seed.product.id}`, `/products/barcode/${seed.product.barcode}`, `/products/${seed.product.id}/compare`]) {
    const response = await app.request('GET', route, { token: ownerToken });
    assert.equal(response.status, 200);
    const text = JSON.stringify(response.body);
    assert.ok(text.includes(seed.product.id)); assert.ok(text.includes('1.25'));
    assert.ok(!text.includes('private-source')); assert.ok(!text.includes('internalSupplierCredential')); assert.ok(!text.includes('do-not-expose'));
  }
});
test('tenant identifiers and company privileges are verified on the server', async () => {
  assert.equal((await app.request('GET', `/products/${seed.product.id}/compare`, { token: ownerToken, shopId: seed.b.shop.id })).status, 403);
  assert.equal((await app.request('GET', `/shop/${seed.wholesale.id}/product-ids`, { token: ownerToken })).status, 403);
  assert.equal((await app.request('GET', `/shop/${seed.b.shop.id}/products`, { token: adminToken })).status, 404);
  const staff = await createCompanyStaff(db, { email: 'noncatalogue@company.test', passwordHash: seed.passwordHash, permissions: ['customers.view'] });
  const token = (await app.login(staff.email, seed.password)).token;
  assert.equal((await app.request('GET', `/products/${seed.product.id}`, { token })).status, 403);
});
test('pagination and batch limits reject excessive work before executing business queries', async () => {
  for (const route of ['/filterProducts?page=1001', '/filterProducts?page=NaN', '/products/search?q=cola&limit=999999']) {
    assert.equal((await app.request('GET', route, { token: adminToken })).status, 400);
  }
  const transfer = await app.request('POST', '/shop/transfer-products', { token: adminToken, body: { sourceShopId: seed.wholesale.id, destinationShopId: seed.wholesale.id, productIds: Array(501).fill(seed.product.id) } });
  assert.equal(transfer.status, 400);
  const conflict = await app.request('GET', `/shop/${seed.wholesale.id}/searchProducts?query=cola&shopId=${seed.b.shop.id}`, { token: adminToken });
  assert.equal(conflict.status, 400);
});
test('bulk ID selection uses bounded stable cursor pages without losing legitimate results', async () => {
  const products = Array.from({ length: 501 }, (_, n) => ({ id: `security-fixture-${String(n).padStart(4,'0')}`, title: `Security fixture ${n}` }));
  await db.product.createMany({ data: products });
  await db.productAtShop.createMany({ data: products.map(p => ({ productId: p.id, shopId: seed.wholesale.id, price: 1 })) });
  const first = await app.request('GET', `/shop/${seed.wholesale.id}/product-ids`, { token: adminToken });
  assert.equal(first.status, 200); assert.equal(first.body.productIds.length, 500); assert.equal(first.body.total, 502); assert.ok(first.body.nextCursor);
  const second = await app.request('GET', `/shop/${seed.wholesale.id}/product-ids?cursor=${first.body.nextCursor}`, { token: adminToken });
  assert.equal(second.status, 200); assert.equal(second.body.productIds.length, 2); assert.equal(second.body.nextCursor, null);
  assert.equal(new Set([...first.body.productIds, ...second.body.productIds]).size, 502);
});
test('SQL metacharacters remain ordinary search data and do not expose other records', async () => {
  const response = await app.request('GET', '/products/search?q=%27%3B%20DROP%20TABLE%20%22Product%22%3B--', { token: ownerToken });
  assert.equal(response.status, 200); assert.ok(Array.isArray(response.body.data));
  assert.ok(await db.product.findUnique({ where: { id: seed.product.id } }));
});

test('public marketing endpoints do not disclose unpublished records through all flags or direct IDs', async () => {
  const news = await db.news.create({ data: { title: 'Internal draft', description: 'Unpublished', sourceUrl: 'https://example.test', isActive: false } });
  const ad = await db.advertisement.create({ data: { title: 'Internal draft advert', imageUrl: '/uploads/advertisements/example.png', isActive: false } });
  for (const route of ['/news?all=true', '/advertisements?all=true']) {
    assert.equal((await app.request('GET', route)).status, 401);
    assert.equal((await app.request('GET', route, { token: ownerToken })).status, 403);
    assert.equal((await app.request('GET', route, { token: adminToken })).status, 200);
  }
  assert.equal((await app.request('GET', `/news/${news.id}`)).status, 404);
  assert.equal((await app.request('GET', `/news/${news.id}`, { token: adminToken })).status, 200);
  assert.ok(!(await app.request('GET', '/news')).body.news.some(item => item.id === news.id));
  assert.ok(!(await app.request('GET', '/advertisements')).body.advertisements.some(item => item.id === ad.id));
});
