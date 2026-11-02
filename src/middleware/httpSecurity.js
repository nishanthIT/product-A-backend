import { isIP } from 'node:net';
import { serviceError } from '../services/serviceErrors.js';

export function trustedProxySetting(value = process.env.TRUSTED_PROXY_CIDRS || '') {
  if (!value.trim()) return false;
  const addresses = value.split(',').map(v => v.trim());
  for (const address of addresses) {
    const [ip, bits, extra] = address.split('/');
    const family = isIP(ip);
    if (!family || extra !== undefined || (bits !== undefined && (!/^\d+$/.test(bits) || +bits > (family === 4 ? 32 : 128)))) {
      throw new Error('TRUSTED_PROXY_CIDRS must contain explicit proxy IP addresses or CIDRs');
    }
  }
  return addresses;
}

export function allowedOrigins(env = process.env) {
  const configured = (env.CORS_ALLOWED_ORIGINS || '').split(',').map(v => v.trim()).filter(Boolean);
  if (env.PUBLIC_BASE_URL) configured.push(new URL(env.PUBLIC_BASE_URL).origin);
  if (env.NODE_ENV !== 'production') configured.push('http://localhost:5173', 'http://localhost:8081', 'http://localhost:3000', 'http://localhost:8080');
  return new Set(configured.map(value => {
    const parsed = new URL(value);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.origin !== value || parsed.username || parsed.password) throw new Error('CORS_ALLOWED_ORIGINS requires exact HTTP(S) origins');
    return value;
  }));
}

export function corsConfiguration(env = process.env) {
  const origins = allowedOrigins(env);
  return {
    origin: (origin, callback) => callback(null, !origin || origins.has(origin)),
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'X-Supermarket-Id', 'Idempotency-Key', 'X-Security-Reauth'],
    exposedHeaders: ['Retry-After'],
    optionsSuccessStatus: 204,
  };
}

// CORS controls response access, not request execution. Browser cookie mutations
// additionally need an explicitly trusted Origin. Native clients use bearer tokens.
export function csrfProtection(env = process.env) {
  const origins = allowedOrigins(env);
  return (req, res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    const origin = req.headers.origin;
    const bearer = /^Bearer\s+\S+$/i.test(req.headers.authorization || '');
    if ((origin && !origins.has(origin)) || (!bearer && req.cookies?.auth_token && !origin)) {
      return res.status(403).json({ error: 'Request origin is not permitted' });
    }
    next();
  };
}

export function securityHeaders(req, res, next) {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('X-Frame-Options', 'DENY');
  res.set('Referrer-Policy', 'no-referrer');
  if (req.secure) res.set('Strict-Transport-Security', 'max-age=31536000');
  if (/^\/(?:api(?:\/|$)|uploads(?:\/|$)|images(?:\/|$))/.test(req.path)) {
    res.set('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; sandbox");
    res.set('Cache-Control', 'private, no-store');
  }
  // A controller must not expose ORM details or stack traces on failure.
  const json = res.json.bind(res);
  res.json = body => json(res.statusCode >= 500 ? {
    error: res.statusCode === 503 ? 'Service temporarily unavailable. Please retry.' : 'Internal server error',
    ...(['CHAT_SCHEMA_NOT_READY', 'CHAT_STORAGE_UNAVAILABLE'].includes(body?.code) && { code: body.code }),
  } : body);
  next();
}

export function requestConstraints(req, res, next) {
  const reject = () => res.status(400).json({ error: 'Invalid or excessive request parameters' });
  if ((req.originalUrl || req.url || '').length > 4096 || Object.keys(req.query || {}).length > 30) return reject();
  for (const [key, value] of Object.entries(req.query || {})) {
    if (typeof value !== 'string' || value.length > 256 || /[\[\]]/.test(key)) return reject();
    if (['page', 'limit', 'pageSize', 'offset', 'skip'].includes(key)) {
      const max = key === 'page' ? 1000 : ['offset', 'skip'].includes(key) ? 100000 : 500;
      const min = ['offset', 'skip'].includes(key) ? 0 : 1;
      if (!/^\d+$/.test(value) || !Number.isSafeInteger(+value) || +value < min || +value > max) return reject();
    }
  }
  let nodes = 0;
  function valid(value, depth = 0) {
    if (++nodes > 20000 || depth > 10) return false;
    if (typeof value === 'string') return value.length <= 20000;
    if (typeof value === 'number') return Number.isFinite(value);
    if (!value || typeof value !== 'object') return true;
    if (Array.isArray(value)) return value.length <= 500 && value.every(v => valid(v, depth + 1));
    return Object.entries(value).every(([key, entry]) => !['__proto__', 'constructor', 'prototype'].includes(key) && valid(entry, depth + 1));
  }
  if (!valid(req.body)) return reject();
  next();
}

export function safeErrorHandler(err, req, res, next) {
  if (res.headersSent) return next(err);
  console.error('Request failed', serviceError(err));
  const status = err.type === 'entity.too.large' || err.code === 'LIMIT_FILE_SIZE' ? 413
    : err.type === 'entity.parse.failed' || err.code?.startsWith('LIMIT_') || err.code === 'INVALID_UPLOAD' || err.status === 400 ? 400 : 500;
  res.status(status).json({ error: status === 413 ? 'Request is too large' : status === 400 ? 'Invalid request' : 'Internal server error' });
}
