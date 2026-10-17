import 'dotenv/config';
import fs from 'node:fs/promises';
import { PrismaClient } from '@prisma/client';
// Authorized operator only. References must point to completed evidence, not promises.
// This script deliberately cannot complete an unprocessed request.
const [jobId, evidenceFile, confirmation] = process.argv.slice(2);
if (!jobId || !evidenceFile || confirmation !== '--confirm-reviewed') throw new Error('Usage: node scripts/completeAccountDeletion.js JOB_ID evidence.json --confirm-reviewed');
const evidence = JSON.parse(await fs.readFile(evidenceFile, 'utf8'));
for (const field of ['reviewer', 'sharedRecords', 'filesAndCaches', 'mailAndLogs', 'backupsAndRestoreLedger']) {
  if (typeof evidence[field] !== 'string' || evidence[field].trim().length < 8) throw new Error(`Missing completed evidence reference: ${field}`);
}
const db = new PrismaClient();
try {
  const result = await db.accountDeletionJob.updateMany({ where: { id: jobId, status: 'EXTERNAL_REVIEW' }, data: { status: 'COMPLETE', completedAt: new Date(), reviewEvidence: evidence } });
  if (result.count !== 1) throw new Error('Request is not awaiting external review, or was already completed.');
  console.log('Deletion review recorded. Evidence retention cleanup still follows the approved operational schedule.');
} finally { await db.$disconnect(); }
