import { before, after, test, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import nodemailer from 'nodemailer';
import { getPrisma, resetDatabase, seedBase, startApp } from './helpers/harness.js';
import { issueOtp, verifyOtp, reserveOtpDelivery } from '../src/services/otpSecurity.js';
import redisService, { RedisService } from '../src/services/redisService.js';
import { DatabaseCache } from '../src/services/databaseCache.js';
import { PrismaClient } from '@prisma/client';
import { io as ioClient } from 'socket.io-client';

let db, app, seed, ownerToken, otherToken, adminToken;
const deliveries = [];
before(async () => {
  // No real SMTP connection or message leaves this disposable integration run.
  process.env.MAIL_PASS = 'disposable-mail-fixture';
  mock.method(nodemailer, 'createTransport', () => ({ sendMail: async message => { deliveries.push(message); return { accepted: [message.to] }; } }));
  await resetDatabase(); db = await getPrisma(); seed = await seedBase(db); app = await startApp();
  ownerToken = (await app.login(seed.a.owner.email, seed.password)).token;
  otherToken = (await app.login(seed.b.owner.email, seed.password)).token;
  adminToken = (await app.login(seed.admin.email, seed.password)).token;
  assert.ok(ownerToken && otherToken && adminToken);
});
after(async () => { mock.restoreAll(); await app?.close(); await db?.$disconnect(); });

test('registration/recovery responses and resend cooldown do not reveal whether an address exists', async () => {
  const absent = 'unregistered-auth-check@example.test';
  for (const [route, extra] of [['/auth/forgot-password', {}], ['/auth/register/send-otp', { name: 'Fixture owner', password: 'New-Fixture-Password123' }]]) {
    const known = await app.request('POST', route, { body: { email: seed.a.owner.email, ...extra } });
    const unknown = await app.request('POST', route, { body: { email: absent, ...extra } });
    assert.equal(known.status, 200); assert.equal(unknown.status, 200); assert.deepEqual(known.body, unknown.body);
    const retryKnown = await app.request('POST', route, { body: { email: seed.a.owner.email, ...extra } });
    const retryUnknown = await app.request('POST', route, { body: { email: absent, ...extra } });
    assert.equal(retryKnown.status, known.status); assert.deepEqual(retryKnown.body, known.body);
    assert.equal(retryUnknown.status, unknown.status); assert.deepEqual(retryUnknown.body, unknown.body);
  }
  assert.equal(deliveries.filter(message => message.to === seed.a.owner.email).length, 1);
  assert.equal(deliveries.filter(message => message.to === absent).length, 1);
  const wrong = await app.login(seed.a.owner.email, 'wrong-password');
  const missing = await app.login('no-account@example.test', 'wrong-password');
  assert.equal(wrong.status, 401); assert.deepEqual(wrong.body, missing.body);
  assert.equal(JSON.stringify(wrong.body).includes('passwordHash'), false);
  assert.equal(await db.securityEvent.count({ where: { rule: 'AUTH_FAILURE', subjectKey: `CUSTOMER:${seed.a.owner.id}` } }), 1);
});

test('the code sent by registration completes signup, and resend cooldown keeps that code valid', async () => {
  const email = 'mail-registration@example.test';
  const details = { name: 'Mail registration fixture', email, password: 'Mail-Fixture-Password123' };
  const sent = await app.request('POST', '/auth/register/send-otp', { body: details });
  assert.equal(sent.status, 200);
  assert.equal(sent.body.resendIn, 60);
  const messages = deliveries.filter(message => message.to === email);
  assert.equal(messages.length, 1);
  const otp = messages[0].subject.match(/^\d{6}/)?.[0];
  assert.ok(otp, 'email must contain a six-digit verification code');
  assert.ok(messages[0].text.includes(otp));
  assert.equal(await db.customer.count({ where: { email } }), 0);

  const resend = await app.request('POST', '/auth/register/send-otp', { body: details });
  assert.equal(resend.status, 200);
  assert.equal(deliveries.filter(message => message.to === email).length, 1);
  const registered = await app.request('POST', '/auth/register', { body: { ...details, otp } });
  assert.equal(registered.status, 201);
  assert.ok(registered.body.token);
  assert.ok(registered.body.shop.id);
  assert.equal(await db.customer.count({ where: { email } }), 1);
});

test('account restrictions prevent new sessions, authenticated me and socket connections until expiry', async () => {
  const subjectKey = `CUSTOMER:${seed.a.owner.id}`;
  const restriction = await db.securityRestriction.create({ data: {
    subjectKey, scope: 'account', until: new Date(Date.now() + 60000), reason: 'Local restriction fixture', source: 'manual',
  } });
  try {
    const deniedLogin = await app.login(seed.a.owner.email, seed.password);
    assert.equal(deniedLogin.status, 403); assert.equal(deniedLogin.token, undefined);
    assert.equal((await app.request('GET', '/auth/me', { token: ownerToken })).status, 403);
    await assert.rejects(app.connectSocket(ownerToken), /restricted/);
    await db.securityRestriction.update({ where: { id: restriction.id }, data: { until: new Date(Date.now() - 1000) } });
    assert.equal((await app.login(seed.a.owner.email, seed.password)).status, 200);
    assert.equal((await app.request('GET', '/auth/me', { token: ownerToken })).status, 200);
  } finally { await db.securityRestriction.deleteMany({ where: { id: restriction.id } }); }
});

test('cookie-only socket restoration authenticates the correct user; explicit bad tokens cannot fall back', async () => {
  const options = { transports: ['websocket'], reconnection: false, timeout: 3000, extraHeaders: { Cookie: `auth_token=${ownerToken}` } };
  const socket = ioClient(app.origin, { ...options, auth: { token: null } });
  try {
    await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('connect_error', reject); });
    const joined = await new Promise(resolve => socket.emit('join_chat', seed.a.shop.groupChatId, resolve));
    assert.equal(joined.success, true);
    const denied = await new Promise(resolve => socket.emit('join_chat', seed.b.shop.groupChatId, resolve));
    assert.equal(denied.success, false);
  } finally { socket.disconnect(); }
  for (const token of ['not-a-jwt', '', 123]) {
    const invalid = ioClient(app.origin, { ...options, auth: { token } });
    try {
      await assert.rejects(new Promise((resolve, reject) => { invalid.once('connect', resolve); invalid.once('connect_error', reject); }), /Authentication/);
    } finally { invalid.disconnect(); }
  }
});

test('durable OTP attempts and consumption remain atomic across independent application stores with Redis unavailable', async () => {
  const secondDb = new PrismaClient();
  const stores = [redisService, new RedisService({ store: new DatabaseCache(secondDb) })];
  try {
    const email = 'distributed-proof@example.test';
    const code = await issueOtp('reset', email, stores[0]);
    const verified = await Promise.all(Array.from({ length: 20 }, (_, i) => verifyOtp('reset', email, code, { cache: stores[i % 2] })));
    assert.equal(verified.filter(result => result.ok).length, 1);
    const replacement = await issueOtp('reset', email, stores[1]);
    await Promise.all(Array.from({ length: 12 }, (_, i) => verifyOtp('reset', email, 'bad-code', { cache: stores[i % 2] })));
    assert.equal((await verifyOtp('reset', email, replacement, { cache: stores[0] })).ok, false);
    const reservations = await Promise.all(Array.from({ length: 12 }, (_, i) => reserveOtpDelivery('reset', email, stores[i % 2])));
    assert.equal(reservations.filter(value => value === 0).length, 1);
  } finally { await secondDb.$disconnect(); }
});

test('reset-code races change the password once and revoke prior sessions', async () => {
  const email = seed.b.owner.email;
  const otp = await issueOtp('reset', email);
  const body = { email, otp, newPassword: 'Replaced-Fixture-Secret123' };
  const results = await Promise.all(Array.from({ length: 5 }, () => app.request('POST', '/auth/reset-password', { body })));
  assert.equal(results.filter(result => result.status === 200).length, 1);
  assert.ok(results.filter(result => result.status !== 200).every(result => result.status === 400));
  assert.equal((await app.request('GET', '/auth/me', { token: otherToken })).status, 401);
  const login = await app.login(email, body.newPassword); assert.equal(login.status, 200); otherToken = login.token;
  const user = await db.customer.findUnique({ where: { id: seed.b.owner.id } });
  assert.equal(user.sessionVersion, 1);
  assert.equal((await app.request('POST', '/auth/reset-password', { body })).status, 400);
});

test('registration retries remain idempotent while a valid proof cannot create multiple accounts', async () => {
  const email = 'concurrent-registration@example.test';
  const otp = await issueOtp('register', email);
  const body = { email, otp, name: 'Concurrent fixture', password: 'Fixture-Account-Secret123', shopName: 'Concurrent Shop' };
  const results = await Promise.all(Array.from({ length: 4 }, () => app.request('POST', '/auth/register', { body })));
  assert.equal(results.filter(result => result.status === 201).length, 1);
  assert.ok(results.every(result => [200, 201].includes(result.status)), JSON.stringify(results.map(result => ({ status: result.status, error: result.body.error }))));
  assert.equal(await db.customer.count({ where: { email } }), 1);
  assert.equal(await db.shop.count({ where: { name: body.shopName } }), 1);
  const changed = await app.request('POST', '/auth/register', { body: { ...body, shopName: 'Another shop' } });
  assert.equal(changed.status, 400);
  assert.equal(await db.shop.count({ where: { name: 'Another shop' } }), 0);
  const account = await db.customer.findUnique({ where: { email } });
  await db.securityRestriction.create({ data: { subjectKey: `CUSTOMER:${account.id}`, scope: 'account', until: new Date(Date.now() + 60000), reason: 'Registration replay restriction fixture', source: 'manual' } });
  const restrictedRetry = await app.request('POST', '/auth/register', { body });
  assert.equal(restrictedRetry.status, 403); assert.equal(restrictedRetry.body.token, undefined);
});

test('authenticated image routes reject active content and traversal, and private incident images stay tenant scoped', async () => {
  const png = await sharp({ create: { width: 2, height: 2, channels: 4, background: '#ef4030ff' } }).png().toBuffer();
  const multipart = (bytes, filename, fields = {}) => {
    const form = new FormData(); for (const [key, value] of Object.entries(fields)) form.append(key, value);
    form.append('image', new Blob([bytes], { type: 'image/png' }), filename); return form;
  };
  const malicious = await fetch(`${app.origin}/api/incidents`, { method: 'POST', headers: { Authorization: `Bearer ${ownerToken}` }, body: multipart(Buffer.from('<html><script>bad()</script></html>'), 'fake.png') });
  assert.equal(malicious.status, 400); await malicious.arrayBuffer();
  assert.equal(await db.incidentLog.count(), 0);
  const traversing = await fetch(`${app.origin}/api/addProduct`, { method: 'POST', headers: { Authorization: `Bearer ${adminToken}` }, body: multipart(png, '../../fake.png', { title: 'Invalid image path', barcode: '../escape' }) });
  assert.equal(traversing.status, 400); await traversing.arrayBuffer();
  assert.equal(await db.product.count({ where: { barcode: '../escape' } }), 0);
  const created = await fetch(`${app.origin}/api/incidents`, { method: 'POST', headers: { Authorization: `Bearer ${ownerToken}` }, body: multipart(png, '../../filename.html', { description: 'Private fixture', date: '2026-10-27', time: '12:30', severity: 'LOW' }) });
  assert.equal(created.status, 201); const payload = await created.json();
  const relative = new URL(payload.log.imageUrl, app.origin).pathname;
  try {
    const own = await fetch(`${app.origin}${relative}`, { headers: { Authorization: `Bearer ${ownerToken}` } });
    assert.equal(own.status, 200); assert.equal(own.headers.get('x-content-type-options'), 'nosniff'); await own.arrayBuffer();
    assert.equal((await fetch(`${app.origin}${relative}`, { headers: { Authorization: `Bearer ${otherToken}` } })).status, 404);
    assert.equal((await fetch(`${app.origin}${relative}`)).status, 401);
    assert.match(path.basename(relative), /^upload-[a-f0-9-]{36}\.png$/);
  } finally { await fs.unlink(path.resolve(relative.replace(/^\//, ''))).catch(() => {}); }
  assert.ok(await db.securityEvent.count({ where: { rule: 'UPLOAD_CONTENT_REJECTED' } }) >= 1);
});
