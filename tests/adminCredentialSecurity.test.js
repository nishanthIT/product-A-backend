import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';
import { getPrisma, resetDatabase, seedBase, startApp } from './helpers/harness.js';

let db, app, seed, adminToken, ownerToken;
const password = 'Fixture-Changed-Password123';
const assertNoCredentials = value => {
  const serialized = JSON.stringify(value);
  for (const key of ['password', 'resetToken', 'resetTokenExpiry', 'sessionVersion']) assert.ok(!serialized.includes(`"${key}"`), key);
  assert.ok(!serialized.includes(password));
};
before(async () => {
  await resetDatabase(); db = await getPrisma(); seed = await seedBase(db); app = await startApp();
  adminToken = (await app.login(seed.admin.email, seed.password)).token;
  ownerToken = (await app.login(seed.a.owner.email, seed.password)).token;
  assert.ok(adminToken && ownerToken);
});
after(async () => { await app?.close(); await db?.$disconnect(); });

test('admin customer creation hashes passwords and every customer response omits credentials', async () => {
  const created = await app.request('POST', '/addCustomer', { token: adminToken, body: {
    name: 'Credential fixture', email: 'credential-fixture@example.test', mobile: 'fixture-mobile', password,
  } });
  assert.equal(created.status, 200); assertNoCredentials(created.body);
  const saved = await db.customer.findUnique({ where: { id: created.body.id } });
  assert.notEqual(saved.password, password); assert.equal(await bcrypt.compare(password, saved.password), true);
  assert.equal(bcrypt.getRounds(saved.password), 12);
  await db.customer.update({ where: { id: saved.id }, data: { resetToken: 'private-reset-proof', resetTokenExpiry: new Date(Date.now() + 60000) } });
  const viewed = await app.request('GET', `/getCustomer/${saved.id}`, { token: adminToken });
  assert.equal(viewed.status, 200); assertNoCredentials(viewed.body); assert.ok(!JSON.stringify(viewed.body).includes('private-reset-proof'));
  const deleted = await app.request('DELETE', `/deleteCustomer/${saved.id}`, { token: adminToken });
  assert.equal(deleted.status, 200); assertNoCredentials(deleted.body);
});

test('ordinary customers cannot invoke administrative credential operations', async () => {
  for (const [method, route, body] of [
    ['POST', '/addCustomer', { name: 'Attacker', mobile: 'attacker', email: 'attacker@example.test', password }],
    ['PUT', '/updateCustomer', { id: seed.b.owner.id, password }],
    ['GET', `/getCustomer/${seed.b.owner.id}`, undefined],
  ]) assert.equal((await app.request(method, route, { token: ownerToken, body })).status, 403);
});

test('admin customer password changes revoke sessions and clear recovery proofs atomically', async () => {
  await db.customer.update({ where: { id: seed.a.owner.id }, data: { resetToken: 'old-recovery-proof', resetTokenExpiry: new Date(Date.now() + 60000) } });
  const updated = await app.request('PUT', '/updateCustomer', { token: adminToken, body: { id: String(seed.a.owner.id), password } });
  assert.equal(updated.status, 200); assertNoCredentials(updated.body);
  const saved = await db.customer.findUnique({ where: { id: seed.a.owner.id } });
  assert.equal(await bcrypt.compare(password, saved.password), true);
  assert.equal(saved.sessionVersion, 1); assert.equal(saved.resetToken, null); assert.equal(saved.resetTokenExpiry, null);
  assert.equal((await app.request('GET', '/auth/me', { token: ownerToken })).status, 401);
  const login = await app.login(seed.a.owner.email, password); assert.equal(login.status, 200); ownerToken = login.token;
});

test('company staff password updates revoke old sessions and never return hashes', async () => {
  const created = await app.request('POST', '/addEmployee', { token: adminToken, body: {
    name: 'Company fixture', email: 'company-credential@example.test', password: seed.password, phoneNo: 'company-credential-phone',
  } });
  assert.equal(created.status, 201); assertNoCredentials(created.body);
  const id = created.body.employee.id;
  const old = await app.login('company-credential@example.test', seed.password); assert.equal(old.status, 200);
  const updated = await app.request('PUT', `/updateEmployee/${id}`, { token: adminToken, body: { password } });
  assert.equal(updated.status, 200); assertNoCredentials(updated.body);
  assert.equal((await app.request('GET', '/auth/me', { token: old.token })).status, 401);
  assert.equal((await app.login('company-credential@example.test', password)).status, 200);
});

test('shop employee password changes revoke old tokens and bcrypt truncation is rejected', async () => {
  const created = await app.request('POST', '/employees', { token: ownerToken, body: {
    name: 'Shop fixture', email: 'shop-credential@example.test', password: seed.password, phoneNo: 'shop-credential-phone',
  } });
  assert.equal(created.status, 201); assertNoCredentials(created.body);
  const id = created.body.employee.id;
  const old = await app.login('shop-credential@example.test', seed.password); assert.equal(old.status, 200);
  const excessive = await app.request('PUT', `/employees/${id}`, { token: ownerToken, body: { password: '€'.repeat(25) } });
  assert.equal(excessive.status, 400);
  const updated = await app.request('PUT', `/employees/${id}`, { token: ownerToken, body: { password } });
  assert.equal(updated.status, 200); assertNoCredentials(updated.body);
  assert.equal((await app.request('GET', '/auth/me', { token: old.token })).status, 401);
  assert.equal((await app.login('shop-credential@example.test', password)).status, 200);
});
