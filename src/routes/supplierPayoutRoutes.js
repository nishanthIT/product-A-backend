import express from 'express';
import { PrismaClient } from '@prisma/client';
import { isAuthenticated, requireShopFeature } from '../middleware/authware.js';
import { SHOP_FEATURES } from '../services/accessControl.js';

const router = express.Router();
const prisma = new PrismaClient();

const VALID_PAYMENT_STATUSES = ['TO_PAY', 'PAID'];
const VALID_PAYMENT_METHODS = ['CASH', 'CARD'];

// Shared auth: verifies the token and reloads employee memberships each request
const authenticateToken = [isAuthenticated, requireShopFeature(SHOP_FEATURES.SUPPLIER_PAYOUTS)];

const getUserShopId = async (userId, userType) => {
  if (userType === 'ADMIN') {
    const admin = await prisma.admin.findUnique({ where: { id: userId }, select: { shopId: true } });
    return admin?.shopId;
  }
  if (userType === 'CUSTOMER') {
    const customer = await prisma.customer.findUnique({ where: { id: userId }, select: { shopId: true } });
    return customer?.shopId;
  }
  if (userType === 'EMPLOYEE') {
    const emp = await prisma.empolyee.findUnique({ where: { id: userId }, select: { shopId: true } });
    return emp?.shopId;
  }
  return null;
};

const resolveUserName = async (userId, userType) => {
  if (userType === 'ADMIN') {
    const admin = await prisma.admin.findUnique({ where: { id: userId }, select: { name: true } });
    return admin?.name || 'Admin';
  }
  if (userType === 'CUSTOMER') {
    const customer = await prisma.customer.findUnique({ where: { id: userId }, select: { name: true } });
    return customer?.name || 'Shop Owner';
  }
  if (userType === 'EMPLOYEE') {
    const emp = await prisma.empolyee.findUnique({ where: { id: userId }, select: { name: true } });
    return emp?.name || 'Employee';
  }
  return 'Unknown';
};

const isManager = (userType) => userType === 'ADMIN' || userType === 'CUSTOMER';

// Owners/admins manage every shop payout; employees only the ones they recorded.
const canEditRecord = (record, user) =>
  isManager(user.userType) ||
  (user.userType === 'EMPLOYEE' &&
    record.createdByType === 'EMPLOYEE' &&
    record.createdById === Number(user.id));

const withPermissions = (record, user) => ({
  ...record,
  canEdit: canEditRecord(record, user),
  canDelete: isManager(user.userType),
});

// GET /api/supplier-payouts - list with filters
router.get('/', authenticateToken, async (req, res) => {
  try {
    const { id: userId, userType } = req.user;
    const shopId = await getUserShopId(userId, userType);
    if (!shopId) return res.status(400).json({ error: 'User not assigned to a shop' });

    const { startDate, endDate, supplier, paymentStatus, paymentMethod, recordedBy, limit = 500 } = req.query;

    const where = { shopId };

    if (startDate || endDate) {
      where.createdAt = {};
      if (startDate) where.createdAt.gte = new Date(`${startDate}T00:00:00.000Z`);
      if (endDate) where.createdAt.lte = new Date(`${endDate}T23:59:59.999Z`);
    }

    if (supplier && String(supplier).trim()) {
      where.supplier = { contains: String(supplier).trim(), mode: 'insensitive' };
    }

    if (paymentStatus && VALID_PAYMENT_STATUSES.includes(String(paymentStatus).toUpperCase())) {
      where.paymentStatus = String(paymentStatus).toUpperCase();
    }

    if (paymentMethod && VALID_PAYMENT_METHODS.includes(String(paymentMethod).toUpperCase())) {
      where.paymentMethod = String(paymentMethod).toUpperCase();
    }

    if (recordedBy && String(recordedBy).trim()) {
      where.recordedBy = { equals: String(recordedBy).trim(), mode: 'insensitive' };
    }

    const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 500, 1), 5000);

    const records = await prisma.supplierPayoutRecord.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: safeLimit,
    });

    res.json({ success: true, records: records.map((record) => withPermissions(record, req.user)) });
  } catch (error) {
    console.error('Error fetching supplier payout records:', error);
    res.status(500).json({ error: 'Failed to fetch supplier payout records' });
  }
});

// POST /api/supplier-payouts - create (any authenticated user)
router.post('/', authenticateToken, async (req, res) => {
  try {
    const { id: userId, userType } = req.user;
    const shopId = await getUserShopId(userId, userType);
    if (!shopId) return res.status(400).json({ error: 'User not assigned to a shop' });

    const { supplier, amount, paymentStatus, paymentMethod, notes } = req.body;

    if (!supplier || !String(supplier).trim()) return res.status(400).json({ error: 'Supplier is required' });
    if (amount === undefined || amount === null || isNaN(Number(amount)) || Number(amount) <= 0) {
      return res.status(400).json({ error: 'Amount must be a positive number' });
    }

    const normalizedStatus = String(paymentStatus || 'TO_PAY').toUpperCase();
    if (!VALID_PAYMENT_STATUSES.includes(normalizedStatus)) {
      return res.status(400).json({ error: 'Payment status must be TO_PAY or PAID' });
    }

    let normalizedMethod = null;
    if (normalizedStatus === 'PAID') {
      normalizedMethod = String(paymentMethod || '').toUpperCase();
      if (!VALID_PAYMENT_METHODS.includes(normalizedMethod)) {
        return res.status(400).json({ error: 'Payment method (Cash or Card) is required when status is Paid' });
      }
    }

    const recordedBy = await resolveUserName(userId, userType);

    const record = await prisma.supplierPayoutRecord.create({
      data: {
        shopId,
        supplier: String(supplier).trim(),
        amount: Number(amount),
        paymentStatus: normalizedStatus,
        paymentMethod: normalizedMethod,
        notes: notes ? String(notes).trim() || null : null,
        recordedBy,
        createdById: userId,
        createdByType: userType,
      },
    });

    res.status(201).json({ success: true, record: withPermissions(record, req.user) });
  } catch (error) {
    console.error('Error creating supplier payout record:', error);
    res.status(500).json({ error: 'Failed to create supplier payout record' });
  }
});

// PUT /api/supplier-payouts/:id - update (ADMIN/CUSTOMER any record; EMPLOYEE own records)
router.put('/:id', authenticateToken, async (req, res) => {
  try {
    const { id: userId, userType } = req.user;

    const shopId = await getUserShopId(userId, userType);
    if (!shopId) return res.status(400).json({ error: 'User not assigned to a shop' });

    const existing = await prisma.supplierPayoutRecord.findFirst({
      where: { id: req.params.id, shopId },
    });
    if (!existing) return res.status(404).json({ error: 'Record not found' });

    if (!canEditRecord(existing, req.user)) {
      return res.status(403).json({ error: 'You can only edit supplier payouts that you recorded' });
    }

    const { supplier, amount, paymentStatus, paymentMethod, notes } = req.body;

    const updateData = {};

    if (supplier !== undefined) {
      if (!String(supplier).trim()) return res.status(400).json({ error: 'Supplier cannot be empty' });
      updateData.supplier = String(supplier).trim();
    }
    if (amount !== undefined) {
      if (isNaN(Number(amount)) || Number(amount) <= 0) return res.status(400).json({ error: 'Amount must be a positive number' });
      updateData.amount = Number(amount);
    }
    if (paymentStatus !== undefined) {
      const normalizedStatus = String(paymentStatus).toUpperCase();
      if (!VALID_PAYMENT_STATUSES.includes(normalizedStatus)) return res.status(400).json({ error: 'Invalid payment status' });
      updateData.paymentStatus = normalizedStatus;
      // When changing to TO_PAY, clear the payment method
      if (normalizedStatus === 'TO_PAY') {
        updateData.paymentMethod = null;
      }
    }
    if (paymentMethod !== undefined) {
      // Only accept paymentMethod if status is (or will be) PAID
      const effectiveStatus = updateData.paymentStatus ?? existing.paymentStatus;
      if (effectiveStatus === 'PAID') {
        const normalizedMethod = String(paymentMethod).toUpperCase();
        if (!VALID_PAYMENT_METHODS.includes(normalizedMethod)) return res.status(400).json({ error: 'Invalid payment method' });
        updateData.paymentMethod = normalizedMethod;
      }
    }
    if (notes !== undefined) {
      updateData.notes = notes ? String(notes).trim() : null;
    }

    const record = await prisma.supplierPayoutRecord.update({
      where: { id: req.params.id },
      data: updateData,
    });

    res.json({ success: true, record: withPermissions(record, req.user) });
  } catch (error) {
    console.error('Error updating supplier payout record:', error);
    res.status(500).json({ error: 'Failed to update supplier payout record' });
  }
});

// DELETE /api/supplier-payouts/:id - delete (ADMIN/CUSTOMER only)
router.delete('/:id', authenticateToken, async (req, res) => {
  try {
    const { id: userId, userType } = req.user;

    if (!isManager(userType)) {
      return res.status(403).json({ error: 'Employees are not allowed to delete supplier payout records' });
    }

    const shopId = await getUserShopId(userId, userType);
    if (!shopId) return res.status(400).json({ error: 'User not assigned to a shop' });

    const existing = await prisma.supplierPayoutRecord.findFirst({
      where: { id: req.params.id, shopId },
    });
    if (!existing) return res.status(404).json({ error: 'Record not found' });

    await prisma.supplierPayoutRecord.delete({ where: { id: req.params.id } });

    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting supplier payout record:', error);
    res.status(500).json({ error: 'Failed to delete supplier payout record' });
  }
});

export default router;
