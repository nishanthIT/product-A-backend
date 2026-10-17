import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { persistRecoveryJournal } from '../src/services/deletionRecoveryJournal.js';
import { getPrisma, resetDatabase, seedBase, startApp } from './helpers/harness.js';
import { processDeletion, requestDeletion } from '../src/services/accountDeletion.js';
import { exportDeletionLedger, verifyDeletionLedger, replayDeletionLedger } from '../src/services/deletionLedger.js';
import { purgeAccountCaches } from '../src/services/deletionCaches.js';
let db, app, seed;
before(async () => { await resetDatabase(); db = await getPrisma(); seed = await seedBase(db); app = await startApp(); });
after(async () => { await app?.close(); await db?.$disconnect(); });
const key = 'synthetic-ledger-integrity-key-not-for-production';
test('a failed provider purge leaves deletion retryable and revokes all old sessions before erasure', async () => {
  const session = await app.login(seed.a.owner.email, seed.password);
  const job = await requestDeletion(db, { id: seed.a.owner.id, userType: 'CUSTOMER' });
  await assert.rejects(processDeletion(db, job.id, { purgeCaches: async () => { throw new Error('Synthetic provider unavailable'); } }), /provider unavailable/);
  assert.equal((await db.accountDeletionJob.findUnique({ where: { id: job.id } })).status, 'PROCESSING');
  assert.ok(await db.customer.findUnique({ where: { id: seed.a.owner.id } }));
  assert.equal((await app.request('GET', '/auth/me', { token: session.token })).status, 401);
  assert.equal((await app.request('POST', '/chat/message', { token: session.token, body: { chatId: seed.a.shop.groupChatId, content: 'delayed sync must not recreate content' } })).status, 401);
  assert.equal((await processDeletion(db, job.id)).status, 'EXTERNAL_REVIEW');
});
test('verified ledger replay erases a restored account, preserves shared shops, rejects old tokens and advances ID sequences', async () => {
  const envelope = await exportDeletionLedger(db, key);
  assert.equal(verifyDeletionLedger(envelope, key).entries.length, 1);
  assert.throws(() => verifyDeletionLedger({ ...envelope, payload: envelope.payload + ' ' }, key), /integrity/);
  const restored = await db.customer.create({ data: { id: seed.a.owner.id, name: 'Restored fixture', mobile: 'restored-fixture', email: seed.a.owner.email, password: seed.passwordHash } });
  const replay = await replayDeletionLedger(db, envelope, key);
  assert.equal(replay.replayed, 1); assert.equal(replay.providerReviewRequired, true);
  assert.equal(await db.customer.findUnique({ where: { id: restored.id } }), null);
  assert.ok(await db.shop.findUnique({ where: { id: seed.a.shop.id } }));
  assert.ok(await db.customer.findUnique({ where: { id: seed.b.owner.id } }));
  assert.equal((await replayDeletionLedger(db, envelope, key)).replayed, 1);
  const next = await db.customer.create({ data: { name: 'New fixture', mobile: 'new-fixture', email: 'new-after-restore@fixture.test', password: seed.passwordHash } });
  assert.ok(next.id > Math.max(seed.a.owner.id, seed.b.owner.id));
});
test('Redis deletion failures propagate instead of silently falling back to local memory', async () => {
  const cache = { isConnected: true, client: { get: async () => null, del: async () => { throw new Error('Provider failure'); } }, get: async () => null, del: async () => true, redisKey: key => `test:${key}` };
  await assert.rejects(purgeAccountCaches(seed.b.owner, 'CUSTOMER', cache), /Provider failure/);
  const keys = [];
  cache.client.del = async (...values) => { keys.push(...values); };
  cache.client.exists = async () => 0;
  await purgeAccountCaches(seed.b.owner, 'CUSTOMER', cache);
  assert.ok(keys.includes(`otp:reset:${seed.b.owner.email}`));
  assert.ok(keys.includes(`user:online:CUSTOMER:${seed.b.owner.id}`));
});

test('journal storage failure prevents erasure; durable journal is integrity-protected and excludes account content', async () => {
  const job = await requestDeletion(db, { id: seed.b.owner.id, userType: 'CUSTOMER' });
  await assert.rejects(processDeletion(db, job.id, { persistJournal: async () => { throw new Error('Journal unavailable'); } }), /Journal unavailable/);
  assert.ok(await db.customer.findUnique({ where: { id: seed.b.owner.id } }));
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'paymi-deletion-ledger-'));
  process.env.DELETION_LEDGER_DIR = directory; process.env.DELETION_LEDGER_KEY = key;
  try {
    await persistRecoveryJournal(db);
    const file = (await fs.readdir(directory))[0];
    const raw = await fs.readFile(path.join(directory, file), 'utf8');
    const ledger = verifyDeletionLedger(JSON.parse(raw), key);
    assert.ok(ledger.entries.some(e => e.userId === seed.b.owner.id));
    assert.ok(!raw.includes(seed.b.owner.email)); assert.ok(!raw.includes(seed.passwordHash));
    assert.equal((await fs.stat(path.join(directory, file))).mode & 0o777, 0o600);
    assert.equal((await processDeletion(db, job.id)).status, 'EXTERNAL_REVIEW');
  } finally {
    delete process.env.DELETION_LEDGER_DIR; delete process.env.DELETION_LEDGER_KEY;
    await fs.rm(directory, { recursive: true, force: true });
  }
});
