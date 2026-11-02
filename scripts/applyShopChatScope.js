#!/usr/bin/env node
// Read-only by default. Only --apply permits the reviewed, transactional change.
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import fs from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

export const MIGRATION = '20261024100000_shop_chat_scope';
const REVIEWED_SHA256 = '1a50bb65d2141381bdadec1cf4af884d08ebacb47d22b759f84ea71f3e261f90';
const fingerprint = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const ensure = (condition, message) => { if (!condition) throw new Error(message); };

async function snapshot(db) {
  const chats = (await db.query('SELECT to_jsonb(c) - \'shopId\' AS row FROM "Chat" c ORDER BY id')).rows.map(r => r.row);
  const messages = (await db.query('SELECT to_jsonb(m) AS row FROM "Message" m ORDER BY id')).rows.map(r => r.row);
  const participants = (await db.query('SELECT to_jsonb(p) AS row FROM "ChatParticipant" p ORDER BY id')).rows.map(r => r.row);
  return { chats, messages: { count: messages.length, sha256: fingerprint(messages) }, participants: { count: participants.length, sha256: fingerprint(participants) } };
}

async function expectedAdditions(db) {
  return (await db.query(`SELECT s."groupChatId" AS id, s.id AS "shopId", s.name || ' - Team Chat' AS name
    FROM "Shop" s WHERE s."shopType"='CUSTOMER' AND s."groupChatId" IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM "Chat" c WHERE c.id=s."groupChatId")
      AND (SELECT count(*) FROM "Shop" linked WHERE linked."groupChatId"=s."groupChatId")=1
      AND (EXISTS (SELECT 1 FROM "SupermarketOwnership" o WHERE o."shopId"=s.id)
        OR EXISTS (SELECT 1 FROM "ShopEmployeeMembership" m WHERE m."shopId"=s.id AND m.status='ACTIVE'))
    ORDER BY s."groupChatId"`)).rows;
}

async function expectedScopes(db) {
  return (await db.query(`WITH links AS (
      SELECT "groupChatId" AS id,min(id) AS "shopId" FROM "Shop" WHERE "groupChatId" IS NOT NULL
      GROUP BY "groupChatId" HAVING count(*)=1 AND bool_and("shopType"='CUSTOMER')
    ), eligible AS (
      SELECT 'CUSTOMER'::text AS kind,"customerId" AS uid,"shopId" FROM "SupermarketOwnership" WHERE "shopType"='CUSTOMER'
      UNION SELECT 'EMPLOYEE',m."employeeId",m."shopId" FROM "ShopEmployeeMembership" m JOIN "Shop" s ON s.id=m."shopId"
      WHERE m.status='ACTIVE' AND s."shopType"='CUSTOMER'
    ), candidates AS (
      SELECT p."chatId",e."shopId" FROM "ChatParticipant" p JOIN eligible e ON e.uid=p."userId" AND e.kind=p."userType"::text
      GROUP BY p."chatId",e."shopId" HAVING count(*)=(SELECT count(*) FROM "ChatParticipant" a WHERE a."chatId"=p."chatId")
    ), unique_shop AS (SELECT "chatId",min("shopId") AS "shopId" FROM candidates GROUP BY "chatId" HAVING count(*)=1)
    SELECT c.id, l."shopId" FROM "Chat" c JOIN links l ON l.id=c.id WHERE c.type='GROUP' AND c.name IS DISTINCT FROM 'ALL Chat'
    UNION ALL
    SELECT c.id,u."shopId" FROM "Chat" c JOIN unique_shop u ON u."chatId"=c.id
    WHERE c.name IS DISTINCT FROM 'ALL Chat' AND NOT EXISTS (SELECT 1 FROM "Shop" s WHERE s."groupChatId"=c.id)
      AND ((c.type='PERSONAL' AND (SELECT count(*) FROM "ChatParticipant" p WHERE p."chatId"=c.id)=2)
        OR (c.type='GROUP' AND (SELECT count(*) FROM "ChatParticipant" p WHERE p."chatId"=c.id)>=2))`)).rows;
}

/** Accepts an already connected pg Client. Never logs identities or history. */
export async function runShopChatScope(db, { apply = false, manageTransaction = true } = {}) {
  const sql = await fs.readFile(new URL(`../prisma/migrations/${MIGRATION}/migration.sql`, import.meta.url), 'utf8');
  const checksum = createHash('sha256').update(sql).digest('hex');
  ensure(checksum === REVIEWED_SHA256, 'Migration SQL differs from the reviewed checksum. Review it before applying.');
  if (manageTransaction) await db.query(apply ? 'BEGIN' : 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try {
    await db.query("SET LOCAL lock_timeout='10s'");
    await db.query("SET LOCAL statement_timeout='120s'");
    if (apply) {
      // Freeze the exact rows being validated and the relationships determining
      // eligibility. Bounded locks fail/roll back instead of waiting forever.
      await db.query('LOCK TABLE "Chat" IN ACCESS EXCLUSIVE MODE');
      await db.query('LOCK TABLE "Message", "ChatParticipant", "Shop", "SupermarketOwnership", "ShopEmployeeMembership" IN SHARE MODE');
      await db.query('LOCK TABLE "_prisma_migrations" IN SHARE ROW EXCLUSIVE MODE');
    }
    const columns = (await db.query(`SELECT column_name FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='Chat' AND column_name='shopId'`)).rows;
    const records = (await db.query('SELECT checksum,finished_at,rolled_back_at FROM "_prisma_migrations" WHERE migration_name=$1', [MIGRATION])).rows;
    const applied = records.find(row => row.finished_at && !row.rolled_back_at);
    if (applied) {
      ensure(applied.checksum === checksum && columns.length === 1, 'Recorded migration and database schema do not match; manual review required.');
      if (manageTransaction) await db.query('ROLLBACK');
      return { migration: MIGRATION, mode: apply ? 'apply' : 'dry-run', status: 'already-applied', committed: false };
    }
    ensure(!records.some(row => !row.finished_at && !row.rolled_back_at), 'An unfinished migration exists; review it before retrying.');
    ensure(columns.length === 0, 'Chat.shopId already exists without an applied migration; inspect its state before proceeding.');
    const pending = (await db.query('SELECT migration_name FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL')).rows.map(r => r.migration_name);
    const directories = await fs.readdir(new URL('../prisma/migrations/', import.meta.url), { withFileTypes: true });
    const pendingMigrations = directories.filter(d => d.isDirectory() && !pending.includes(d.name)).map(d => d.name).sort();
    const before = await snapshot(db);
    const additions = await expectedAdditions(db);
    const scopes = await expectedScopes(db);
    const result = { migration: MIGRATION, checksum, mode: apply ? 'apply' : 'dry-run', committed: false, pendingMigrations,
      before: { chats: before.chats.length, messages: before.messages.count, participants: before.participants.count },
      planned: { newCanonicalTeams: additions.length, existingConversationsScoped: scopes.length },
    };
    if (!apply) { if (manageTransaction) await db.query('ROLLBACK'); return { ...result, status: 'ready' }; }

    await db.query(sql);
    const after = await snapshot(db);
    const oldIds = new Set(before.chats.map(chat => chat.id));
    ensure(fingerprint(after.chats.filter(chat => oldIds.has(chat.id))) === fingerprint(before.chats), 'Existing chat fields changed unexpectedly.');
    ensure(fingerprint(after.messages) === fingerprint(before.messages), 'Message history changed unexpectedly.');
    ensure(fingerprint(after.participants) === fingerprint(before.participants), 'Participant history changed unexpectedly.');
    const newRows = after.chats.filter(chat => !oldIds.has(chat.id));
    ensure(newRows.length === additions.length && newRows.every(chat => additions.some(expected => expected.id === chat.id && expected.name === chat.name && chat.type === 'GROUP')), 'Unexpected canonical team additions.');
    const expected = new Map([...scopes, ...additions].map(row => [row.id, row.shopId]));
    const actual = (await db.query('SELECT id,"shopId" FROM "Chat" ORDER BY id')).rows;
    ensure(actual.every(chat => chat.shopId === (expected.get(chat.id) ?? null)), 'Shop associations differ from reviewed eligibility.');

    // Same SHA256 and ledger columns Prisma uses. Record only this migration in
    // the same transaction: a failure cannot leave schema and ledger apart.
    await db.query(`INSERT INTO "_prisma_migrations" (id,checksum,finished_at,migration_name,logs,rolled_back_at,started_at,applied_steps_count)
      VALUES ($1,$2,now(),$3,NULL,NULL,now(),1)`, [randomUUID(), checksum, MIGRATION]);
    if (manageTransaction) await db.query('COMMIT');
    return { ...result, status: 'applied', committed: true, preserved: { messages: true, participants: true, existingChatFields: true }, after: { chats: after.chats.length, messages: after.messages.count, participants: after.participants.count } };
  } catch (error) {
    if (manageTransaction) await db.query('ROLLBACK').catch(() => {});
    throw error;
  }
}

/** Use the same connection driver as the application; Prisma owns the transaction. */
export async function runPrismaChatScope(prisma, { apply = false } = {}) {
  const migrationSql = await fs.readFile(new URL(`../prisma/migrations/${MIGRATION}/migration.sql`, import.meta.url), 'utf8');
  const result = await prisma.$transaction(async tx => {
    if (!apply) await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
    const adapter = { query: async (sql, values = []) => {
      // Only the fixed, checksummed migration contains multiple statements.
      // Prisma's prepared-query interface executes those statements individually
      // within this single transaction, retaining every preservation check.
      if (sql === migrationSql) {
        for (const statement of sql.replace(/--[^\n]*/g, '').split(';').map(value => value.trim()).filter(Boolean)) {
          await tx.$executeRawUnsafe(statement);
        }
        return { rows: [] };
      }
      if (/^\s*(SELECT|WITH)\b/i.test(sql)) return { rows: await tx.$queryRawUnsafe(sql, ...values) };
      return { rows: [], rowCount: await tx.$executeRawUnsafe(sql, ...values) };
    } };
    return runShopChatScope(adapter, { apply, manageTransaction: false });
  }, { isolationLevel: 'RepeatableRead', maxWait: 10000, timeout: 120000 });
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args[0] && !['--apply', '--dry-run'].includes(args[0]))) {
    console.error('Usage: node scripts/applyShopChatScope.js [--dry-run|--apply]'); process.exitCode = 1;
  } else {
    const db = new PrismaClient();
    try {
      console.log(JSON.stringify(await runPrismaChatScope(db, { apply: args[0] === '--apply' }), null, 2));
    } catch (error) {
      // Do not print PostgreSQL detail/query fields or connection credentials.
      console.error(JSON.stringify({ migration: MIGRATION, committed: false, error: error.code ? 'Database operation failed; transaction rolled back.' : error.message, code: error.code }));
      process.exitCode = 1;
    } finally { await db.$disconnect(); }
  }
}
