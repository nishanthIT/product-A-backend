import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { disconnectUser } from './realtime.js';
import { purgeAccountCaches } from './deletionCaches.js';
import { persistRecoveryJournal } from './deletionRecoveryJournal.js';

export const receiptDigest = receipt => crypto.createHash('sha256').update(receipt).digest('hex');
export const accountTable = type => ({ CUSTOMER: 'customer', EMPLOYEE: 'empolyee', ADMIN: 'admin' })[type];
export const deletionStatus = job => ({ id: job.id, status: job.status, requestedAt: job.createdAt, completedAt: job.completedAt });

export async function requestDeletion(db, user) {
  const receipt = crypto.randomBytes(32).toString('hex');
  const job = await db.accountDeletionJob.upsert({
    where: { userId_userType: { userId: user.id, userType: user.userType } },
    create: { userId: user.id, userType: user.userType, receiptHash: receiptDigest(receipt) },
    // Reauthentication can replace a lost receipt without creating a second job.
    update: { receiptHash: receiptDigest(receipt) },
  });
  return { ...deletionStatus(job), receipt };
}

/** Removes direct account data; shared content and external processors require recorded review.
 * No workspace, another user's content, or staff account is deleted here.
 */
export async function processDeletion(db, jobId, { uploadsRoot = path.resolve('uploads'), purgeCaches = purgeAccountCaches, persistJournal = persistRecoveryJournal } = {}) {
  let job = await db.accountDeletionJob.findUniqueOrThrow({ where: { id: jobId } });
  if (['EXTERNAL_REVIEW', 'COMPLETE'].includes(job.status)) return deletionStatus(job);
  // Commit the access barrier before erasure. Failures remain retryable while sessions stay revoked.
  await db.accountDeletionJob.updateMany({ where: { id: jobId, status: 'REQUESTED' }, data: { status: 'PROCESSING' } });
  disconnectUser(job.userType, job.userId);
  await persistJournal(db);
  job = await db.$transaction(async tx => {
    // Lock this job across workers. A crashed transaction leaves it retryable.
    await tx.$queryRaw`SELECT "id" FROM "AccountDeletionJob" WHERE "id" = ${jobId} FOR UPDATE`;
    const current = await tx.accountDeletionJob.findUniqueOrThrow({ where: { id: jobId } });
    if (current.status !== 'PROCESSING') return current;
    const id = current.userId, type = current.userType, table = accountTable(type);
    const sqlTable = { CUSTOMER: 'Customer', EMPLOYEE: 'Empolyee', ADMIN: 'Admin' }[type];
    await tx.$queryRawUnsafe(`SELECT "id" FROM "${sqlTable}" WHERE "id" = $1 FOR UPDATE`, id);
    const account = await tx[table].findUnique({ where: { id } });
    if (!account) throw new Error('Deletion account missing before processing');
    await purgeCaches(account, type);
    const authored = { senderId: id, senderType: type };
    const uploads = await tx.chatUpload.findMany({ where: { uploaderId: id, uploaderType: type } });
    // Only uploader-owned files are safe to erase automatically. Legacy untracked URLs
    // and shared references require the mandatory external review, not a guessed owner.
    const filePaths = new Set(uploads.map(u => `chat/${u.filename}`));
    await tx.userBlock.deleteMany({ where: { OR: [{ userId: id, userType: type }, { blockedId: id, blockedType: type }] } });
    await tx.communityAcceptance.deleteMany({ where: { userId: id, userType: type } });
    await tx.moderationDeletionJob.updateMany({ where: { userId: id, userType: type }, data: { userId: 0, status: 'COMPLETED', completedAt: new Date() } });
    await tx.chatSuspension.deleteMany({ where: { userId: id, userType: type } });
    // Case evidence remains in mandatory shared-record review until a legitimate retention decision.
    await tx.chatModerationAction.updateMany({ where: { userId: id, userType: type }, data: { userId: 0 } });
    await tx.contentReport.updateMany({ where: { reporterId: id, reporterType: type }, data: { reporterId: null } });
    if (type === 'ADMIN') {
      await tx.moderationDeletionJob.updateMany({ where: { moderatorId: id }, data: { moderatorId: null } });
      await tx.contentReport.updateMany({ where: { moderatorId: id }, data: { moderatorId: null } });
      await tx.chatSuspension.updateMany({ where: { moderatorId: id }, data: { moderatorId: null } });
      await tx.chatModerationAction.updateMany({ where: { moderatorId: id }, data: { moderatorId: null } });
    }
    await tx.message.deleteMany({ where: authored });
    await tx.messageRead.deleteMany({ where: { userId: id, userType: type } });
    await tx.chatParticipant.deleteMany({ where: { userId: id, userType: type } });
    await tx.trackedList.deleteMany({ where: { userId: id, userType: type } });
    await tx.chatUpload.deleteMany({ where: { uploaderId: id, uploaderType: type } });
    const creatorField = { CUSTOMER: 'customerId', EMPLOYEE: 'employeeId', ADMIN: 'adminId' }[type];
    await tx.list.deleteMany({ where: { [creatorField]: id, shopId: null } });
    await tx.list.updateMany({ where: { [creatorField]: id }, data: { [creatorField]: null } });
    if (type === 'CUSTOMER') {
      // Clear the composite default FK before removing ownerships. Existing co-owners remain.
      await tx.customer.update({ where: { id }, data: { defaultSupermarketId: null } });
      await tx.supermarketCreationReceipt.deleteMany({ where: { customerId: id } });
      await tx.productAtShop.updateMany({ where: { userId: id }, data: { userId: null } });
    } else if (type === 'EMPLOYEE') {
      await tx.actionLog.deleteMany({ where: { employeeId: id } });
      await tx.productAtShop.updateMany({ where: { employeeId: id }, data: { employeeId: null } });
    } else {
      await tx.priceReport.updateMany({ where: { reviewedBy: id }, data: { reviewedBy: null } });
    }
    // Non-relational author IDs must not continue identifying the deleted account.
    for (const model of ['ageRestrictedRecord', 'ageRestrictionRecord', 'incidentLog', 'wasteRecord', 'supplierPayoutRecord', 'shiftSheetRecord', 'shopCertificate']) {
      const data = { createdById: 0 };
      if (['ageRestrictedRecord', 'supplierPayoutRecord', 'shiftSheetRecord'].includes(model)) data.recordedBy = 'Deleted member';
      await tx[model].updateMany({ where: { createdById: id, createdByType: type }, data });
    }
    for (const model of ['ageRestrictionRecord', 'incidentLog', 'shopCertificate']) {
      await tx[model].updateMany({ where: { updatedById: id, updatedByType: type }, data: { updatedById: null, updatedByType: null } });
    }
    await tx.fridgeTemperatureLog.updateMany({ where: { recordedById: id, recordedByType: type }, data: { recordedById: 0 } });
    await tx.cleaningLog.updateMany({ where: { completedById: id, completedByType: type }, data: { completedById: 0 } });
    await tx.expiryProduct.updateMany({ where: { addedById: id, addedByType: type }, data: { addedById: 0 } });
    await tx.supermarketAdminAccessLog.updateMany({ where: { actorId: id, actorType: type }, data: { actorId: 0 } });
    await tx[table].delete({ where: { id } });
    return tx.accountDeletionJob.update({ where: { id: jobId }, data: { status: 'FILES_PENDING', filePaths: [...filePaths], attempts: { increment: 1 } } });
  }, { timeout: 30000 });
  disconnectUser(job.userType, job.userId);
  if (job.status === 'FILES_PENDING') {
    for (const relative of job.filePaths) {
      if (!/^chat\/[a-zA-Z0-9._-]+$/.test(relative)) throw new Error('Unsafe deletion path');
      // Do not delete a file still referenced by someone else's message.
      const references = await db.message.count({ where: { attachmentUrl: { endsWith: `/uploads/${relative}` } } });
      if (!references) await fs.unlink(path.join(uploadsRoot, relative)).catch(error => { if (error.code !== 'ENOENT') throw error; });
    }
    job = await db.accountDeletionJob.update({ where: { id: jobId }, data: { status: 'EXTERNAL_REVIEW', filePaths: [] } });
  }
  return deletionStatus(job);
}
