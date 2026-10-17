import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { processDeletion } from '../src/services/accountDeletion.js';
import redis from '../src/services/redisService.js';
// Deploy as a monitored scheduled job after authorization. Dry-run is the default.
const apply = process.argv.includes('--apply');
const db = new PrismaClient();
try {
  const jobs = await db.accountDeletionJob.findMany({ where: { status: { in: ['REQUESTED', 'PROCESSING', 'FILES_PENDING'] } }, orderBy: { createdAt: 'asc' }, take: 100 });
  if (apply) await redis.connect();
  for (const job of jobs) {
    if (!apply) { console.log(JSON.stringify({ id: job.id, status: job.status, action: 'would-process-personal-deletion' })); continue; }
    try { console.log(JSON.stringify(await processDeletion(db, job.id))); }
    catch { console.error(JSON.stringify({ id: job.id, status: 'RETRY_REQUIRED' })); process.exitCode = 1; }
  }
} finally { await redis.disconnect(); await db.$disconnect(); }
