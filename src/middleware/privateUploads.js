import { hiddenAuthors } from '../services/chatSafety.js';
import express from 'express';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { isAuthenticated, requireShopFeature } from './authware.js';
import { SHOP_FEATURES } from '../services/accessControl.js';
import { getChatAccess } from '../services/chatAccess.js';
const db = new PrismaClient();
const router = express.Router();
router.get('/chat/:filename', isAuthenticated, async (req, res, next) => {
  try {
    if (req.params.filename !== path.basename(req.params.filename)) return res.sendStatus(404);
    const suffix = `/uploads/chat/${req.params.filename}`;
    const messages = await db.message.findMany({
      where: { attachmentUrl: { endsWith: suffix }, deletedAt: null, NOT: await hiddenAuthors(req.user, db) }, select: { chatId: true },
    });
    for (const message of messages) {
      if ((await getChatAccess(req.user, message.chatId, db))?.canRead) {
        res.set('Cache-Control', 'private, no-store');
        res.set('X-Content-Type-Options', 'nosniff');
        return res.sendFile(path.resolve('uploads/chat', req.params.filename), error => { if (error) next(error); });
      }
    }
    return res.sendStatus(404);
  } catch (error) { next(error); }
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
