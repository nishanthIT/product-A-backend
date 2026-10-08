#!/usr/bin/env node
// Separates company staff from shop employees for existing records.
//
//   node scripts/migrateEmployeeMemberships.js                 # dry run (read-only), prints + saves report
//   node scripts/migrateEmployeeMemberships.js --apply         # writes memberships/reviews, saves run log
//   node scripts/migrateEmployeeMemberships.js --rollback=<run-log.json>
//
// Options: --report=<path>  --shop-flow-cutoff=<ISO date>
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import { PrismaClient } from '@prisma/client';
import {
  DEFAULT_SHOP_FLOW_CUTOFF,
  applyPlan,
  buildPlan,
  collectFacts,
  rollbackRun,
} from './lib/employeeMembershipMigration.js';

dotenv.config();

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, ...v] = a.replace(/^--/, '').split('=');
    return [k, v.length ? v.join('=') : true];
  })
);

const logDir = path.resolve('prisma/logs');
const stamp = new Date().toISOString().replace(/[:.]/g, '-');

function printReport(plan) {
  const { summary } = plan;
  console.log('\n=== Employee membership migration report ===');
  console.log(`Membership tables present: ${plan.hasMembershipTables ? 'yes' : 'NO (schema migration not applied yet)'}`);
  console.table(Object.fromEntries(Object.entries(summary).filter(([k]) => k !== 'reviewReasons')));
  if (Object.keys(summary.reviewReasons).length) {
    console.log('Needs review by reason:');
    console.table(summary.reviewReasons);
  }
  console.log('Per employee (ids only; see report file for evidence):');
  console.table(plan.items.map((i) => ({
    employeeId: i.employeeId,
    outcome: i.outcome,
    shopId: i.shopId ?? '',
    reason: i.reason ?? '',
    catalogActions: i.evidence.wholesaleCatalogActions,
    lists: i.evidence.listCount,
    actions: i.actions.join(',') || '(none)',
  })));
}

async function main() {
  const prisma = new PrismaClient();
  try {
    fs.mkdirSync(logDir, { recursive: true });

    if (args.rollback) {
      const runLog = JSON.parse(fs.readFileSync(args.rollback, 'utf8'));
      await rollbackRun(prisma, runLog);
      console.log(`Rolled back run ${args.rollback}: removed ${runLog.created.companyMemberships.length} company, ${runLog.created.shopMemberships.length} shop memberships and ${runLog.created.reviews.length} reviews. Session versions were NOT restored (old tokens stay invalid).`);
      return;
    }

    const shopFlowCutoff = args['shop-flow-cutoff'] ? new Date(args['shop-flow-cutoff']) : DEFAULT_SHOP_FLOW_CUTOFF;
    const facts = await collectFacts(prisma);
    const plan = buildPlan(facts, { shopFlowCutoff });
    printReport(plan);

    const reportPath = args.report || path.join(logDir, `employee-membership-${args.apply ? 'apply' : 'dry-run'}-${stamp}.json`);
    fs.writeFileSync(reportPath, JSON.stringify({ generatedAt: new Date().toISOString(), shopFlowCutoff, ...plan }, null, 2));
    console.log(`Report written to ${reportPath}`);

    if (!args.apply) {
      console.log('\nDry run only. Nothing was written to the database. Re-run with --apply after review.');
      return;
    }

    const affectedIds = plan.items.filter((i) => i.actions.length > 0).map((i) => i.employeeId);
    const snapshot = await prisma.empolyee.findMany({
      where: { id: { in: affectedIds } },
      select: { id: true, shopId: true, sessionVersion: true, createdByAdminId: true, createdByCustomerId: true },
    });
    const created = await applyPlan(prisma, plan);
    const runLogPath = path.join(logDir, `employee-membership-run-${stamp}.json`);
    fs.writeFileSync(runLogPath, JSON.stringify({ appliedAt: new Date().toISOString(), snapshot, created }, null, 2));
    console.log(`\nApplied. Created ${created.companyMemberships.length} company memberships, ${created.shopMemberships.length} shop memberships, ${created.reviews.length} review flags; invalidated sessions for ${created.sessionsInvalidated.length} employees.`);
    console.log(`Run log (for --rollback): ${runLogPath}`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
