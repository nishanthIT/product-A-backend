import cacheService from '../services/cacheService.js';

/**
 * Legacy limiter using the distributed PostgreSQL-authoritative cache.
 * Limits requests per IP address or user ID
 */

/**
 * Create a rate limiter middleware
 * @param {object} options 
 * @param {number} options.windowMs - Time window in milliseconds (default: 60000 = 1 minute)
 * @param {number} options.max - Maximum requests per window (default: 100)
 * @param {string} options.keyPrefix - Prefix for the rate limit key
 * @param {boolean} options.useUserId - Use user ID instead of IP (requires auth)
 */
export const rateLimiter = (options = {}) => {
  const {
    windowMs = 60000, // 1 minute
    max = 100,        // 100 requests per minute
    keyPrefix = 'api',
    useUserId = false,
    message = 'Too many requests, please try again later.'
  } = options;

  const windowSeconds = Math.max(1, Math.ceil(windowMs / 1000));

  return async (req, res, next) => {
    try {
      // Determine the identifier (user ID or IP)
      let identifier;
      if (useUserId && req.user?.id) {
        identifier = `${keyPrefix}:user:${req.user.userType}:${req.user.id}`;
      } else {
        // Use IP address
        const ip = req.ip || req.connection.remoteAddress || 'unknown';
        identifier = `${keyPrefix}:ip:${ip}`;
      }

      // Check rate limit
      const result = await cacheService.checkRateLimit(identifier, max, windowSeconds);

      if (!result.allowed) {
        res.set('Retry-After', String(windowSeconds));
        return res.status(429).json({
          success: false,
          message,
          retryAfter: windowSeconds
        });
      }

      next();
    } catch (error) {
      console.error('Rate limiter unavailable');
      res.status(503).json({ error: 'Service temporarily unavailable. Please retry.' });
    }
  };
};

// Pre-configured limiters
export const apiLimiter = rateLimiter({
  windowMs: 60000,    // 1 minute
  max: 100,           // 100 requests per minute
  keyPrefix: 'api'
});

export const authLimiter = rateLimiter({
  windowMs: 900000,   // 15 minutes
  max: 10,            // 10 attempts per 15 minutes
  keyPrefix: 'auth',
  message: 'Too many login attempts, please try again after 15 minutes.'
});

export const chatLimiter = rateLimiter({
  windowMs: 1000,     // 1 second
  max: 10,            // 10 messages per second
  keyPrefix: 'chat',
  useUserId: true,
  message: 'Sending too fast, please slow down.'
});

export const uploadLimiter = rateLimiter({
  windowMs: 60000,    // 1 minute
  max: 10,            // 10 uploads per minute
  keyPrefix: 'upload',
  useUserId: true,
  message: 'Too many uploads, please wait a moment.'
});

export default rateLimiter;
