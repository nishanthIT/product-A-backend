import express from 'express';
import { PrismaClient } from '@prisma/client';
import { isAuthenticated } from '../middleware/authware.js';
import { createAdditionalSupermarket, resolveSupermarketSelection } from '../services/supermarketProvisioning.js';

const db = new PrismaClient();
const router = express.Router();
router.use(isAuthenticated);
const handleError = (res, err) => res.status(err.status || 500).json({ error: err.status ? err.message : 'Unable to update your shops. Please try again.', code: err.code });

router.get('/', async (req, res) => {
  try {
    const owner = req.user.userType === 'CUSTOMER';
    if (!owner && req.user.userType !== 'EMPLOYEE') return res.status(403).json({ error: 'Customer supermarket access required' });
    const select = { id: true, name: true, address: true, createdAt: true,
      ...(owner && { _count: { select: { employeeMemberships: { where: { status: 'ACTIVE' } } } } }) };
    const records = owner
      ? await db.supermarketOwnership.findMany({ where: { customerId: req.user.id, shopType: 'CUSTOMER', shop: { shopType: 'CUSTOMER' } }, include: { shop: { select } }, orderBy: { createdAt: 'asc' } })
      : await db.shopEmployeeMembership.findMany({ where: { employeeId: req.user.id, status: 'ACTIVE', shop: { shopType: 'CUSTOMER' } }, include: { shop: { select } }, orderBy: { createdAt: 'asc' } });
    const customer = owner ? await db.customer.findUnique({ where: { id: req.user.id }, select: { defaultSupermarketId: true } }) : null;
    const supermarkets = records.map((record) => ({ id: record.shop.id, name: record.shop.name, address: record.shop.address,
      isDefault: customer?.defaultSupermarketId === record.shopId, role: owner ? 'OWNER' : 'EMPLOYEE',
      permissions: owner ? [] : record.permissions,
      ...(owner && { employeeCount: record.shop._count.employeeMemberships }),
    }));
    res.json({ supermarkets, defaultSupermarketId: supermarkets.find((s) => s.isDefault)?.id ?? req.user.shopId ?? null,
      canCreateAdditional: owner && supermarkets.length > 0, canSwitchOperationalContext: true });
  } catch (err) { handleError(res, err); }
});
router.post('/', async (req, res) => {
  try {
    const result = await createAdditionalSupermarket(db, req.user, req.body, req.get('Idempotency-Key'));
    res.status(result.replayed ? 200 : 201).json(result);
  } catch (err) { handleError(res, err); }
});
router.put('/:id/default', async (req, res) => {
  try {
    if (req.user.userType !== 'CUSTOMER') return res.status(403).json({ error: 'Only shop owners can change the default' });
    await db.$transaction(async (tx) => {
      await resolveSupermarketSelection(tx, req.user, req.params.id);
      await tx.customer.update({ where: { id: req.user.id }, data: { defaultSupermarketId: req.params.id, defaultSupermarketVersion: { increment: 1 } } });
    });
    res.json({ defaultSupermarketId: req.params.id });
  } catch (err) { handleError(res, err); }
});
export default router;
