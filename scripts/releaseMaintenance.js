import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';
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
    await db.$transaction(async tx => {
      // The send endpoint locks this same row before creating an attachment reference.
      await tx.$queryRaw`SELECT "filename" FROM "ChatUpload" WHERE "filename" = ${upload.filename} FOR UPDATE`;
      if (!await tx.chatUpload.findUnique({ where: { filename: upload.filename } })) return;
      if (await tx.message.count({ where: { attachmentUrl: { endsWith: `/uploads/chat/${upload.filename}` } } })) return;
      orphans++;
      if (apply) {
        await fs.unlink(path.resolve('uploads/chat', upload.filename)).catch(error => { if (error.code !== 'ENOENT') throw error; });
        await tx.chatUpload.delete({ where: { filename: upload.filename } });
      }
    });
  }
  const revoked = await db.revokedSession.count({ where: expired });
  if (apply) await db.revokedSession.deleteMany({ where: expired });
  console.log(JSON.stringify({ mode: apply ? 'apply-expired-sessions' : 'dry-run', expiredSessionDigests: revoked, unattachedUploadsPastTarget: orphans, scannedUploads: uploads.length }));
} finally { await db.$disconnect(); }
