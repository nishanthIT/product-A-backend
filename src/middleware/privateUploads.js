import { hiddenAuthors } from '../services/chatSafety.js';
import express from 'express';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { PrismaClient } from '@prisma/client';
import { isAuthenticated, requireShopFeature } from './authware.js';
import { SHOP_FEATURES } from '../services/accessControl.js';
import { getChatAccess } from '../services/chatAccess.js';
import { attachmentFilename, attachmentReferenceFilter, getChatStorage } from '../services/chatStorage.js';
const db = new PrismaClient();
const router = express.Router();
router.use((_req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Content-Security-Policy', "default-src 'none'; sandbox");
  next();
});
router.get('/chat/:filename', isAuthenticated, async (req, res, next) => {
  try {
    const filename = attachmentFilename(`/uploads/chat/${req.params.filename}`);
    if (!filename || filename !== req.params.filename) return res.sendStatus(404);
    const messages = await db.message.findMany({
      where: { ...attachmentReferenceFilter(filename), deletedAt: null, NOT: await hiddenAuthors(req.user, db) }, select: { chatId: true }, distinct: ['chatId'],
    });
    for (const message of messages) {
      if ((await getChatAccess(req.user, message.chatId, db))?.canRead) {
        const upload = await db.chatUpload.findUnique({ where: { filename } });
        if (upload?.pendingDeletion) return res.sendStatus(404);
        const file = await getChatStorage().open(upload || { filename });
        if (!file) return res.sendStatus(404);
        res.set('Cache-Control', 'private, no-store');
        res.set('X-Content-Type-Options', 'nosniff');
        res.set('Content-Type', file.contentType);
        res.set('Content-Disposition', `${/^image\//.test(file.contentType) ? 'inline' : 'attachment'}; filename="${filename}"`);
        if (Number.isSafeInteger(file.size)) res.set('Content-Length', String(file.size));
        // Proxy private objects through the same authorization gate as disk
        // files; no public bucket URLs or reusable presigned URLs escape it.
        await pipeline(file.stream, res);
        return;
      }
    }
    return res.sendStatus(404);
  } catch (error) { if (res.headersSent) res.destroy(error); else next(error); }
});
router.use('/chat', (_req, res) => res.sendStatus(404));
for (const [directory, model, feature] of [
  ['incidents', 'incidentLog', SHOP_FEATURES.INCIDENTS],
  ['age-restriction-records', 'ageRestrictionRecord', SHOP_FEATURES.AGE_RECORDS],
]) {
  router.get(`/${directory}/:filename`, isAuthenticated, requireShopFeature(feature, 'read'), async (req, res, next) => {
    try {
      if (!req.user.shopId || req.params.filename !== path.basename(req.params.filename)) return res.sendStatus(404);
      const suffix = `/uploads/${directory}/${req.params.filename}`;
      const record = await db[model].findFirst({ where: { shopId: req.user.shopId, imageUrl: { endsWith: suffix } }, select: { id: true } });
      if (!record) return res.sendStatus(404);
      res.set('Cache-Control', 'private, no-store');
      res.sendFile(path.resolve('uploads', directory, req.params.filename), (error) => { if (error) next(error); });
    } catch (error) { next(error); }
  });
  // Prevent static middleware from bypassing protection via other methods or nested paths.
  router.use(`/${directory}`, (_req, res) => res.sendStatus(404));
}
// Certificates already have an authenticated download endpoint.
router.use('/certificates', (_req, res) => res.sendStatus(404));
export default router;
