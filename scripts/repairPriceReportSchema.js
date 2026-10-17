// Apply only the reviewed typed-reporter migration, preserving legacy reports/earnings.
// Never runs db push, reset, seeds or historical identity reassignment.
import 'dotenv/config';
import fs from 'node:fs/promises';
import pg from 'pg';

const migration = '20261017160000_typed_price_reporters';
const newColumns = ['reporterType', 'reporterEmployeeId', 'reporterAdminId', 'reviewedByEmployeeId'];
const apply = process.argv.includes('--apply');
const db = new pg.Client({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 15000 });
try {
  await db.connect();
  await db.query('BEGIN');
  await db.query("SET LOCAL lock_timeout = '5s'");
  await db.query("SET LOCAL statement_timeout = '60s'");
  if (apply) {
    await db.query('LOCK TABLE "PriceReport" IN ACCESS EXCLUSIVE MODE');
    await db.query('LOCK TABLE "Customer" IN SHARE MODE');
  }
  const present = (await db.query(`SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='PriceReport' AND column_name = ANY($1::text[])`, [newColumns])).rows;
  if (present.length !== 0 && present.length !== newColumns.length) throw Object.assign(new Error('Partially applied migration'), { code: 'PARTIAL_SCHEMA' });
  const fingerprint = async () => ({
    reports: (await db.query(`SELECT count(*)::int AS count, md5(coalesce(string_agg(md5((to_jsonb(t)-$1::text[])::text), '' ORDER BY id), '')) AS digest FROM "PriceReport" t`, [newColumns])).rows[0],
    earnings: (await db.query(`SELECT count(*)::int AS count, md5(coalesce(string_agg(md5(jsonb_build_array(id, earnings)::text), '' ORDER BY id), '')) AS digest FROM "Customer"`)).rows[0],
  });
  const before = await fingerprint();
  if (!present.length && apply) await db.query(await fs.readFile(new URL(`../prisma/migrations/${migration}/migration.sql`, import.meta.url), 'utf8'));
  const after = await fingerprint();
  if (JSON.stringify(before) !== JSON.stringify(after)) throw Object.assign(new Error('Existing data changed'), { code: 'PRESERVATION_FAILED' });
  if (present.length || apply) {
    const constraints = (await db.query(`SELECT conname FROM pg_constraint WHERE conrelid = '"PriceReport"'::regclass AND conname = ANY($1::text[])`, [['PriceReport_typed_reporter', 'PriceReport_single_reviewer', 'PriceReport_reporterEmployeeId_fkey', 'PriceReport_reporterAdminId_fkey', 'PriceReport_reviewedByEmployeeId_fkey']])).rows;
    if (constraints.length !== 5) throw Object.assign(new Error('Missing constraints'), { code: 'PARTIAL_SCHEMA' });
  }
  await db.query('COMMIT');
  console.log(JSON.stringify({ checkedAt: new Date().toISOString(), migration, applied: apply && !present.length, columnsPresent: Boolean(present.length) || apply, before, existingReportsAndEarningsUnchanged: true, migrationLedger: 'Record the verified migration with prisma migrate resolve --applied' }, null, 2));
} catch (error) {
  await db.query('ROLLBACK').catch(() => {});
  console.error(JSON.stringify({ code: error.code ?? 'REPAIR_FAILED', message: 'Schema repair failed and transaction rolled back; no credentials or row contents disclosed' }));
  process.exitCode = 1;
} finally { await db.end(); }
