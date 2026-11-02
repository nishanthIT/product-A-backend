import { after, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { getPrisma, resetDatabase, seedBase } from './helpers/harness.js';
import { runChatDeliveryStorage, runPrismaChatDeliveryStorage, MIGRATION } from '../scripts/applyChatDeliveryStorage.js';

let db, client;
beforeEach(async () => {
  await client?.end();
  await resetDatabase(); db = await getPrisma();
  const seed = await seedBase(db);
  await db.message.create({ data: { id: 'preserve-original-message', content: 'Exact original message',
    chatId: seed.a.shop.groupChatId, senderId: seed.a.owner.id, senderType: 'CUSTOMER',
    attachmentUrl: '/uploads/chat/legacy-preserved.jpg', createdAt: new Date('2025-01-01T00:00:00Z') } });
  await db.chatUpload.create({ data: { filename: 'legacy-preserved.jpg', uploaderId: seed.a.owner.id, uploaderType: 'CUSTOMER' } });
  client = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL }); await client.connect();
  // Reconstruct exactly the pre-release schema in this disposable database.
  await client.query('DROP TABLE "MessageDelivery", "ChatAttachmentDeletionJob", "ChatRetentionRun"');
  await client.query('DROP INDEX "Message_createdAt_id_idx", "Message_attachmentUrl_idx"');
  await client.query(`ALTER TABLE "ChatUpload" DROP COLUMN "storageProvider", DROP COLUMN "storageKey", DROP COLUMN "storageBucket",
    DROP COLUMN "storageEndpoint", DROP COLUMN "storageVersionId", DROP COLUMN "contentType", DROP COLUMN "pendingDeletion"`);
  await client.query(`CREATE TABLE "_prisma_migrations" (
    id varchar(36) PRIMARY KEY, checksum varchar(64) NOT NULL, finished_at timestamptz,
    migration_name varchar(255) NOT NULL, logs text, rolled_back_at timestamptz,
    started_at timestamptz NOT NULL DEFAULT now(), applied_steps_count integer NOT NULL DEFAULT 0
  )`);
  await client.query(`INSERT INTO "_prisma_migrations" (id, checksum, migration_name, finished_at) VALUES ('existing','unchanged','previous_migration',now())`);
});
after(async () => { await client?.end(); await db?.$disconnect(); });
const history = async () => JSON.stringify((await client.query(`SELECT jsonb_build_object(
  'chats',(SELECT jsonb_agg(to_jsonb(c) ORDER BY id) FROM "Chat" c),
  'messages',(SELECT jsonb_agg(to_jsonb(m) ORDER BY id) FROM "Message" m),
  'participants',(SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM "ChatParticipant" p),
  'uploads',(SELECT jsonb_agg(jsonb_build_object('filename',u.filename,'uploaderId',u."uploaderId",'uploaderType',u."uploaderType",'createdAt',u."createdAt") ORDER BY filename) FROM "ChatUpload" u)
) AS data`)).rows[0].data);
const hasColumn = async () => (await client.query(`SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='ChatUpload' AND column_name='storageProvider'`)).rowCount === 1;

test('delivery/storage migration defaults to read-only and reports zero message deletions', async () => {
  const before = await history();
  const plan = await runChatDeliveryStorage(client);
  assert.equal(plan.status, 'ready'); assert.equal(plan.mode, 'dry-run'); assert.equal(plan.committed, false);
  assert.equal(plan.planned.messagesToDelete, 0);
  assert.ok(plan.pendingMigrations.includes(MIGRATION));
  assert.ok(plan.pendingMigrations.includes('20261017210000_packaging_without_outer_barcode'));
  assert.equal(await hasColumn(), false); assert.equal(await history(), before);
  assert.equal((await client.query('SELECT count(*)::int AS n FROM "_prisma_migrations"')).rows[0].n, 1);
});

test('targeted additive apply preserves every existing history/upload field and can be replayed', async () => {
  const before = await history();
  const result = await runChatDeliveryStorage(client, { apply: true });
  assert.equal(result.committed, true); assert.deepEqual(result.after, result.before);
  assert.equal(await history(), before);
  const upload = (await client.query('SELECT * FROM "ChatUpload" WHERE filename=$1', ['legacy-preserved.jpg'])).rows[0];
  assert.equal(upload.pendingDeletion, false);
  for (const name of ['storageProvider', 'storageKey', 'storageBucket', 'storageEndpoint', 'storageVersionId', 'contentType']) assert.equal(upload[name], null);
  for (const table of ['MessageDelivery', 'ChatRetentionRun', 'ChatAttachmentDeletionJob']) assert.equal((await client.query(`SELECT count(*)::int AS n FROM "${table}"`)).rows[0].n, 0);
  const ledger = (await client.query('SELECT migration_name,checksum FROM "_prisma_migrations" ORDER BY migration_name')).rows;
  assert.deepEqual(ledger.map(row => row.migration_name), [MIGRATION, 'previous_migration']);
  assert.equal(ledger.find(row => row.migration_name === MIGRATION).checksum, result.checksum);
  assert.equal(ledger.find(row => row.migration_name === 'previous_migration').checksum, 'unchanged');
  assert.equal((await runChatDeliveryStorage(client, { apply: true })).status, 'already-applied');
  assert.equal(await history(), before);
});

test('a preservation failure rolls back schema, message changes and the migration ledger together', async () => {
  const before = await history();
  const intercepted = { query: async (sql, values) => {
    const result = await client.query(sql, values);
    if (sql.includes('ADD COLUMN "storageProvider"')) await client.query(`UPDATE "Message" SET content='Injected rollback test mutation'`);
    return result;
  } };
  await assert.rejects(runChatDeliveryStorage(intercepted, { apply: true }), /Message history changed unexpectedly/);
  assert.equal(await hasColumn(), false); assert.equal(await history(), before);
  assert.equal((await client.query('SELECT count(*)::int AS n FROM "_prisma_migrations"')).rows[0].n, 1);
});

test('application Prisma driver previews and applies the same guarded migration', async () => {
  const before = await history();
  assert.equal((await runPrismaChatDeliveryStorage(db)).status, 'ready');
  assert.equal(await hasColumn(), false);
  const applied = await runPrismaChatDeliveryStorage(db, { apply: true });
  assert.equal(applied.committed, true); assert.equal(await history(), before);
  assert.equal((await runPrismaChatDeliveryStorage(db, { apply: true })).status, 'already-applied');
});

test('an unrecorded partial schema is rejected without guessing or applying unrelated migrations', async () => {
  await client.query('ALTER TABLE "ChatUpload" ADD COLUMN "storageProvider" TEXT');
  const before = await history();
  await assert.rejects(runChatDeliveryStorage(client, { apply: true }), /exists without its applied migration/);
  assert.equal(await history(), before);
  assert.equal((await client.query('SELECT count(*)::int AS n FROM "_prisma_migrations"')).rows[0].n, 1);
});

test('recorded checksum/schema drift and unfinished migration records fail closed', async () => {
  await client.query(`INSERT INTO "_prisma_migrations" (id,checksum,migration_name) VALUES ('incomplete','unchecked',$1)`, [MIGRATION]);
  await assert.rejects(runChatDeliveryStorage(client), /unfinished migration/);
  await client.query('DELETE FROM "_prisma_migrations" WHERE id=$1', ['incomplete']);
  await runChatDeliveryStorage(client, { apply: true });
  await client.query('DROP INDEX "Message_attachmentUrl_idx"');
  await assert.rejects(runChatDeliveryStorage(client, { apply: true }), /schema do not match/);
});
