import test from 'node:test';
import assert from 'node:assert/strict';
import { issueOtp, verifyOtp, reserveOtpDelivery, OTP_TTL_SECONDS } from '../src/services/otpSecurity.js';
import { authRateLimit } from '../src/middleware/authRateLimit.js';
import { validateSessionClaims, sessionSignOptions, jwtSecret } from '../src/services/sessionSecurity.js';

process.env.JWT_SECRET = 'disposable-security-tests-only-key';
function cacheFixture() {
  const entries = new Map(); let tail = Promise.resolve();
  return {
    async set(key, value, seconds) { entries.set(key, { type: 'string', value: JSON.stringify(value), expiresAt: new Date(Date.now() + seconds * 1000) }); },
    change(key, fn) { const result = tail.then(() => { const changed = fn(entries.get(key)); if (changed.entry) entries.set(key, changed.entry); else entries.delete(key); return changed.result; }); tail = result.catch(() => {}); return result; },
  };
}
test('one-time reset proof is consumed atomically across simultaneous verifiers', async () => {
  const cache = cacheFixture(), email = 'owner@example.test';
  const code = await issueOtp('reset', email, cache);
  const results = await Promise.all(Array.from({ length: 30 }, () => verifyOtp('reset', email, code, { cache })));
  assert.equal(results.filter(result => result.ok).length, 1);
});
test('concurrent wrong OTP attempts cannot lose increments or revive a consumed proof', async () => {
  const cache = cacheFixture(), email = 'owner@example.test';
  const code = await issueOtp('reset', email, cache);
  await Promise.all(Array.from({ length: 30 }, () => verifyOtp('reset', email, 'not-a-code', { cache })));
  assert.equal((await verifyOtp('reset', email, code, { cache })).ok, false);
});
test('OTP expiry, flow separation and resend reservation are enforced', async () => {
  const cache = cacheFixture(), email = 'owner@example.test', now = Date.now();
  const code = await issueOtp('register', email, cache, now);
  assert.equal((await verifyOtp('reset', email, code, { cache, now })).ok, false);
  assert.equal((await verifyOtp('register', email, code, { cache, now: now + OTP_TTL_SECONDS * 1000 })).ok, false);
  const reserved = await Promise.all(Array.from({ length: 10 }, () => reserveOtpDelivery('register', email, cache, now)));
  assert.equal(reserved.filter(seconds => seconds === 0).length, 1);
});
function authFixture(limit = 3) {
  const counters = new Map(), events = [], restrictions = [];
  const cache = { async checkRateLimit(key, maximum) { const current = (counters.get(key) || 0) + 1; counters.set(key, current); return { current, allowed: current <= maximum }; } };
  const security = { activeSecurityRestriction: async () => null, recordSecurityEvent: async (_req, event) => events.push(event), setAutomaticRestriction: async (_req, restriction) => restrictions.push(restriction) };
  const middleware = authRateLimit('login', { limit, cache, security });
  return { counters, events, restrictions, async request(email, ip = '192.0.2.1') { const res = { code: 200, headers: {}, set(k,v) {this.headers[k]=v;}, status(code) { this.code=code; return this; }, json(body) {this.body=body;return this;} }; let passed = false; await middleware({ ip, body: { email } }, res, () => { passed = true; }); return { ...res, passed }; } };
}
test('rotating IP addresses cannot bypass account auth quota and no email is stored', async () => {
  const auth = authFixture();
  for (let i = 0; i < 3; i++) assert.equal((await auth.request(' Owner@Example.test ', `192.0.2.${i}`)).passed, true);
  assert.equal((await auth.request('owner@example.test', '198.51.100.1')).code, 429);
  assert.ok([...auth.counters.keys()].every(key => !key.includes('@')));
  assert.equal(auth.events.at(-1).rule, 'AUTH_RATE_LIMIT');
});
test('rotating email addresses cannot bypass IP quota; shared IP receives generous allowance', async () => {
  const auth = authFixture();
  for (let i = 0; i < 180; i++) assert.equal((await auth.request(`account${i}@example.test`)).passed, true);
  const denied = await auth.request('next@example.test');
  assert.equal(denied.code, 429); assert.equal(denied.headers['Retry-After'], '900');
});
test('sustained blocked requests create temporary auth restriction, storage failures fail closed', async () => {
  const auth = authFixture();
  for (let i = 0; i < 12; i++) await auth.request('owner@example.test');
  assert.equal(auth.restrictions.length, 1); assert.equal(auth.restrictions[0].seconds, 14400);
  const middleware = authRateLimit('login', { security: { activeSecurityRestriction: async () => { throw new Error('offline'); } } });
  const res = { set() {}, status(code) { this.code = code; return this; }, json() {} };
  await middleware({ body: {}, ip: '192.0.2.1' }, res, () => assert.fail('must fail closed'));
  assert.equal(res.code, 503);
});
test('account throttle backoff progresses while blocked-request logging is sampled', async () => {
  const auth = authFixture();
  for (let i = 0; i < 3; i++) await auth.request('owner@example.test');
  assert.equal((await auth.request('owner@example.test')).headers['Retry-After'], '30');
  assert.equal((await auth.request('owner@example.test')).headers['Retry-After'], '60');
  assert.equal((await auth.request('owner@example.test')).headers['Retry-After'], '120');
  assert.equal(auth.events.length, 1);
});
test('new JWT claims bind issuer/audience and legacy compatibility can be disabled', () => {
  const claims = { id: 1, userType: 'CUSTOMER', exp: 123 };
  assert.equal(validateSessionClaims(claims), true);
  assert.equal(validateSessionClaims({ ...claims, iss: 'other-app' }), false);
  assert.equal(validateSessionClaims({ ...claims, aud: 'other-app' }), false);
  assert.equal(validateSessionClaims({ ...claims, userType: 'OWNER' }), false);
  process.env.JWT_REQUIRE_ISSUER_AUDIENCE = 'true';
  try { assert.equal(validateSessionClaims(claims), false); assert.equal(validateSessionClaims({ ...claims, iss: sessionSignOptions().issuer, aud: sessionSignOptions().audience }), true); }
  finally { delete process.env.JWT_REQUIRE_ISSUER_AUDIENCE; }
  const previous = process.env.NODE_ENV; process.env.NODE_ENV = 'production';
  try { process.env.JWT_SECRET = 'short'; assert.throws(jwtSecret); }
  finally { process.env.JWT_SECRET = 'disposable-security-tests-only-key'; if (previous === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previous; }
});
