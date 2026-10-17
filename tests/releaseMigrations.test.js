import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import pg from 'pg';
import { getPrisma, resetDatabase, seedBase } from './helpers/harness.js';
let db;
before(async () => { await resetDatabase(); db = await getPrisma(); });
after(async () => { await db?.$disconnect(); });
test('release migrations upgrade the prior schema without replacing account IDs, passwords, ownership or tasks', async () => {
  const seed = await seedBase(db);
  const task = await db.task.create({ data: { title: 'Existing shared task', shopId: seed.a.shop.id, createdById: seed.a.owner.id } });
  const client = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
  await client.connect();
  try {
    await client.query('DROP TABLE "CacheEntry", "ModerationDeletionJob", "ChatModerationAction", "ChatSuspension", "ContentReport", "CommunityAcceptance", "UserBlock", "AccountDeletionJob", "ChatUpload", "RevokedSession"; ALTER TABLE "Customer" DROP COLUMN "sessionVersion"; ALTER TABLE "Admin" DROP COLUMN "sessionVersion"; ALTER TABLE "Task" DROP CONSTRAINT "Task_createdById_fkey"; ALTER TABLE "Task" ALTER COLUMN "createdById" SET NOT NULL; ALTER TABLE "Task" ADD CONSTRAINT "Task_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;');
    for (const migration of ['20261012120000_release_session_security', '20261012121000_private_chat_uploads', '20261012122000_account_deletion', '20261012123000_chat_safety', '20261012124000_moderation_evidence_suspension', '20261013100000_moderation_refinement', '20261014090000_database_cache_fallback']) {
      await client.query(await fs.readFile(new URL(`../prisma/migrations/${migration}/migration.sql`, import.meta.url), 'utf8'));
    }
    const owner = await db.customer.findUniqueOrThrow({ where: { id: seed.a.owner.id } });
    assert.equal(owner.password, seed.passwordHash); assert.equal(owner.sessionVersion, 0);
    assert.equal(await db.supermarketOwnership.count(), 2);
    assert.equal((await db.task.findUniqueOrThrow({ where: { id: task.id } })).createdById, owner.id);
    assert.equal(await db.accountDeletionJob.count(), 0);
    assert.equal(await db.cacheEntry.count(), 0);
  } finally { await client.end(); }
});
