import { beforeEach, after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import pg from 'pg';
import { runSecurityProtectionMigration, inspectSecuritySchema, migrationFailureReport, MIGRATION, MIGRATION_SHA256, TABLES } from '../scripts/applySecurityProtection.js';

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('A disposable local TEST_DATABASE_URL is required');
const target = new URL(url);
if (!['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname) || !/test/i.test(target.pathname)) throw new Error('Refusing to reset a nonlocal/non-test database');
let db;
const sql = await fs.readFile(new URL(`../prisma/migrations/${MIGRATION}/migration.sql`, import.meta.url), 'utf8');
beforeEach(async () => {
  if (!db) { db = new pg.Client({ connectionString: url }); await db.connect(); }
  await db.query(`DROP TABLE IF EXISTS ${TABLES.map(t => `public."${t}"`).join(',')},public."_prisma_migrations",public."SecurityMigrationBusinessFixture" CASCADE`);
  await db.query('DROP FUNCTION IF EXISTS public.paymi_security_audit_append_only() CASCADE');
  await db.query('DROP SEQUENCE IF EXISTS public."SecurityAdminAudit_sequence_seq"');
  await db.query(`CREATE TABLE public."_prisma_migrations" (id varchar(36) PRIMARY KEY, checksum varchar(64) NOT NULL,
    finished_at timestamptz,migration_name varchar(255) NOT NULL,logs text,rolled_back_at timestamptz,
    started_at timestamptz NOT NULL DEFAULT now(),applied_steps_count integer NOT NULL DEFAULT 0)`);
  await db.query(`INSERT INTO public."_prisma_migrations" (id,checksum,migration_name,finished_at) VALUES ('existing','untouched','unrelated_existing_migration',now())`);
  await db.query(`CREATE TABLE public."SecurityMigrationBusinessFixture" (id integer PRIMARY KEY,content text NOT NULL)`);
  await db.query(`INSERT INTO public."SecurityMigrationBusinessFixture" VALUES (1,'Preserve exact existing business data')`);
});
after(async () => { await db?.end(); });
const business = async () => (await db.query('SELECT * FROM public."SecurityMigrationBusinessFixture"')).rows;
const targetLedger = async () => (await db.query('SELECT checksum,applied_steps_count FROM public."_prisma_migrations" WHERE migration_name=$1', [MIGRATION])).rows;

test('default preview is read-only and identifies precisely the five missing tables', async () => {
  const before = await business();
  const plan = await runSecurityProtectionMigration(db);
  assert.equal(plan.mode, 'dry-run'); assert.equal(plan.status, 'ready'); assert.equal(plan.committed, false);
  assert.deepEqual(plan.missingTables, TABLES); assert.equal(plan.planned.existingBusinessRowsChanged, 0);
  assert.deepEqual(await targetLedger(), []); assert.deepEqual((await inspectSecuritySchema(db)).tables, []);
  assert.deepEqual(await business(), before);
});
test('explicit apply is atomic, preserves business rows and unrelated ledger entries, and is idempotent', async () => {
  const before = await business();
  const result = await runSecurityProtectionMigration(db, { apply: true });
  assert.equal(result.status, 'applied'); assert.equal(result.committed, true); assert.deepEqual(result.missingTables, []);
  assert.deepEqual(await targetLedger(), [{ checksum: MIGRATION_SHA256, applied_steps_count: 1 }]);
  assert.equal((await db.query('SELECT checksum FROM public."_prisma_migrations" WHERE id=$1', ['existing'])).rows[0].checksum, 'untouched');
  assert.deepEqual(await business(), before);
  assert.equal((await runSecurityProtectionMigration(db, { apply: true })).status, 'already-applied');
  assert.equal((await targetLedger()).length, 1);
});
test('an exact previously created schema is recorded without executing DDL or changing its rows', async () => {
  await db.query(sql);
  await db.query(`INSERT INTO public."SecurityPolicy" (id,"values","updatedAt","updatedBy") VALUES ('default','{"retentionDays":30}',now(),1)`);
  const intercept = { query: (statement, values) => { assert.notEqual(statement, sql, 'must not replay DDL over an exact existing schema'); return db.query(statement, values); } };
  const plan = await runSecurityProtectionMigration(intercept);
  assert.equal(plan.action, 'record-existing-exact-schema'); assert.deepEqual(plan.planned.createTables, []);
  assert.equal((await runSecurityProtectionMigration(intercept, { apply: true })).status, 'recorded-existing-schema');
  assert.equal((await db.query('SELECT "values" FROM public."SecurityPolicy"')).rows[0].values.retentionDays, 30);
});
test('partial schema and a disabled append-only trigger are rejected without guessing', async () => {
  await db.query('CREATE TABLE public."SecurityEvent" (id text)');
  await assert.rejects(runSecurityProtectionMigration(db, { apply: true }), /partial or drifted/);
  assert.deepEqual(await targetLedger(), []);
  await db.query('DROP TABLE public."SecurityEvent"'); await db.query(sql);
  await db.query('ALTER TABLE public."SecurityAdminAudit" DISABLE TRIGGER security_audit_no_truncate');
  await assert.rejects(runSecurityProtectionMigration(db), /partial or drifted/);
  assert.deepEqual(await targetLedger(), []);
});
test('unfinished records, checksum mismatch and missing ledger are refused', async () => {
  await db.query('INSERT INTO public."_prisma_migrations" (id,checksum,migration_name) VALUES ($1,$2,$3)', ['unfinished',MIGRATION_SHA256,MIGRATION]);
  await assert.rejects(runSecurityProtectionMigration(db), /unfinished/);
  await db.query('DELETE FROM public."_prisma_migrations" WHERE id=$1', ['unfinished']);
  await runSecurityProtectionMigration(db, { apply: true });
  await db.query('UPDATE public."_prisma_migrations" SET checksum=$1 WHERE migration_name=$2', ['changed',MIGRATION]);
  await assert.rejects(runSecurityProtectionMigration(db), /checksum differs/);
  await db.query('DROP TABLE public."_prisma_migrations"');
  await assert.rejects(runSecurityProtectionMigration(db, { apply: true }), /ledger is missing/);
});
test('an injected DDL failure rolls back all five tables and the target ledger entry', async () => {
  const before = await business();
  const intercepted = { query: async (statement, values) => {
    const result = await db.query(statement, values);
    if (statement === sql) throw new Error('Injected failure before ledger insertion');
    return result;
  } };
  await assert.rejects(runSecurityProtectionMigration(intercepted, { apply: true }), /Injected failure/);
  assert.deepEqual((await inspectSecuritySchema(db)).tables, []); assert.deepEqual(await targetLedger(), []);
  assert.deepEqual(await business(), before);
});
test('concurrent applies serialize and produce one completed migration record', async () => {
  const peer = new pg.Client({ connectionString: url }); await peer.connect();
  try {
    const results = await Promise.all([runSecurityProtectionMigration(db, { apply: true }), runSecurityProtectionMigration(peer, { apply: true })]);
    assert.deepEqual(results.map(r => r.status).sort(), ['already-applied','applied']);
    assert.equal((await targetLedger()).length, 1);
  } finally { await peer.end(); }
});

test('a lost COMMIT acknowledgement reports unknown until a fresh read-only check resolves it', async () => {
  const intercepted = { query: async (statement, values) => {
    const result = await db.query(statement, values);
    if (statement === 'COMMIT') throw Object.assign(new Error('Simulated network loss after server commit'), { code: 'ETIMEDOUT' });
    return result;
  } };
  let failure;
  try { await runSecurityProtectionMigration(intercepted, { apply: true }); }
  catch (error) { failure = error; }
  assert.ok(failure); assert.equal(failure.migrationCommitStatus, 'unknown');
  const report = migrationFailureReport(failure);
  assert.equal(report.committed, null); assert.equal(report.commitStatus, 'unknown'); assert.equal(report.recheckRequired, true);
  assert.match(report.error, /Run --dry-run/); assert.ok(!report.error.includes('no migration was committed'));
  assert.equal((await targetLedger()).length, 1, 'server committed despite losing its acknowledgement');
  const check = await runSecurityProtectionMigration(db);
  assert.equal(check.status, 'already-applied'); assert.equal(check.action, 'none');
});

test('connection failures and failures before COMMIT remain distinct from ambiguous commits', async () => {
  assert.equal(migrationFailureReport({ code: 'ETIMEDOUT' }).committed, false);
  assert.equal(migrationFailureReport({ migrationCommitStatus: 'not-committed', code: '23505' }).commitStatus, 'not-committed');
  assert.equal(migrationFailureReport({ code: 'EPIPE' }, { committed: true }).committed, true);
});
