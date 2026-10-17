import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { getPrisma, resetDatabase, seedBase, startApp } from './helpers/harness.js';
import redisService from '../src/services/redisService.js';

let db, app, seed;
before(async () => { await resetDatabase(); db = await getPrisma(); seed = await seedBase(db); app = await startApp(); });
after(async () => { await app?.close(); await db?.$disconnect(); });

test('logout durably revokes only that session and disconnects its socket; retries succeed', async () => {
  const login = await app.login(seed.a.owner.email, seed.password);
  const socket = await app.connectSocket(login.token);
  const disconnected = new Promise(resolve => socket.once('disconnect', resolve));
  assert.equal((await app.request('POST', '/auth/logout', { token: login.token })).status, 200);
  await disconnected;
  assert.equal((await app.request('GET', '/auth/me', { token: login.token })).status, 401);
  assert.equal((await app.request('GET', '/lists', { token: login.token })).status, 401);
  assert.equal((await app.request('POST', '/auth/logout', { token: login.token })).status, 200);
  assert.equal(await db.revokedSession.count(), 1);
  const rows = await db.revokedSession.findMany();
  assert.equal(rows[0].tokenHash.length, 64);
  assert.notEqual(rows[0].tokenHash, login.token);
});

test('password recovery invalidates customer and admin tokens and prevents OTP reuse', async () => {
  for (const account of [seed.a.owner, seed.admin]) {
    const login = await app.login(account.email, seed.password);
    const otp = '718293';
    const hash = crypto.createHmac('sha256', process.env.JWT_SECRET).update(`${account.email}:${otp}`).digest('hex');
    await redisService.set(`otp:reset:${account.email}`, { hash, attempts: 0, expiresAt: Date.now() + 600000 }, 600);
    const body = { email: account.email, otp, newPassword: 'Updated-secret123!' };
    assert.equal((await app.request('POST', '/auth/reset-password', { body })).status, 200);
    assert.equal((await app.request('GET', '/auth/me', { token: login.token })).status, 401);
    assert.equal((await app.request('POST', '/auth/reset-password', { body })).status, 400);
    const fresh = await app.login(account.email, body.newPassword);
    assert.equal(fresh.status, 200);
    assert.equal((await app.request('GET', '/auth/me', { token: fresh.token })).status, 200);
  }
});

test('legacy version-zero tokens remain valid until revocation, and bearer wins over cookie', async () => {
  const token = jwt.sign({ id: seed.b.owner.id, userType: 'CUSTOMER' }, process.env.JWT_SECRET, { expiresIn: '1h' });
  const response = await app.request('GET', '/auth/me', { token, headers: { Cookie: 'auth_token=stale-token' } });
  assert.equal(response.status, 200);
  assert.equal(response.body.user.id, seed.b.owner.id);
});

test('an expired legacy trial does not limit the free release or spend saved points', async () => {
  await db.customer.update({ where: { id: seed.b.owner.id }, data: { subscriptionStatus: 'expired', trialEndDate: new Date('2020-01-01'), points: 40 } });
  const login = await app.login(seed.b.owner.email, seed.password);
  const me = await app.request('GET', '/auth/me', { token: login.token });
  assert.deepEqual(me.body.user.subscriptionInfo, { status: 'free', isActive: true, isExpired: false });
  assert.equal((await app.request('GET', '/lists', { token: login.token })).status, 200);
  assert.equal((await app.request('POST', '/auth/extend-trial', { token: login.token })).status, 409);
  assert.equal(Number((await db.customer.findUnique({ where: { id: seed.b.owner.id } })).points), 40);
});
