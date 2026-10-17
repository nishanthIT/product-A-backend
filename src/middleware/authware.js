import { serviceError } from '../services/serviceErrors.js';
import { readSessionToken } from '../services/sessionSecurity.js';
import { verifySessionToken, isInvalidSession } from '../services/sessionTokens.js';
import { hasCompanyPermission, hasShopFeatureAccess, hasShopPermission, resolvePrincipal } from '../services/accessControl.js';

// Verifies the JWT and reloads memberships on every request, so deactivated
// memberships and bumped session versions take effect for existing tokens.
const isAuthenticated = async (req, res, next) => {
  const token = readSessionToken(req);
  if (!token) {
    return res.status(401).json({ error: 'Authentication required - No token found' });
  }

  let decoded;
  try {
    decoded = await verifySessionToken(token);
  } catch (error) {
    if (!isInvalidSession(error)) console.error('Session token lookup failed', serviceError(error));
    return isInvalidSession(error)
      ? res.status(401).json({ error: 'Invalid or expired token' })
      : res.status(503).json({ error: 'Session verification is temporarily unavailable. Try again.' });
  }

  try {
    const result = await resolvePrincipal(decoded, undefined, req.get('X-Supermarket-Id'));
    if (!result.user) {
      return res.status(result.status).json({ error: result.error, code: result.code });
    }
    req.user = result.user;
    next();
  } catch (error) {
    console.error('Session account lookup failed', serviceError(error));
    return res.status(503).json({ error: 'Session verification is temporarily unavailable. Try again.' });
  }
};

// Company super-admin (Admin table) only.
const isAdmin = (req, res, next) => {
  if (!req.user) return res.status(401).json({ error: 'Authentication required' });
  if (req.user.userType === 'ADMIN') return next();
  return res.status(403).json({ error: 'Access denied. Requires admin privileges' });
};

// Requires every listed company permission. Shop owners and shop employees never hold these.
const requireCompanyPermission = (...permissions) => (req, res, next) => {
  if (!req.user) return res.status(401).json({ error: 'Authentication required' });
  if (permissions.every((p) => hasCompanyPermission(req.user, p))) return next();
  return res.status(403).json({ error: 'Company staff permission required', code: 'COMPANY_PERMISSION_REQUIRED' });
};

// Any active company membership (or Admin).
const requireCompanyStaff = (req, res, next) => {
  if (!req.user) return res.status(401).json({ error: 'Authentication required' });
  if (req.user.company) return next();
  return res.status(403).json({ error: 'Company staff access required', code: 'COMPANY_PERMISSION_REQUIRED' });
};

// Employees may only use shop resources through an ACTIVE shop membership.
const requireShopMembershipForEmployees = (req, res, next) => {
  if (!req.user) return res.status(401).json({ error: 'Authentication required' });
  if (req.user.userType !== 'EMPLOYEE' || req.user.shopId) return next();
  return res.status(403).json({ error: 'No active shop membership', code: 'SHOP_MEMBERSHIP_REQUIRED' });
};

// Shop tools the owner can switch on/off per employee, with read (GET), write (POST) and edit (PUT/PATCH/DELETE) access.
const ACCESS_LEVEL_BY_METHOD = { GET: 'read', HEAD: 'read', OPTIONS: 'read', POST: 'write' };
const requireShopFeature = (feature, level) => (req, res, next) => {
  if (!req.user) return res.status(401).json({ error: 'Authentication required' });
  if (req.user.userType === 'CUSTOMER' && !req.user.shopId) return res.status(409).json({ error: 'Your shop relationships need review. Please contact support.', code: 'SUPERMARKET_REVIEW_REQUIRED' });
  if (req.user.userType !== 'EMPLOYEE') return next();
  if (!req.user.shopId) {
    return res.status(403).json({ error: 'No active shop membership', code: 'SHOP_MEMBERSHIP_REQUIRED' });
  }
  const required = level || ACCESS_LEVEL_BY_METHOD[req.method] || 'edit';
  if (hasShopFeatureAccess(req.user, feature, required)) return next();
  const message = hasShopPermission(req.user, feature)
    ? `Your shop owner has not given you ${required} access here`
    : 'Your shop owner has not given you access to this feature';
  return res.status(403).json({ error: message, code: 'SHOP_FEATURE_DISABLED', feature, level: required });
};

export {
  isAuthenticated,
  isAdmin,
  requireCompanyPermission,
  requireCompanyStaff,
  requireShopMembershipForEmployees,
  requireShopFeature,
};
