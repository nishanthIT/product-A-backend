import { PrismaClient } from '@prisma/client';
import { ALL_SHOP_PERMISSIONS, MEMBERSHIP_STATUSES, SHOP_EMPLOYEE_ROLES, defaultShopPermissions, normalizeShopPermissions } from '../../services/accessControl.js';
import { SLOW_DB_TX_OPTIONS, createShopMembership } from '../../services/membershipService.js';

// Company-admin views of customers' Shop Employees and the access-review queue.
// Read access here never creates or changes company membership.
const prisma = new PrismaClient();

const emptyCounts = () => ({ ...Object.fromEntries(MEMBERSHIP_STATUSES.map((s) => [s, 0])), total: 0 });

/**
 * GET /api/admin/customers/:customerId/employees[?shopId=&status=]
 * Shop employees of the shop(s) this customer owns, grouped by shop.
 */
const getCustomerEmployees = async (req, res) => {
  try {
    const customerId = parseInt(req.params.customerId, 10);
    if (Number.isNaN(customerId)) return res.status(400).json({ success: false, error: 'Invalid customer ID' });

    const customer = await prisma.customer.findUnique({
      where: { id: customerId },
      select: { id: true, name: true, email: true, shop: { select: { id: true, name: true, shopType: true } } },
    });
    if (!customer) return res.status(404).json({ success: false, error: 'Customer not found' });

    // Customer.shopId is the ownership relation; only shops this customer owns are shown.
    const ownedShops = customer.shop ? [customer.shop] : [];
    const requestedShopId = req.query.shopId ? String(req.query.shopId) : null;
    if (requestedShopId && !ownedShops.some((s) => s.id === requestedShopId)) {
      return res.status(404).json({ success: false, error: 'Shop not found for this customer' });
    }
    const shops = requestedShopId ? ownedShops.filter((s) => s.id === requestedShopId) : ownedShops;

    const statusFilter = String(req.query.status || '').toUpperCase();
    const totals = emptyCounts();
    const groups = [];

    for (const shop of shops) {
      const where = { shopId: shop.id };
      if (MEMBERSHIP_STATUSES.includes(statusFilter)) where.status = statusFilter;

      const [memberships, grouped] = await Promise.all([
        prisma.shopEmployeeMembership.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          include: {
            employee: {
              select: {
                id: true,
                name: true,
                email: true,
                lastActiveAt: true,
                lists: {
                  where: { shopId: shop.id },
                  select: { id: true, name: true, createdAt: true, _count: { select: { products: true } } },
                  orderBy: { createdAt: 'desc' },
                },
              },
            },
          },
        }),
        prisma.shopEmployeeMembership.groupBy({ by: ['status'], where: { shopId: shop.id }, _count: { _all: true } }),
      ]);

      const counts = emptyCounts();
      grouped.forEach((g) => {
        counts[g.status] = g._count._all;
        totals[g.status] += g._count._all;
      });
      counts.total = MEMBERSHIP_STATUSES.reduce((sum, s) => sum + counts[s], 0);

      groups.push({
        shop: { id: shop.id, name: shop.name, shopType: shop.shopType },
        counts,
        employees: memberships.map((m) => ({
          id: m.employee.id,
          membershipId: m.id,
          name: m.employee.name,
          email: m.employee.email,
          shopId: shop.id,
          shopName: shop.name,
          role: m.role,
          permissions: m.permissions,
          status: m.status,
          createdAt: m.createdAt,
          deactivatedAt: m.deactivatedAt,
          lastActiveAt: m.lastActiveAt ?? m.employee.lastActiveAt ?? null,
          lists: m.employee.lists.map((l) => ({
            id: l.id,
            name: l.name,
            createdAt: l.createdAt,
            itemCount: l._count.products,
          })),
        })),
      });
    }
    totals.total = MEMBERSHIP_STATUSES.reduce((sum, s) => sum + totals[s], 0);

    res.json({
      success: true,
      data: {
        customer: { id: customer.id, name: customer.name, email: customer.email },
        shops: groups,
        counts: totals,
      },
    });
  } catch (error) {
    console.error('Error fetching customer employees:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch customer employees' });
  }
};

/** GET /api/admin/lists/:listId - read-only list view for company admins. */
const getListForAdmin = async (req, res) => {
  try {
    const list = await prisma.list.findUnique({
      where: { id: String(req.params.listId) },
      include: {
        employee: { select: { id: true, name: true, email: true } },
        customer: { select: { id: true, name: true, email: true } },
        products: {
          orderBy: { id: 'desc' },
          include: {
            productAtShop: {
              select: {
                price: true,
                shop: { select: { id: true, name: true } },
                product: { select: { id: true, title: true, barcode: true } },
              },
            },
          },
        },
      },
    });
    if (!list) return res.status(404).json({ success: false, error: 'List not found' });

    const shop = list.shopId
      ? await prisma.shop.findUnique({ where: { id: list.shopId }, select: { id: true, name: true } })
      : null;

    res.json({
      success: true,
      data: {
        id: list.id,
        name: list.name,
        description: list.description,
        creatorType: list.creatorType,
        createdAt: list.createdAt,
        updatedAt: list.updatedAt,
        shop,
        createdBy: list.employee ?? list.customer ?? null,
        items: list.products.map((p) => ({
          id: p.id,
          quantity: p.quantity,
          isPurchased: p.isPurchased,
          isUrgent: p.isUrgent,
          title: p.productAtShop?.product?.title ?? 'Unknown product',
          barcode: p.productAtShop?.product?.barcode ?? null,
          price: p.productAtShop?.price ?? null,
          shopName: p.productAtShop?.shop?.name ?? null,
        })),
      },
    });
  } catch (error) {
    console.error('Error fetching list for admin:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch list' });
  }
};

/** GET /api/admin/access-reviews[?status=OPEN|RESOLVED] */
const getAccessReviews = async (req, res) => {
  try {
    const status = String(req.query.status || 'OPEN').toUpperCase();
    const reviews = await prisma.employeeAccessReview.findMany({
      where: ['OPEN', 'RESOLVED'].includes(status) ? { status } : {},
      orderBy: { createdAt: 'asc' },
      include: {
        employee: {
          select: {
            id: true,
            name: true,
            email: true,
            createdAt: true,
            createdByCustomerId: true,
            companyMembership: { select: { status: true, role: true } },
            shopMemberships: { select: { shopId: true, status: true, role: true } },
          },
        },
      },
    });
    res.json({ success: true, data: reviews });
  } catch (error) {
    console.error('Error fetching access reviews:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch access reviews' });
  }
};

/**
 * GET /api/admin/access-reviews/assignable-shops?search=&reviewId=
 * Customer shops (with an owner) a flagged employee can be assigned to. When the
 * employee's recorded creator still owns a shop, that shop is marked as suggested.
 */
const getAssignableShops = async (req, res) => {
  try {
    const search = String(req.query.search || '').trim();
    const textFilter = search
      ? {
          OR: [
            { name: { contains: search, mode: 'insensitive' } },
            { customers: { some: { name: { contains: search, mode: 'insensitive' } } } },
            { customers: { some: { email: { contains: search, mode: 'insensitive' } } } },
          ],
        }
      : {};

    let suggestedShopId = null;
    if (req.query.reviewId) {
      const review = await prisma.employeeAccessReview.findUnique({
        where: { id: String(req.query.reviewId) },
        select: { employee: { select: { createdByCustomer: { select: { shopId: true } } } } },
      });
      suggestedShopId = review?.employee?.createdByCustomer?.shopId ?? null;
    }

    const shops = await prisma.shop.findMany({
      where: { shopType: 'CUSTOMER', customers: { some: {} }, ...textFilter },
      select: {
        id: true,
        name: true,
        address: true,
        customers: { select: { id: true, name: true, email: true } },
        _count: { select: { employeeMemberships: { where: { status: 'ACTIVE' } } } },
      },
      orderBy: { name: 'asc' },
      take: 50,
    });

    const data = shops
      .map((shop) => ({
        id: shop.id,
        name: shop.name,
        address: shop.address,
        owners: shop.customers,
        activeEmployees: shop._count.employeeMemberships,
        suggested: shop.id === suggestedShopId,
      }))
      .sort((a, b) => Number(b.suggested) - Number(a.suggested));

    res.json({ success: true, data });
  } catch (error) {
    console.error('Error fetching assignable shops:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch shops' });
  }
};

/**
 * POST /api/admin/access-reviews/:id/resolve
 * body: { action: 'ASSIGN_SHOP' | 'GRANT_COMPANY' | 'NO_ACCESS', shopId?, note }
 * GRANT_COMPANY only records the decision; the grant itself goes through POST /api/admin/staff/grant.
 */
const resolveAccessReview = async (req, res) => {
  try {
    const { action, shopId } = req.body || {};
    const note = String(req.body?.note || '').trim();
    if (!['ASSIGN_SHOP', 'GRANT_COMPANY', 'NO_ACCESS'].includes(action)) {
      return res.status(400).json({ success: false, error: 'action must be ASSIGN_SHOP, GRANT_COMPANY or NO_ACCESS' });
    }
    if (!note) return res.status(400).json({ success: false, error: 'A resolution note is required' });

    const role = String(req.body?.role || 'EMPLOYEE').toUpperCase();
    if (!SHOP_EMPLOYEE_ROLES.includes(role)) {
      return res.status(400).json({ success: false, error: `Shop role must be one of: ${SHOP_EMPLOYEE_ROLES.join(', ')}` });
    }
    let permissions = defaultShopPermissions();
    if (req.body?.permissions !== undefined) {
      const requested = req.body.permissions;
      if (!Array.isArray(requested) || requested.some((p) => !ALL_SHOP_PERMISSIONS.includes(p))) {
        return res.status(400).json({ success: false, error: 'Permissions must be shop permissions' });
      }
      permissions = normalizeShopPermissions(requested);
    }

    const review = await prisma.employeeAccessReview.findUnique({ where: { id: String(req.params.id) } });
    if (!review) return res.status(404).json({ success: false, error: 'Review not found' });
    if (review.status !== 'OPEN') return res.status(409).json({ success: false, error: 'Review already resolved' });

    await prisma.$transaction(async (tx) => {
      if (action === 'ASSIGN_SHOP') {
        const shop = shopId
          ? await tx.shop.findUnique({ where: { id: String(shopId) }, select: { id: true, shopType: true, customers: { select: { id: true } } } })
          : null;
        if (!shop || shop.shopType !== 'CUSTOMER' || shop.customers.length === 0) {
          throw Object.assign(new Error('shopId must be an existing customer shop with an owner'), { status: 400 });
        }
        const active = await tx.shopEmployeeMembership.findFirst({
          where: { employeeId: review.employeeId, status: 'ACTIVE' },
          select: { id: true },
        });
        if (active) throw Object.assign(new Error('Employee already has an active shop membership'), { status: 409 });
        const existing = await tx.shopEmployeeMembership.findUnique({
          where: { employeeId_shopId: { employeeId: review.employeeId, shopId: shop.id } },
        });
        if (existing) throw Object.assign(new Error('Employee already has a membership in this shop'), { status: 409 });
        await createShopMembership(tx, {
          employeeId: review.employeeId,
          shopId: shop.id,
          role,
          permissions,
          createdByCustomerId: shop.customers[0].id,
          source: 'ACCESS_REVIEW',
        });
      }

      if (action === 'GRANT_COMPANY') {
        const membership = await tx.companyStaffMembership.findUnique({ where: { employeeId: review.employeeId } });
        if (membership?.status !== 'ACTIVE') {
          throw Object.assign(new Error('Grant company access first via POST /api/admin/staff/grant'), { status: 409 });
        }
      }

      await tx.employeeAccessReview.update({
        where: { id: review.id },
        data: {
          status: 'RESOLVED',
          resolution: action,
          resolutionNote: note,
          resolvedById: req.user.id,
          resolvedAt: new Date(),
        },
      });
    }, SLOW_DB_TX_OPTIONS);

    res.json({ success: true, message: 'Review resolved' });
  } catch (error) {
    if (error.status) return res.status(error.status).json({ success: false, error: error.message });
    console.error('Error resolving access review:', error);
    res.status(500).json({ success: false, error: 'Failed to resolve review' });
  }
};

export { getCustomerEmployees, getListForAdmin, getAccessReviews, resolveAccessReview, getAssignableShops };
