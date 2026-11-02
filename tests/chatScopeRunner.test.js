import { after, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { getPrisma, resetDatabase, seedBase, createCompanyStaff } from './helpers/harness.js';
import { runShopChatScope, runPrismaChatScope, MIGRATION } from '../scripts/applyShopChatScope.js';

let db, client, seed, direct, dangling;
beforeEach(async () => {
  await client?.end();
  await resetDatabase(); db = await getPrisma(); seed = await seedBase(db);
  const employee = await createCompanyStaff(db, { email: 'migration@fixture.test', passwordHash: seed.passwordHash, permissions: [] });
  await db.shopEmployeeMembership.create({ data: { employeeId: employee.id, shopId: seed.a.shop.id, status: 'ACTIVE', permissions: [] } });
  direct = await db.chat.create({ data: { type: 'PERSONAL', name: 'Preserved private history', participants: { create: [
    { userId: seed.a.owner.id, userType: 'CUSTOMER' }, { userId: employee.id, userType: 'EMPLOYEE' },
  ] }, messages: { create: { content: 'Keep this exact message', senderId: employee.id, senderType: 'EMPLOYEE' } } } });
  dangling = await db.shop.create({ data: { name: 'Missing team', address: 'Fixture', mobile: 'fixture', shopType: 'CUSTOMER', groupChatId: 'missing-team-fixture' } });
  await db.supermarketOwnership.create({ data: { shopId: dangling.id, customerId: seed.a.owner.id, source: 'TEST' } });
  client = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL }); await client.connect();
  await client.query('ALTER TABLE "Chat" DROP COLUMN "shopId" CASCADE');
  await client.query(`CREATE TABLE "_prisma_migrations" (
    id varchar(36) PRIMARY KEY, checksum varchar(64) NOT NULL, finished_at timestamptz,
    migration_name varchar(255) NOT NULL, logs text, rolled_back_at timestamptz,
    started_at timestamptz NOT NULL DEFAULT now(), applied_steps_count integer NOT NULL DEFAULT 0
  )`);
  await client.query(`INSERT INTO "_prisma_migrations" (id, checksum, migration_name, finished_at) VALUES ('existing','unchanged','previous_migration',now())`);
});
after(async () => { await client?.end(); await db?.$disconnect(); });
const history = async () => JSON.stringify((await client.query(`SELECT jsonb_build_object(
  'messages',(SELECT jsonb_agg(to_jsonb(m) ORDER BY id) FROM "Message" m),
  'participants',(SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM "ChatParticipant" p)
) AS data`)).rows[0].data);
const hasColumn = async () => (await client.query(`SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='Chat' AND column_name='shopId'`)).rowCount === 1;

test('default migration run is read-only and reports only reviewed chat changes', async () => {
  const before = await history();
  const plan = await runShopChatScope(client);
  assert.equal(plan.mode, 'dry-run'); assert.equal(plan.committed, false);
  assert.equal(plan.planned.newCanonicalTeams, 1);
  assert.ok(plan.pendingMigrations.includes(MIGRATION));
  assert.ok(plan.pendingMigrations.includes('20261017210000_packaging_without_outer_barcode'));
  assert.equal(await hasColumn(), false); assert.equal(await history(), before);
  assert.equal((await client.query('SELECT count(*)::int AS n FROM "_prisma_migrations"')).rows[0].n, 1);
});

test('targeted migration commits schema and ledger together, preserves history and is safe to rerun', async () => {
  const before = await history();
  const applied = await runShopChatScope(client, { apply: true });
  assert.equal(applied.committed, true);
  assert.equal(applied.after.chats, applied.before.chats + 1);
  assert.equal(await history(), before);
  assert.equal((await db.chat.findUniqueOrThrow({ where: { id: direct.id } })).shopId, seed.a.shop.id);
  assert.equal((await db.chat.findUniqueOrThrow({ where: { id: dangling.groupChatId } })).shopId, dangling.id);
  const ledger = (await client.query('SELECT migration_name,checksum FROM "_prisma_migrations" ORDER BY migration_name')).rows;
  assert.deepEqual(ledger.map(row => row.migration_name), [MIGRATION, 'previous_migration']);
  assert.equal(ledger.find(row => row.migration_name === MIGRATION).checksum, applied.checksum);
  assert.equal(ledger.find(row => row.migration_name === 'previous_migration').checksum, 'unchanged');
  const replay = await runShopChatScope(client, { apply: true });
  assert.equal(replay.status, 'already-applied'); assert.equal(replay.committed, false);
  assert.equal(await history(), before);
});

test('preservation verification failure rolls back schema, message changes and migration ledger', async () => {
  const before = await history();
  const intercepted = { query: async (sql, values) => {
    const result = await client.query(sql, values);
    if (sql.includes('ALTER TABLE "Chat" ADD COLUMN')) await client.query(`UPDATE "Message" SET content='Injected failure inside disposable test transaction'`);
    return result;
  } };
  await assert.rejects(runShopChatScope(intercepted, { apply: true }), /Message history changed unexpectedly/);
  assert.equal(await hasColumn(), false); assert.equal(await history(), before);
  assert.equal((await client.query('SELECT count(*)::int AS n FROM "_prisma_migrations"')).rows[0].n, 1);
});


test('application Prisma driver applies the same guarded transaction and defaults to read-only', async () => {
  const before = await history();
  const plan = await runPrismaChatScope(db);
  assert.equal(plan.status, 'ready'); assert.equal(plan.committed, false);
  assert.equal(await hasColumn(), false);
  const applied = await runPrismaChatScope(db, { apply: true });
  assert.equal(applied.committed, true); assert.equal(await hasColumn(), true);
  assert.equal(await history(), before);
  assert.equal((await runPrismaChatScope(db, { apply: true })).status, 'already-applied');
});

test('Prisma rolls back the complete repair when preservation checks fail', async () => {
  const before = await history();
  await client.query(`CREATE FUNCTION test_chat_preservation_failure() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN UPDATE "Message" SET content='Unexpected trigger mutation'; RETURN NEW; END $$`);
  await client.query(`CREATE TRIGGER test_chat_preservation_failure AFTER UPDATE ON "Chat" FOR EACH ROW EXECUTE FUNCTION test_chat_preservation_failure()`);
  await assert.rejects(runPrismaChatScope(db, { apply: true }), /Message history changed unexpectedly/);
  assert.equal(await hasColumn(), false); assert.equal(await history(), before);
  assert.equal((await client.query('SELECT count(*)::int AS n FROM "_prisma_migrations"')).rows[0].n, 1);
});
