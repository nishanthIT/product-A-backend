import crypto from 'node:crypto';
import cacheService from '../services/cacheService.js';
import { recordSecurityEvent, activeSecurityRestriction, setAutomaticRestriction, securityBudgetIdentity } from '../services/securityProtection.js';

const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const setting = (name, fallback, min, max) => {
  const value = Number(process.env[name] || fallback);
  return Number.isInteger(value) && value >= min && value <= max ? value : fallback;
};

// Independent buckets stop both rotating-address credential stuffing and a
// distributed attack against one account. Identifiers never store raw emails.
export function authRateLimit(action, { limit, cache = cacheService, security = { recordSecurityEvent, activeSecurityRestriction, setAutomaticRestriction, securityBudgetIdentity } } = {}) {
  return async (req, res, next) => {
    const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase().slice(0, 254) : '';
    const identity = `identity:${digest(email)}`;
    const windowSeconds = 900;
    const accountLimit = limit || setting('AUTH_ACCOUNT_ATTEMPTS', 30, 5, 200);
    const ipLimit = setting('AUTH_IP_ATTEMPTS', 180, 30, 2000);
    try {
      const restriction = await security.activeSecurityRestriction(req, 'auth', email ? [identity] : []);
      if (restriction) {
        res.set('Retry-After', String(Math.max(1, Math.ceil((+new Date(restriction.until) - Date.now()) / 1000))));
        return res.status(403).json({ error: 'This authentication flow is temporarily restricted. Please try again later.' });
      }
      const resetIdentity = security.securityBudgetIdentity || (async subject => subject);
      const [ipBudget, accountBudget] = await Promise.all([resetIdentity(`ip:${req.ip}`), email ? resetIdentity(identity) : null]);
      const buckets = [{ key: `auth:ip:${digest(ipBudget)}`, limit: ipLimit }];
      if (email) buckets.push({ key: `auth:${action}:${accountBudget}`, limit: accountLimit });
      const results = await Promise.all(buckets.map(bucket => cache.checkRateLimit(bucket.key, bucket.limit, windowSeconds)));
      const blocked = results.findIndex(result => !result.allowed);
      if (blocked !== -1) {
        const result = results[blocked];
        const subjectKey = blocked === 1 ? identity : `ip:${req.ip}`;
        const excess = result.current - buckets[blocked].limit;
        // Retain aggregate evidence without turning a blocked bot into an
        // unbounded security-log writer. Restrictions still apply every time.
        if (excess === 1 || excess % 8 === 0) await security.recordSecurityEvent(req, { category: 'authentication', severity: 'medium', rule: 'AUTH_RATE_LIMIT', reason: 'Authentication request quota exceeded', subjectKey,
          action: 'throttle', evidence: { count: result.current, windowSeconds } });
        // Repeated blocked attempts establish sustained abuse; a normal shared
        // office IP receives a higher quota than an individual account.
        if (result.current >= buckets[blocked].limit * 4) await security.setAutomaticRestriction(req, {
          subjectKey, scope: 'auth', seconds: setting('AUTH_ABUSE_BLOCK_SECONDS', 14400, 900, 86400),
          rule: 'AUTH_SUSTAINED_ABUSE', reason: 'Sustained authentication request abuse', evidence: { count: result.current, windowSeconds },
        });
        const retryAfter = blocked === 1 ? Math.min(windowSeconds, 30 * 2 ** Math.min(excess - 1, 5)) : windowSeconds;
        res.set('Retry-After', String(retryAfter));
        return res.status(429).json({ error: 'Too many attempts. Please try again later.' });
      }
      req.authSecuritySubject = identity;
      return next();
    } catch {
      return res.status(503).json({ error: 'Sign-in is temporarily unavailable. Please try again.' });
    }
  };
}
