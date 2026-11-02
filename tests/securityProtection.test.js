import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import { getPrisma, resetDatabase, seedBase, startApp, createCompanyStaff } from './helpers/harness.js';
import { DatabaseCache } from '../src/services/databaseCache.js';
import { RedisService } from '../src/services/redisService.js';
import {
  SecurityBudgetStore, SECURITY_DEFAULTS, securityHash, securityDb,
  activeSecurityRestriction, setAutomaticRestriction, recordBudgetViolation,
  recordSecurityEvent, securityBudgetIdentity, resetSecurityBudgets,
  securityAdminAudit, verifySecurityAudit, safeSecurityEvidence, securityAuditKey,
} from '../src/services/securityProtection.js';
import { createSecurityProtection, createPublicApiProtection, extractProtectedResources, securityScope } from '../src/middleware/securityProtection.js';

let db, app, seed, adminToken, ownerToken, staffToken;
const localRedis = process.env.TEST_REDIS_URL;
const subject = id => ({ id, userType: 'CUSTOMER', name: 'Security fixture', shopId: 'test-shop' });
const reqOf = (user = subject(9001), extra = {}) => ({ user, ip: '192.0.2.5', method: 'GET', originalUrl: '/api/products/search', path: '/products/search', baseUrl: '/api', route: { path: '/products/search' }, query: {}, params: {}, headers: { authorization: `Bearer disposable-${user.id}`, 'user-agent': 'security-test' }, ...extra });

async function protectedResponse(req, payload = { ok: true }, options = {}) {
  const middleware = options.publicOnly ? createPublicApiProtection(options) : createSecurityProtection(options);
  return new Promise((resolve, reject) => {
    const res = new EventEmitter();
    Object.assign(res, { statusCode: 200, headers: {}, headersSent: false, writableEnded: false,
      set(key, value) { this.headers[key.toLowerCase()] = value; return this; },
      status(code) { this.statusCode = code; return this; },
      json(body) { if (this.writableEnded) return this; this.body = body; this.headersSent = true; this.writableEnded = true; this.emit('finish'); resolve(this); return this; },
    });
    middleware(req, res, () => res.json(payload)).catch(reject);
  });
}
const withPolicy = async values => db.securityPolicy.upsert({ where: { id: 'default' }, create: { id: 'default', values, updatedBy: seed.admin.id }, update: { values } });
const reauthenticate = async token => {
  const response = await app.request('POST', '/admin/security/reauth', { token, body: { password: seed.password } });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  return { 'X-Security-Reauth': response.body.reauthToken };
};

before(async () => {
  await resetDatabase(); db = await getPrisma(); seed = await seedBase(db); app = await startApp();
  adminToken = (await app.login('admin@company.test', seed.password)).token;
  ownerToken = (await app.login('alpha-owner@shop.test', seed.password)).token;
  await createCompanyStaff(db, { email: 'security-staff@company.test', passwordHash: seed.passwordHash, permissions: ['catalog.read', 'staff.manage'] });
  staffToken = (await app.login('security-staff@company.test', seed.password)).token;
  assert.ok(adminToken && ownerToken && staffToken);
});
after(async () => { await app?.close(); await db?.$disconnect(); await securityDb.$disconnect(); });

test('all security administration requires a real Admin; mutations require session-bound reauthentication and reasons', async () => {
  assert.equal((await app.request('GET', '/admin/security/overview')).status, 401);
  for (const token of [ownerToken, staffToken]) {
    assert.equal((await app.request('GET', '/admin/security/overview', { token })).status, 403);
    assert.equal((await app.request('POST', '/admin/security/reauth', { token, body: { password: seed.password } })).status, 403);
  }
  const body = { subjectKey: `CUSTOMER:${seed.b.owner.id}`, scope: 'catalogue', minutes: 10, reason: 'Investigate confirmed bulk retrieval' };
  assert.equal((await app.request('POST', '/admin/security/restrictions', { token: adminToken, body })).status, 403);
  const headers = await reauthenticate(adminToken);
  assert.equal((await app.request('POST', '/admin/security/restrictions', { token: adminToken, headers, body: { ...body, reason: '' } })).status, 400);
  const differentSession = (await app.login('admin@company.test', seed.password)).token;
  assert.equal((await app.request('POST', '/admin/security/restrictions', { token: differentSession, headers, body })).status, 403);
  assert.equal((await app.request('PATCH', '/admin/security/policy', { token: adminToken, headers, body: { values: { accountRequestsPerMinute: 0 }, reason: 'Unsafe configuration attempt' } })).status, 400);
  assert.equal((await app.request('GET', '/admin/security/events?page=999999', { token: adminToken })).status, 400);
});

test('distributed quotas serialize across two application instances and survive Redis loss without resetting', async () => {
  const { PrismaClient } = await import('@prisma/client'); const peer = new PrismaClient();
  const redis = new RedisService({ store: new DatabaseCache(db) });
  if (localRedis) { assert.equal(await redis.connect(localRedis), true, 'local disposable Redis must be reachable when configured'); }
  const first = new SecurityBudgetStore({ store: new DatabaseCache(db), redis });
  const second = new SecurityBudgetStore({ store: new DatabaseCache(peer), redis });
  const identity = `distributed:${randomUUID()}`;
  try {
    const results = await Promise.all(Array.from({ length: 24 }, (_, index) => (index % 2 ? first : second).consume(identity, 'simultaneous', { limit: 10, seconds: 3600 })));
    assert.equal(results.filter(result => result.allowed).length, 10);
    await redis.disconnect();
    const denied = await second.consume(identity, 'simultaneous', { limit: 10, seconds: 3600 });
    assert.equal(denied.allowed, false); assert.equal(denied.count, 25);
    const brokenStore = new SecurityBudgetStore({ store: { mutate: async () => { throw new Error('database offline'); } }, redis });
    await assert.rejects(brokenStore.consume(identity, 'offline', { limit: 10 }), /offline/);
  } finally { await redis.disconnect(); await peer.$disconnect(); }
});

test('failed distinct-record admissions remain denied on retry while previously admitted records remain usable', async () => {
  const budgets = new SecurityBudgetStore({ store: new DatabaseCache(db), redis: null });
  const id = randomUUID();
  assert.equal((await budgets.consume(id, 'products', { limit: 2, resources: ['one', 'two'] })).allowed, true);
  assert.equal((await budgets.consume(id, 'products', { limit: 2, resources: ['three'] })).allowed, false);
  assert.equal((await budgets.consume(id, 'products', { limit: 2, resources: ['three'] })).allowed, false);
  assert.equal((await budgets.consume(id, 'products', { limit: 2, resources: ['one'] })).allowed, true);
});

test('response budgets stop catalogue extraction before data leaves the server, then temporarily restrict sustained abuse', async () => {
  await withPolicy({ distinctProductsPerHour: 100, distinctProductsPerDay: 200, restrictionAfterViolations: 5 });
  const user = subject(9002), req = () => reqOf(user);
  const products = Array.from({ length: 100 }, (_, index) => ({ id: `protected-${index}`, title: `Product ${index}` }));
  assert.equal((await protectedResponse(req(), { products })).statusCode, 200);
  const denied = await protectedResponse(req(), { products: [{ id: 'never-disclosed', title: 'Protected business data' }] });
  assert.equal(denied.statusCode, 429); assert.ok(+denied.headers['retry-after'] > 0);
  assert.ok(!JSON.stringify(denied.body).includes('never-disclosed'));
  assert.equal((await protectedResponse(req(), { products: [products[0]] })).statusCode, 200, 'ordinary reread must remain usable');
  let response;
  for (let i = 0; i < 4; i++) response = await protectedResponse(req(), { products: [{ id: `additional-${i}`, title: 'More protected data' }] });
  assert.equal(response.statusCode, 403); assert.equal(response.body.code, 'TEMPORARILY_RESTRICTED');
  const restriction = await activeSecurityRestriction(req(), 'catalogue', [], db);
  assert.ok(+restriction.until > Date.now() + 3 * 3600000);
  assert.equal((await protectedResponse(req(), { products: [] })).statusCode, 403);
  assert.equal((await protectedResponse(reqOf(user, { originalUrl: '/api/shop/my-shop' }))).statusCode, 200, 'catalogue restriction must not suspend unrelated shop workflows');
  const event = await db.securityEvent.findFirst({ where: { restrictionId: restriction.id } });
  assert.equal(event.category, 'scraping'); assert.equal(event.action, 'restricted');
  assert.ok(!JSON.stringify(event).includes('additional-'));
  await db.securityPolicy.deleteMany();
});

test('account and IP budgets remain independent; shared-IP overages never automatically suspend an account', async () => {
  await withPolicy({ accountRequestsPerMinute: 30 });
  const budgets = new SecurityBudgetStore({ store: new DatabaseCache(db), redis: null });
  const user = subject(9003), identity = await securityBudgetIdentity('CUSTOMER:9003', db);
  await budgets.consume(identity, 'account-requests', { limit: 30, amount: 30 });
  for (const ip of ['192.0.2.10', '198.51.100.20']) assert.equal((await protectedResponse(reqOf(user, { ip, originalUrl: '/api/shop/my-shop' }))).statusCode, 429);
  const peer = subject(9004), ip = '203.0.113.22';
  await budgets.consume(await securityBudgetIdentity(`ip:${ip}`, db), 'ip-requests', { limit: SECURITY_DEFAULTS.ipRequestsPerMinute, amount: 6000 });
  for (let i = 0; i < 9; i++) assert.equal((await protectedResponse(reqOf(peer, { ip, originalUrl: '/api/shop/my-shop' }))).statusCode, 429);
  assert.equal(await activeSecurityRestriction(reqOf(peer, { ip }), 'account', [], db), null);
  await db.securityPolicy.deleteMany();
});

test('multipart uploads have their own quota before any handler runs and database outages fail closed', async () => {
  const user = subject(9005), request = reqOf(user, { originalUrl: '/api/incidents', method: 'POST', headers: { 'content-type': 'multipart/form-data; boundary=example' } });
  assert.equal(securityScope(request), 'upload');
  const budgets = new SecurityBudgetStore({ store: new DatabaseCache(db), redis: null });
  const identity = await securityBudgetIdentity('CUSTOMER:9005', db);
  await budgets.consume(identity, 'upload-requests', { limit: 120, seconds: 3600, amount: 120 });
  assert.equal((await protectedResponse(request, { stored: 'must not run' })).statusCode, 429);
  const offlineDb = { securityRestriction: { findFirst: async () => null }, securityPolicy: { findUnique: async () => { throw new Error('offline'); } } };
  const failure = await protectedResponse(reqOf(subject(9006)), { secret: 'must not leave server' }, { db: offlineDb, budgets });
  assert.equal(failure.statusCode, 503); assert.ok(!JSON.stringify(failure.body).includes('must not leave'));
});

test('distributed concurrency leases expire and release without exceeding the configured capacity', async () => {
  let now = Date.now(); const budgets = new SecurityBudgetStore({ store: new DatabaseCache(db), redis: null, now: () => now });
  const id = randomUUID(); const leases = await Promise.all(Array.from({ length: 8 }, () => budgets.lease(id, 2, 30)));
  assert.equal(leases.filter(Boolean).length, 2);
  await leases.find(Boolean)(); const replacement = await budgets.lease(id, 2, 30); assert.ok(replacement);
  now += 31000; const afterExpiry = await budgets.lease(id, 2, 30); assert.ok(afterExpiry); await afterExpiry(); await replacement();
});

test('manual block, immediate unblock, expiry, scope and expiring exceptions are enforced on real routes', async () => {
  const headers = await reauthenticate(adminToken), target = `CUSTOMER:${seed.a.owner.id}`;
  const created = await app.request('POST', '/admin/security/restrictions', { token: adminToken, headers, body: { subjectKey: target, scope: 'catalogue', minutes: 60, reason: 'Investigate repeated price scraping' } });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal((await app.request('GET', `/products/${seed.product.id}`, { token: ownerToken })).status, 403);
  assert.equal((await app.request('GET', '/shop/my-shop', { token: ownerToken })).status, 200);
  const before = await securityBudgetIdentity(target, db);
  const lifted = await app.request('POST', `/admin/security/restrictions/${created.body.id}/lift`, { token: adminToken, headers, body: { reason: 'Verified legitimate owner activity' } });
  assert.equal(lifted.status, 200); assert.notEqual(await securityBudgetIdentity(target, db), before);
  assert.equal((await app.request('GET', `/products/${seed.product.id}`, { token: ownerToken })).status, 200);
  await db.securityRestriction.update({ where: { id: created.body.id }, data: { liftedAt: null, until: new Date(Date.now() - 1000) } });
  assert.equal((await app.request('GET', `/products/${seed.product.id}`, { token: ownerToken })).status, 200);
  const exception = await app.request('POST', '/admin/security/exceptions', { token: adminToken, headers, body: { subjectKey: target, scope: 'catalogue', minutes: 5, reason: 'Scheduled approved inventory check' } });
  assert.equal(exception.status, 201); assert.ok(+new Date(exception.body.until) <= Date.now() + 301000);
  assert.equal((await app.request('POST', '/admin/security/exceptions', { token: adminToken, headers, body: { subjectKey: target, scope: 'account', minutes: 5, reason: 'Disallowed broad exception' } })).status, 400);
  const budgets = new SecurityBudgetStore({ store: new DatabaseCache(db), redis: null });
  const identity = await securityBudgetIdentity(target, db);
  await budgets.consume(identity, 'catalogue-requests', { limit: 120, amount: 120 });
  assert.equal((await app.request('GET', `/products/${seed.product.id}`, { token: ownerToken })).status, 200, 'explicit scoped exception bypasses only catalogue quota');
  await db.securityException.update({ where: { id: exception.body.id }, data: { until: new Date(Date.now() - 1) } });
  assert.equal((await app.request('GET', `/products/${seed.product.id}`, { token: ownerToken })).status, 429);
  await db.$transaction(tx => resetSecurityBudgets(tx, target));
});

test('admin review/notes, session revocation and audit integrity work without exposing event secrets', async () => {
  const headers = await reauthenticate(adminToken);
  const event = await recordSecurityEvent(reqOf(subject(seed.b.owner.id)), { category: 'scraping', severity: 'high', rule: 'TEST_EVENT', reason: 'Test investigation', evidence: { password: 'do-not-store', authorization: 'do-not-store', nested: { otp: 'do-not-store', count: 3 } } }, db);
  assert.ok(!JSON.stringify(event).includes('do-not-store'));
  assert.equal((await app.request('POST', `/admin/security/events/${event.id}/notes`, { token: adminToken, headers, body: { note: 'Reviewed activity with the owner' } })).status, 201);
  assert.equal((await app.request('PATCH', `/admin/security/events/${event.id}`, { token: adminToken, headers, body: { status: 'RESOLVED', note: 'Investigation finished with owner' } })).status, 200);
  const detail = await app.request('GET', `/admin/security/events/${event.id}`, { token: adminToken });
  assert.equal(detail.status, 200); assert.equal(detail.body.event.status, 'RESOLVED'); assert.equal(detail.body.history.length, 2);
  const victimToken = (await app.login('bravo-owner@shop.test', seed.password)).token;
  assert.equal((await app.request('POST', `/admin/security/accounts/CUSTOMER:${seed.b.owner.id}/revoke-sessions`, { token: adminToken, headers, body: { reason: 'Owner reported a lost device' } })).status, 200);
  assert.equal((await app.request('GET', '/shop/my-shop', { token: victimToken })).status, 401);
  const integrity = await verifySecurityAudit(db); assert.equal(integrity.valid, true); assert.ok(integrity.count >= 5);
  const rows = await db.securityAdminAudit.findMany({ orderBy: { sequence: 'asc' } });
  rows[0].reason = 'tampered';
  assert.equal((await verifySecurityAudit({ securityAdminAudit: { findMany: async ({ where }) => rows.filter(row => row.sequence > where.sequence.gt) } })).valid, false);
  assert.deepEqual(safeSecurityEvidence({ secret: 's', password: 'p', safe: { tokens: 't', count: 2 } }), { safe: { count: 2 } });
});

test('additive migration enforces append-only admin audit at the SQL boundary', async () => {
  const { default: pg } = await import('pg'); const client = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
  const schema = `security_migration_test_${randomUUID().replaceAll('-', '')}`;
  const sql = await fs.readFile(new URL('../prisma/migrations/20261027130000_central_security_protection/migration.sql', import.meta.url), 'utf8');
  await client.connect();
  try {
    await client.query('BEGIN'); await client.query(`CREATE SCHEMA "${schema}"`); await client.query(`SET LOCAL search_path TO "${schema}"`); await client.query(sql);
    await client.query(`INSERT INTO "SecurityAdminAudit" ("adminId", action, reason, details, "previousHash", hash) VALUES (1,'TEST','Test action','{}','GENESIS','test')`);
    for (const statement of ['UPDATE "SecurityAdminAudit" SET reason=\'changed\'', 'DELETE FROM "SecurityAdminAudit"', 'TRUNCATE "SecurityAdminAudit"']) {
      await client.query('SAVEPOINT attack'); await assert.rejects(client.query(statement), /append-only/); await client.query('ROLLBACK TO SAVEPOINT attack');
    }
  } finally { await client.query('ROLLBACK'); await client.end(); }
});

test('production audit key cannot reuse JWT signing credentials', () => {
  const oldEnv = process.env.NODE_ENV, oldKey = process.env.SECURITY_AUDIT_KEY;
  process.env.NODE_ENV = 'production';
  try {
    delete process.env.SECURITY_AUDIT_KEY; assert.throws(securityAuditKey, /separate/);
    process.env.SECURITY_AUDIT_KEY = process.env.JWT_SECRET; assert.throws(securityAuditKey, /separate/);
    process.env.SECURITY_AUDIT_KEY = 'independent-audit-key-for-local-test-only'; assert.equal(securityAuditKey(), process.env.SECURITY_AUDIT_KEY);
  } finally { if (oldEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = oldEnv; if (oldKey === undefined) delete process.env.SECURITY_AUDIT_KEY; else process.env.SECURITY_AUDIT_KEY = oldKey; }
});

test('nested comparison and list responses enumerate actual product and supplier-price resources', () => {
  const result = extractProtectedResources({ products: [{ productAtShop: { id: 'pas-one', productId: 'product-one', shopId: 'shop-one', price: 3, product: { id: 'product-one', title: 'Cola' } } }], productIds: ['product-two'] });
  assert.deepEqual(new Set(result.products), new Set(['product-one', 'product-two'])); assert.ok(result.prices.includes('product-one:shop-one'));
});


test('public API requests enforce shared-IP budgets and restrictions without double charging authenticated requests', async () => {
  const ip = '198.51.100.77', budgets = new SecurityBudgetStore({ store: new DatabaseCache(db), redis: null });
  const request = reqOf(subject(9020), { user: undefined, ip, originalUrl: '/api/news', headers: {} });
  const identity = await securityBudgetIdentity(`ip:${ip}`, db);
  const first = await protectedResponse(request, { news: [] }, { publicOnly: true });
  assert.equal(first.statusCode, 200); assert.equal(request.securityIpChecked, ip);
  request.user = subject(9020);
  assert.equal((await protectedResponse(request, { ok: true })).statusCode, 200);
  const count = await budgets.consume(identity, 'ip-requests', { limit: SECURITY_DEFAULTS.ipRequestsPerMinute });
  assert.equal(count.count, 2, 'public + authenticated chain charges the IP exactly once');
  await budgets.consume(identity, 'ip-requests', { limit: SECURITY_DEFAULTS.ipRequestsPerMinute, amount: SECURITY_DEFAULTS.ipRequestsPerMinute });
  assert.equal((await protectedResponse({ ...request, user: undefined }, {}, { publicOnly: true })).statusCode, 429);
  await db.securityRestriction.create({ data: { subjectKey: `ip:${ip}`, scope: 'account', until: new Date(Date.now() + 60000), reason: 'Manual reviewed source restriction', source: 'manual' } });
  assert.equal((await protectedResponse({ ...request, user: undefined }, {}, { publicOnly: true })).statusCode, 403);
  assert.equal((await protectedResponse({ ...request, originalUrl: '/api/health', user: undefined }, {}, { publicOnly: true })).statusCode, 200);
});

test('non-catalogue authenticated responses are size bounded before sending data', async () => {
  await withPolicy({ maximumResponseBytes: 262144 });
  const request = reqOf(subject(9021), { originalUrl: '/api/shop/my-shop' });
  const response = await protectedResponse(request, { privateHistory: 'x'.repeat(300000) });
  assert.equal(response.statusCode, 413);
  assert.ok(!JSON.stringify(response.body).includes('privateHistory'));
  assert.equal((await db.securityEvent.findFirst({ where: { subjectKey: 'CUSTOMER:9021', rule: 'RESPONSE_SIZE' } })).category, 'availability');
  await db.securityPolicy.deleteMany();
});
