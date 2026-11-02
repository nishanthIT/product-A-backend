import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { attachmentFilename, readAttachmentBuffer } from './chatStorage.js';

// Never mounted as static content. Moderators fetch one reported item through an admin-only route.
export const evidenceRoot = () => path.resolve(process.env.MODERATION_EVIDENCE_DIR || '.private-moderation');
export async function captureEvidence(message, { db } = {}) {
  const evidence = {
    messageId: message.id, chatId: message.chatId, senderId: message.senderId, senderType: message.senderType,
    content: message.content, messageType: message.messageType, createdAt: message.createdAt.toISOString(),
    attachmentName: message.attachmentName, attachmentStatus: message.attachmentUrl ? 'UNAVAILABLE' : 'NONE',
  };
  let evidenceFile = null;
  const filename = attachmentFilename(message.attachmentUrl);
  if (filename) {
    const upload = await db?.chatUpload.findUnique({ where: { filename } });
    const bytes = await readAttachmentBuffer(upload || { filename });
    if (bytes) {
      await fs.mkdir(evidenceRoot(), { recursive: true, mode: 0o700 });
      evidenceFile = crypto.randomUUID();
      await fs.writeFile(path.join(evidenceRoot(), evidenceFile), bytes, { flag: 'wx', mode: 0o600 });
      evidence.attachmentStatus = 'CAPTURED';
    }
  }
  return { evidence, evidenceFile };
}
