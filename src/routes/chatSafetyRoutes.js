import express from 'express';
import path from 'node:path';
import fs from 'node:fs/promises';
import { captureEvidence, evidenceRoot } from '../services/moderationEvidence.js';
import { PrismaClient } from '@prisma/client';
import { isAuthenticated } from '../middleware/authware.js';
import { authRateLimit } from '../middleware/authRateLimit.js';
import { getChatAccess } from '../services/chatAccess.js';
import { activeSuspension, COMMUNITY_VERSION } from '../services/chatSafety.js';
import moderationRoutes from './moderationRoutes.js';
import { disconnectUser } from '../services/realtime.js';
const db = new PrismaClient();
const router = express.Router();
router.use(isAuthenticated);
const identity = req => ({ userId: req.user.id, userType: req.user.userType });
router.get('/', async (req, res, next) => {
  try {
    res.set('Cache-Control', 'no-store').json({ version: COMMUNITY_VERSION, acceptanceRequired: false, suspension: await activeSuspension(req.user, db), blocks: await db.userBlock.findMany({ where: identity(req), select: { id: true, blockedId: true, blockedType: true } }) });
  } catch (error) { next(error); }
});
// Compatibility for older clients: no acceptance state gates posting.
router.post('/accept', (_req, res) => res.sendStatus(204));
router.post('/report', authRateLimit('content-report', { limit: 20 }), async (req, res, next) => {
  try {
    const { messageId, reason, explanation } = req.body;
    if (typeof messageId !== 'string' || !['ABUSE', 'SEXUAL_CONTENT', 'CHILD_SAFETY', 'THREATS', 'SPAM', 'SCAM', 'INAPPROPRIATE', 'OTHER'].includes(reason)) return res.sendStatus(400);
    if (explanation !== undefined && (typeof explanation !== 'string' || explanation.length > 1000)) return res.sendStatus(400);
    const message = await db.message.findUnique({ where: { id: messageId } });
    if (!message || !(await getChatAccess(req.user, message.chatId, db))?.canRead) return res.sendStatus(404);
    if (message.senderId === req.user.id && message.senderType === req.user.userType) return res.status(400).json({ error: 'You cannot report your own message.' });
    let captured;
    let report;
    try {
      report = await db.$transaction(async tx => {
        // Serializes duplicate reports and author deletion of this message.
        await tx.$queryRaw`SELECT "id" FROM "Message" WHERE "id" = ${messageId} FOR UPDATE`;
        const existing = await tx.contentReport.findFirst({ where: { messageId, reporterId: req.user.id, reporterType: req.user.userType } });
        if (existing) return existing;
        const current = await tx.message.findUnique({ where: { id: messageId } });
        if (!current || current.deletedAt) return null;
        captured = await captureEvidence(current);
        return tx.contentReport.create({ data: { messageId, reporterId: req.user.id, reporterType: req.user.userType, reason, explanation: explanation?.trim() || null, reportedUserId: current.senderId, reportedUserType: current.senderType, chatId: current.chatId, ...captured } });
      }, { timeout: 30000 });
    } catch (error) {
      if (captured?.evidenceFile) await fs.unlink(path.join(evidenceRoot(), captured.evidenceFile)).catch(() => {});
      throw error;
    }
    if (!report) return res.sendStatus(404);
    res.status(202).json({ id: report.id, status: report.status });
  } catch (error) { next(error); }
});
router.post('/block', async (req, res, next) => {
  try {
    const message = typeof req.body.messageId === 'string' && await db.message.findUnique({ where: { id: req.body.messageId } });
    if (!message || !(await getChatAccess(req.user, message.chatId, db))?.canRead) return res.sendStatus(404);
    if (message.senderId === req.user.id && message.senderType === req.user.userType) return res.sendStatus(400);
    const key = { ...identity(req), blockedId: message.senderId, blockedType: message.senderType };
    await db.userBlock.upsert({ where: { userId_userType_blockedId_blockedType: key }, create: key, update: {} });
    // Reconnect clients so no old room membership can bypass a new direct-chat block.
    disconnectUser(req.user.userType, req.user.id);
    disconnectUser(message.senderType, message.senderId);
    res.sendStatus(204);
  } catch (error) { next(error); }
});
router.delete('/block/:id', async (req, res, next) => {
  try { await db.userBlock.deleteMany({ where: { id: req.params.id, ...identity(req) } }); res.sendStatus(204); }
  catch (error) { next(error); }
});
router.use(moderationRoutes);
export default router;
