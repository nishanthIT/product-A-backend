import express from 'express';
import path from 'node:path';
import { isAdmin } from '../middleware/authware.js';
import { evidenceRoot } from '../services/moderationEvidence.js';
import { moderationDb as db, accountDetails, lockSubject, validReason, validMinutes, subjectOf, reportView, audit, removeMessages, notifyRemoval } from '../services/moderation.js';
import { disconnectUser } from '../services/realtime.js';
const router = express.Router();
router.use(isAdmin);
router.use((_req, res, next) => { res.set('Cache-Control', 'private, no-store'); next(); });
const wrap = fn => async (req, res, next) => { try { await fn(req, res); } catch (error) { next(error); } };
const findReport = id => db.contentReport.findUnique({ where: { id }, include: { message: true } });
const statuses = ['PENDING', 'UNDER_REVIEW', 'RESOLVED', 'DISMISSED'];
router.get('/reports', wrap(async (req, res) => {
  const { status, reporter, reportedUser, from, to, sort = 'date', direction = 'desc', q = '' } = req.query;
  const page = Number(req.query.page || 1);
  if (!Number.isInteger(page) || page < 1 || page > 100000 || (status && !statuses.includes(status)) || !['date','reporter','reportedUser','status'].includes(sort) || !['asc','desc'].includes(direction) || typeof q !== 'string' || q.length > 200) return res.sendStatus(400);
  const where = {};
  if (status) where.status = status;
  for (const [value, field] of [[reporter, 'reporter'], [reportedUser, 'reportedUser']]) if (value) {
    const match = /^(CUSTOMER|EMPLOYEE|ADMIN):([1-9][0-9]*)$/.exec(value);
    if (!match) return res.status(400).json({ error: 'Use a typed identity such as CUSTOMER:12.' });
    where[`${field}Id`] = Number(match[2]); where[`${field}Type`] = match[1];
  }
  if (from || to) {
    if ((from && !Number.isFinite(Date.parse(from))) || (to && !Number.isFinite(Date.parse(to)))) return res.sendStatus(400);
    where.createdAt = { ...(from && { gte: new Date(from) }), ...(to && { lte: new Date(to) }) };
  }
  if (q.trim()) {
    const matches = await Promise.all(['CUSTOMER','EMPLOYEE','ADMIN'].map(async type => {
      const model = { CUSTOMER:'customer', EMPLOYEE:'empolyee', ADMIN:'admin' }[type];
      return (await db[model].findMany({ where: { OR: [{ name: { contains: q, mode: 'insensitive' } }, { email: { contains: q, mode: 'insensitive' } }] }, select: { id: true }, take: 100 })).flatMap(u => [{ reporterId: u.id, reporterType: type }, { reportedUserId: u.id, reportedUserType: type }]);
    }));
    where.OR = [{ id: { contains: q, mode: 'insensitive' } }, { reason: { contains: q, mode: 'insensitive' } }, ...matches.flat()];
  }
  const orderField = { date: 'createdAt', reporter: 'reporterId', reportedUser: 'reportedUserId', status: 'status' }[sort];
  const reports = await db.contentReport.findMany({ where, include: { message: true }, orderBy: [{ [orderField]: direction }, { id: direction }], take: 50, skip: (page - 1) * 50 });
  res.set('X-Total-Count', String(await db.contentReport.count({ where }))).json(await Promise.all(reports.map(r => reportView(r))));
}));
router.get('/reports/:id', wrap(async (req, res) => {
  const report = await findReport(req.params.id); if (!report) return res.sendStatus(404);
  const subject = subjectOf(report);
  const at = report.message?.createdAt || (report.evidence?.createdAt && new Date(report.evidence.createdAt));
  const chatId = report.chatId || report.message?.chatId || report.evidence?.chatId;
  let context = [];
  if (chatId && at && Number.isFinite(+at)) {
    const select = { id:true, chatId:true, senderId:true, senderType:true, content:true, messageType:true, createdAt:true, deletedAt:true };
    const before = await db.message.findMany({ where: { chatId, createdAt: { lte: at }, deletedAt: null }, select, orderBy: [{ createdAt:'desc' }, { id:'desc' }], take:6 });
    const after = await db.message.findMany({ where: { chatId, createdAt: { gt: at }, deletedAt: null }, select, orderBy: [{ createdAt:'asc' }, { id:'asc' }], take:5 });
    context = [...before.reverse(), ...after];
    await audit(db, subject, req.user.id, 'VIEW_REPORT_CONTEXT', 'Opened bounded conversation context for investigation', { reportId: report.id });
  }
  const history = subject.userId ? await db.chatModerationAction.findMany({ where: subject, orderBy: { createdAt:'desc' }, take:100 }) : [];
  const related = subject.userId ? await db.contentReport.findMany({ where: { reportedUserId:subject.userId, reportedUserType:subject.userType, id:{ not:report.id } }, select: { id:true, reason:true, status:true, createdAt:true }, orderBy:{ createdAt:'desc' }, take:20 }) : [];
  const restrictions = subject.userId ? await db.chatSuspension.findMany({ where: subject }) : [];
  res.json({ ...await reportView(report), context, history, related, restrictions });
}));
router.get('/reports/:id/attachment', wrap(async (req, res) => {
  const report = await findReport(req.params.id);
  if (!report?.evidenceFile || !/^[a-f0-9-]{36}$/.test(report.evidenceFile)) return res.sendStatus(404);
  await audit(db, subjectOf(report), req.user.id, 'VIEW_ATTACHMENT', 'Downloaded protected report evidence', { reportId:report.id });
  res.set({ 'X-Content-Type-Options':'nosniff', 'Content-Type':'application/octet-stream', 'Content-Disposition':'attachment; filename="reported-attachment"' });
  res.sendFile(path.join(evidenceRoot(), report.evidenceFile));
}));
router.post('/reports/:id/status', wrap(async (req, res) => {
  const { status, note } = req.body;
  if (!statuses.includes(status) || !validReason(note)) return res.sendStatus(400);
  const found = await db.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "ContentReport" WHERE id = ${req.params.id} FOR UPDATE`;
    const report = await tx.contentReport.findUnique({ where:{ id:req.params.id }, include:{ message:true } });
    if (!report) return false;
    await tx.contentReport.update({ where:{ id:report.id }, data:{ status, moderatorId:req.user.id, resolutionNote:note.trim(), resolvedAt:['RESOLVED','DISMISSED'].includes(status) ? new Date() : null } });
    await audit(tx, subjectOf(report), req.user.id, `REPORT_${status}`, note, { reportId:report.id }); return true;
  });
  res.sendStatus(found ? 204 : 404);
}));
router.post('/reports/:id/notes', wrap(async (req, res) => {
  if (!validReason(req.body.note)) return res.sendStatus(400);
  const report = await findReport(req.params.id); if (!report) return res.sendStatus(404);
  await audit(db, subjectOf(report), req.user.id, 'INTERNAL_NOTE', req.body.note, { reportId:report.id }); res.sendStatus(204);
}));
// Legacy client operation retained; current dashboard separates removal and report status.
router.post('/reports/:id/resolve', wrap(async (req, res) => {
  const { action, note } = req.body;
  if (!['REMOVE','NO_VIOLATION'].includes(action) || !validReason(note)) return res.sendStatus(400);
  const report = await findReport(req.params.id); if (!report) return res.sendStatus(404);
  const removed = await db.$transaction(async tx => {
    const messages = action === 'REMOVE' && report.message ? await tx.message.findMany({ where: report.message.attachmentUrl ? { attachmentUrl:report.message.attachmentUrl, senderId:report.message.senderId, senderType:report.message.senderType } : { id:report.message.id }, select:{ id:true } }) : [];
    const removed = await removeMessages(tx, messages.map(m => m.id));
    await tx.contentReport.update({ where:{ id:report.id }, data:{ status:action === 'REMOVE' ? 'RESOLVED':'DISMISSED', resolvedAt:new Date(), moderatorId:req.user.id, resolutionNote:note.trim() } });
    await audit(tx, subjectOf(report), req.user.id, action, note, { reportId:report.id }); return removed;
  }, { timeout:30000 });
  notifyRemoval(req.io, removed); res.sendStatus(204);
}));
router.get('/suspensions', wrap(async (_req, res) => res.json(await db.chatSuspension.findMany({ where:{ until:{ gt:new Date() } }, orderBy:{ until:'asc' }, take:200 }))));
router.post('/reports/:id/suspension', wrap(async (req, res) => {
  const { minutes, reason, scope = 'CHAT' } = req.body;
  if (!validMinutes(minutes) || !validReason(reason) || !['CHAT','ACCOUNT'].includes(scope)) return res.sendStatus(400);
  const report = await findReport(req.params.id); if (!report) return res.sendStatus(404);
  const subject = subjectOf(report);
  // Platform Admin peers are deliberately outside this interface's moderation authority.
  if (subject.userType === 'ADMIN') return res.status(403).json({ error:'Platform administrator restrictions require a separate authorized operator process.' });
  const saved = await db.$transaction(async tx => {
    if (!await lockSubject(tx, subject)) return null;
    const data = { until:new Date(Date.now()+minutes*60000), startedAt:new Date(), reason:reason.trim(), moderatorId:req.user.id };
    const saved = await tx.chatSuspension.upsert({ where:{ userId_userType_scope:{ ...subject, scope } }, create:{ ...subject, scope, ...data }, update:data });
    await audit(tx, subject, req.user.id, `SET_${scope}_SUSPENSION`, reason, { until:data.until, reportId:report.id }); return saved;
  });
  if (!saved) return res.sendStatus(404);
  req.io?.to(`user_${saved.userType}_${saved.userId}`).emit(scope === 'CHAT' ? 'chat_suspended':'account_suspended', { until:saved.until, reason:saved.reason });
  if (scope === 'ACCOUNT') disconnectUser(saved.userType, saved.userId);
  res.json(saved);
}));
for (const action of ['extend','lift']) router.post(`/suspensions/:id/${action}`, wrap(async (req, res) => {
  const { minutes, reason } = req.body;
  if (!validReason(reason) || (action === 'extend' && !validMinutes(minutes))) return res.sendStatus(400);
  const saved = await db.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "ChatSuspension" WHERE id = ${req.params.id} FOR UPDATE`;
    const current = await tx.chatSuspension.findUnique({ where:{ id:req.params.id } }); if (!current) return null;
    if (current.userType === 'ADMIN') return 'FORBIDDEN';
    const until = action === 'lift' ? new Date() : new Date(Math.max(Date.now(), +current.until)+minutes*60000);
    if (+until > Date.now()+43200*60000) return 'TOO_LONG';
    await audit(tx, current, req.user.id, `${action.toUpperCase()}_${current.scope}_SUSPENSION`, reason, { until });
    return tx.chatSuspension.update({ where:{ id:current.id }, data:{ until, reason:reason.trim(), moderatorId:req.user.id } });
  });
  if (!saved) return res.sendStatus(404);
  if (saved === 'FORBIDDEN') return res.sendStatus(403);
  if (saved === 'TOO_LONG') return res.status(400).json({ error:'Expiry cannot exceed 30 days from now.' });
  req.io?.to(`user_${saved.userType}_${saved.userId}`).emit('chat_suspended', { until:saved.until, reason:saved.reason });
  if (action === 'lift') res.sendStatus(204); else res.json(saved);
}));
router.post('/messages/:id/remove', wrap(async (req, res) => {
  if (!validReason(req.body.reason) || req.body.confirm !== req.params.id) return res.sendStatus(400);
  const result = await db.$transaction(async tx => {
    const message = await tx.message.findUnique({ where:{ id:req.params.id } }); if (!message) return null;
    const removed = await removeMessages(tx, [message.id]);
    if (removed.length) await audit(tx, { userId:message.senderId, userType:message.senderType }, req.user.id, 'REMOVE_MESSAGE', req.body.reason);
    return removed;
  }, { timeout:30000 });
  if (!result) return res.sendStatus(404); notifyRemoval(req.io, result); res.sendStatus(204);
}));
router.post('/reports/:id/delete-user-messages', wrap(async (req, res) => {
  const report = await findReport(req.params.id); if (!report) return res.sendStatus(404);
  const subject = subjectOf(report);
  if (!validReason(req.body.reason) || req.body.confirm !== `${subject.userType}:${subject.userId}` || req.body.confirmAll !== true) return res.status(400).json({ error:'Both confirmations and a reason are required.' });
  if (subject.userType === 'ADMIN') return res.sendStatus(403);
  const job = await db.$transaction(async tx => {
    if (!await lockSubject(tx, subject)) return null;
    const existing = await tx.moderationDeletionJob.findFirst({ where:{ ...subject, status:{ in:['PENDING','PROCESSING'] } } }); if (existing) return existing;
    const job = await tx.moderationDeletionJob.create({ data:{ ...subject, moderatorId:req.user.id, reason:req.body.reason.trim() } });
    await audit(tx, subject, req.user.id, 'BULK_DELETE_REQUESTED', `${req.body.reason} (job ${job.id})`, { reportId:report.id }); return job;
  });
  if (!job) return res.sendStatus(404); res.status(202).json(job);
}));
router.get('/deletion-jobs', wrap(async (_req,res) => res.json(await db.moderationDeletionJob.findMany({ orderBy:{ cutoff:'desc' }, take:100 }))));
export default router;
