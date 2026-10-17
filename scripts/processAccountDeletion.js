import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { processDeletion } from '../src/services/accountDeletion.js';
import redis from '../src/services/redisService.js';

// Deliberately separate from server startup: deploy and authorize an operator/worker explicitly.
const [jobId, confirmation] = process.argv.slice(2);
if (!jobId || confirmation !== '--confirm-personal-deletion') {
  throw new Error('Usage: node scripts/processAccountDeletion.js JOB_ID --confirm-personal-deletion. Shared workspaces are preserved.');
}
const db = new PrismaClient();
try { await redis.connect(); console.log(JSON.stringify(await processDeletion(db, jobId))); }
finally { await db.$disconnect(); await redis.disconnect(); }
