import crypto from 'node:crypto';
import cacheService from '../services/cacheService.js';

export function authRateLimit(action, { limit = 30, cache = cacheService } = {}) {
  return async (req, res, next) => {
    // Never put raw email addresses into rate-limit keys or diagnostics.
    const identity = crypto.createHash('sha256')
      .update(`${req.ip}:${String(req.body?.email || '').trim().toLowerCase()}`).digest('hex');
    try {
      const result = await cache.checkRateLimit(`auth:${action}:${identity}`, limit, 900);
      if (!result.allowed) {
        res.set('Retry-After', '900');
        return res.status(429).json({ error: 'Too many attempts. Please try again in 15 minutes.' });
      }
      return next();
    } catch {
      return res.status(503).json({ error: 'Sign-in is temporarily unavailable. Please try again.' });
    }
  };
}
