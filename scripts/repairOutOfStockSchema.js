// Apply only the reviewed additive migration. Never runs db push, reset or seeds.
import 'dotenv/config';
import fs from 'node:fs/promises';
import pg from 'pg';

const migration = '20261016160000_out_of_stock_origin';
const apply = process.argv.includes('--apply');
const db = new pg.Client({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 15000 });
try {
  await db.connect();
  await db.query('BEGIN');
  await db.query("SET LOCAL lock_timeout = '5s'");
  await db.query("SET LOCAL statement_timeout = '60s'");
  if (apply) await db.query('LOCK TABLE "ListProduct" IN ACCESS EXCLUSIVE MODE');
  const columns = await db.query(`SELECT data_type, is_nullable FROM information_schema.columns WHERE table_schema='public' AND table_name='ListProduct' AND column_name='outOfStockSourceListId'`);
  const fingerprint = async () => (await db.query(`SELECT count(*)::int AS count, md5(coalesce(string_agg(md5((to_jsonb(t)-'outOfStockSourceListId')::text), '' ORDER BY id), '')) AS digest FROM "ListProduct" t`)).rows[0];
  const before = await fingerprint();
  const present = columns.rows[0];
  if (present && (present.data_type !== 'text' || present.is_nullable !== 'YES')) throw Object.assign(new Error('Unexpected existing column'), { code: 'COLUMN_MISMATCH' });
  if (!present && apply) {
    const sql = await fs.readFile(new URL(`../prisma/migrations/${migration}/migration.sql`, import.meta.url), 'utf8');
    await db.query(sql);
  }
  const after = await fingerprint();
  if (JSON.stringify(before) !== JSON.stringify(after)) throw Object.assign(new Error('Existing item data changed'), { code: 'PRESERVATION_FAILED' });
  await db.query('COMMIT');
  console.log(JSON.stringify({ checkedAt: new Date().toISOString(), migration, applied: apply && !present, columnPresent: Boolean(present) || apply, existingListProducts: before, existingFieldsUnchanged: true, migrationLedger: 'Use prisma migrate resolve --applied only after this successful verification' }, null, 2));
} catch (error) {
  await db.query('ROLLBACK').catch(() => {});
  console.error(JSON.stringify({ code: error.code ?? 'REPAIR_FAILED', message: 'Schema repair failed and transaction rolled back; no credentials or row contents disclosed' }));
  process.exitCode = 1;
} finally { await db.end(); }
