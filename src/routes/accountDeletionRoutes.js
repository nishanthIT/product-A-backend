import express from 'express';
import bcrypt from 'bcryptjs';
import { PrismaClient } from '@prisma/client';
import { isAuthenticated, isAdmin } from '../middleware/authware.js';
import { authRateLimit } from '../middleware/authRateLimit.js';
import { accountTable, deletionStatus, receiptDigest, requestDeletion } from '../services/accountDeletion.js';

const db = new PrismaClient();
const router = express.Router();
// Deletion reauthentication does not require an active employment membership.
// A departing employee can prove account ownership without regaining shop access.
router.post('/request-with-password', authRateLimit('deletion-password', { limit: 10 }), async (req, res, next) => {
  try {
    const { email, password, confirmation } = req.body;
    if (typeof email !== 'string' || typeof password !== 'string' || confirmation !== 'DELETE') return res.status(400).json({ error: 'Enter your account email, password and DELETE.' });
    const matches = [];
    for (const userType of ['ADMIN', 'CUSTOMER', 'EMPLOYEE']) {
      const account = await db[accountTable(userType)].findFirst({ where: { email: { equals: email.trim(), mode: 'insensitive' } } });
      if (account && await bcrypt.compare(password, account.password)) matches.push({ id: account.id, userType });
    }
    if (!matches.length) return res.status(403).json({ error: 'Account verification failed. Check your email and password.' });
    if (matches.length !== 1) return res.status(409).json({ error: 'More than one account matches. Contact support@paymi.co.uk to identify the account to delete.' });
    res.set('Cache-Control', 'no-store').status(202).json(await requestDeletion(db, matches[0]));
  } catch (error) { next(error); }
});
router.use((req, _res, next) => { delete req.headers['x-supermarket-id']; next(); });
router.post('/request', isAuthenticated, authRateLimit('deletion', { limit: 10 }), async (req, res, next) => {
  try {
    if (req.body.confirmation !== 'DELETE' || typeof req.body.password !== 'string') {
      return res.status(400).json({ error: 'Enter your password and DELETE to confirm personal account deletion.' });
    }
    const account = await db[accountTable(req.user.userType)].findUnique({ where: { id: req.user.id } });
    if (!account || !await bcrypt.compare(req.body.password, account.password)) return res.status(403).json({ error: 'Password verification failed.' });
    res.set('Cache-Control', 'no-store').status(202).json(await requestDeletion(db, req.user));
  } catch (error) { next(error); }
});
router.post('/status', authRateLimit('deletion-status', { limit: 60 }), async (req, res, next) => {
  try {
    if (!/^[a-f0-9]{64}$/.test(req.body.receipt || '')) return res.sendStatus(404);
    const job = await db.accountDeletionJob.findUnique({ where: { receiptHash: receiptDigest(req.body.receipt) } });
    if (!job) return res.sendStatus(404);
    res.set('Cache-Control', 'no-store').json(deletionStatus(job));
  } catch (error) { next(error); }
});
router.get('/queue', isAuthenticated, isAdmin, async (_req, res, next) => {
  try { res.set('Cache-Control', 'no-store').json(await db.accountDeletionJob.findMany({ where: { status: { not: 'COMPLETE' } }, select: { id: true, status: true, createdAt: true, updatedAt: true }, orderBy: { createdAt: 'asc' } })); }
  catch (error) { next(error); }
});
export default router;
