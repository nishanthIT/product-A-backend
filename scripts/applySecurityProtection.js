#!/usr/bin/env node
// Default: read-only preview. Only --apply can execute the single pinned migration.
import 'dotenv/config';
import pg from 'pg';
import fs from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

export const MIGRATION = '20261027130000_central_security_protection';
export const MIGRATION_SHA256 = 'f3fffd9be0a5004aea3b364f85ecca0c5d997c33051e0cad979895bdb544c797';
// Generated from this exact migration on disposable PostgreSQL, never from a
// production schema. It includes types/defaults, checks, indexes and trigger code.
const EXPECTED_SCHEMA_SHA256 = '0ad96d67894f0cc0b406261bc77a9e093cb83b051af5b3ae99eedec313b3afdb';
export const TABLES = ['SecurityAdminAudit', 'SecurityEvent', 'SecurityException', 'SecurityPolicy', 'SecurityRestriction'];
const INDEXES = [
  ...TABLES.map(table => `${table}_pkey`), 'SecurityEvent_createdAt_idx', 'SecurityEvent_subjectKey_createdAt_idx',
  'SecurityEvent_ipHash_createdAt_idx', 'SecurityEvent_category_severity_createdAt_idx', 'SecurityEvent_status_createdAt_idx',
  'SecurityRestriction_subjectKey_scope_key', 'SecurityRestriction_until_idx',
  'SecurityException_subjectKey_scope_until_idx', 'SecurityAdminAudit_createdAt_idx',
];
const FUNCTION = 'paymi_security_audit_append_only';
const SEQUENCE = 'SecurityAdminAudit_sequence_seq';
const TRIGGERS = ['security_audit_append_only', 'security_audit_no_truncate'];
const fail = message => { throw Object.assign(new Error(message), { code: 'SECURITY_MIGRATION_REVIEW_REQUIRED' }); };
const ensure = (condition, message) => { if (!condition) fail(message); };
const digest = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');

/** Metadata only. No account, chat, catalogue or security-event rows are read. */
export async function inspectSecuritySchema(db) {
  const tables = (await db.query(`SELECT c.relname AS name,c.relkind AS kind,c.relpersistence AS persistence,
      c.relrowsecurity AS row_security,c.relforcerowsecurity AS force_row_security,c.relispartition AS partition
    FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relname=ANY($1::text[]) ORDER BY c.relname`, [TABLES])).rows;
  const columns = (await db.query(`SELECT c.relname AS table_name,a.attnum AS position,a.attname AS name,
      pg_catalog.format_type(a.atttypid,a.atttypmod) AS type,a.attnotnull AS not_null,
      pg_catalog.pg_get_expr(d.adbin,d.adrelid) AS default_value,a.attidentity AS identity,a.attgenerated AS generated
    FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_class c ON c.oid=a.attrelid
    JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
    WHERE n.nspname='public' AND c.relname=ANY($1::text[]) AND a.attnum>0 AND NOT a.attisdropped
    ORDER BY c.relname,a.attnum`, [TABLES])).rows;
  const indexes = (await db.query(`SELECT ic.relname AS name,tc.relname AS table_name,
      pg_catalog.pg_get_indexdef(i.indexrelid) AS definition,i.indisvalid AS valid,i.indisready AS ready
    FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class ic ON ic.oid=i.indexrelid
    JOIN pg_catalog.pg_class tc ON tc.oid=i.indrelid JOIN pg_catalog.pg_namespace n ON n.oid=ic.relnamespace
    WHERE n.nspname='public' AND (tc.relname=ANY($1::text[]) OR ic.relname=ANY($2::text[])) ORDER BY ic.relname`, [TABLES, INDEXES])).rows;
  const constraints = (await db.query(`SELECT c.relname AS table_name,k.conname AS name,k.contype AS type,
      pg_catalog.pg_get_constraintdef(k.oid) AS definition,k.convalidated AS validated,
      k.condeferrable AS deferrable,k.condeferred AS deferred
    FROM pg_catalog.pg_constraint k JOIN pg_catalog.pg_class c ON c.oid=k.conrelid
    JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relname=ANY($1::text[]) AND k.contype<>'n' ORDER BY c.relname,k.conname`, [TABLES])).rows;
  const functions = (await db.query(`SELECT p.proname AS name,pg_catalog.pg_get_function_identity_arguments(p.oid) AS arguments,
      pg_catalog.pg_get_function_result(p.oid) AS result,l.lanname AS language,p.prosrc AS source,
      p.prosecdef AS security_definer,p.provolatile AS volatility,p.proparallel AS parallel,p.proisstrict AS strict,
      p.proleakproof AS leakproof,p.proconfig AS settings
    FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
    JOIN pg_catalog.pg_language l ON l.oid=p.prolang
    WHERE n.nspname='public' AND p.proname=$1 ORDER BY arguments`, [FUNCTION])).rows;
  const triggers = (await db.query(`SELECT c.relname AS table_name,t.tgname AS name,t.tgenabled AS enabled,
      pg_catalog.pg_get_triggerdef(t.oid) AS definition
    FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid=t.tgrelid
    JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND NOT t.tgisinternal AND (c.relname=ANY($1::text[]) OR t.tgname=ANY($2::text[]))
    ORDER BY c.relname,t.tgname`, [TABLES, TRIGGERS])).rows;
  const sequences = (await db.query(`SELECT c.relname AS name,pg_catalog.format_type(s.seqtypid,NULL) AS type,
      s.seqstart::text AS start,s.seqincrement::text AS increment,s.seqmin::text AS minimum,
      s.seqmax::text AS maximum,s.seqcache::text AS cache,s.seqcycle AS cycle,
      tc.relname AS owned_table,a.attname AS owned_column
    FROM pg_catalog.pg_sequence s JOIN pg_catalog.pg_class c ON c.oid=s.seqrelid
    JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    LEFT JOIN pg_catalog.pg_depend d ON d.classid='pg_class'::regclass AND d.objid=c.oid AND d.deptype='a'
    LEFT JOIN pg_catalog.pg_class tc ON tc.oid=d.refobjid
    LEFT JOIN pg_catalog.pg_attribute a ON a.attrelid=d.refobjid AND a.attnum=d.refobjsubid
    WHERE n.nspname='public' AND c.relname=$1 ORDER BY c.relname`, [SEQUENCE])).rows;
  const rules = (await db.query(`SELECT tablename AS table_name,rulename AS name,definition FROM pg_catalog.pg_rules
    WHERE schemaname='public' AND tablename=ANY($1::text[]) ORDER BY tablename,rulename`, [TABLES])).rows;
  return { tables, columns, indexes, constraints, functions, triggers, sequences, rules };
}

/** Pass an already-connected pg client. Every invocation owns its transaction. */
export async function runSecurityProtectionMigration(db, { apply = false } = {}) {
  const sql = await fs.readFile(new URL(`../prisma/migrations/${MIGRATION}/migration.sql`, import.meta.url), 'utf8');
  ensure(digest(sql) === MIGRATION_SHA256, 'Migration SQL differs from its reviewed checksum. Review the migration and runner together.');
  await db.query(apply ? 'BEGIN' : 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  let commitSent = false;
  try {
    await db.query("SET LOCAL search_path TO public, pg_catalog");
    await db.query("SET LOCAL lock_timeout='10s'");
    await db.query("SET LOCAL statement_timeout='60s'");
    ensure((await db.query(`SELECT to_regclass('public."_prisma_migrations"') IS NOT NULL AS present`)).rows[0].present,
      'Prisma migration ledger is missing; baseline review is required. This runner will not create or infer it.');
    if (apply) {
      await db.query(`SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, [`paymi:${MIGRATION}`]);
      await db.query('LOCK TABLE public."_prisma_migrations" IN SHARE ROW EXCLUSIVE MODE');
    }
    const state = await inspectSecuritySchema(db);
    const schemaFingerprint = digest(state);
    const present = Object.values(state).some(rows => rows.length > 0);
    const complete = schemaFingerprint === EXPECTED_SCHEMA_SHA256;
    const records = (await db.query(`SELECT id,checksum,migration_name,finished_at,rolled_back_at,started_at,applied_steps_count
      FROM public."_prisma_migrations" ORDER BY migration_name,id`)).rows;
    const own = records.filter(row => row.migration_name === MIGRATION);
    ensure(!own.some(row => !row.finished_at && !row.rolled_back_at), 'An unfinished security migration exists; review it before retrying.');
    const applied = own.filter(row => row.finished_at && !row.rolled_back_at);
    ensure(applied.length <= 1, 'Duplicate completed security migration records require manual review.');
    ensure(!applied.length || applied[0].checksum === MIGRATION_SHA256, 'Recorded security migration checksum differs from the reviewed SQL.');
    ensure(!present || complete, 'Security schema is partial or drifted. No changes were made; inspect the schema before proceeding.');
    ensure(!applied.length || complete, 'Security migration is recorded but its schema is missing. No changes were made.');
    const action = applied.length ? 'none' : complete ? 'record-existing-exact-schema' : 'create-security-schema-and-record';
    const otherRecords = records.filter(row => row.migration_name !== MIGRATION);
    const result = {
      migration: MIGRATION, checksum: MIGRATION_SHA256, mode: apply ? 'apply' : 'dry-run', committed: false,
      status: applied.length ? 'already-applied' : 'ready', action, schemaFingerprint,
      missingTables: TABLES.filter(name => !state.tables.some(row => row.name === name)),
      planned: { createTables: complete ? [] : TABLES, createAuditTriggers: complete ? [] : TRIGGERS,
        recordMigration: applied.length ? null : MIGRATION, existingBusinessRowsChanged: 0, existingRowsDeleted: 0 },
      unrelatedMigrationRecordsUntouched: otherRecords.length,
    };
    if (!apply || action === 'none') { await db.query('ROLLBACK'); return result; }
    if (!complete) {
      await db.query(sql);
      ensure(digest(await inspectSecuritySchema(db)) === EXPECTED_SCHEMA_SHA256, 'Applied security schema differs from its reviewed shape; transaction rolled back.');
    }
    await db.query(`INSERT INTO public."_prisma_migrations" (id,checksum,finished_at,migration_name,logs,rolled_back_at,started_at,applied_steps_count)
      VALUES ($1,$2,now(),$3,NULL,NULL,now(),1)`, [randomUUID(), MIGRATION_SHA256, MIGRATION]);
    const afterOther = (await db.query(`SELECT id,checksum,migration_name,finished_at,rolled_back_at,started_at,applied_steps_count
      FROM public."_prisma_migrations" WHERE migration_name<>$1 ORDER BY migration_name,id`, [MIGRATION])).rows;
    ensure(digest(otherRecords) === digest(afterOther), 'Unrelated migration records changed; transaction rolled back.');
    // A network failure after sending COMMIT does not establish whether the
    // server committed. Only a fresh read-only inspection can resolve that case.
    commitSent = true;
    await db.query('COMMIT');
    return { ...result, committed: true, status: complete ? 'recorded-existing-schema' : 'applied', missingTables: [] };
  } catch (error) {
    error.migrationCommitStatus = commitSent ? 'unknown' : 'not-committed';
    await db.query('ROLLBACK').catch(() => {});
    throw error;
  }
}

export function migrationFailureReport(error, completedResult) {
  const commitStatus = completedResult?.committed ? 'committed' : error.migrationCommitStatus || 'not-committed';
  return { migration: MIGRATION, committed: commitStatus === 'unknown' ? null : commitStatus === 'committed', commitStatus,
    recheckRequired: commitStatus === 'unknown',
    error: commitStatus === 'unknown'
      ? 'Commit acknowledgement was lost. Run --dry-run to determine database state before retrying --apply.'
      : completedResult?.committed ? 'Migration committed, but reporting failed. Run --dry-run to verify.'
        : error.code === 'SECURITY_MIGRATION_REVIEW_REQUIRED' ? error.message : 'Database operation failed; no migration was committed.',
    code: error.code || 'CONNECTION_FAILED' };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args[0] && !['--dry-run', '--apply'].includes(args[0]))) {
    console.error('Usage: node scripts/applySecurityProtection.js [--dry-run|--apply]'); process.exitCode = 1;
  } else if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is required.'); process.exitCode = 1;
  } else {
    const db = new pg.Client({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 15000, application_name: 'paymi-security-migration' });
    let completedResult;
    try { await db.connect(); completedResult = await runSecurityProtectionMigration(db, { apply: args[0] === '--apply' }); console.log(JSON.stringify(completedResult, null, 2)); }
    catch (error) {
      // Driver messages can contain database URLs or values. Only our own fixed
      // review messages and a SQLSTATE/code reach the terminal.
      console.error(JSON.stringify(migrationFailureReport(error, completedResult))); process.exitCode = 1;
    } finally { await db.end().catch(() => {}); }
  }
}
