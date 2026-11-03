import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';
import { PrismaClient } from '@prisma/client';
import { getPrisma, resetDatabase, seedBase } from './helpers/harness.js';
import { DatabaseCache, cacheKey } from '../src/services/databaseCache.js';
import { RedisService } from '../src/services/redisService.js';
import { issueOtp, verifyOtp, otpKey, OTP_MAX_ATTEMPTS } from '../src/services/otpSecurity.js';
import { resetPasswordWithOtp } from '../src/services/passwordRecovery.js';

let db, seed, cache, passwordHash;
before(async () => {
  // The harness refuses every database except a disposable local *test* DB.
  await resetDatabase();
  db = await getPrisma();
  seed = await seedBase(db);
  cache = new RedisService({ store: new DatabaseCache(db) });
  passwordHash = await bcrypt.hash('New-Fixture-Password123', 4);
});
after(async () => { await db?.$disconnect(); });

test('a password update failure rolls back OTP consumption and permits retry with the same code', async () => {
  const { email, id } = seed.a.owner;
  const otp = await issueOtp('reset', email, cache);
  const before = await db.cacheEntry.findUnique({ where: { key: cacheKey(otpKey('reset', email)) } });
  const unavailable = {
    $transaction: (operation, options) => db.$transaction(tx => operation(new Proxy(tx, {
      get(target, property) {
        if (property === 'customer') return {
          findFirst: args => target.customer.findFirst(args),
          update: async () => { throw Object.assign(new Error('Fixture password storage unavailable'), { code: 'FIXTURE_UPDATE_FAILED' }); },
        };
        const value = target[property];
        return typeof value === 'function' ? value.bind(target) : value;
      },
    })), options),
  };
  await assert.rejects(resetPasswordWithOtp(unavailable, { email, otp, passwordHash }), { code: 'FIXTURE_UPDATE_FAILED' });
  const unchanged = await db.customer.findUnique({ where: { id } });
  assert.equal(unchanged.password, seed.passwordHash);
  assert.equal(unchanged.sessionVersion, 0);
  assert.deepEqual(await db.cacheEntry.findUnique({ where: { key: before.key } }), before);

  const result = await resetPasswordWithOtp(db, { email, otp, passwordHash });
  assert.deepEqual(result, { ok: true, userId: id, userType: 'CUSTOMER' });
  const updated = await db.customer.findUnique({ where: { id } });
  assert.equal(updated.password, passwordHash);
  assert.equal(updated.sessionVersion, 1);
  assert.equal(await cache.get(otpKey('reset', email)), null);
  assert.equal((await resetPasswordWithOtp(db, { email, otp, passwordHash })).ok, false);
});

test('independent workers can commit only one password reset for a proof', async () => {
  const secondDb = new PrismaClient();
  const { email, id } = seed.b.owner;
  try {
    const otp = await issueOtp('reset', email, cache);
    const results = await Promise.all(Array.from({ length: 8 }, (_, index) =>
      resetPasswordWithOtp(index % 2 ? secondDb : db, { email, otp, passwordHash })));
    assert.equal(results.filter(result => result.ok).length, 1);
    assert.equal((await db.customer.findUnique({ where: { id } })).sessionVersion, 1);
    assert.equal((await verifyOtp('reset', email, otp, { cache })).ok, false);
  } finally { await secondDb.$disconnect(); }
});

test('invalid reset attempts share the existing limit and do not change a password', async () => {
  const { email, id } = seed.admin;
  const otp = await issueOtp('reset', email, cache);
  for (let attempt = 0; attempt < OTP_MAX_ATTEMPTS; attempt++) {
    const result = await resetPasswordWithOtp(db, { email, otp: '000000', passwordHash });
    assert.equal(result.ok, false);
  }
  assert.equal((await resetPasswordWithOtp(db, { email, otp, passwordHash })).ok, false);
  const unchanged = await db.admin.findUnique({ where: { id } });
  assert.equal(unchanged.password, seed.passwordHash);
  assert.equal(unchanged.sessionVersion, 0);
});

test('admin and employee resets revoke sessions and clear obsolete reset tokens', async () => {
  const employee = await db.empolyee.create({ data: {
    name: 'Password fixture employee', email: 'password-fixture-employee@example.test',
    phoneNo: 'password-fixture-employee', password: seed.passwordHash,
  } });
  for (const [table, userType, user] of [['admin', 'ADMIN', seed.admin], ['empolyee', 'EMPLOYEE', employee]]) {
    await db[table].update({ where: { id: user.id }, data: { resetToken: 'obsolete-fixture', resetTokenExpiry: new Date(Date.now() + 60000) } });
    const otp = await issueOtp('reset', user.email, cache);
    assert.deepEqual(await resetPasswordWithOtp(db, { email: user.email, otp, passwordHash }), { ok: true, userId: user.id, userType });
    const updated = await db[table].findUnique({ where: { id: user.id } });
    assert.equal(updated.password, passwordHash);
    assert.equal(updated.sessionVersion, 1);
    assert.equal(updated.resetToken, null);
    assert.equal(updated.resetTokenExpiry, null);
  }
});
