import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

// Never mounted as static content. Moderators fetch one reported item through an admin-only route.
export const evidenceRoot = () => path.resolve(process.env.MODERATION_EVIDENCE_DIR || '.private-moderation');
export async function captureEvidence(message) {
  const evidence = {
    messageId: message.id, chatId: message.chatId, senderId: message.senderId, senderType: message.senderType,
    content: message.content, messageType: message.messageType, createdAt: message.createdAt.toISOString(),
    attachmentName: message.attachmentName, attachmentStatus: message.attachmentUrl ? 'UNAVAILABLE' : 'NONE',
  };
  let evidenceFile = null;
  const filename = message.attachmentUrl?.match(/^\/uploads\/chat\/([a-zA-Z0-9._-]+)$/)?.[1];
  if (filename) {
    await fs.mkdir(evidenceRoot(), { recursive: true, mode: 0o700 });
    const source = path.resolve('uploads/chat', filename);
    try {
      const stat = await fs.lstat(source);
      if (!stat.isFile() || stat.size > 20 * 1024 * 1024) throw new Error('Invalid report attachment');
      evidenceFile = crypto.randomUUID();
      await fs.copyFile(source, path.join(evidenceRoot(), evidenceFile), fs.constants.COPYFILE_EXCL);
      await fs.chmod(path.join(evidenceRoot(), evidenceFile), 0o600);
      evidence.attachmentStatus = 'CAPTURED';
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  return { evidence, evidenceFile };
}
