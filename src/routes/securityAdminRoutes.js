import express from 'express';
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { isAuthenticated, isAdmin } from '../middleware/authware.js';
import { readSessionToken } from '../services/sessionSecurity.js';
import { DatabaseCache } from '../services/databaseCache.js';
import { disconnectUser } from '../services/realtime.js';
import {
  securityDb as db, securityHash, securityBudgets, securityPolicy, securityAdminAudit,
  recordSecurityEvent, validSecuritySubject, SECURITY_SCOPES, SECURITY_CATEGORIES,
  SECURITY_SEVERITIES, SECURITY_POLICY_BOUNDS, validateSecurityPolicy, resetSecurityBudgets, verifySecurityAudit,
} from '../services/securityProtection.js';

const router = express.Router();
const cache = new DatabaseCache(db);
router.use(isAuthenticated, isAdmin);
router.use((_req, res, next) => { res.set('Cache-Control', 'private, no-store'); next(); });
const wrap = fn => async (req, res, next) => { try { await fn(req, res); } catch (error) { next(error); } };
const reasonOK = value => typeof value === 'string' && value.trim().length >= 5 && value.length <= 1000;
const minutesOK = value => Number.isInteger(value) && value >= 1 && value <= 43200;
const invalid = res => res.status(400).json({ error: 'Invalid security request. Check the target, duration and reason.' });
const pageOf = query => {
  const page = Number(query.page || 1), pageSize = Number(query.limit || query.pageSize || 50);
  return Number.isInteger(page) && page >= 1 && page <= 1000 && Number.isInteger(pageSize) && pageSize >= 1 && pageSize <= 100 ? { page, pageSize, skip: (page - 1) * pageSize } : null;
};
const accountModel = subject => ({ CUSTOMER: 'customer', EMPLOYEE: 'empolyee', ADMIN: 'admin' })[subject.split(':')[0]];
const targetExists = async (tx, subject) => {
  if (!validSecuritySubject(subject)) return false;
  const model = accountModel(subject);
  return model ? !!await tx[model].findUnique({ where: { id: Number(subject.split(':')[1]) }, select: { id: true } }) : true;
};
const sessionBinding = req => `${req.user.id}:${securityHash(readSessionToken(req) || '')}`;

router.post('/reauth', wrap(async (req, res) => {
  const quota = await securityBudgets.consume(`reauth:${req.user.id}`, 'admin-reauth', { limit: 5, seconds: 900 });
  if (!quota.allowed) { res.set('Retry-After', String(quota.retryAfter)); return res.status(429).json({ error: 'Too many confirmation attempts. Please try again later.' }); }
  if (typeof req.body.password !== 'string' || req.body.password.length > 200) return invalid(res);
  const admin = await db.admin.findUnique({ where: { id: req.user.id }, select: { password: true } });
  if (!admin || !await bcrypt.compare(req.body.password, admin.password)) {
    await recordSecurityEvent(req, { category: 'authentication', severity: 'high', rule: 'ADMIN_REAUTH_FAILED', reason: 'Security administrator password confirmation failed', action: 'denied' });
    return res.status(401).json({ error: 'Password confirmation failed.' });
  }
  const reauthToken = crypto.randomBytes(32).toString('hex'), expiresAt = new Date(Date.now() + 600000);
  await cache.setValue(`security-reauth:${securityHash(reauthToken)}`, sessionBinding(req), expiresAt);
  res.json({ reauthToken, expiresAt });
}));
router.use((req, res, next) => {
  if (['GET', 'HEAD'].includes(req.method)) return next();
  const token = req.get('X-Security-Reauth');
  if (!token || !/^[a-f0-9]{64}$/.test(token)) return res.status(403).json({ error: 'Confirm your administrator password before changing security controls.', code: 'SECURITY_REAUTH_REQUIRED' });
  cache.read(`security-reauth:${securityHash(token)}`).then(entry => {
    if (entry?.value !== sessionBinding(req)) return res.status(403).json({ error: 'Administrator confirmation expired. Please confirm again.', code: 'SECURITY_REAUTH_REQUIRED' });
    next();
  }).catch(next);
});

router.get('/overview', wrap(async (_req, res) => {
  const active = { until: { gt: new Date() }, liftedAt: null };
  const [totalEvents, failedLogins, rateLimitViolations, suspectedScraping, unauthorizedAccess, restrictedAccounts, ipRestrictions, highSeverityEvents, recentEvents, activeRestrictions] = await Promise.all([
    db.securityEvent.count(), db.securityEvent.count({ where: { category: 'authentication' } }),
    db.securityEvent.count({ where: { category: 'rate_limit' } }), db.securityEvent.count({ where: { category: 'scraping' } }),
    db.securityEvent.count({ where: { category: 'authorization' } }),
    db.securityRestriction.count({ where: { ...active, NOT: { subjectKey: { startsWith: 'ip:' } } } }),
    db.securityRestriction.count({ where: { ...active, subjectKey: { startsWith: 'ip:' } } }),
    db.securityEvent.count({ where: { severity: { in: ['high', 'critical'] } } }),
    db.securityEvent.findMany({ orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 20 }),
    db.securityRestriction.findMany({ where: active, orderBy: { until: 'desc' }, take: 50 }),
  ]);
  res.json({ totalEvents, failedLogins, rateLimitViolations, suspectedScraping, unauthorizedAccess, restrictedAccounts, ipRestrictions, highSeverityEvents, recentEvents, activeRestrictions });
}));
router.get('/events', wrap(async (req, res) => {
  const paging = pageOf(req.query); if (!paging) return invalid(res);
  const { category, severity, subjectKey, q, from, to, status } = req.query;
  if ((category && !SECURITY_CATEGORIES.includes(category)) || (severity && !SECURITY_SEVERITIES.includes(severity)) || (subjectKey && !validSecuritySubject(subjectKey)) || (q !== undefined && (typeof q !== 'string' || q.length > 200)) || (status && !['OPEN','REVIEWED','RESOLVED'].includes(status))) return invalid(res);
  if ([from, to].some(value => value && (typeof value !== 'string' || !Number.isFinite(Date.parse(value))))) return invalid(res);
  const where = {
    ...(category && { category }), ...(severity && { severity }), ...(subjectKey && { subjectKey }), ...(status && { status }),
    ...((from || to) && { createdAt: { ...(from && { gte: new Date(from) }), ...(to && { lte: new Date(to) }) } }),
    ...(q?.trim() && { OR: ['username','subjectKey','rule','reason','endpoint'].map(key => ({ [key]: { contains: q.trim(), mode: 'insensitive' } })) }),
  };
  const [events, total] = await Promise.all([db.securityEvent.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: paging.pageSize, skip: paging.skip }), db.securityEvent.count({ where })]);
  res.json({ events, total, page: paging.page, pageSize: paging.pageSize });
}));
router.get('/events/:id', wrap(async (req, res) => {
  const event = await db.securityEvent.findUnique({ where: { id: req.params.id } });
  if (!event) return res.sendStatus(404);
  const correlate = [...(event.subjectKey ? [{ subjectKey: event.subjectKey }] : []), ...(event.ipHash ? [{ ipHash: event.ipHash }] : []), ...(event.sessionHash ? [{ sessionHash: event.sessionHash }] : [])];
  const [related, restrictions, history] = await Promise.all([
    correlate.length ? db.securityEvent.findMany({ where: { OR: correlate, id: { not: event.id } }, take: 30, orderBy: { createdAt: 'desc' } }) : [],
    event.subjectKey ? db.securityRestriction.findMany({ where: { subjectKey: event.subjectKey }, take: 10 }) : [],
    db.securityAdminAudit.findMany({ where: { details: { path: ['eventId'], equals: event.id } }, orderBy: { sequence: 'desc' }, take: 50 }),
  ]);
  res.json({ event, related, restrictions, history });
}));
for (const [path, delegate, field] of [['restrictions','securityRestriction','restrictions'], ['exceptions','securityException','exceptions'], ['audit','securityAdminAudit','audit']]) router.get(`/${path}`, wrap(async (req, res) => {
  const paging = pageOf(req.query); if (!paging) return invalid(res);
  if (req.query.subjectKey && !validSecuritySubject(req.query.subjectKey)) return invalid(res);
  const where = path === 'audit' ? {} : { ...(req.query.subjectKey && { subjectKey: req.query.subjectKey }), ...(req.query.active === 'true' && { until: { gt: new Date() }, liftedAt: null }) };
  const [rows, total] = await Promise.all([db[delegate].findMany({ where, take: paging.pageSize, skip: paging.skip, orderBy: path === 'audit' ? { sequence: 'desc' } : { until: 'desc' } }), db[delegate].count({ where })]);
  res.json({ [field]: rows, total, page: paging.page, pageSize: paging.pageSize });
}));
router.get('/audit/integrity', wrap(async (_req, res) => res.json(await verifySecurityAudit())));
router.get('/policy', wrap(async (_req, res) => res.json({ values: await securityPolicy(), bounds: SECURITY_POLICY_BOUNDS })));
router.patch('/policy', wrap(async (req, res) => {
  const { values, reason } = req.body;
  if (!validateSecurityPolicy(values) || !reasonOK(reason)) return invalid(res);
  const policy = await db.$transaction(async tx => {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended('security-policy', 0))::text`;
    const merged = { ...await securityPolicy(tx), ...values };
    if (merged.distinctProductsPerDay < merged.distinctProductsPerHour) throw Object.assign(new Error('Daily product budget must cover hourly budget'), { status: 400 });
    await securityAdminAudit(tx, req, 'POLICY_UPDATED', reason, { values });
    return tx.securityPolicy.upsert({ where: { id: 'default' }, create: { id: 'default', values: merged, updatedBy: req.user.id }, update: { values: merged, updatedBy: req.user.id } });
  });
  res.json({ values: policy.values, bounds: SECURITY_POLICY_BOUNDS });
}));
router.post('/restrictions', wrap(async (req, res) => {
  const { subjectKey, scope = 'account', minutes, reason } = req.body;
  if (!validSecuritySubject(subjectKey) || !SECURITY_SCOPES.includes(scope) || !minutesOK(minutes) || !reasonOK(reason)) return invalid(res);
  if (subjectKey.startsWith('ADMIN:') || (subjectKey === `ip:${req.ip}` && scope === 'account')) return res.status(403).json({ error: 'Administrator or own-IP account restrictions require an authorized operator process.' });
  const restriction = await db.$transaction(async tx => {
    if (!await targetExists(tx, subjectKey)) return null;
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`security-restriction:${subjectKey}:${scope}`}, 0))::text`;
    const data = { until: new Date(Date.now() + minutes * 60000), startedAt: new Date(), liftedAt: null, reason: reason.trim(), source: 'manual', createdBy: req.user.id };
    const result = await tx.securityRestriction.upsert({ where: { subjectKey_scope: { subjectKey, scope } }, create: { subjectKey, scope, ...data }, update: data });
    await securityAdminAudit(tx, req, 'RESTRICTION_SET', reason, { subjectKey, scope, until: data.until.toISOString(), restrictionId: result.id });
    await recordSecurityEvent(req, { category: 'administrative', severity: 'high', subjectKey, rule: 'MANUAL_RESTRICTION', reason, action: 'restricted', restrictionId: result.id }, tx);
    return result;
  });
  if (!restriction) return res.sendStatus(404);
  if (scope === 'account' && accountModel(subjectKey)) disconnectUser(subjectKey.split(':')[0], Number(subjectKey.split(':')[1]));
  res.status(201).json(restriction);
}));
for (const action of ['lift', 'extend']) {
  const handler = wrap(async (req, res) => {
    const { reason, minutes } = req.body;
    if (!reasonOK(reason) || (action === 'extend' && !minutesOK(minutes))) return invalid(res);
    const saved = await db.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM "SecurityRestriction" WHERE id=${req.params.id} FOR UPDATE`;
      const current = await tx.securityRestriction.findUnique({ where: { id: req.params.id } }); if (!current) return null;
      if (current.subjectKey.startsWith('ADMIN:')) return 'FORBIDDEN';
      const data = action === 'lift' ? { liftedAt: new Date(), reason: reason.trim() } : { until: new Date(Date.now() + minutes * 60000), liftedAt: null, reason: reason.trim() };
      if (action === 'lift') await resetSecurityBudgets(tx, current.subjectKey);
      await securityAdminAudit(tx, req, `RESTRICTION_${action.toUpperCase()}`, reason, { subjectKey: current.subjectKey, restrictionId: current.id, minutes });
      return tx.securityRestriction.update({ where: { id: current.id }, data });
    });
    if (saved === 'FORBIDDEN') return res.sendStatus(403);
    if (!saved) return res.sendStatus(404); res.json(saved);
  });
  if (action === 'lift') router.post('/restrictions/:id/lift', handler);
  else router.patch('/restrictions/:id', handler);
}
router.post('/accounts/:subjectKey/revoke-sessions', wrap(async (req, res) => {
  const { subjectKey } = req.params, { reason } = req.body, model = accountModel(subjectKey);
  if (!model || !validSecuritySubject(subjectKey) || !reasonOK(reason)) return invalid(res);
  if (subjectKey.startsWith('ADMIN:')) return res.sendStatus(403);
  const user = await db.$transaction(async tx => {
    if (!await targetExists(tx, subjectKey)) return null;
    const result = await tx[model].update({ where: { id: Number(subjectKey.split(':')[1]) }, data: { sessionVersion: { increment: 1 } }, select: { id: true } });
    await securityAdminAudit(tx, req, 'SESSIONS_REVOKED', reason, { subjectKey }); return result;
  });
  if (!user) return res.sendStatus(404);
  disconnectUser(subjectKey.split(':')[0], user.id);
  res.json({ success: true });
}));
router.patch('/events/:id', wrap(async (req, res) => {
  const { status, note } = req.body;
  if (!['REVIEWED','RESOLVED'].includes(status) || !reasonOK(note)) return invalid(res);
  const event = await db.$transaction(async tx => {
    if (!await tx.securityEvent.findUnique({ where: { id: req.params.id }, select: { id: true } })) return null;
    await securityAdminAudit(tx, req, `EVENT_${status}`, note, { eventId: req.params.id });
    return tx.securityEvent.update({ where: { id: req.params.id }, data: { status, reviewedBy: req.user.id, reviewedAt: new Date() } });
  });
  if (!event) return res.sendStatus(404); res.json(event);
}));
router.post('/events/:id/notes', wrap(async (req, res) => {
  if (!reasonOK(req.body.note)) return invalid(res);
  const result = await db.$transaction(async tx => {
    if (!await tx.securityEvent.findUnique({ where: { id: req.params.id }, select: { id: true } })) return null;
    return securityAdminAudit(tx, req, 'INVESTIGATION_NOTE', req.body.note, { eventId: req.params.id });
  });
  if (!result) return res.sendStatus(404); res.status(201).json(result);
}));
router.post('/exceptions', wrap(async (req, res) => {
  const { subjectKey, scope, minutes, reason } = req.body;
  if (!validSecuritySubject(subjectKey) || !accountModel(subjectKey) || !['catalogue','upload'].includes(scope) || !minutesOK(minutes) || !reasonOK(reason)) return invalid(res);
  const exception = await db.$transaction(async tx => {
    if (!await targetExists(tx, subjectKey)) return null;
    const result = await tx.securityException.create({ data: { subjectKey, scope, until: new Date(Date.now() + minutes * 60000), reason: reason.trim(), createdBy: req.user.id } });
    await securityAdminAudit(tx, req, 'EXCEPTION_CREATED', reason, { subjectKey, scope, minutes, exceptionId: result.id }); return result;
  });
  if (!exception) return res.sendStatus(404); res.status(201).json(exception);
}));
router.post('/exceptions/:id/lift', wrap(async (req, res) => {
  if (!reasonOK(req.body.reason)) return invalid(res);
  const result = await db.$transaction(async tx => {
    const current = await tx.securityException.findUnique({ where: { id: req.params.id } }); if (!current) return null;
    await securityAdminAudit(tx, req, 'EXCEPTION_REMOVED', req.body.reason, { exceptionId: current.id, subjectKey: current.subjectKey });
    return tx.securityException.update({ where: { id: current.id }, data: { liftedAt: new Date() } });
  });
  if (!result) return res.sendStatus(404); res.json(result);
}));
export default router;
