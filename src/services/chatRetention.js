import { Prisma, PrismaClient } from '@prisma/client';
import { attachmentFilename, attachmentReferenceFilter, attachmentStorageDescriptor, getChatStorage } from './chatStorage.js';
import { captureEvidence } from './moderationEvidence.js';
import { serviceError } from './serviceErrors.js';

const prisma = new PrismaClient();
export const CHAT_RETENTION_DAYS = 30;
const DAY = 86400000;
const safeError = error => String(error?.code || error?.name || 'STORAGE_FAILURE').slice(0, 100);

export function retentionConfig(env = process.env) {
  if (env.CHAT_RETENTION_ENABLED && !['true', 'false'].includes(env.CHAT_RETENTION_ENABLED)) throw new Error('CHAT_RETENTION_ENABLED must be true or false');
  const hour = Number(env.CHAT_RETENTION_HOUR_UTC || 2);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) throw new Error('CHAT_RETENTION_HOUR_UTC must be 0–23');
  // A developer process may use the hosted DB without its attachment volume.
  // Enable expiry explicitly on the supervised deployment owning that storage.
  return { enabled: env.CHAT_RETENTION_ENABLED === 'true', hour };
}

export function retentionSchedule(now = new Date(), hour = 2) {
  const due = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hour));
  if (due > now) due.setUTCDate(due.getUTCDate() - 1);
  return { id: due.toISOString().slice(0, 10), cutoff: new Date(+due - CHAT_RETENTION_DAYS * DAY) };
}

// Caller must be in a transaction. All sends lock this same ownership row and
// reject pendingDeletion, preventing a new reference while a file is removed.
export async function queueUnusedAttachments(tx, filenames, { legacy = false } = {}) {
  const candidates = [...new Set(filenames)].sort();
  if (!candidates.length) return [];
  // Validate identifiers before using them in either provider metadata or SQL.
  for (const filename of candidates) attachmentReferenceFilter(filename);
  const uploads = await tx.$queryRaw`SELECT * FROM "ChatUpload"
    WHERE filename IN (${Prisma.join(candidates)}) ORDER BY filename FOR UPDATE`;
  const owned = new Map(uploads.map(upload => [upload.filename, upload]));
  const referenced = await tx.$queryRaw`SELECT candidate.filename FROM
    unnest(ARRAY[${Prisma.join(candidates)}]::text[]) AS candidate(filename)
    WHERE EXISTS (SELECT 1 FROM "Message" m WHERE
      right(m."attachmentUrl", length('/uploads/chat/' || candidate.filename)) = '/uploads/chat/' || candidate.filename
      OR strpos(m."attachmentUrl", '/uploads/chat/' || candidate.filename || '?') > 0
      OR strpos(m."attachmentUrl", '/uploads/chat/' || candidate.filename || '#') > 0)`;
  const retained = new Set(referenced.map(row => row.filename));
  const unused = candidates.filter(filename => !retained.has(filename) && (legacy || owned.has(filename)));
  if (!unused.length) return [];
  // Never rewrite an existing durable descriptor after a provider/config change.
  await tx.chatAttachmentDeletionJob.createMany({ data: unused.map(filename => ({
    ...attachmentStorageDescriptor(owned.get(filename) || { filename }), nextAttemptAt: new Date(),
  })), skipDuplicates: true });
  await tx.chatUpload.updateMany({ where: { filename: { in: unused } }, data: { pendingDeletion: true } });
  return unused;
}

export async function queueUnusedAttachment(tx, filename, options) {
  return (await queueUnusedAttachments(tx, [filename], options)).length > 0;
}

/** One short DB transaction; deletion and the file outbox commit together. */
export async function expireChatBatch(runId, { db = prisma, batchSize = 100 } = {}) {
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 500) throw new Error('Invalid retention batch size');
  return db.$transaction(async tx => {
    const locked = await tx.$queryRaw`SELECT id FROM "ChatRetentionRun" WHERE id = ${runId} FOR UPDATE SKIP LOCKED`;
    if (!locked.length) return { busy: true, removed: 0 };
    const run = await tx.chatRetentionRun.findUnique({ where: { id: runId } });
    if (run.status === 'COMPLETED') return { complete: true, removed: 0, cutoff: run.cutoff };
    // Prisma stores DateTime in UTC timestamp columns. Raw Date parameters are
    // timestamptz: convert explicitly so a server timezone cannot widen expiry.
    // Lock selected messages against simultaneous reporting/author deletion.
    const selected = await tx.$queryRaw`SELECT * FROM "Message" WHERE "createdAt" < (${run.cutoff}::timestamptz AT TIME ZONE 'UTC')
      ORDER BY "createdAt", id LIMIT ${batchSize} FOR UPDATE`;
    // Avoid a network round trip for every unreported message in the batch.
    const reports = selected.length ? await tx.$queryRaw`SELECT id, "messageId" FROM "ContentReport"
      WHERE "messageId" IN (${Prisma.join(selected.map(message => message.id))})
        AND (evidence IS NULL OR evidence = 'null'::jsonb)` : [];
    const reportsByMessage = new Map();
    for (const report of reports) {
      const list = reportsByMessage.get(report.messageId) || [];
      list.push(report); reportsByMessage.set(report.messageId, list);
    }
    const evidenceUpdates = [];
    const messages = [];
    let copiedAttachment = false;
    for (const message of selected) {
      let pendingEvidence = false;
      for (const report of reportsByMessage.get(message.id) || []) {
        const needsFile = !!attachmentFilename(message.attachmentUrl);
        // One provider read/copy per transaction keeps cloud latency bounded.
        // A message with multiple legacy reports remains until every report has
        // its own evidence copy; subsequent batches resume the remaining work.
        if (needsFile && copiedAttachment) { pendingEvidence = true; continue; }
        if (needsFile) copiedAttachment = true;
        evidenceUpdates.push({ id: report.id, ...await captureEvidence(message, { db: tx }),
          reportedUserId: message.senderId, reportedUserType: message.senderType, chatId: message.chatId });
      }
      if (!pendingEvidence) messages.push(message);
    }
    if (evidenceUpdates.length) await tx.$executeRaw`UPDATE "ContentReport" AS report SET
      evidence = data.evidence, "evidenceFile" = data."evidenceFile", "reportedUserId" = data."reportedUserId",
      "reportedUserType" = data."reportedUserType"::"UserType", "chatId" = data."chatId"
      FROM jsonb_to_recordset(${JSON.stringify(evidenceUpdates)}::jsonb) AS data(
        id text, evidence jsonb, "evidenceFile" text, "reportedUserId" integer, "reportedUserType" text, "chatId" text)
      WHERE report.id = data.id AND (report.evidence IS NULL OR report.evidence = 'null'::jsonb)`;
    if (messages.length) await tx.message.deleteMany({ where: { id: { in: messages.map(m => m.id) }, createdAt: { lt: run.cutoff } } });
    const filenames = messages.map(message => attachmentFilename(message.attachmentUrl)).filter(Boolean);
    await queueUnusedAttachments(tx, filenames, { legacy: true });
    const chatIds = [...new Set(messages.map(m => m.chatId))].sort();
    if (chatIds.length) {
      // Lock every affected chat in one stable order, then use a fresh statement
      // snapshot so a concurrent send committed before the lock stays latest.
      await tx.$queryRaw`SELECT id FROM "Chat" WHERE id IN (${Prisma.join(chatIds)}) ORDER BY id FOR UPDATE`;
      await tx.$executeRaw`UPDATE "Chat" AS chat SET
        "lastMessageAt" = (SELECT max(message."createdAt") FROM "Message" AS message WHERE message."chatId" = chat.id AND message."deletedAt" IS NULL),
        "updatedAt" = (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')
        WHERE chat.id IN (${Prisma.join(chatIds)})`;
    }
    let orphanCount = 0;
    if (!selected.length) {
      // Include abandoned/failed uploads older than the same retention window.
      // Exact suffix checks avoid interpreting underscores as SQL wildcards.
      const uploads = await tx.$queryRaw`SELECT u.filename FROM "ChatUpload" u
        WHERE u."createdAt" < (${run.cutoff}::timestamptz AT TIME ZONE 'UTC') AND NOT u."pendingDeletion"
          AND NOT EXISTS (SELECT 1 FROM "Message" m WHERE
            right(m."attachmentUrl",length('/uploads/chat/' || u.filename)) = '/uploads/chat/' || u.filename
            OR strpos(m."attachmentUrl",'/uploads/chat/' || u.filename || '?') > 0
            OR strpos(m."attachmentUrl",'/uploads/chat/' || u.filename || '#') > 0)
        ORDER BY u.filename LIMIT ${batchSize} FOR UPDATE OF u SKIP LOCKED`;
      orphanCount = (await queueUnusedAttachments(tx, uploads.map(upload => upload.filename))).length;
    }
    const complete = selected.length === 0 && orphanCount === 0;
    await tx.chatRetentionRun.update({ where: { id: runId }, data: {
      removed: { increment: messages.length }, attempts: { increment: 1 }, lastError: null,
      status: complete ? 'COMPLETED' : 'RUNNING', completedAt: complete ? new Date() : null,
    } });
    return { removed: messages.length, evidenceCaptured: evidenceUpdates.length, orphanCount, chatIds, complete, cutoff: run.cutoff };
  }, { maxWait: 10000, timeout: Math.max(60000, getChatStorage().config.timeoutMs + 45000) });
}

/** Missing files are successful; failed provider operations retain their job. */
export async function deleteQueuedAttachment(filename, { db = prisma, storage = getChatStorage(), now = new Date() } = {}) {
  try {
    return await db.$transaction(async tx => {
      // Match enqueue/send lock ordering: ownership first, then deletion job.
      await tx.$queryRaw`SELECT filename FROM "ChatUpload" WHERE filename = ${filename} FOR UPDATE`;
      const locked = await tx.$queryRaw`SELECT filename FROM "ChatAttachmentDeletionJob"
        WHERE filename = ${filename} AND "nextAttemptAt" <= (${now}::timestamptz AT TIME ZONE 'UTC') FOR UPDATE SKIP LOCKED`;
      if (!locked.length) return { busy: true };
      const job = await tx.chatAttachmentDeletionJob.findUnique({ where: { filename } });
      if (await tx.message.count({ where: attachmentReferenceFilter(filename) })) {
        await tx.chatUpload.updateMany({ where: { filename }, data: { pendingDeletion: false } });
        await tx.chatAttachmentDeletionJob.delete({ where: { filename } });
        return { preserved: true };
      }
      // A crash after storage deletion is safe: a retry treats missing as success.
      await storage.delete(job);
      await tx.chatUpload.deleteMany({ where: { filename } });
      await tx.chatAttachmentDeletionJob.delete({ where: { filename } });
      return { deleted: true };
    }, { maxWait: 10000, timeout: Math.max(60000, (storage.config?.timeoutMs ?? 15000) + 45000) });
  } catch (error) {
    const job = await db.chatAttachmentDeletionJob.findUnique({ where: { filename } }).catch(() => null);
    const waitMs = Math.min(3600000, 60000 * 2 ** Math.min(job?.attempts ?? 0, 6));
    await db.chatAttachmentDeletionJob.updateMany({ where: { filename }, data: {
      attempts: { increment: 1 }, lastError: safeError(error), nextAttemptAt: new Date(+now + waitMs),
    } }).catch(() => {});
    console.warn('Chat attachment deletion will retry', serviceError(error));
    return { failed: true };
  }
}

export async function runChatRetention({ db = prisma, io, storage = getChatStorage(), now = new Date(), hour = 2, maxBatches = 20, fileLimit = 25 } = {}) {
  const schedule = retentionSchedule(now, hour);
  await db.chatRetentionRun.upsert({ where: { id: schedule.id }, create: schedule, update: {} });
  // Resume older incomplete work before the latest daily run. Never create one
  // run for every missed day: the latest cutoff already covers missed expiry.
  const runs = await db.chatRetentionRun.findMany({ where: { status: 'RUNNING' }, orderBy: { id: 'asc' }, take: 2 });
  let removed = 0, failedFiles = 0, deletedFiles = 0;
  for (const run of runs) {
    for (let i = 0; i < maxBatches; i++) {
      const batch = await expireChatBatch(run.id, { db }).catch(async error => {
        await db.chatRetentionRun.updateMany({ where: { id: run.id, status: 'RUNNING' }, data: { lastError: safeError(error), attempts: { increment: 1 } } }).catch(() => {});
        throw error;
      });
      removed += batch.removed;
      if (batch.removed) io?.emit('chats_changed', { reason: 'retention', cutoff: batch.cutoff.toISOString() });
      if (batch.busy || batch.complete) break;
    }
  }
  const jobs = await db.chatAttachmentDeletionJob.findMany({ where: { nextAttemptAt: { lte: now } }, select: { filename: true }, orderBy: { nextAttemptAt: 'asc' }, take: fileLimit });
  for (const job of jobs) {
    const result = await deleteQueuedAttachment(job.filename, { db, storage, now });
    if (result.failed) failedFiles++;
    if (result.deleted) deletedFiles++;
  }
  return { day: schedule.id, cutoff: schedule.cutoff.toISOString(), removed, deletedFiles, failedFiles };
}

export const chatRetentionStatus = { state: 'stopped', lastPollAt: null, lastResult: null };
export function startChatRetentionWorker(io, { db = prisma, storage = getChatStorage(), env = process.env, intervalMs = 60000 } = {}) {
  const config = retentionConfig(env);
  if (!config.enabled) { chatRetentionStatus.state = 'disabled'; return async () => {}; }
  chatRetentionStatus.state = 'starting';
  let active = null, stopped = false;
  const tick = () => {
    if (active || stopped || process.env.PAYMI_RESTORE_MODE === '1') return;
    active = runChatRetention({ db, io, storage, hour: config.hour }).then(result => {
      chatRetentionStatus.state = result.failedFiles ? 'degraded' : 'ready';
      chatRetentionStatus.lastPollAt = new Date().toISOString(); chatRetentionStatus.lastResult = result;
      if (result.removed || result.deletedFiles || result.failedFiles) console.log('Chat retention completed batch', result);
    }).catch(error => {
      chatRetentionStatus.state = 'unavailable'; console.error('Chat retention will retry', serviceError(error));
    }).finally(() => { active = null; });
  };
  const timer = setInterval(tick, intervalMs); timer.unref(); tick();
  return async () => { stopped = true; clearInterval(timer); await active; chatRetentionStatus.state = 'stopped'; };
}
