import express from 'express';
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import { isAuthenticated } from '../middleware/authware.js';
import {
  ALL_COMPANY_PERMISSIONS,
  ALL_SHOP_PERMISSIONS,
  MEMBERSHIP_STATUSES,
  SHOP_EMPLOYEE_ROLES,
  defaultShopPermissions,
  normalizeShopPermissions,
} from '../services/accessControl.js';
import { setShopMembershipStatus } from '../services/membershipService.js';

// Shop Employees: people who work in a customer's shop. Nothing here can create or
// modify company staff membership.
const router = express.Router();
const prisma = new PrismaClient();

const COMPANY_ONLY_FIELDS = [
  'companyRole',
  'companyPermissions',
  'companyMembership',
  'company',
  'userType',
  'createdByAdminId',
];
const COMPANY_ROLE_NAMES = ['ADMIN', 'STAFF', 'COMPANY_STAFF', 'SUPER_ADMIN'];

/** Resolves the caller's shop from server-side state only: the shop owner via Customer.shopId. */
async function resolveShopContext(req, { createShopIfMissing = false }) {
  const { user } = req;

  if (user.userType === 'CUSTOMER') {
    const customer = await prisma.customer.findUnique({
      where: { id: user.id },
      select: { id: true, name: true, shopId: true },
    });
    if (!customer) return { status: 401, error: 'Account no longer exists' };

    let shopId = customer.shopId;
    if (!shopId && createShopIfMissing) {
      const shop = await prisma.shop.create({
        data: { name: `${customer.name || 'My'}'s Shop`, address: 'Not specified', mobile: 'Not specified', shopType: 'CUSTOMER' },
      });
      await prisma.customer.update({ where: { id: customer.id }, data: { shopId: shop.id } });
      shopId = shop.id;
    }
    return { shopId, actor: 'OWNER', ownerCustomerId: customer.id };
  }

  return { status: 403, error: 'Only the shop owner can manage shop employees' };
}

const shopContextMiddleware = (options) => async (req, res, next) => {
  try {
    const ctx = await resolveShopContext(req, options);
    if (ctx.error) return res.status(ctx.status).json({ error: ctx.error });
    req.shopContext = ctx;
    next();
  } catch (error) {
    console.error('Error resolving shop context:', error);
    res.status(500).json({ error: 'Failed to resolve shop' });
  }
};

const authenticateShopOwner = [isAuthenticated, shopContextMiddleware({})];
const authenticateShopCreator = [isAuthenticated, shopContextMiddleware({ createShopIfMissing: true })];

/** Rejects company fields and any attempt to target a shop other than the caller's own. */
function rejectForbiddenFields(body, ctx) {
  const payload = body || {};
  const companyField = COMPANY_ONLY_FIELDS.find((field) => payload[field] !== undefined);
  if (companyField) {
    return { status: 400, error: 'Company roles and permissions cannot be assigned from a shop' };
  }
  if (payload.shopId !== undefined && payload.shopId !== ctx.shopId) {
    return { status: 403, error: 'You can only manage employees of your own shop' };
  }
  return null;
}

/** Validates the (single) shop role and the per-tool read/write/edit access. */
function validateRoleAndPermissions(body, { partial }) {
  const payload = body || {};
  const result = {};

  if (payload.role !== undefined) {
    const role = String(payload.role).toUpperCase();
    if (COMPANY_ROLE_NAMES.includes(role)) {
      return { error: 'Company roles and permissions cannot be assigned from a shop' };
    }
    if (!SHOP_EMPLOYEE_ROLES.includes(role)) {
      return { error: 'Shop employees have a single role; set what they can do with their access instead' };
    }
    result.role = role;
  } else if (!partial) {
    result.role = 'EMPLOYEE';
  }

  if (payload.permissions !== undefined) {
    if (!Array.isArray(payload.permissions) || payload.permissions.some((p) => typeof p !== 'string')) {
      return { error: 'Permissions must be a list of permission names' };
    }
    if (payload.permissions.some((p) => ALL_COMPANY_PERMISSIONS.includes(p))) {
      return { error: 'Company roles and permissions cannot be assigned from a shop' };
    }
    const unknown = payload.permissions.filter((p) => !ALL_SHOP_PERMISSIONS.includes(p));
    if (unknown.length > 0) {
      return { error: `Unknown shop permission: ${unknown.join(', ')}` };
    }
    result.permissions = normalizeShopPermissions(payload.permissions);
  } else if (!partial) {
    result.permissions = defaultShopPermissions();
  }

  return result;
}

/** Finds a non-removed membership in the caller's shop. */
async function findManageableMembership(ctx, employeeId) {
  if (!Number.isInteger(employeeId)) return { status: 400, error: 'Invalid employee id' };
  const record = await prisma.shopEmployeeMembership.findUnique({
    where: { employeeId_shopId: { employeeId, shopId: ctx.shopId } },
    include: { employee: { select: { id: true, email: true, companyMembership: { select: { status: true } } } } },
  });
  if (!record || record.status === 'REMOVED') {
    return { status: 404, error: 'Employee not found or access denied' };
  }
  return { record };
}

async function emailInUse(email) {
  const [admin, employee, customer] = await Promise.all([
    prisma.admin.findFirst({ where: { email }, select: { id: true } }),
    prisma.empolyee.findFirst({ where: { email }, select: { id: true } }),
    prisma.customer.findFirst({ where: { email }, select: { id: true } }),
  ]);
  return !!(admin || employee || customer);
}

const shopEmployeeInclude = (shopId) => ({
  employee: {
    select: {
      id: true,
      name: true,
      email: true,
      phoneNo: true,
      lastActiveAt: true,
      companyMembership: { select: { status: true } },
      lists: {
        where: { shopId },
        select: {
          id: true,
          name: true,
          description: true,
          createdAt: true,
          _count: { select: { products: true } },
        },
        orderBy: { createdAt: 'desc' },
      },
    },
  },
});

function formatShopEmployee(membership) {
  const { employee } = membership;
  const lists = employee.lists.map((list) => ({
    id: list.id,
    name: list.name,
    description: list.description,
    createdAt: list.createdAt,
    productCount: list._count.products,
  }));
  return {
    id: employee.id,
    membershipId: membership.id,
    name: employee.name,
    email: employee.email,
    phoneNo: employee.phoneNo,
    shopId: membership.shopId,
    role: membership.role,
    permissions: membership.permissions,
    status: membership.status,
    createdAt: membership.createdAt,
    deactivatedAt: membership.deactivatedAt,
    lastActiveAt: membership.lastActiveAt ?? employee.lastActiveAt ?? null,
    credentialsLocked: employee.companyMembership?.status === 'ACTIVE',
    listCount: lists.length,
    lists,
  };
}

async function loadShopEmployee(shopId, employeeId) {
  const membership = await prisma.shopEmployeeMembership.findUnique({
    where: { employeeId_shopId: { employeeId, shopId } },
    include: shopEmployeeInclude(shopId),
  });
  return membership ? formatShopEmployee(membership) : null;
}

async function ensureShopGroupChat(shopId, ownerCustomerId) {
  const shop = await prisma.shop.findUnique({ where: { id: shopId }, select: { groupChatId: true, name: true } });
  if (shop?.groupChatId) return;
  const groupChat = await prisma.chat.create({
    data: {
      name: `${shop?.name || 'Shop'} Group`,
      type: 'GROUP',
      ...(ownerCustomerId && {
        participants: { create: { userId: ownerCustomerId, userType: 'CUSTOMER', isAdmin: true } },
      }),
    },
  });
  await prisma.shop.update({ where: { id: shopId }, data: { groupChatId: groupChat.id } });
}

// GET /api/employees - Shop employees of the caller's shop (optional ?status=ACTIVE|INACTIVE|INVITED|REMOVED|ALL)
router.get('/', authenticateShopOwner, async (req, res) => {
  try {
    const { shopId } = req.shopContext;
    if (!shopId) {
      return res.json({ success: true, employees: [], counts: { total: 0 } });
    }

    const statusFilter = String(req.query.status || '').toUpperCase();
    const where = { shopId };
    if (MEMBERSHIP_STATUSES.includes(statusFilter)) where.status = statusFilter;
    else if (statusFilter !== 'ALL') where.status = { not: 'REMOVED' };

    const [memberships, grouped] = await Promise.all([
      prisma.shopEmployeeMembership.findMany({
        where,
        include: shopEmployeeInclude(shopId),
        orderBy: { createdAt: 'desc' },
      }),
      prisma.shopEmployeeMembership.groupBy({ by: ['status'], where: { shopId }, _count: { _all: true } }),
    ]);

    const counts = Object.fromEntries(MEMBERSHIP_STATUSES.map((s) => [s, 0]));
    grouped.forEach((g) => { counts[g.status] = g._count._all; });
    counts.total = counts.ACTIVE + counts.INACTIVE + counts.INVITED;

    res.json({ success: true, employees: memberships.map(formatShopEmployee), counts });
  } catch (error) {
    console.error('Error fetching employees:', error);
    res.status(500).json({ error: 'Failed to fetch employees' });
  }
});

// POST /api/employees - Create a shop employee account with a membership in the caller's shop only
router.post('/', authenticateShopCreator, async (req, res) => {
  try {
    const ctx = req.shopContext;
    const { name, email, password, phoneNo } = req.body;

    const forbidden = rejectForbiddenFields(req.body, ctx);
    if (forbidden) return res.status(forbidden.status).json({ error: forbidden.error });

    if (!name || !email || !password) {
      return res.status(400).json({ error: 'Name, email, and password are required' });
    }

    if (password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }

    const roleAndPermissions = validateRoleAndPermissions(req.body, { partial: false });
    if (roleAndPermissions.error) return res.status(400).json({ error: roleAndPermissions.error });

    const normalizedEmail = String(email).toLowerCase().trim();
    if (await emailInUse(normalizedEmail)) {
      return res.status(400).json({ error: 'An account with this email already exists' });
    }

    if (phoneNo) {
      const existingPhone = await prisma.empolyee.findFirst({ where: { phoneNo } });
      if (existingPhone) {
        return res.status(400).json({ error: 'An employee with this phone number already exists' });
      }
    }

    const hashedPassword = await bcrypt.hash(password, 12);
    await ensureShopGroupChat(ctx.shopId, ctx.ownerCustomerId);

    // Account + shop membership are written in one statement (no company membership is ever created here).
    const { id: employeeId } = await prisma.empolyee.create({
      data: {
        name: String(name).trim(),
        email: normalizedEmail,
        password: hashedPassword,
        phoneNo: phoneNo || `temp_${Date.now()}`,
        createdByCustomerId: ctx.ownerCustomerId ?? null,
        userType: 'EMPLOYEE',
        shopId: ctx.shopId,
        shopMemberships: {
          create: {
            shopId: ctx.shopId,
            role: roleAndPermissions.role,
            permissions: roleAndPermissions.permissions,
            status: 'ACTIVE',
            createdByCustomerId: ctx.ownerCustomerId ?? null,
            source: 'SHOP_OWNER_FLOW',
          },
        },
      },
      select: { id: true },
    });

    const shop = await prisma.shop.findUnique({ where: { id: ctx.shopId }, select: { groupChatId: true } });
    if (shop?.groupChatId) {
      // Not fatal: the employee can still join their own shop's group chat on first message.
      await prisma.chatParticipant.upsert({
        where: { chatId_userId_userType: { chatId: shop.groupChatId, userId: employeeId, userType: 'EMPLOYEE' } },
        create: { chatId: shop.groupChatId, userId: employeeId, userType: 'EMPLOYEE', isAdmin: false },
        update: {},
      }).catch((err) => console.error('Could not add employee to shop group chat:', err.message));
    }

    const employee = await loadShopEmployee(ctx.shopId, employeeId);
    res.status(201).json({
      success: true,
      message: 'Employee created successfully',
      employee
    });
  } catch (error) {
    if (error.code === 'P2002') {
      return res.status(400).json({ error: 'An account with this email or phone number already exists' });
    }
    console.error('Error creating employee:', error);
    res.status(500).json({ error: 'Failed to create employee' });
  }
});

// PUT /api/employees/:id - Update an employee's account details or shop role (this shop only)
router.put('/:id', authenticateShopOwner, async (req, res) => {
  try {
    const ctx = req.shopContext;
    const employeeId = parseInt(req.params.id, 10);
    const { name, email, password, phoneNo } = req.body;

    const forbidden = rejectForbiddenFields(req.body, ctx);
    if (forbidden) return res.status(forbidden.status).json({ error: forbidden.error });

    const membership = await findManageableMembership(ctx, employeeId);
    if (membership.error) return res.status(membership.status).json({ error: membership.error });
    const { record } = membership;

    const roleUpdate = validateRoleAndPermissions(req.body, { partial: true });
    if (roleUpdate.error) return res.status(400).json({ error: roleUpdate.error });

    const credentialsLocked = record.employee.companyMembership?.status === 'ACTIVE';
    if (credentialsLocked && (email || password)) {
      return res.status(403).json({ error: 'Login details for this account cannot be changed from the shop.' });
    }

    const updateData = {};
    if (name) updateData.name = String(name).trim();
    if (email) {
      const normalized = String(email).toLowerCase().trim();
      if (normalized !== record.employee.email && await emailInUse(normalized)) {
        return res.status(400).json({ error: 'Email already in use by another account' });
      }
      updateData.email = normalized;
    }
    if (phoneNo) {
      const existing = await prisma.empolyee.findFirst({ where: { phoneNo, id: { not: employeeId } } });
      if (existing) {
        return res.status(400).json({ error: 'Phone number already in use' });
      }
      updateData.phoneNo = phoneNo;
    }
    if (password) {
      if (password.length < 6) {
        return res.status(400).json({ error: 'Password must be at least 6 characters' });
      }
      updateData.password = await bcrypt.hash(password, 12);
    }

    await prisma.$transaction([
      ...(Object.keys(updateData).length > 0
        ? [prisma.empolyee.update({ where: { id: employeeId }, data: updateData })]
        : []),
      ...(roleUpdate.role !== undefined || roleUpdate.permissions !== undefined
        ? [prisma.shopEmployeeMembership.update({
            where: { id: record.id },
            data: {
              ...(roleUpdate.role !== undefined && { role: roleUpdate.role }),
              ...(roleUpdate.permissions !== undefined && { permissions: roleUpdate.permissions }),
            },
          })]
        : []),
    ]);

    const updated = await loadShopEmployee(ctx.shopId, employeeId);
    res.json({ success: true, message: 'Employee updated successfully', employee: updated });
  } catch (error) {
    console.error('Error updating employee:', error);
    res.status(500).json({ error: 'Failed to update employee' });
  }
});

// PATCH /api/employees/:id/status - Activate or deactivate this shop membership only
router.patch('/:id/status', authenticateShopOwner, async (req, res) => {
  try {
    const ctx = req.shopContext;
    const employeeId = parseInt(req.params.id, 10);
    const status = String(req.body?.status || '').toUpperCase();
    if (!['ACTIVE', 'INACTIVE'].includes(status)) {
      return res.status(400).json({ error: 'Status must be ACTIVE or INACTIVE' });
    }

    const membership = await findManageableMembership(ctx, employeeId);
    if (membership.error) return res.status(membership.status).json({ error: membership.error });

    await setShopMembershipStatus(membership.record.id, status);
    const updated = await loadShopEmployee(ctx.shopId, employeeId);
    res.json({
      success: true,
      message: status === 'ACTIVE' ? 'Employee reactivated' : 'Employee deactivated',
      employee: updated,
    });
  } catch (error) {
    if (error.status) return res.status(error.status).json({ error: error.message });
    if (error.code === 'P2002') {
      return res.status(409).json({ error: 'This person is already active in another shop' });
    }
    console.error('Error updating employee status:', error);
    res.status(500).json({ error: 'Failed to update employee status' });
  }
});

// DELETE /api/employees/:id - Remove from this shop. The account, its lists and history are kept.
router.delete('/:id', authenticateShopOwner, async (req, res) => {
  try {
    const ctx = req.shopContext;
    const employeeId = parseInt(req.params.id, 10);

    const membership = await findManageableMembership(ctx, employeeId);
    if (membership.error) return res.status(membership.status).json({ error: membership.error });

    await setShopMembershipStatus(membership.record.id, 'REMOVED');
    res.json({ success: true, message: 'Employee removed from this shop. Their lists are kept.' });
  } catch (error) {
    console.error('Error removing employee:', error);
    res.status(500).json({ error: 'Failed to remove employee' });
  }
});

// GET /api/employees/:id/lists - Lists this employee created in this shop, and whether the owner already copied each one
router.get('/:id/lists', authenticateShopOwner, async (req, res) => {
  try {
    const ctx = req.shopContext;
    const employeeId = parseInt(req.params.id, 10);
    if (!Number.isInteger(employeeId)) return res.status(400).json({ error: 'Invalid employee id' });

    const membership = await prisma.shopEmployeeMembership.findUnique({
      where: { employeeId_shopId: { employeeId, shopId: ctx.shopId } },
      select: { employee: { select: { id: true, name: true } } },
    });
    if (!membership) {
      return res.status(404).json({ error: 'Employee not found or access denied' });
    }

    const lists = await prisma.list.findMany({
      where: { employeeId, shopId: ctx.shopId },
      select: {
        id: true,
        name: true,
        description: true,
        createdAt: true,
        updatedAt: true,
        _count: { select: { products: true } },
        products: { where: { isPurchased: true }, select: { id: true } },
        trackedBy: { where: { userId: req.user.id, userType: 'CUSTOMER' }, select: { id: true } },
      },
      orderBy: { createdAt: 'desc' },
    });

    res.json({
      success: true,
      employee: membership.employee,
      lists: lists.map((list) => ({
        id: list.id,
        name: list.name,
        description: list.description,
        createdAt: list.createdAt,
        updatedAt: list.updatedAt,
        itemCount: list._count.products,
        collectedCount: list.products.length,
        copiedByMe: list.trackedBy.length > 0,
      })),
    });
  } catch (error) {
    console.error('Error fetching employee lists:', error);
    res.status(500).json({ error: 'Failed to fetch employee lists' });
  }
});

export default router;
