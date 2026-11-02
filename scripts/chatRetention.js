#!/usr/bin/env node
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { pathToFileURL } from 'node:url';
import { retentionConfig, retentionSchedule, runChatRetention } from '../src/services/chatRetention.js';
import { attachmentFilename, attachmentReferenceFilter, getChatStorage } from '../src/services/chatStorage.js';
import { serviceError } from '../src/services/serviceErrors.js';

// No attachment bytes, message bodies, identities or credentials are printed.
// This preview also works before the additive storage migration is applied.
export async function previewChatRetention(db, { now = new Date(), hour = retentionConfig().hour } = {}) {
  const schedule = retentionSchedule(now, hour);
  return db.$transaction(async tx => {
    await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
    const [expiredMessages, retainedMessages, files] = await Promise.all([
      tx.message.count({ where: { createdAt: { lt: schedule.cutoff } } }),
      tx.message.count({ where: { createdAt: { gte: schedule.cutoff } } }),
      tx.message.findMany({ where: { createdAt: { lt: schedule.cutoff }, attachmentUrl: { not: null } }, select: { attachmentUrl: true }, distinct: ['attachmentUrl'] }),
    ]);
    const names = new Set(files.map(item => attachmentFilename(item.attachmentUrl)).filter(Boolean));
    let sharedFilesPreserved = 0;
    for (const filename of names) {
      if (await tx.message.count({ where: { ...attachmentReferenceFilter(filename), createdAt: { gte: schedule.cutoff } } })) sharedFilesPreserved++;
    }
    return { mode: 'dry-run', day: schedule.id, cutoffUtc: schedule.cutoff.toISOString(), retentionDays: 30,
      expiredMessages, retainedMessages, expiredAttachmentCandidates: names.size,
      sharedFilesPreserved, unrecognizedAttachmentUrlsSkipped: files.filter(item => !attachmentFilename(item.attachmentUrl)).length,
      note: 'The worker rechecks all file references before deletion and also removes old unattached uploads. No data was changed.' };
  }, { isolationLevel: 'RepeatableRead', maxWait: 10000, timeout: 120000 });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args[0] && !['--dry-run', '--run-once'].includes(args[0]))) {
    console.error('Usage: node scripts/chatRetention.js [--dry-run|--run-once]'); process.exitCode = 1;
  } else {
    const db = new PrismaClient();
    let storage;
    try {
      if (args[0] === '--run-once') storage = getChatStorage();
      console.log(JSON.stringify(args[0] === '--run-once'
        ? await runChatRetention({ db, storage, hour: retentionConfig().hour })
        : await previewChatRetention(db), null, 2));
    } catch (error) { console.error('Chat retention operation failed', serviceError(error)); process.exitCode = 1; }
    finally { storage?.close(); await db.$disconnect(); }
  }
}
