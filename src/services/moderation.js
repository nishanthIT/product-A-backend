import { serviceError } from './serviceErrors.js';
import { PrismaClient } from '@prisma/client';
import { captureEvidence } from './moderationEvidence.js';
export const moderationDb = new PrismaClient();
const models = { CUSTOMER: 'customer', EMPLOYEE: 'empolyee', ADMIN: 'admin' };
const tables = { CUSTOMER: 'Customer', EMPLOYEE: 'Empolyee', ADMIN: 'Admin' };
export const validReason = value => typeof value === 'string' && value.trim().length >= 5 && value.length <= 1000;
export const validMinutes = value => Number.isInteger(value) && value >= 1 && value <= 43200;
export const subjectOf = report => ({ userId: report.reportedUserId ?? report.evidence?.senderId ?? report.message?.senderId,
  userType: report.reportedUserType ?? report.evidence?.senderType ?? report.message?.senderType });
export async function accountDetails(id, type, db = moderationDb) {
  if (!Number.isInteger(id) || !models[type]) return null;
  return db[models[type]].findUnique({ where: { id }, select: { id: true, name: true, email: true, userType: true } });
}
export async function lockSubject(db, subject) {
  if (!tables[subject.userType] || !Number.isInteger(subject.userId)) return false;
  return (await db.$queryRawUnsafe(`SELECT id FROM "${tables[subject.userType]}" WHERE id = $1 FOR UPDATE`, subject.userId)).length > 0;
}
export async function reportView(report, db = moderationDb) {
  const { evidenceFile, ...safe } = report;
  const subject = subjectOf(report);
  return { ...safe, hasAttachmentEvidence: !!evidenceFile,
    reporter: await accountDetails(report.reporterId, report.reporterType, db),
    reportedUser: await accountDetails(subject.userId, subject.userType, db) };
}
export async function audit(db, subject, moderatorId, action, reason, extra = {}) {
  return db.chatModerationAction.create({ data: { userId: subject.userId ?? 0, userType: subject.userType ?? 'CUSTOMER', moderatorId, action, reason: reason.trim(), ...extra } });
}
// Lock actual messages before mutation, matching report/author deletion serialization.
export async function removeMessages(db, ids) {
  const removed = [];
  for (const id of [...ids].sort()) {
    await db.$queryRaw`SELECT id FROM "Message" WHERE id = ${id} FOR UPDATE`;
    const message = await db.message.findUnique({ where: { id } });
    if (!message || message.deletedAt) continue;
    const legacyReports = await db.contentReport.findMany({ where: { messageId: id } });
    for (const report of legacyReports) if (!report.evidence) {
      await db.contentReport.update({ where: { id: report.id }, data: { ...await captureEvidence(message), reportedUserId: message.senderId, reportedUserType: message.senderType, chatId: message.chatId } });
    }
    await db.message.update({ where: { id }, data: { deletedAt: new Date(), content: '[Removed by moderation]' } });
    removed.push({ id, chatId: message.chatId });
  }
  return removed;
}
export function notifyRemoval(io, messages) {
  for (const m of messages) io?.to(`chat_${m.chatId}`).emit('message_deleted', { messageId: m.id, chatId: m.chatId });
  if (messages.length) io?.emit('chats_changed');
}
// The job row lock makes multiple workers/retries safe. Each transaction is bounded to 100 messages.
export async function processModerationDeletion(id, { db = moderationDb, io } = {}) {
  const result = await db.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "ModerationDeletionJob" WHERE id = ${id} FOR UPDATE`;
    const job = await tx.moderationDeletionJob.findUnique({ where: { id } });
    if (!job || job.status === 'COMPLETED') return { messages: [], job };
    const messages = await tx.message.findMany({ where: { senderId: job.userId, senderType: job.userType, createdAt: { lte: job.cutoff }, deletedAt: null }, select: { id: true }, orderBy: { id: 'asc' }, take: 100 });
    const removed = await removeMessages(tx, messages.map(m => m.id));
    const done = messages.length < 100;
    const saved = await tx.moderationDeletionJob.update({ where: { id }, data: { status: done ? 'COMPLETED' : 'PROCESSING', removed: { increment: removed.length }, attempts: { increment: 1 }, lastError: null, completedAt: done ? new Date() : null } });
    if (done) await audit(tx, job, job.moderatorId, 'BULK_DELETE_COMPLETED', `${job.reason} (${saved.removed} messages; job ${id})`);
    return { messages: removed, job: saved };
  }, { timeout: 30000 }).catch(async error => {
    await db.moderationDeletionJob.updateMany({ where: { id, status: { in: ['PENDING', 'PROCESSING'] } }, data: { lastError: 'A batch failed and will be retried. Check backend logs if this persists.', attempts: { increment: 1 } } }).catch(() => {});
    throw error;
  });
  notifyRemoval(io, result.messages);
  return result.job;
}
export const moderationWorkerStatus = { state: 'stopped', lastPollAt: null };
export function startModerationWorker(io, { db = moderationDb, intervalMs = 2000 } = {}) {
  moderationWorkerStatus.state = 'starting';
  let busy = false;
  const tick = async () => {
    if (busy || process.env.PAYMI_RESTORE_MODE === '1') return;
    busy = true;
    try {
      const jobs = await db.moderationDeletionJob.findMany({ where: { status: { in: ['PENDING', 'PROCESSING'] } }, take: 10, orderBy: { updatedAt: 'asc' } });
      if (moderationWorkerStatus.state !== 'ready') console.log('Moderation queue ready (PostgreSQL)');
      moderationWorkerStatus.state = 'ready';
      moderationWorkerStatus.lastPollAt = new Date().toISOString();
      for (const job of jobs) await processModerationDeletion(job.id, { io, db }).catch(error => {
        moderationWorkerStatus.state = 'degraded';
        console.error('Moderation removal batch failed', { jobId: job.id, ...serviceError(error) });
      });
    } catch (error) {
      moderationWorkerStatus.state = 'unavailable';
      console.error('Moderation queue unavailable', serviceError(error));
    }
    finally { busy = false; }
  };
  const timer = setInterval(tick, intervalMs); timer.unref(); void tick();
  return () => { clearInterval(timer); moderationWorkerStatus.state = 'stopped'; };
}
