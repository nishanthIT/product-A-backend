import 'dotenv/config';
import fs from 'node:fs/promises';
import redis from '../src/services/redisService.js';
import { PrismaClient } from '@prisma/client';
import { exportDeletionLedger, replayDeletionLedger, verifyDeletionLedger } from '../src/services/deletionLedger.js';
const [action, file, confirmation] = process.argv.slice(2);
if (!['export', 'replay'].includes(action) || !file) throw new Error('Usage: node scripts/deletionLedger.js export|replay PROTECTED_FILE [--confirm-offline-restore]');
const db = new PrismaClient();
try {
  if (action === 'export') {
    await fs.writeFile(file, JSON.stringify(await exportDeletionLedger(db, process.env.DELETION_LEDGER_KEY)), { mode: 0o600, flag: 'wx' });
    console.log('Signed deletion ledger exported. Copy to protected storage independent of the backup before marking that backup recoverable.');
  } else {
    if (confirmation !== '--confirm-offline-restore' || process.env.PAYMI_RESTORE_MODE !== '1') throw new Error('Restore replay requires a traffic-disabled environment and explicit confirmation');
    const envelope = JSON.parse(await fs.readFile(file, 'utf8'));
    const ledger = verifyDeletionLedger(envelope, process.env.DELETION_LEDGER_KEY);
    const backupDate = Date.parse(process.env.RESTORE_BACKUP_CREATED_AT || '');
    if (!Number.isFinite(backupDate) || Date.parse(ledger.exportedAt) < backupDate) throw new Error('Supply RESTORE_BACKUP_CREATED_AT; ledger must postdate the backup. Independently verify no newer ledger entries are missing.');
    await redis.connect();
    console.log(JSON.stringify(await replayDeletionLedger(db, envelope, process.env.DELETION_LEDGER_KEY)));
  }
} finally { await redis.disconnect(); await db.$disconnect(); }
