import crypto from 'node:crypto';
import { isIP } from 'node:net';
import { PrismaClient } from '@prisma/client';
import redisService from './redisService.js';
import { DatabaseCache, cacheKey } from './databaseCache.js';
import { readSessionToken, jwtSecret } from './sessionSecurity.js';

export const securityDb = new PrismaClient();
export const securityHash = value => crypto.createHash('sha256').update(String(value)).digest('hex');
export const SECURITY_SCOPES = Object.freeze(['account', 'catalogue', 'auth', 'upload']);
export const SECURITY_CATEGORIES = Object.freeze(['authentication', 'authorization', 'rate_limit', 'scraping', 'upload', 'administrative', 'availability']);
export const SECURITY_SEVERITIES = Object.freeze(['low', 'medium', 'high', 'critical']);
export const SECURITY_DEFAULTS = Object.freeze({
  accountRequestsPerMinute: 300, catalogueRequestsPerMinute: 120, ipRequestsPerMinute: 1800,
  sessionRequestsPerMinute: 240, uploadRequestsPerHour: 120, distinctProductsPerHour: 1200, distinctProductsPerDay: 4000,
  distinctPricesPerHour: 6000, distinctSearchesPerHour: 300, distinctPagesPerHour: 120,
  concurrentRequests: 12, requestTimeoutSeconds: 30, maximumResponseBytes: 8 * 1024 * 1024,
  restrictionAfterViolations: 8, restrictionSeconds: 4 * 3600, retentionDays: 90, companyCatalogueMultiplier: 8,
});
export const SECURITY_POLICY_BOUNDS = Object.freeze({
  accountRequestsPerMinute: [30, 3000], catalogueRequestsPerMinute: [20, 1000], ipRequestsPerMinute: [300, 30000],
  sessionRequestsPerMinute: [20, 3000], uploadRequestsPerHour: [20, 1000], distinctProductsPerHour: [100, 10000], distinctProductsPerDay: [200, 30000],
  distinctPricesPerHour: [500, 100000], distinctSearchesPerHour: [30, 3000], distinctPagesPerHour: [20, 1000],
  concurrentRequests: [2, 50], requestTimeoutSeconds: [5, 120], maximumResponseBytes: [262144, 16777216],
  restrictionAfterViolations: [5, 30], restrictionSeconds: [900, 86400], retentionDays: [7, 365], companyCatalogueMultiplier: [1, 20],
});
export function validateSecurityPolicy(values) {
  if (!values || typeof values !== 'object' || Array.isArray(values)) return false;
  return Object.entries(values).length > 0 && Object.entries(values).every(([key, value]) => {
    const bounds = SECURITY_POLICY_BOUNDS[key];
    return bounds && Number.isInteger(value) && value >= bounds[0] && value <= bounds[1];
  });
}
export const subjectKeyOf = user => user?.id && ['ADMIN','CUSTOMER','EMPLOYEE'].includes(user.userType) ? `${user.userType}:${user.id}` : null;
export function validSecuritySubject(subject) {
  return typeof subject === 'string' && ((/^(ADMIN|CUSTOMER|EMPLOYEE):[1-9]\d{0,9}$/.test(subject) && Number(subject.split(':')[1]) <= 2147483647) || /^identity:[a-f0-9]{64}$/.test(subject) || (subject.startsWith('ip:') && isIP(subject.slice(3)) !== 0));
}
export function requestSubjects(req, additional = []) {
  return [...new Set([subjectKeyOf(req.user), req.ip && `ip:${req.ip}`, ...additional].filter(validSecuritySubject))];
}
export function securityContext(req = {}) {
  const token = readSessionToken(req);
  return {
    subjectKey: subjectKeyOf(req.user), userId: req.user?.id || null, userType: req.user?.userType || null,
    username: String(req.user?.name || '').slice(0, 160) || null, shopId: req.user?.shopId || null,
    sourceIp: isIP(req.ip || '') ? req.ip : null, ipHash: req.ip ? securityHash(req.ip) : null,
    sessionHash: token ? securityHash(token) : null,
    // Path templates avoid storing access tokens, raw searches or identifiers in URLs.
    endpoint: `${req.baseUrl || ''}${typeof req.route?.path === 'string' ? req.route.path : String(req.path || '').replace(/(?:[a-z0-9_-]{20,}|\d{6,})/gi, ':resource')}`.slice(0, 240),
    method: String(req.method || '').slice(0, 10), userAgent: String(req.headers?.['user-agent'] || '').replace(/[\r\n]/g, '').slice(0, 400),
  };
}
export function safeSecurityEvidence(input, depth = 0) {
  if (depth > 4 || input === null || input === undefined) return null;
  if (typeof input === 'number') return Number.isFinite(input) ? input : null;
  if (typeof input === 'boolean') return input;
  if (typeof input === 'string') return input.slice(0, 200);
  if (Array.isArray(input)) return input.slice(0, 20).map(value => safeSecurityEvidence(value, depth + 1));
  if (typeof input !== 'object') return null;
  return Object.fromEntries(Object.entries(input).slice(0, 30).filter(([key]) => !/pass|secret|token|cookie|authorization|email|otp|body|query|url/i.test(key)).map(([key, value]) => [key.slice(0, 60), safeSecurityEvidence(value, depth + 1)]));
}

// PostgreSQL remains authoritative through every Redis outage/reconnect. Its
// transaction-scoped advisory locks serialize quota changes across all instances.
// Redis holds an atomic, monotonic fixed-window mirror; it never resets a budget
// or resurrects a restriction when a process or Redis restarts.
const MIRROR_MAX_SCRIPT = `local old=tonumber(redis.call('GET',KEYS[1]) or '0'); local new=tonumber(ARGV[1]); if new>old then redis.call('SET',KEYS[1],ARGV[1],'PX',ARGV[2]); elseif redis.call('PTTL',KEYS[1])<0 then redis.call('PEXPIRE',KEYS[1],ARGV[2]); end; return math.max(old,new)`;
export class SecurityBudgetStore {
  constructor({ store = new DatabaseCache(securityDb), redis = redisService, now = () => Date.now() } = {}) { this.store = store; this.redis = redis; this.now = now; }
  async consume(identity, rule, { limit, seconds = 60, resources = null, amount = 1 } = {}) {
    if (!Number.isInteger(limit) || limit < 1 || !Number.isInteger(seconds) || seconds < 1) throw new Error('Invalid security budget');
    const now = this.now(), bucket = Math.floor(now / (seconds * 1000));
    const expiresAt = new Date((bucket + 1) * seconds * 1000);
    const key = `security:v1:${securityHash(identity)}:${rule}:${bucket}`;
    const { result } = await this.store.mutate(key, current => {
      let value = current?.value && typeof current.value === 'object' ? current.value : { count: 0, resources: [] };
      let count;
      if (resources) {
        // Only successful admissions enter the set. Counting a rejected batch as
        // admitted would let its retry retrieve those records without a quota.
        const admitted = new Set(value.resources || []);
        const candidate = new Set(admitted);
        for (const resource of resources) { candidate.add(securityHash(resource)); if (candidate.size > limit) break; }
        count = candidate.size;
        value = count <= limit ? { count, resources: [...candidate] } : { count: admitted.size, resources: [...admitted] };
      } else { count = Math.min(Number(value.count || 0) + amount, limit * 100 + 1); value = { count }; }
      return { entry: { type: 'security-budget', value, expiresAt }, result: { allowed: count <= limit, count, limit, retryAfter: Math.max(1, Math.ceil((+expiresAt - now) / 1000)), rule } };
    });
    // Cache availability never controls enforcement. A failed DB mutation throws.
    if (this.redis?.isRedisConnected?.()) await this.redis.redis('eval', MIRROR_MAX_SCRIPT, 1, `paymi:security:${securityHash(key)}`, result.count, Math.max(1, +expiresAt - now));
    return result;
  }
  async lease(identity, limit, seconds) {
    const id = crypto.randomUUID(), now = this.now(), key = `security:concurrency:${securityHash(identity)}`;
    const { result } = await this.store.mutate(key, current => {
      const leases = (current?.value?.leases || []).filter(lease => lease.until > now);
      if (leases.length >= limit) return { entry: current, result: null };
      leases.push({ id, until: now + seconds * 1000 });
      return { entry: { type: 'security-leases', value: { leases }, expiresAt: new Date(now + seconds * 1000) }, result: id };
    });
    if (!result) return null;
    let released = false;
    return async () => {
      if (released) return; released = true;
      await this.store.mutate(key, current => {
        const leases = (current?.value?.leases || []).filter(lease => lease.id !== id && lease.until > this.now());
        return { entry: leases.length ? { ...current, value: { leases } } : null, result: null };
      });
    };
  }
}
export const securityBudgets = new SecurityBudgetStore();
// A manual unblock advances a durable epoch rather than scanning/deleting cache
// keys. Every instance observes it immediately; old budgets expire naturally.
export async function securityBudgetIdentity(subject, db = securityDb) {
  const row = await db.cacheEntry.findUnique({ where: { key: cacheKey(`security-budget-epoch:${subject}`) }, select: { value: true, expiresAt: true } });
  const epoch = row && (!row.expiresAt || +row.expiresAt > Date.now()) ? row.value : '0';
  return `${subject}:${epoch}`;
}
export async function resetSecurityBudgets(tx, subject) {
  const key = cacheKey(`security-budget-epoch:${subject}`);
  const data = { type: 'string', value: crypto.randomUUID(), revision: crypto.randomUUID(), expiresAt: new Date(Date.now() + 31 * 86400000) };
  await tx.cacheEntry.upsert({ where: { key }, create: { key, ...data }, update: data });
}
export async function securityPolicy(db = securityDb) {
  const row = await db.securityPolicy.findUnique({ where: { id: 'default' } });
  const saved = row?.values || {};
  const values = { ...SECURITY_DEFAULTS };
  // Invalid stored policy cannot disable protection even after a bad manual edit.
  for (const [key, value] of Object.entries(saved)) if (validateSecurityPolicy({ [key]: value })) values[key] = value;
  return values;
}
export async function recordSecurityEvent(req, details, db = securityDb) {
  const data = {
    ...securityContext(req), category: SECURITY_CATEGORIES.includes(details.category) ? details.category : 'authorization',
    severity: SECURITY_SEVERITIES.includes(details.severity) ? details.severity : 'medium',
    rule: String(details.rule || 'SECURITY_EVENT').slice(0, 80), reason: String(details.reason || 'Security protection triggered').slice(0, 500),
    action: String(details.action || 'recorded').slice(0, 60), evidence: safeSecurityEvidence(details.evidence || {}),
    ...(validSecuritySubject(details.subjectKey) && { subjectKey: details.subjectKey }),
    riskScore: Math.min(100, Math.max(0, Number(details.riskScore) || 0)), restrictionId: details.restrictionId || null,
  };
  const event = await db.securityEvent.create({ data });
  // Existing Socket.IO admin rooms are assigned only by verified principals.
  // Event payload is intentionally minimal; the dashboard fetches private details.
  if (req?.io) req.io.to('security_admins').emit('security_event', { id: event.id, category: event.category, severity: event.severity, createdAt: event.createdAt });
  return event;
}
export async function activeSecurityRestriction(req, scope = 'account', additionalSubjects = [], db = securityDb) {
  const subjects = requestSubjects(req, additionalSubjects);
  if (!subjects.length) return null;
  return db.securityRestriction.findFirst({ where: { subjectKey: { in: subjects }, scope: { in: [...new Set(['account', scope])] }, until: { gt: new Date() }, liftedAt: null }, orderBy: { until: 'desc' } });
}
export async function hasSecurityException(req, scope, db = securityDb) {
  const subjectKey = subjectKeyOf(req.user);
  if (!subjectKey) return false;
  return !!await db.securityException.findFirst({ where: { subjectKey, scope, until: { gt: new Date() }, liftedAt: null } });
}
export async function setAutomaticRestriction(req, { subjectKey = subjectKeyOf(req.user), scope = 'catalogue', seconds = 14400, rule, reason, evidence }, db = securityDb) {
  if (!validSecuritySubject(subjectKey) || !SECURITY_SCOPES.includes(scope)) throw new Error('Invalid restriction target');
  // Automated IP blocking can punish offices/NATs; only explicit reviewed admin
  // actions may restrict an IP. Automated identity lockouts remain scoped to auth.
  if (subjectKey.startsWith('ip:')) return null;
  const duration = Math.min(86400, Math.max(900, Number(seconds) || 14400));
  return db.$transaction(async tx => {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`security-restriction:${subjectKey}:${scope}`}, 0))::text`;
    const current = await tx.securityRestriction.findUnique({ where: { subjectKey_scope: { subjectKey, scope } } });
    const repeats = (current?.enforcementCount || 0) + 1;
    const until = new Date(Math.max(Date.now() + Math.min(86400, duration * 2 ** Math.min(repeats - 1, 3)) * 1000, current && !current.liftedAt ? +current.until : 0));
    const data = { until, startedAt: new Date(), liftedAt: null, reason, source: 'automatic', createdBy: null, enforcementCount: repeats };
    const restriction = await tx.securityRestriction.upsert({ where: { subjectKey_scope: { subjectKey, scope } }, create: { subjectKey, scope, ...data }, update: data });
    await recordSecurityEvent(req, { category: scope === 'auth' ? 'authentication' : 'scraping', severity: 'high', subjectKey, rule, reason, action: 'restricted', evidence, riskScore: 90, restrictionId: restriction.id }, tx);
    return restriction;
  });
}
export async function recordBudgetViolation(req, quota, { scope = 'catalogue', extraction = false, policy = SECURITY_DEFAULTS, budgets = securityBudgets, db = securityDb } = {}) {
  // Office/NAT traffic must not accumulate strikes against an individual account.
  const subject = quota.rule === 'ip-requests'
    ? await securityBudgetIdentity(`ip:${req.ip}`, db)
    : req.securityBudgetIdentity || await securityBudgetIdentity(subjectKeyOf(req.user) || `ip:${req.ip}`, db);
  const strikes = await budgets.consume(subject, `violations:${scope}`, { limit: 100000, seconds: 900 });
  const restrict = quota.rule !== 'ip-requests' && !!subjectKeyOf(req.user) && strikes.count >= policy.restrictionAfterViolations && (extraction || quota.count > quota.limit * 3);
  const evidence = { count: quota.count, limitWindowSeconds: quota.retryAfter, violations: strikes.count, resourceSamples: quota.resourceSamples || [] };
  const rule = quota.rule || 'REQUEST_BUDGET';
  if (restrict) {
    const restriction = await setAutomaticRestriction(req, { scope, seconds: policy.restrictionSeconds, rule, reason: 'Repeated excessive access to protected resources', evidence }, db);
    return { restriction, retryAfter: Math.max(1, Math.ceil((+restriction.until - Date.now()) / 1000)) };
  }
  // Record the first and every eighth subsequent hit, limiting logging write amplification.
  if (strikes.count === 1 || strikes.count % 8 === 0) await recordSecurityEvent(req, { category: extraction ? 'scraping' : 'rate_limit', severity: extraction ? 'high' : 'medium', rule, reason: extraction ? 'Distinct resource retrieval budget exceeded' : 'Request budget exceeded', action: 'throttled', riskScore: Math.min(80, 10 + strikes.count * 5), evidence }, db);
  return { retryAfter: Math.min(quota.retryAfter || 900, Math.max(30, 15 * 2 ** Math.min(strikes.count, 6))) };
}

export function securityAuditKey() {
  const key = process.env.SECURITY_AUDIT_KEY;
  if (process.env.NODE_ENV === 'production' && (!key || Buffer.byteLength(key, 'utf8') < 32 || key === process.env.JWT_SECRET)) {
    throw new Error('A separate SECURITY_AUDIT_KEY of at least 32 bytes is required');
  }
  return key || jwtSecret();
}
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
const auditPayload = row => ({ adminId: row.adminId, action: row.action, reason: row.reason, details: row.details, sourceIp: row.sourceIp, createdAt: new Date(row.createdAt).toISOString() });
const auditHash = (previousHash, payload) => crypto.createHmac('sha256', securityAuditKey()).update(previousHash).update(canonicalJson(payload)).digest('hex');

// Verify canonical JSON so PostgreSQL jsonb object-key ordering is immaterial.
// Export the terminal sequence/hash separately to detect privileged tail deletion.
export async function verifySecurityAudit(db = securityDb) {
  let previousHash = 'GENESIS', sequence = 0, count = 0;
  for (;;) {
    const rows = await db.securityAdminAudit.findMany({ where: { sequence: { gt: sequence } }, orderBy: { sequence: 'asc' }, take: 500 });
    if (!rows.length) return { valid: true, count, sequence, hash: previousHash };
    for (const row of rows) {
      if (row.previousHash !== previousHash || row.hash !== auditHash(previousHash, auditPayload(row))) return { valid: false, sequence: row.sequence, count };
      previousHash = row.hash; sequence = row.sequence; count++;
    }
  }
}

export async function securityAdminAudit(tx, req, action, reason, details = {}) {
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended('security-admin-audit', 0))::text`;
  const previous = await tx.securityAdminAudit.findFirst({ orderBy: { sequence: 'desc' }, select: { hash: true } });
  const payload = { adminId: req.user.id, action, reason: reason.trim(), details: safeSecurityEvidence(details), sourceIp: securityContext(req).sourceIp, createdAt: new Date().toISOString() };
  const previousHash = previous?.hash || 'GENESIS';
  const hash = auditHash(previousHash, payload);
  return tx.securityAdminAudit.create({ data: { ...payload, createdAt: new Date(payload.createdAt), previousHash, hash } });
}
export async function pruneSecurityEvents(db = securityDb) {
  const policy = await securityPolicy(db);
  const before = new Date(Date.now() - policy.retentionDays * 86400000);
  // Administrative audit hashes are deliberately retained; export/archive policy
  // is an operator responsibility. Event review information is in that audit log.
  return db.securityEvent.deleteMany({ where: { createdAt: { lt: before } } });
}
