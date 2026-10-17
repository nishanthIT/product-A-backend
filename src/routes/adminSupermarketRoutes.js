import express from 'express';
import { PrismaClient } from '@prisma/client';
import { requireCompanyPermission } from '../middleware/authware.js';
import { COMPANY_PERMISSIONS } from '../services/accessControl.js';
const db = new PrismaClient();
const router = express.Router();
router.use(requireCompanyPermission(COMPANY_PERMISSIONS.CUSTOMERS_VIEW));
const ownerSelect = { customer: { select: { id: true, name: true, email: true, subscriptionStatus: true } } };
const format = (shop) => ({ ...shop, owners: shop.supermarketOwnerships.map((o) => o.customer), supermarketOwnerships: undefined, employeeCount: shop._count.employeeMemberships, _count: undefined });
const audit = (req, action, supermarketId = null) => db.supermarketAdminAccessLog.create({ data: { actorId: req.user.id, actorType: req.user.userType, action, supermarketId } });
router.get('/', async (req, res, next) => {
  try {
    const page = Math.max(1, Math.min(100000, Number.parseInt(req.query.page, 10) || 1));
    const limit = 25;
    const search = String(req.query.search || '').trim().slice(0, 200);
    const status = String(req.query.status || '');
    const ownerWhere = { ...(status && { subscriptionStatus: status }) };
    const where = { shopType: 'CUSTOMER',
      ...(status && { supermarketOwnerships: { some: { customer: ownerWhere } } }),
      ...(search && { OR: [{ name: { contains: search, mode: 'insensitive' } }, { supermarketOwnerships: { some: { customer: { OR: [{ name: { contains: search, mode: 'insensitive' } }, { email: { contains: search, mode: 'insensitive' } }] } } } }] }),
    };
    const sort = req.query.sort === 'name' ? 'name' : 'createdAt';
    const direction = req.query.direction === 'asc' ? 'asc' : 'desc';
    const [shops, total] = await db.$transaction([
      db.shop.findMany({ where, orderBy: [{ [sort]: direction }, { id: 'asc' }], skip: (page - 1) * limit, take: limit,
        select: { id: true, name: true, address: true, createdAt: true, supermarketOwnerships: { select: ownerSelect }, _count: { select: { employeeMemberships: { where: { status: 'ACTIVE' } } } } } }),
      db.shop.count({ where }),
    ]);
    await audit(req, 'DIRECTORY_VIEW');
    res.json({ supermarkets: shops.map(format), total, page, limit });
  } catch (err) { next(err); }
});
router.get('/:id', async (req, res, next) => {
  try {
    const shop = await db.shop.findFirst({ where: { id: req.params.id, shopType: 'CUSTOMER' }, select: {
      id: true, name: true, address: true, createdAt: true, supermarketOwnerships: { select: ownerSelect },
      employeeMemberships: { where: { status: { not: 'REMOVED' } }, select: { id: true, status: true, permissions: true, employee: { select: { id: true, name: true, email: true } } } },
      _count: { select: { employeeMemberships: { where: { status: 'ACTIVE' } }, expiryProducts: true, tasks: true, fridges: true, cleaningAreas: true, incidentLogs: true } },
    } });
    if (!shop) return res.status(404).json({ error: 'Supermarket not found' });
    const listCount = await db.list.count({ where: { shopId: shop.id } });
    await audit(req, 'DETAIL_VIEW', shop.id);
    res.json({ ...format(shop), statistics: { lists: listCount, expiryRecords: shop._count.expiryProducts, tasks: shop._count.tasks, fridges: shop._count.fridges, cleaningAreas: shop._count.cleaningAreas, incidents: shop._count.incidentLogs } });
  } catch (err) { next(err); }
});
export default router;
