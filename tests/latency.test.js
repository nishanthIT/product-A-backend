// Shop-employee lifecycle over a slow database link (the shared DB is ~1.6s per round trip
// from a dev machine). Run with TEST_DB_LATENCY_MS set, e.g. 350.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { DB_LATENCY_MS, getPrisma, resetDatabase, seedBase, startApp } from './helpers/harness.js';

let prisma;
let app;
let seed;

before(async () => {
  await resetDatabase();
  prisma = await getPrisma();
  seed = await seedBase(prisma);
  app = await startApp();
});

after(async () => {
  await app?.close();
  await prisma?.$disconnect();
});

test(`create → deactivate → reactivate survives ${DB_LATENCY_MS}ms DB latency`, { skip: DB_LATENCY_MS === 0 && 'set TEST_DB_LATENCY_MS' }, async () => {
  const owner = (await app.login('alpha-owner@shop.test', seed.password)).token;

  const created = await app.request('POST', '/employees', {
    token: owner,
    body: { name: 'Slow Sam', email: 'sam@shop.test', password: 'Secret123' },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.employee.status, 'ACTIVE');
  const id = created.body.employee.id;

  const off = await app.request('PATCH', `/employees/${id}/status`, { token: owner, body: { status: 'INACTIVE' } });
  assert.equal(off.status, 200, JSON.stringify(off.body));
  const on = await app.request('PATCH', `/employees/${id}/status`, { token: owner, body: { status: 'ACTIVE' } });
  assert.equal(on.status, 200, JSON.stringify(on.body));

  const list = await app.request('GET', '/employees', { token: owner });
  assert.equal(list.body.employees.find((e) => e.id === id).status, 'ACTIVE');
  const login = await app.login('sam@shop.test', 'Secret123');
  assert.equal(login.status, 200);
  assert.equal(login.body.user.shopAccess.shopId, seed.a.shop.id);
});
