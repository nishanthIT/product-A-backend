#!/usr/bin/env node
// Preview is read-only. --apply executes exactly one reviewed additive migration.
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import fs from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

export const MIGRATION = '20261026090000_chat_delivery_retention_storage';
const REVIEWED_SHA256 = 'b89d718f21c09d4787b67e0b58d840950beea7190391d16f35d547ae941665ce';
const fingerprint = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const ensure = (condition, message) => { if (!condition) throw new Error(message); };
const uploadColumns = ['storageProvider', 'storageKey', 'storageBucket', 'storageEndpoint', 'storageVersionId', 'contentType', 'pendingDeletion'];
const requiredColumns = {
  ChatUpload: uploadColumns,
  MessageDelivery: ['id', 'messageId', 'userId', 'userType', 'deliveredAt'],
  ChatRetentionRun: ['id', 'cutoff', 'status', 'removed', 'attempts', 'lastError', 'createdAt', 'updatedAt', 'completedAt'],
  ChatAttachmentDeletionJob: ['filename', 'storageProvider', 'storageKey', 'storageBucket', 'storageEndpoint', 'storageVersionId', 'contentType', 'attempts', 'lastError', 'nextAttemptAt', 'createdAt', 'updatedAt'],
};
const requiredIndexes = ['MessageDelivery_pkey', 'MessageDelivery_messageId_userId_userType_key', 'MessageDelivery_userId_userType_idx',
  'Message_createdAt_id_idx', 'Message_attachmentUrl_idx', 'ChatRetentionRun_pkey', 'ChatAttachmentDeletionJob_pkey', 'ChatAttachmentDeletionJob_nextAttemptAt_idx'];

async function schemaState(db) {
  const columns = (await db.query(`SELECT table_name,column_name,data_type,is_nullable,column_default FROM information_schema.columns
    WHERE table_schema=current_schema() AND table_name=ANY($1::text[]) ORDER BY table_name,ordinal_position`, [Object.keys(requiredColumns)])).rows
    .filter(row => requiredColumns[row.table_name].includes(row.column_name));
  const indexes = (await db.query(`SELECT indexname FROM pg_indexes WHERE schemaname=current_schema() AND indexname=ANY($1::text[])`, [requiredIndexes])).rows;
  return { columns, indexes };
}

function schemaComplete(state) {
  const complete = Object.entries(requiredColumns).every(([table, columns]) => columns.every(name => state.columns.some(column => column.table_name === table && column.column_name === name)));
  const pendingDeletion = state.columns.find(column => column.table_name === 'ChatUpload' && column.column_name === 'pendingDeletion');
  const nullableMetadata = state.columns.filter(column => column.table_name === 'ChatUpload' && column.column_name !== 'pendingDeletion');
  return complete && requiredIndexes.every(name => state.indexes.some(index => index.indexname === name))
    && pendingDeletion?.data_type === 'boolean' && pendingDeletion.is_nullable === 'NO' && pendingDeletion.column_default === 'false'
    && nullableMetadata.every(column => column.data_type === 'text' && column.is_nullable === 'YES');
}

async function snapshot(db) {
  const result = {};
  for (const table of ['Chat', 'Message', 'ChatParticipant', 'ChatUpload']) {
    // Existing column values are compared byte-for-byte after JSON canonicalization.
    // New nullable metadata/default fields are deliberately excluded.
    const subtract = table === 'ChatUpload' ? ` - ARRAY[${uploadColumns.map(name => `'${name}'`).join(',')}]::text[]` : '';
    const key = table === 'ChatUpload' ? 'filename' : 'id';
    const rows = (await db.query(`SELECT to_jsonb(t)${subtract} AS row FROM "${table}" t ORDER BY "${key}"`)).rows.map(row => row.row);
    result[table] = { count: rows.length, sha256: fingerprint(rows) };
  }
  return result;
}

/** An already-connected pg-compatible client; output contains counts, never history. */
export async function runChatDeliveryStorage(db, { apply = false, manageTransaction = true } = {}) {
  const sql = await fs.readFile(new URL(`../prisma/migrations/${MIGRATION}/migration.sql`, import.meta.url), 'utf8');
  const checksum = createHash('sha256').update(sql).digest('hex');
  ensure(checksum === REVIEWED_SHA256, 'Migration SQL differs from the reviewed checksum. Review it before applying.');
  if (manageTransaction) await db.query(apply ? 'BEGIN' : 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try {
    await db.query("SET LOCAL lock_timeout='10s'");
    await db.query("SET LOCAL statement_timeout='120s'");
    if (apply) {
      // These bounded locks prevent concurrent data changes from producing a
      // false preservation result while the additive schema/indexes are built.
      await db.query('LOCK TABLE "ChatUpload", "Message" IN ACCESS EXCLUSIVE MODE');
      await db.query('LOCK TABLE "Chat", "ChatParticipant" IN SHARE MODE');
      await db.query('LOCK TABLE "_prisma_migrations" IN SHARE ROW EXCLUSIVE MODE');
    }
    const state = await schemaState(db);
    const records = (await db.query('SELECT checksum,finished_at,rolled_back_at FROM "_prisma_migrations" WHERE migration_name=$1', [MIGRATION])).rows;
    const applied = records.find(row => row.finished_at && !row.rolled_back_at);
    if (applied) {
      ensure(applied.checksum === checksum && schemaComplete(state), 'Recorded migration and database schema do not match; manual review required.');
      if (manageTransaction) await db.query('ROLLBACK');
      return { migration: MIGRATION, mode: apply ? 'apply' : 'dry-run', status: 'already-applied', committed: false };
    }
    ensure(!records.some(row => !row.finished_at && !row.rolled_back_at), 'An unfinished migration exists; review it before retrying.');
    ensure(state.columns.length === 0 && state.indexes.length === 0, 'Delivery/retention storage schema exists without its applied migration; inspect its state before proceeding.');
    const completed = (await db.query('SELECT migration_name FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL')).rows.map(row => row.migration_name);
    const directories = await fs.readdir(new URL('../prisma/migrations/', import.meta.url), { withFileTypes: true });
    const pendingMigrations = directories.filter(directory => directory.isDirectory() && !completed.includes(directory.name)).map(directory => directory.name).sort();
    const before = await snapshot(db);
    const counts = value => Object.fromEntries(Object.entries(value).map(([table, entry]) => [table, entry.count]));
    const result = { migration: MIGRATION, checksum, mode: apply ? 'apply' : 'dry-run', committed: false, pendingMigrations,
      before: counts(before), planned: { nullableUploadMetadataColumns: 6, uploadDeletionBarrier: true, newTables: Object.keys(requiredColumns).filter(name => name !== 'ChatUpload'), messagesToDelete: 0 } };
    if (!apply) { if (manageTransaction) await db.query('ROLLBACK'); return { ...result, status: 'ready' }; }
    await db.query(sql);
    ensure(schemaComplete(await schemaState(db)), 'Applied schema differs from the reviewed delivery/storage migration.');
    const after = await snapshot(db);
    for (const table of Object.keys(before)) ensure(fingerprint(before[table]) === fingerprint(after[table]), `${table} history changed unexpectedly.`);
    const defaults = (await db.query(`SELECT count(*)::int AS n FROM "ChatUpload" WHERE "pendingDeletion"
      OR "storageProvider" IS NOT NULL OR "storageKey" IS NOT NULL OR "storageBucket" IS NOT NULL
      OR "storageEndpoint" IS NOT NULL OR "storageVersionId" IS NOT NULL OR "contentType" IS NOT NULL`)).rows[0].n;
    ensure(defaults === 0, 'Existing uploads received unexpected provider or deletion metadata.');
    for (const table of Object.keys(requiredColumns).filter(name => name !== 'ChatUpload')) {
      ensure((await db.query(`SELECT count(*)::int AS n FROM "${table}"`)).rows[0].n === 0, 'New delivery/retention tables contain unexpected records.');
    }
    // Record only the checked migration in this same transaction. Unrelated
    // pending migrations remain untouched; applying schema does not run expiry.
    await db.query(`INSERT INTO "_prisma_migrations" (id,checksum,finished_at,migration_name,logs,rolled_back_at,started_at,applied_steps_count)
      VALUES ($1,$2,now(),$3,NULL,NULL,now(),1)`, [randomUUID(), checksum, MIGRATION]);
    if (manageTransaction) await db.query('COMMIT');
    return { ...result, status: 'applied', committed: true, after: counts(after), preserved: { messages: true, chats: true, participants: true, existingUploads: true } };
  } catch (error) {
    if (manageTransaction) await db.query('ROLLBACK').catch(() => {});
    throw error;
  }
}

/** Same driver as the app, with schema and ledger enclosed in one transaction. */
export async function runPrismaChatDeliveryStorage(prisma, { apply = false } = {}) {
  const migrationSql = await fs.readFile(new URL(`../prisma/migrations/${MIGRATION}/migration.sql`, import.meta.url), 'utf8');
  return prisma.$transaction(async tx => {
    if (!apply) await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
    const adapter = { query: async (sql, values = []) => {
      if (sql === migrationSql) {
        for (const statement of sql.replace(/--[^\n]*/g, '').split(';').map(value => value.trim()).filter(Boolean)) await tx.$executeRawUnsafe(statement);
        return { rows: [] };
      }
      if (/^\s*(SELECT|WITH)\b/i.test(sql)) return { rows: await tx.$queryRawUnsafe(sql, ...values) };
      return { rows: [], rowCount: await tx.$executeRawUnsafe(sql, ...values) };
    } };
    return runChatDeliveryStorage(adapter, { apply, manageTransaction: false });
  }, { isolationLevel: 'RepeatableRead', maxWait: 10000, timeout: 120000 });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args[0] && !['--apply', '--dry-run'].includes(args[0]))) {
    console.error('Usage: node scripts/applyChatDeliveryStorage.js [--dry-run|--apply]'); process.exitCode = 1;
  } else {
    const db = new PrismaClient();
    try { console.log(JSON.stringify(await runPrismaChatDeliveryStorage(db, { apply: args[0] === '--apply' }), null, 2)); }
    catch (error) {
      console.error(JSON.stringify({ migration: MIGRATION, committed: false, error: error.code ? 'Database operation failed; transaction rolled back.' : error.message, code: error.code }));
      process.exitCode = 1;
    } finally { await db.$disconnect(); }
  }
}
