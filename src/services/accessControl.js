import { activeSuspension } from './chatSafety.js';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// Company (platform) permissions. Only CompanyStaffMembership or the Admin table grant these.
export const COMPANY_PERMISSIONS = Object.freeze({
  CATALOG_READ: 'catalog.read',
  CATALOG_WRITE: 'catalog.write',
  SHOPS_MANAGE: 'shops.manage',
  LIST_ITEMS_MANAGE: 'list_items.manage',
  PRICE_REPORTS_REVIEW: 'price_reports.review',
  CUSTOMERS_VIEW: 'customers.view',
  CUSTOMERS_MANAGE: 'customers.manage',
  STAFF_MANAGE: 'staff.manage',
  CONTENT_MANAGE: 'content.manage',
});
export const ALL_COMPANY_PERMISSIONS = Object.freeze(Object.values(COMPANY_PERMISSIONS));

// What legacy company staff could reach in the admin dashboard before memberships existed.
export const DEFAULT_COMPANY_STAFF_PERMISSIONS = Object.freeze([
  COMPANY_PERMISSIONS.CATALOG_READ,
  COMPANY_PERMISSIONS.CATALOG_WRITE,
  COMPANY_PERMISSIONS.SHOPS_MANAGE,
  COMPANY_PERMISSIONS.LIST_ITEMS_MANAGE,
  COMPANY_PERMISSIONS.PRICE_REPORTS_REVIEW,
]);

export const COMPANY_STAFF_ROLES = Object.freeze(['STAFF', 'MANAGER']);

// Shop permissions are scoped to a single ShopEmployeeMembership.
// feature.* keys gate shop tools for employees; owners always have every feature.
export const SHOP_FEATURES = Object.freeze({
  LISTS: 'feature.lists',
  TASKS: 'feature.tasks',
  EXPIRY: 'feature.expiry',
  FRIDGES: 'feature.fridges',
  CLEANING: 'feature.cleaning',
  INCIDENTS: 'feature.incidents',
  AGE_RECORDS: 'feature.age_records',
  WASTE: 'feature.waste',
  SUPPLIER_PAYOUTS: 'feature.supplier_payouts',
  SHIFT_SHEET: 'feature.shift_sheet',
});
export const ALL_SHOP_FEATURES = Object.freeze(Object.values(SHOP_FEATURES));

// read = view (the bare feature key, kept for existing data), write = add new records, edit = change/delete.
export const SHOP_ACCESS_LEVELS = Object.freeze(['read', 'write', 'edit']);
export const shopAccessKey = (feature, level = 'read') => (level === 'read' ? feature : `${feature}.${level}`);
export const ALL_SHOP_PERMISSIONS = Object.freeze(
  ALL_SHOP_FEATURES.flatMap((feature) => SHOP_ACCESS_LEVELS.map((level) => shopAccessKey(feature, level))),
);
// Shop owners (Customer) run the shop; everyone they add is a plain shop employee.
export const SHOP_EMPLOYEE_ROLES = Object.freeze(['EMPLOYEE']);

/** New employees get full access to every shop tool, as before per-tool access existed. */
export function defaultShopPermissions() {
  return [...ALL_SHOP_PERMISSIONS];
}

/** Write/edit are meaningless without read, so they imply it. Unknown keys are dropped. */
export function normalizeShopPermissions(permissions) {
  const known = new Set((permissions || []).filter((p) => ALL_SHOP_PERMISSIONS.includes(p)));
  for (const feature of ALL_SHOP_FEATURES) {
    if (known.has(shopAccessKey(feature, 'write')) || known.has(shopAccessKey(feature, 'edit'))) known.add(feature);
  }
  return ALL_SHOP_PERMISSIONS.filter((p) => known.has(p));
}

export const MEMBERSHIP_STATUSES = Object.freeze(['INVITED', 'ACTIVE', 'INACTIVE', 'REMOVED']);

const LAST_ACTIVE_THROTTLE_MS = 5 * 60 * 1000;
const lastActiveWrites = new Map();

const knownCompanyPermissions = (permissions) =>
  (permissions || []).filter((p) => ALL_COMPANY_PERMISSIONS.includes(p));

const knownShopPermissions = (permissions) =>
  (permissions || []).filter((p) => ALL_SHOP_PERMISSIONS.includes(p));

const employeeAccessSelect = {
  id: true,
  name: true,
  email: true,
  shopId: true,
  sessionVersion: true,
  companyMembership: {
    select: { id: true, role: true, permissions: true, status: true },
  },
  shopMemberships: {
    where: { status: 'ACTIVE' },
    select: {
      id: true,
      shopId: true,
      role: true,
      permissions: true,
      status: true,
      shop: { select: { id: true, name: true, shopType: true } },
    },
    orderBy: { createdAt: 'asc' },
  },
};

function toCompanyAccess(membership) {
  if (!membership || membership.status !== 'ACTIVE') return null;
  return {
    membershipId: membership.id,
    role: membership.role,
    permissions: knownCompanyPermissions(membership.permissions),
  };
}

function toShopAccess(membership) {
  if (!membership) return null;
  return {
    membershipId: membership.id,
    shopId: membership.shopId,
    shopName: membership.shop?.name ?? null,
    role: membership.role,
    status: membership.status,
    permissions: knownShopPermissions(membership.permissions),
  };
}

/**
 * Loads an employee account and its ACTIVE memberships. Company and shop access are
 * derived independently; neither implies the other.
 */
export async function loadEmployeeAccess(employeeId, db = prisma, selectedShopId) {
  const employee = await db.empolyee.findUnique({
    where: { id: employeeId },
    select: employeeAccessSelect,
  });
  if (!employee) return null;

  const memberships = employee.shopMemberships.filter((m) => m.shop?.shopType === 'CUSTOMER');
  const activeShop = selectedShopId !== undefined
    ? memberships.find((m) => m.shopId === selectedShopId)
    : memberships.find((m) => m.shopId === employee.shopId) ?? (memberships.length === 1 ? memberships[0] : null);
  const company = toCompanyAccess(employee.companyMembership);
  const shop = toShopAccess(activeShop);

  return {
    id: employee.id,
    name: employee.name,
    email: employee.email,
    sessionVersion: employee.sessionVersion,
    hasShopMemberships: memberships.length > 0,
    company,
    shop,
  };
}

/**
 * Resolves the request principal from a verified JWT payload.
 * Returns { user } on success or { error, status, code } when the token must be rejected.
 */
export async function resolvePrincipal(decoded, db = prisma, selectedShopId) {
  const id = Number.parseInt(decoded?.id, 10);
  if (!Number.isInteger(id)) return { status: 401, error: 'Invalid token', code: 'INVALID_TOKEN' };

  let account;
  if (['ADMIN', 'CUSTOMER', 'EMPLOYEE'].includes(decoded.userType)) {
    // These independent reads all validate the same signed principal. Start them
    // together so every shop request does not pay another remote-DB round trip.
    // No access is returned (or last-active write scheduled) before every guard passes.
    const accountQuery = decoded.userType === 'EMPLOYEE'
      ? loadEmployeeAccess(id, db, selectedShopId)
      : decoded.userType === 'ADMIN'
        ? db.admin.findUnique({ where: { id }, select: { id: true, email: true, name: true, sessionVersion: true } })
        : db.customer.findUnique({ where: { id }, select: {
          email: true, name: true, defaultSupermarketId: true, sessionVersion: true,
          supermarketOwnerships: { where: { shopType: 'CUSTOMER', shop: { shopType: 'CUSTOMER' } }, select: { shopId: true } },
        } });
    const [suspension, deletion, loadedAccount] = await Promise.all([
      activeSuspension({ id, userType: decoded.userType }, db, new Date(), 'ACCOUNT'),
      db.accountDeletionJob.findUnique({ where: { userId_userType: { userId: id, userType: decoded.userType } }, select: { status: true } }),
      accountQuery,
    ]);
    account = loadedAccount;
    if (suspension) return { status: 403, code: 'ACCOUNT_SUSPENDED', error: `Account access is suspended until ${suspension.until.toISOString()}. ${suspension.reason} Contact support@paymi.co.uk to appeal.` };
    if (deletion && deletion.status !== 'REQUESTED') return { status: 401, error: 'Personal account deletion is in progress', code: 'ACCOUNT_DELETION_PENDING' };
  }

  if (decoded.userType === 'ADMIN') {
    const admin = account;
    if (!admin) return { status: 401, error: 'Account no longer exists', code: 'SESSION_REVOKED' };
    if ((decoded.sv ?? 0) !== admin.sessionVersion) return { status: 401, error: 'Session revoked', code: 'SESSION_REVOKED' };
    return {
      user: {
        sv: admin.sessionVersion,
        id: admin.id,
        email: admin.email,
        name: admin.name,
        userType: 'ADMIN',
        company: { role: 'ADMIN', permissions: [...ALL_COMPANY_PERMISSIONS] },
        shop: null,
        shopId: null,
      },
    };
  }

  if (decoded.userType === 'EMPLOYEE') {
    const access = account;
    if (!access) return { status: 401, error: 'Account no longer exists', code: 'SESSION_REVOKED' };
    if ((decoded.sv ?? 0) !== access.sessionVersion) {
      return { status: 401, error: 'Session expired. Please sign in again.', code: 'SESSION_REVOKED' };
    }
    if (selectedShopId !== undefined && !access.shop) return { status: 403, error: "No active membership for this supermarket", code: "SHOP_MEMBERSHIP_REQUIRED" };
    if (!access.company && !access.hasShopMemberships) {
      return { status: 401, error: 'This account has no active access.', code: 'ACCESS_REVOKED' };
    }
    touchLastActive(access, db);
    return {
      user: {
        sv: access.sessionVersion,
        id: access.id,
        email: access.email,
        name: access.name,
        userType: 'EMPLOYEE',
        company: access.company,
        shop: access.shop,
        shopId: access.shop?.shopId ?? null,
      },
    };
  }

  if (decoded.userType === 'CUSTOMER') {
    const customer = account;
    if (!customer) return { status: 401, error: 'Account no longer exists', code: 'SESSION_REVOKED' };
    if ((decoded.sv ?? 0) !== customer.sessionVersion) return { status: 401, error: 'Session revoked', code: 'SESSION_REVOKED' };
    const selected = selectedShopId ?? customer.defaultSupermarketId;
    const valid = customer.supermarketOwnerships.some((o) => o.shopId === selected);
    if (selectedShopId !== undefined && !valid) return { status: 403, error: 'Supermarket access denied', code: 'SUPERMARKET_ACCESS_REQUIRED' };
    return { user: { id, sv: customer.sessionVersion, name: customer.name, email: customer.email, userType: 'CUSTOMER', company: null, shop: null, shopId: valid ? selected : null } };
  }

  return { status: 401, error: 'Invalid token', code: 'INVALID_TOKEN' };
}

function touchLastActive(access, db) {
  const now = Date.now();
  const last = lastActiveWrites.get(access.id) ?? 0;
  if (now - last < LAST_ACTIVE_THROTTLE_MS) return;
  lastActiveWrites.set(access.id, now);
  const at = new Date(now);
  Promise.all([
    db.empolyee.update({ where: { id: access.id }, data: { lastActiveAt: at } }),
    access.shop
      ? db.shopEmployeeMembership.update({ where: { id: access.shop.membershipId }, data: { lastActiveAt: at } })
      : null,
  ]).catch((err) => console.warn('lastActiveAt update failed:', err.message));
}

export function hasCompanyPermission(user, permission) {
  return !!user?.company?.permissions?.includes(permission);
}

export function hasShopPermission(user, permission) {
  return !!user?.shop?.permissions?.includes(permission);
}

export function hasShopFeatureAccess(user, feature, level = 'read') {
  return hasShopPermission(user, feature) && hasShopPermission(user, shopAccessKey(feature, level));
}

/** Public shape returned to clients by login and /auth/me. */
export function describeAccess(user) {
  return {
    companyAccess: user.company
      ? { role: user.company.role, permissions: user.company.permissions }
      : null,
    shopAccess: user.shop
      ? {
          shopId: user.shop.shopId,
          shopName: user.shop.shopName,
          role: user.shop.role,
          permissions: user.shop.permissions,
        }
      : null,
  };
}

/** Whether a verified socket/HTTP user may observe a shop's realtime channels. */
export async function canAccessShop(decoded, shopId, db = prisma) {
  if (!decoded || !shopId) return false;
  const result = await resolvePrincipal(decoded, db, shopId);
  if (!result.user) return false;
  const { user } = result;
  if (user.userType === 'ADMIN') return true;
  if (user.userType === 'EMPLOYEE') return user.shopId === shopId;
  if (user.userType === 'CUSTOMER') return user.shopId === shopId;
  return false;
}

export { knownCompanyPermissions, knownShopPermissions };
