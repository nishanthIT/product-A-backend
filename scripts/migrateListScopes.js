#!/usr/bin/env node
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { applyListScopePlan as applyDefaultPlan, inspectListScopeMigration as inspectDefaultMigration, recoverListScopeRun as recoverDefaultRun } from './lib/listScopeMigration.js';

// Deliberately no dotenv/application DATABASE_URL fallback. Target must be explicit.
const args = Object.fromEntries(process.argv.slice(2).map((arg) => {
  const [key, ...rest] = arg.replace(/^--/, '').split('=');
  return [key, rest.length ? rest.join('=') : true];
}));
const allowed = new Set(['report', 'apply', 'recover', 'production-approved', 'backup-ref', 'restore-tested-ref']);
if (Object.keys(args).some((k) => !allowed.has(k)) || (args.apply && args.recover)) {
  throw new Error('Use --report=path (read-only), --apply=reviewed-report.json, or --recover=run-id');
}
const url = process.env.MIGRATION_DATABASE_URL;
if (!url) throw new Error('Set MIGRATION_DATABASE_URL explicitly. The application database is never selected implicitly.');
let parsed;
try { parsed = new URL(url); } catch { throw new Error('MIGRATION_DATABASE_URL must be a valid PostgreSQL URL'); }
const targetFingerprint = createHash('sha256').update(JSON.stringify([
  parsed.hostname, parsed.port || '5432', parsed.pathname, parsed.searchParams.get('schema') || 'public',
])).digest('hex');
const localTest = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname) && /test/i.test(parsed.pathname);
const writes = !!(args.apply || args.recover);
if (writes && !localTest && !['production-approved', 'backup-ref', 'restore-tested-ref'].every((k) => typeof args[k] === 'string' && args[k].trim())) {
  throw new Error('Non-test writes require explicit production approval, backup and restore-test references. Generate a read-only report first.');
}
const db = new PrismaClient({ datasources: { db: { url } } });
try {
  const inspection = await inspectDefaultMigration(db);
  if (writes && !localTest) {
    const installed = inspection.migrations.some((m) => m.migration_name === '20261011160000_multisupermarket_operations' && m.finished_at && !m.rolled_back_at);
    const failed = inspection.migrations.some((m) => !m.finished_at && !m.rolled_back_at);
    if (!installed || failed) throw new Error('Deployed migration history is unverified or incomplete. Reconcile it before backfill.');
  }
  if (args.apply) {
    if (typeof args.apply !== 'string') throw new Error('--apply requires the exact reviewed report path');
    const report = JSON.parse(fs.readFileSync(args.apply, 'utf8'));
    if (report.targetFingerprint !== targetFingerprint) throw new Error('The reviewed report is for a different database target. Generate a new report for this target.');
    const run = await applyDefaultPlan(db, report.plan);
    console.log(JSON.stringify({ appliedRunId: run.id, associatedLists: run.changes.length, summary: inspection.plan.summary }));
  } else if (args.recover) {
    const run = await recoverDefaultRun(db, args.recover);
    console.log(JSON.stringify({ recoveredRunId: run.id, existingRecordsRetained: true }));
  } else {
    if (typeof args.report !== 'string') throw new Error('Dry run requires --report=path; report contains relationship IDs, not names or credentials');
    fs.writeFileSync(args.report, JSON.stringify({ generatedAt: new Date().toISOString(), targetFingerprint, ...inspection }, null, 2), { flag: 'wx', mode: 0o600 });
    console.log(JSON.stringify({ dryRun: true, planHash: inspection.plan.hash, summary: inspection.plan.summary, migrationHistoryPresent: inspection.migrationHistoryPresent }));
  }
} catch (error) {
  // Prisma connection failures may contain host details. Do not print connection strings.
  const databaseError = error.code || error.errorCode || (error.name?.startsWith('Prisma') ? error.name : null);
  console.error(databaseError ? `Migration stopped (${databaseError}). No success is claimed; inspect the database/run ledger before retrying.` : error.message);
  process.exitCode = 1;
} finally {
  await db.$disconnect();
}
