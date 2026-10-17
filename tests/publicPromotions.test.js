import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { getPrisma, resetDatabase, seedBase, startApp } from './helpers/harness.js';
let db, app, seed;
before(async () => { await resetDatabase(); db = await getPrisma(); seed = await seedBase(db); app = await startApp(); });
after(async () => { await app?.close(); await db?.$disconnect(); });
test('anonymous promotions expose only current published wholesaler offers and cannot grant workspace access', async () => {
  const common = { imageUrl: '/uploads/promotions/fixture.png', title: 'Synthetic offer', shopId: seed.wholesale.id };
  const visible = await db.promotion.create({ data: common });
  await db.promotion.createMany({ data: [ { ...common, isActive: false }, { ...common, startDate: new Date(Date.now() + 86400000) }, { ...common, endDate: new Date(Date.now() - 86400000) }, { ...common, shopId: seed.a.shop.id } ] });
  const result = await app.request('GET', '/promotions/public'); assert.equal(result.status, 200);
  assert.deepEqual(result.body.promotions.map(p => p.id), [visible.id]);
  assert.deepEqual(Object.keys(result.body.promotions[0].shop).sort(), ['id', 'name']);
  assert.equal((await app.request('GET', '/promotions')).status, 401);
  assert.equal((await app.request('GET', '/lists')).status, 401);
  assert.equal((await app.request('POST', '/promotions', { body: common })).status, 401);
});
