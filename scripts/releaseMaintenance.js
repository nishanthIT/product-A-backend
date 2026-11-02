import 'dotenv/config';
import { attachmentReferenceFilter } from '../src/services/chatStorage.js';
import { queueUnusedAttachment, deleteQueuedAttachment } from '../src/services/chatRetention.js';
import { PrismaClient } from '@prisma/client';
// Defaults to counts only. Schedule with --apply only after deployment authorization.
const apply = process.argv.includes('--apply');
const db = new PrismaClient();
try {
  const now = new Date();
  const expired = { expiresAt: { lt: now } };
  const uploads = await db.chatUpload.findMany({ where: { createdAt: { lt: new Date(+now - 86400000) } }, take: 500 });
  let orphans = 0;
  for (const upload of uploads) {
    if (!/^[a-zA-Z0-9._-]+$/.test(upload.filename)) continue;
    const queued = await db.$transaction(async tx => {
      // The send endpoint locks this same row before creating an attachment reference.
      await tx.$queryRaw`SELECT "filename" FROM "ChatUpload" WHERE "filename" = ${upload.filename} FOR UPDATE`;
      if (!await tx.chatUpload.findUnique({ where: { filename: upload.filename } })) return;
      if (await tx.message.count({ where: attachmentReferenceFilter(upload.filename) })) return;
      orphans++;
      if (apply) {
        return queueUnusedAttachment(tx, upload.filename);
      }
    }, { maxWait: 15000, timeout: 60000 });
    if (queued) await deleteQueuedAttachment(upload.filename, { db });
  }
  const revoked = await db.revokedSession.count({ where: expired });
  if (apply) await db.revokedSession.deleteMany({ where: expired });
  console.log(JSON.stringify({ mode: apply ? 'apply-expired-sessions' : 'dry-run', expiredSessionDigests: revoked, unattachedUploadsPastTarget: orphans, scannedUploads: uploads.length }));
} finally { await db.$disconnect(); }
