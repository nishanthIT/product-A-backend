import {
  activeSecurityRestriction, hasSecurityException, recordSecurityEvent, recordBudgetViolation,
  securityPolicy, securityBudgets, securityDb, securityHash, subjectKeyOf, securityBudgetIdentity,
} from '../services/securityProtection.js';
import { readSessionToken } from '../services/sessionSecurity.js';

export function securityScope(req) {
  const url = String(req.originalUrl || req.path || '').split('?')[0];
  if (/\/admin\/security(?:\/|$)/.test(url)) return 'account';
  if (/\/auth\//.test(url)) return 'auth';
  if (req.method !== 'GET' && (/upload|attachment/i.test(url) || /^multipart\/form-data(?:;|$)/i.test(req.headers?.['content-type'] || ''))) return 'upload';
  if (/(?:products?|filterProducts|productFilters|getProduct|lowest-prices|price-tiers|price-reports|pack-options|bundle-offers|check-cart-offers|promotions|\/lists(?:\/|$))/i.test(url)) return 'catalogue';
  return 'account';
}
export function extractProtectedResources(payload) {
  const products = new Set(), prices = new Set();
  let visited = 0;
  const visit = (value, key = '', productContext = null, depth = 0) => {
    if (!value || typeof value !== 'object' || depth > 12 || visited++ > 30000) return;
    if (Array.isArray(value)) {
      for (const item of value) {
        if (key === 'productIds' && typeof item === 'string') products.add(item);
        else visit(item, key, productContext, depth + 1);
      }
      return;
    }
    const product = typeof value.productId === 'string' ? value.productId
      : typeof value.id === 'string' && (typeof value.title === 'string' || typeof value.barcode === 'string') ? value.id : productContext;
    if (product) products.add(product);
    if (typeof value.productAtShopId === 'string') prices.add(value.productAtShopId);
    if (product && typeof value.shopId === 'string' && ['price','unitPrice','lowestPrice','offerPrice','effectivePrice'].some(field => field in value)) prices.add(`${product}:${value.shopId}`);
    // Several comparison responses nest {product:{id,...},shops:[...]}.
    const nestedProduct = value.product?.id || product;
    for (const [field, child] of Object.entries(value)) visit(child, field, nestedProduct, depth + 1);
  };
  visit(payload);
  return { products: [...products], prices: [...prices], exceededTraversal: visited > 30000 };
}
const unavailable = res => res.status(503).json({ error: 'Security verification is temporarily unavailable. Please try again.' });
export function sendSecurityRestriction(res, restriction) {
  res.set('Retry-After', String(Math.max(1, Math.ceil((+new Date(restriction.until) - Date.now()) / 1000))));
  return res.status(403).json({ error: 'Access is temporarily restricted. Please contact support if this is unexpected.', code: 'TEMPORARILY_RESTRICTED' });
}
export function createSecurityProtection({ db = securityDb, budgets = securityBudgets } = {}) {
  return async (req, res, next) => {
    // Routes may authenticate twice. Never install nested wrappers/charge twice.
    if (req.securityProtected) return next();
    req.securityProtected = true;
    const subject = subjectKeyOf(req.user);
    if (!subject) return res.status(401).json({ error: 'Authentication required' });
    const scope = securityScope(req);
    let release;
    try {
      const [restriction, policy] = await Promise.all([activeSecurityRestriction(req, scope, [], db), securityPolicy(db)]);
      if (restriction) return sendSecurityRestriction(res, restriction);
      const exempt = scope !== 'account' && await hasSecurityException(req, scope, db);
      const permissions = req.user.company?.permissions || [];
      const companyCatalogue = req.user.userType === 'ADMIN' || permissions.some(permission => ['catalog.read','shops.manage'].includes(permission));
      const multiplier = companyCatalogue ? policy.companyCatalogueMultiplier : 1;
      const [budgetSubject, budgetIp] = await Promise.all([securityBudgetIdentity(subject, db), securityBudgetIdentity(`ip:${req.ip}`, db)]);
      req.securityBudgetIdentity = budgetSubject;
      const token = readSessionToken(req);
      const checks = [
        budgets.consume(budgetSubject, 'account-requests', { limit: policy.accountRequestsPerMinute }),
        ...(req.securityIpChecked === req.ip ? [] : [budgets.consume(budgetIp, 'ip-requests', { limit: policy.ipRequestsPerMinute })]),
        ...(token ? [budgets.consume(`session:${securityHash(token)}:${budgetSubject}`, 'session-requests', { limit: policy.sessionRequestsPerMinute })] : []),
        ...(scope === 'upload' && !exempt ? [budgets.consume(budgetSubject, 'upload-requests', { seconds: 3600, limit: policy.uploadRequestsPerHour })] : []),
        ...(scope === 'catalogue' && !exempt ? [budgets.consume(budgetSubject, 'catalogue-requests', { limit: policy.catalogueRequestsPerMinute * multiplier })] : []),
      ];
      const results = await Promise.all(checks);
      let violation = results.find(result => !result.allowed);
      if (!violation && scope === 'catalogue' && !exempt) {
        const query = req.query?.q ?? req.query?.search ?? req.query?.query;
        const inputChecks = [];
        if (typeof query === 'string' && query.trim()) inputChecks.push(budgets.consume(budgetSubject, 'distinct-searches', { seconds: 3600, limit: policy.distinctSearchesPerHour * multiplier, resources: [query.trim().toLowerCase()] }));
        if (req.query?.page !== undefined || req.query?.cursor !== undefined) inputChecks.push(budgets.consume(budgetSubject, 'distinct-pages', { seconds: 3600, limit: policy.distinctPagesPerHour * multiplier, resources: [`${req.baseUrl || ''}${req.route?.path || req.path}:${req.query.page ?? req.query.cursor}:${typeof query === 'string' ? query : ''}`] }));
        const identifier = req.params?.productId || req.params?.id || req.params?.barcode;
        if (identifier) inputChecks.push(budgets.consume(budgetSubject, 'distinct-lookups', { seconds: 3600, limit: policy.distinctProductsPerHour * multiplier, resources: [String(identifier)] }));
        violation = (await Promise.all(inputChecks)).find(result => !result.allowed);
      }
      const deny = async (quota, extraction = false, send = body => res.json(body)) => {
        const result = await recordBudgetViolation(req, quota, { scope, extraction, policy, budgets, db });
        if (result.restriction) {
          res.set('Retry-After', String(result.retryAfter));
          res.status(403); return send({ error: 'Access is temporarily restricted. Please contact support.', code: 'TEMPORARILY_RESTRICTED' });
        }
        res.set('Retry-After', String(result.retryAfter)); res.status(429);
        return send({ error: 'Too many requests. Please try again later.' });
      };
      if (violation) return await deny(violation, /^distinct-/.test(violation.rule));
      release = await budgets.lease(subject, policy.concurrentRequests, policy.requestTimeoutSeconds + 5);
      if (!release) return await deny({ rule: 'concurrency', count: policy.concurrentRequests + 1, limit: policy.concurrentRequests, retryAfter: 30 });
      const releaseSafely = () => { release?.().catch(() => console.error('Security concurrency lease release failed; lease expires automatically')); };
      res.once('finish', releaseSafely); res.once('close', releaseSafely);
      const originalJson = res.json.bind(res);
      const timer = setTimeout(() => { if (!res.headersSent && !res.writableEnded) { res.status(503); originalJson({ error: 'Request timed out. Please try again.' }); } }, policy.requestTimeoutSeconds * 1000);
      timer.unref(); res.once('finish', () => clearTimeout(timer)); res.once('close', () => clearTimeout(timer));
      {
        // Every authenticated JSON response is bounded; catalogue responses also
        // consume distinct-record budgets before bytes are sent.
        const send = res.json.bind(res); let handling = false;
        res.set('Cache-Control', 'private, no-store');
        res.json = payload => {
          if (handling || res.headersSent || res.writableEnded) return res;
          handling = true;
          (async () => {
            if (res.statusCode >= 400) return send(payload);
            const size = Buffer.byteLength(JSON.stringify(payload));
            const resources = scope === 'catalogue' ? extractProtectedResources(payload) : { products: [], prices: [], exceededTraversal: false };
            if (size > policy.maximumResponseBytes || resources.exceededTraversal) {
              await recordSecurityEvent(req, { category: scope === 'catalogue' ? 'scraping' : 'availability', severity: 'high', rule: 'RESPONSE_SIZE', reason: 'Protected response exceeds safe retrieval size', action: 'blocked', evidence: { size } }, db);
              res.status(413); return send({ error: 'Requested result is too large. Narrow your query.' });
            }
            if (scope === 'catalogue' && !exempt) {
              const checks = [];
              if (resources.products.length) {
                checks.push(budgets.consume(budgetSubject, 'products-hour', { seconds: 3600, limit: policy.distinctProductsPerHour * multiplier, resources: resources.products }));
                checks.push(budgets.consume(budgetSubject, 'products-day', { seconds: 86400, limit: policy.distinctProductsPerDay * multiplier, resources: resources.products }));
              }
              if (resources.prices.length) checks.push(budgets.consume(budgetSubject, 'prices-hour', { seconds: 3600, limit: policy.distinctPricesPerHour * multiplier, resources: resources.prices }));
              const exceeded = (await Promise.all(checks)).find(result => !result.allowed);
              if (exceeded) {
                exceeded.resourceSamples = resources.products.slice(0, 5).map(securityHash);
                return await deny(exceeded, true, send);
              }
            }
            if (!res.headersSent && !res.writableEnded) send(payload);
          })().catch(() => {
            console.error('Protected response security verification failed');
            if (!res.headersSent && !res.writableEnded) { res.status(503); send({ error: 'Security verification is temporarily unavailable. Please try again.' }); }
          });
          return res;
        };
      }
      return next();
    } catch {
      await release?.().catch(() => {});
      console.error('Request security verification failed');
      return unavailable(res);
    }
  };
}
export const protectAuthenticatedRequest = createSecurityProtection();

// Public API reads need the same shared-IP ceiling and manual restrictions as
// authenticated requests. Mark the admission so the account guard does not charge
// the same request twice. The tiny liveness route remains independent of the DB.
export function createPublicApiProtection({ db = securityDb, budgets = securityBudgets } = {}) {
  return async (req, res, next) => {
    const url = String(req.originalUrl || req.path || '').split('?')[0];
    if (url === '/api/health') return next();
    try {
      const scope = securityScope(req);
      const [restriction, policy, identity] = await Promise.all([
        activeSecurityRestriction(req, scope, [], db), securityPolicy(db), securityBudgetIdentity(`ip:${req.ip}`, db),
      ]);
      if (restriction) return sendSecurityRestriction(res, restriction);
      const quota = await budgets.consume(identity, 'ip-requests', { limit: policy.ipRequestsPerMinute });
      if (!quota.allowed) {
        const result = await recordBudgetViolation(req, quota, { scope, policy, budgets, db });
        res.set('Retry-After', String(result.retryAfter));
        return res.status(429).json({ error: 'Too many requests. Please try again later.' });
      }
      req.securityIpChecked = req.ip;
      next();
    } catch {
      console.error('Public API security verification failed');
      return unavailable(res);
    }
  };
}
export const publicApiProtection = createPublicApiProtection();

// Observe already-denied requests, without leaking credentials or changing the
// original denial. Failure to store telemetry cannot grant access.
export function securityResponseObserver(req, res, next) {
  res.once('finish', () => {
    if (![401, 403, 404].includes(res.statusCode) || req.securityDenialRecorded) return;
    const category = res.statusCode === 401 ? 'authentication' : 'authorization';
    const subject = subjectKeyOf(req.user) || `ip:${req.ip}`;
    securityBudgets.consume(subject, `denial-log:${category}`, { limit: 5, seconds: 60 }).then(quota => {
      if (quota.allowed) return recordSecurityEvent(req, { category, severity: 'medium', rule: res.statusCode === 401 ? 'AUTHENTICATION_REQUIRED' : 'ACCESS_DENIED', reason: 'Request denied by server authorization', action: 'denied', evidence: { status: res.statusCode } });
    }).catch(() => console.error('Denied-request security event storage unavailable'));
  });
  next();
}
