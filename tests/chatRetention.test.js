import { before, beforeEach, after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { getPrisma, resetDatabase, seedBase, startApp } from './helpers/harness.js';
import { retentionSchedule, retentionConfig, runChatRetention, expireChatBatch, queueUnusedAttachment, queueUnusedAttachments, deleteQueuedAttachment, startChatRetentionWorker, chatRetentionStatus } from '../src/services/chatRetention.js';
import { createChatStorage } from '../src/services/chatStorage.js';

let db, seed, root, storage, app, token;
const now = new Date('2026-10-26T10:00:00Z');
const cutoff = new Date('2026-09-26T02:00:00Z');
const old = new Date(+cutoff - 1);
const recent = new Date(+cutoff + 1);
const message = (extra = {}) => db.message.create({ data: { chatId: seed.a.shop.groupChatId, senderId: seed.a.owner.id, senderType: 'CUSTOMER', content: 'retention fixture', createdAt: old, ...extra } });
const upload = async (filename, extra = {}, bytes = true) => {
  if (bytes) await fs.writeFile(path.join(root, filename), 'synthetic bytes');
  return db.chatUpload.create({ data: { filename, uploaderId: seed.a.owner.id, uploaderType: 'CUSTOMER', createdAt: old, ...extra } });
};
const run = (options = {}) => runChatRetention({ db, storage, now, ...options });
before(async () => {
  await resetDatabase(); db = await getPrisma(); seed = await seedBase(db);
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'paymi-retention-test-'));
  process.env.CHAT_STORAGE_ROOT = root;
  process.env.MODERATION_EVIDENCE_DIR = path.join(root, 'evidence');
  storage = createChatStorage({ env: { CHAT_STORAGE_ROOT: root } });
  app = await startApp(); token = (await app.login(seed.a.owner.email, seed.password)).token;
});
beforeEach(async () => {
  await db.contentReport.deleteMany(); await db.message.deleteMany();
  await db.chatAttachmentDeletionJob.deleteMany(); await db.chatUpload.deleteMany(); await db.chatRetentionRun.deleteMany();
});
after(async () => { await app?.close(); await db?.$disconnect(); await fs.rm(root, { recursive: true, force: true }); delete process.env.CHAT_STORAGE_ROOT; delete process.env.MODERATION_EVIDENCE_DIR; });

test('schedule uses a stable UTC cutoff, catches downtime, and validates worker settings', () => {
  assert.deepEqual(retentionSchedule(now), { id: '2026-10-26', cutoff });
  assert.deepEqual(retentionSchedule(new Date('2026-10-26T01:59:59.999Z')), { id: '2026-10-25', cutoff: new Date('2026-09-25T02:00:00Z') });
  assert.equal(retentionSchedule(new Date('2027-01-01T03:00:00Z')).cutoff.toISOString(), '2026-12-02T02:00:00.000Z');
  assert.equal(retentionConfig({ CHAT_RETENTION_HOUR_UTC: '0' }).hour, 0);
  assert.equal(retentionConfig({}).enabled, false);
  assert.equal(retentionConfig({ CHAT_RETENTION_ENABLED: 'true' }).enabled, true);
  assert.equal(retentionConfig({ CHAT_RETENTION_ENABLED: 'false' }).enabled, false);
  assert.throws(() => retentionConfig({ CHAT_RETENTION_HOUR_UTC: '24' }));
  assert.throws(() => retentionConfig({ CHAT_RETENTION_ENABLED: 'yes' }));
});

test('expires only strictly older messages and cascades receipts while preserving rooms, participants and newer history', async () => {
  const expired = await message();
  const boundary = await message({ createdAt: cutoff });
  const keep = await message({ createdAt: recent });
  const participants = await db.chatParticipant.count(), chats = await db.chat.count();
  await db.messageRead.create({ data: { messageId: expired.id, userId: seed.b.owner.id, userType: 'CUSTOMER' } });
  await db.messageDelivery.create({ data: { messageId: expired.id, userId: seed.b.owner.id, userType: 'CUSTOMER' } });
  const events = [];
  const result = await run({ io: { emit: (...args) => events.push(args) } });
  assert.equal(result.removed, 1); assert.equal(result.failedFiles, 0);
  assert.deepEqual((await db.message.findMany({ orderBy: { createdAt: 'asc' } })).map(m => m.id), [boundary.id, keep.id]);
  assert.equal(await db.messageRead.count(), 0); assert.equal(await db.messageDelivery.count(), 0);
  assert.equal(await db.chat.count(), chats); assert.equal(await db.chatParticipant.count(), participants);
  assert.equal(+(await db.chat.findUnique({ where: { id: keep.chatId } })).lastMessageAt, +recent);
  assert.ok(events.some(([event, payload]) => event === 'chats_changed' && payload.reason === 'retention' && payload.cutoff === cutoff.toISOString()));
  assert.equal((await run()).removed, 0); assert.equal(await db.chatRetentionRun.count(), 1);
});

test('shared newer files survive, legacy absolute/query URLs are resolved safely, and old abandoned/missing files are removed', async () => {
  for (const name of ['shared.jpg', 'expired.pdf', 'legacy.jpg', 'abandoned.txt']) await upload(name);
  await upload('missing.jpg', {}, false);
  await upload('new-upload.jpg', { createdAt: recent });
  await message({ attachmentUrl: '/uploads/chat/shared.jpg' });
  const keep = await message({ createdAt: recent, attachmentUrl: 'https://old-api.test/api/uploads/chat/shared.jpg?download=1' });
  for (const name of ['expired.pdf', 'missing.jpg']) await message({ attachmentUrl: `/uploads/chat/${name}` });
  await db.chatUpload.delete({ where: { filename: 'legacy.jpg' } });
  await message({ attachmentUrl: 'https://old-api.test/uploads/chat/legacy.jpg#old' });
  const outside = path.join(root, 'protected.txt'); await fs.writeFile(outside, 'keep outside route');
  await message({ attachmentUrl: outside });
  const done = await run({ now });
  assert.equal(done.removed, 5); // shared, expired, missing, legacy, unsafe path
  assert.equal((await db.message.findUnique({ where: { id: keep.id } })).attachmentUrl.includes('shared'), true);
  assert.equal(await fs.readFile(path.join(root, 'shared.jpg'), 'utf8'), 'synthetic bytes');
  assert.equal(await fs.readFile(outside, 'utf8'), 'keep outside route');
  assert.ok(await db.chatUpload.findUnique({ where: { filename: 'shared.jpg' } }));
  assert.ok(await db.chatUpload.findUnique({ where: { filename: 'new-upload.jpg' } }));
  // Outbox timestamps use the database clock, so dispatch with a later clock in tests.
  for (const job of await db.chatAttachmentDeletionJob.findMany()) {
    await deleteQueuedAttachment(job.filename, { db, storage, now: new Date(Date.now() + 10000) });
  }
  for (const name of ['expired.pdf', 'missing.jpg', 'legacy.jpg', 'abandoned.txt']) await assert.rejects(fs.stat(path.join(root, name)), { code: 'ENOENT' });
});

test('file failures leave durable retry jobs; missing files and crash-after-delete retries are successful', async () => {
  await upload('retry.jpg'); await message({ attachmentUrl: '/uploads/chat/retry.jpg' });
  let calls = 0;
  const unreliable = { config: { timeoutMs: 1000 }, delete: async item => { calls++; await storage.delete(item); if (calls === 1) throw Object.assign(new Error('lost acknowledgement'), { code: 'ETIMEDOUT' }); } };
  await run({ fileLimit: 0 });
  const dispatch = new Date(Date.now() + 10000);
  assert.equal((await deleteQueuedAttachment('retry.jpg', { db, storage: unreliable, now: dispatch })).failed, true);
  const job = await db.chatAttachmentDeletionJob.findUnique({ where: { filename: 'retry.jpg' } });
  assert.equal(job.attempts, 1); assert.equal(job.lastError, 'ETIMEDOUT');
  assert.equal((await db.chatUpload.findUnique({ where: { filename: 'retry.jpg' } })).pendingDeletion, true);
  assert.equal((await deleteQueuedAttachment('retry.jpg', { db, storage: unreliable, now: dispatch })).busy, true);
  assert.equal((await deleteQueuedAttachment('retry.jpg', { db, storage: unreliable, now: new Date(+dispatch + 60001) })).deleted, true);
  assert.equal(await db.chatAttachmentDeletionJob.count(), 0); assert.equal(await db.chatUpload.count(), 0);
});

test('simultaneous workers create one daily run and never expire a message twice', async () => {
  await db.message.createMany({ data: Array.from({ length: 205 }, () => ({ chatId: seed.a.shop.groupChatId, senderId: seed.a.owner.id, senderType: 'CUSTOMER', content: 'old', createdAt: old })) });
  await message({ createdAt: recent });
  const results = await Promise.all([run(), run(), run()]);
  assert.equal(results.reduce((sum, result) => sum + result.removed, 0), 205);
  assert.equal(await db.chatRetentionRun.count(), 1);
  const row = await db.chatRetentionRun.findFirst(); assert.equal(row.removed, 205); assert.equal(row.status, 'COMPLETED');
  assert.equal(await db.message.count(), 1);
});

test('attachment deletion outbox rolls back with message expiry and resumes after restart', async () => {
  await upload('rollback.jpg'); const item = await message({ attachmentUrl: '/uploads/chat/rollback.jpg' });
  await assert.rejects(db.$transaction(async tx => {
    await tx.message.delete({ where: { id: item.id } }); await queueUnusedAttachment(tx, 'rollback.jpg'); throw new Error('simulate transaction failure');
  }));
  assert.ok(await db.message.findUnique({ where: { id: item.id } })); assert.equal(await db.chatAttachmentDeletionJob.count(), 0);
  await db.chatRetentionRun.create({ data: retentionSchedule(now) });
  assert.equal((await expireChatBatch('2026-10-26', { db, batchSize: 1 })).removed, 1);
  assert.equal((await db.chatRetentionRun.findFirst()).status, 'RUNNING');
  assert.equal((await run()).removed, 0); assert.equal((await db.chatRetentionRun.findFirst()).status, 'COMPLETED');
});

test('queued files cannot be sent and references added before dispatch protect shared bytes', async () => {
  await upload('pending.jpg'); await db.$transaction(tx => queueUnusedAttachment(tx, 'pending.jpg'));
  const denied = await app.request('POST', '/chat/message', { token, shopId: seed.a.shop.id, body: { chatId: seed.a.shop.groupChatId, content: 'blocked pending upload', messageType: 'IMAGE', attachmentUrl: '/uploads/chat/pending.jpg' } });
  assert.equal(denied.status, 403);
  await message({ createdAt: recent, attachmentUrl: '/uploads/chat/pending.jpg' }); // Simulate a pre-existing shared reference recovered during restore.
  assert.equal((await deleteQueuedAttachment('pending.jpg', { db, storage, now: new Date(Date.now() + 10000) })).preserved, true);
  assert.equal((await db.chatUpload.findUnique({ where: { filename: 'pending.jpg' } })).pendingDeletion, false);
  assert.equal(await db.chatAttachmentDeletionJob.count(), 0); assert.equal(await fs.readFile(path.join(root, 'pending.jpg'), 'utf8'), 'synthetic bytes');
});

test('retention preserves moderation evidence before detaching an expired message', async () => {
  const item = await message({ content: 'reported content' });
  const report = await db.contentReport.create({ data: { messageId: item.id, reporterId: seed.b.owner.id, reporterType: 'CUSTOMER', reason: 'ABUSE' } });
  await run();
  const retained = await db.contentReport.findUnique({ where: { id: report.id } });
  assert.equal(retained.messageId, null); assert.equal(retained.evidence.content, 'reported content');
  assert.equal(retained.evidence.messageId, item.id);
});

test('worker starts automatically, skips restore mode, and stops cleanly', async () => {
  const stopped = startChatRetentionWorker(null, { db, storage, env: { CHAT_RETENTION_ENABLED: 'false' }, intervalMs: 10 });
  assert.equal(chatRetentionStatus.state, 'disabled'); await stopped();
  process.env.PAYMI_RESTORE_MODE = '1';
  const stop = startChatRetentionWorker(null, { db, storage, env: { CHAT_RETENTION_ENABLED: 'true' }, intervalMs: 10 });
  await new Promise(resolve => setTimeout(resolve, 25)); assert.equal(await db.chatRetentionRun.count(), 0);
  delete process.env.PAYMI_RESTORE_MODE;
  for (let n = 0; n < 100 && !await db.chatRetentionRun.count(); n++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(await db.chatRetentionRun.count(), 1); await stop(); assert.equal(chatRetentionStatus.state, 'stopped');
});

test('raw expiry comparisons stay in UTC for positive and negative database timezone offsets', async () => {
  for (const [index, zone] of ['UTC', 'Asia/Kolkata', 'America/Los_Angeles'].entries()) {
    await db.message.deleteMany();
    const item = await message();
    const boundary = await message({ createdAt: cutoff });
    const keep = await message({ createdAt: recent });
    const run = await db.chatRetentionRun.create({ data: { id: `timezone-${index}`, cutoff } });
    const zonedDb = { $transaction: (work, options) => db.$transaction(async tx => {
      await tx.$executeRawUnsafe(`SET LOCAL TIME ZONE '${zone}'`);
      return work(tx);
    }, options) };
    const result = await expireChatBatch(run.id, { db: zonedDb });
    assert.equal(result.removed, 1, zone);
    assert.equal(await db.message.findUnique({ where: { id: item.id } }), null, zone);
    assert.deepEqual((await db.message.findMany({ orderBy: { createdAt: 'asc' } })).map(m => m.id), [boundary.id, keep.id], zone);
  }
});

test('operations preview reports shared attachment preservation without changing history or queue state', async () => {
  const { previewChatRetention } = await import('../scripts/chatRetention.js');
  await message({ attachmentUrl: '/uploads/chat/shared-preview.jpg' });
  await message({ attachmentUrl: 'https://unrelated.example/image.jpg' });
  await message({ createdAt: cutoff, attachmentUrl: '/uploads/chat/shared-preview.jpg' });
  const before = JSON.stringify(await db.message.findMany());
  const result = await previewChatRetention(db, { now });
  assert.equal(result.mode, 'dry-run'); assert.equal(result.expiredMessages, 2); assert.equal(result.retainedMessages, 1);
  assert.equal(result.sharedFilesPreserved, 1); assert.equal(result.unrecognizedAttachmentUrlsSkipped, 1);
  assert.equal(JSON.stringify(await db.message.findMany()), before);
  assert.equal(await db.chatRetentionRun.count(), 0); assert.equal(await db.chatAttachmentDeletionJob.count(), 0);
});


test('a full batch across many chats and attachments uses bounded database calls and keeps latest activity', async () => {
  const chats = Array.from({ length: 20 }, (_, index) => ({ id: `retention-bulk-chat-${index}`, type: 'GROUP', name: 'Bulk retention fixture' }));
  await db.chat.createMany({ data: chats });
  const attachments = Array.from({ length: 100 }, (_, index) => `bulk-${index}.jpg`);
  await db.chatUpload.createMany({ data: attachments.map(filename => ({ filename, uploaderId: seed.a.owner.id, uploaderType: 'CUSTOMER', createdAt: old })) });
  await db.message.createMany({ data: attachments.map((filename, index) => ({ id: `retention-bulk-message-${index}`, chatId: chats[index % chats.length].id,
    senderId: seed.a.owner.id, senderType: 'CUSTOMER', content: 'expired bulk fixture', attachmentUrl: `/uploads/chat/${filename}`, createdAt: old })) });
  await db.message.createMany({ data: chats.map(chat => ({ chatId: chat.id, senderId: seed.a.owner.id, senderType: 'CUSTOMER', content: 'newer activity', createdAt: recent })) });
  const schedule = retentionSchedule(now); await db.chatRetentionRun.create({ data: schedule });
  let calls = 0;
  const countedDb = { $transaction: (work, options) => db.$transaction(async tx => {
    const trackedModels = new Set(['message', 'contentReport', 'chat', 'chatUpload', 'chatAttachmentDeletionJob', 'chatRetentionRun']);
    const counted = new Proxy(tx, { get(target, key) {
      const value = target[key];
      if (['$queryRaw', '$executeRaw'].includes(key)) return (...args) => { calls++; return value.apply(target, args); };
      if (trackedModels.has(key)) return new Proxy(value, { get(model, operation) {
        const method = model[operation];
        return typeof method === 'function' ? (...args) => { calls++; return method.apply(model, args); } : method;
      } });
      return value;
    } });
    return work(counted);
  }, options) };
  const result = await expireChatBatch(schedule.id, { db: countedDb });
  assert.equal(result.removed, 100);
  assert.ok(calls <= 20, `A 100-message/100-file/20-chat batch took ${calls} database calls`);
  assert.equal(await db.chatAttachmentDeletionJob.count(), 100);
  assert.equal(await db.chatUpload.count({ where: { pendingDeletion: true } }), 100);
  const remaining = await db.chat.findMany({ where: { id: { in: chats.map(chat => chat.id) } } });
  assert.ok(remaining.every(chat => +chat.lastMessageAt === +recent));
});

test('bulk file queue preserves exact shared references and existing provider descriptors', async () => {
  await upload('bulk-shared_1.jpg'); await upload('bulk-sharedX1.jpg'); await upload('bulk-orphan.jpg');
  await message({ createdAt: recent, attachmentUrl: 'https://legacy.test/api/uploads/chat/bulk-sharedX1.jpg?download=1' });
  await message({ createdAt: recent, attachmentUrl: '/uploads/chat/bulk-shared_1.jpg#preview' });
  const existing = await db.chatAttachmentDeletionJob.create({ data: { filename: 'bulk-orphan.jpg', storageProvider: 'local', storageKey: 'bulk-orphan.jpg' } });
  const queued = await db.$transaction(tx => queueUnusedAttachments(tx, ['bulk-orphan.jpg', 'bulk-shared_1.jpg', 'bulk-sharedX1.jpg', 'bulk-orphan.jpg']));
  assert.deepEqual(queued, ['bulk-orphan.jpg']);
  assert.deepEqual(await db.chatAttachmentDeletionJob.findUnique({ where: { filename: 'bulk-orphan.jpg' } }), existing);
  assert.equal(await db.chatUpload.count({ where: { pendingDeletion: true } }), 1);
});

test('legacy reported attachments copy once per batch and stay until every report has independent evidence', async () => {
  await upload('evidence-one.jpg'); await upload('evidence-two.jpg');
  const first = await message({ id: 'evidence-message-01', attachmentUrl: '/uploads/chat/evidence-one.jpg', content: 'first reported image' });
  const second = await message({ id: 'evidence-message-02', attachmentUrl: '/uploads/chat/evidence-two.jpg', content: 'second reported image' });
  const plain = await message({ id: 'evidence-message-03', content: 'ordinary expired message' });
  await db.contentReport.createMany({ data: [first, first, second].map(item => ({ messageId: item.id, reporterId: seed.b.owner.id, reporterType: 'CUSTOMER', reason: 'ABUSE' })) });
  const schedule = retentionSchedule(now); await db.chatRetentionRun.create({ data: schedule });
  const firstPass = await expireChatBatch(schedule.id, { db });
  assert.equal(firstPass.evidenceCaptured, 1); assert.equal(firstPass.removed, 1); assert.equal(firstPass.complete, false);
  assert.equal(await db.message.findUnique({ where: { id: plain.id } }), null);
  assert.ok(await db.message.findUnique({ where: { id: first.id } }));
  assert.ok(await db.message.findUnique({ where: { id: second.id } }));
  const secondPass = await expireChatBatch(schedule.id, { db });
  assert.equal(secondPass.evidenceCaptured, 1); assert.equal(secondPass.removed, 1);
  assert.equal(await db.message.findUnique({ where: { id: first.id } }), null);
  assert.ok(await db.message.findUnique({ where: { id: second.id } }));
  const thirdPass = await expireChatBatch(schedule.id, { db });
  assert.equal(thirdPass.evidenceCaptured, 1); assert.equal(thirdPass.removed, 1);
  assert.equal((await expireChatBatch(schedule.id, { db })).complete, true);
  const reports = await db.contentReport.findMany();
  assert.ok(reports.every(report => report.messageId === null && report.evidence.attachmentStatus === 'CAPTURED'));
  assert.equal(new Set(reports.map(report => report.evidenceFile)).size, 3);
  for (const report of reports) assert.equal(await fs.readFile(path.join(root, 'evidence', report.evidenceFile), 'utf8'), 'synthetic bytes');
});
