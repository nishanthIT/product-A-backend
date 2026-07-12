import express from 'express';
import { PrismaClient } from '@prisma/client';
import jwt from 'jsonwebtoken';

const router = express.Router();
const prisma = new PrismaClient();

const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Access token required' });
  jwt.verify(token, process.env.JWT_SECRET || 'your-secret-key', (err, user) => {
    if (err) return res.status(403).json({ error: 'Invalid token' });
    req.user = user;
    next();
  });
};

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

// GET /api/shift-sheet - list with filters
router.get('/', authenticateToken, async (req, res) => {
  try {
    const { id: userId, userType } = req.user;
    const shopId = await getUserShopId(userId, userType);
    if (!shopId) return res.status(400).json({ error: 'User not assigned to a shop' });

    const { startDate, endDate, recordedBy, limit = 500 } = req.query;

    const where = { shopId };

    if (startDate || endDate) {
      where.shiftDate = {};
      if (startDate) where.shiftDate.gte = new Date(`${startDate}T00:00:00.000Z`);
      if (endDate) where.shiftDate.lte = new Date(`${endDate}T23:59:59.999Z`);
    }

    if (recordedBy && String(recordedBy).trim()) {
      where.recordedBy = { equals: String(recordedBy).trim(), mode: 'insensitive' };
    }

    const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 500, 1), 5000);

    const records = await prisma.shiftSheetRecord.findMany({
      where,
      orderBy: { shiftDate: 'desc' },
      take: safeLimit,
    });

    res.json({ success: true, records });
  } catch (error) {
    console.error('Error fetching shift sheet records:', error);
    res.status(500).json({ error: 'Failed to fetch shift sheet records' });
  }
});

// POST /api/shift-sheet - create (any authenticated user)
router.post('/', authenticateToken, async (req, res) => {
  try {
    const { id: userId, userType } = req.user;
    const shopId = await getUserShopId(userId, userType);
    if (!shopId) return res.status(400).json({ error: 'User not assigned to a shop' });

    const { shiftDate, cashTotal, cardTotal, notes } = req.body;

    if (!shiftDate) return res.status(400).json({ error: 'Shift date is required' });
    const parsedDate = new Date(shiftDate);
    if (isNaN(parsedDate.getTime())) return res.status(400).json({ error: 'Invalid shift date' });

    if (cashTotal === undefined || cashTotal === null || isNaN(Number(cashTotal)) || Number(cashTotal) < 0) {
      return res.status(400).json({ error: 'Cash total must be a non-negative number' });
    }
    if (cardTotal === undefined || cardTotal === null || isNaN(Number(cardTotal)) || Number(cardTotal) < 0) {
      return res.status(400).json({ error: 'Card total must be a non-negative number' });
    }

    const cash = Number(cashTotal);
    const card = Number(cardTotal);
    const total = cash + card;

    const recordedBy = await resolveUserName(userId, userType);

    const record = await prisma.shiftSheetRecord.create({
      data: {
        shopId,
        shiftDate: parsedDate,
        cashTotal: cash,
        cardTotal: card,
        totalSales: total,
        notes: notes ? String(notes).trim() : null,
        recordedBy,
        createdById: userId,
        createdByType: userType,
      },
    });

    res.status(201).json({ success: true, record });
  } catch (error) {
    console.error('Error creating shift sheet record:', error);
    res.status(500).json({ error: 'Failed to create shift sheet record' });
  }
});

// PUT /api/shift-sheet/:id - update (ADMIN/CUSTOMER only)
router.put('/:id', authenticateToken, async (req, res) => {
  try {
    const { id: userId, userType } = req.user;

    if (userType === 'EMPLOYEE') {
      return res.status(403).json({ error: 'Employees are not allowed to edit shift sheet records' });
    }

    const shopId = await getUserShopId(userId, userType);
    if (!shopId) return res.status(400).json({ error: 'User not assigned to a shop' });

    const existing = await prisma.shiftSheetRecord.findFirst({
      where: { id: req.params.id, shopId },
    });
    if (!existing) return res.status(404).json({ error: 'Record not found' });

    const { shiftDate, cashTotal, cardTotal, notes } = req.body;

    const updateData = {};

    if (shiftDate !== undefined) {
      const parsedDate = new Date(shiftDate);
      if (isNaN(parsedDate.getTime())) return res.status(400).json({ error: 'Invalid shift date' });
      updateData.shiftDate = parsedDate;
    }

    const newCash = cashTotal !== undefined ? Number(cashTotal) : Number(existing.cashTotal);
    const newCard = cardTotal !== undefined ? Number(cardTotal) : Number(existing.cardTotal);

    if (cashTotal !== undefined) {
      if (isNaN(newCash) || newCash < 0) return res.status(400).json({ error: 'Cash total must be a non-negative number' });
      updateData.cashTotal = newCash;
    }
    if (cardTotal !== undefined) {
      if (isNaN(newCard) || newCard < 0) return res.status(400).json({ error: 'Card total must be a non-negative number' });
      updateData.cardTotal = newCard;
    }

    if (cashTotal !== undefined || cardTotal !== undefined) {
      updateData.totalSales = newCash + newCard;
    }

    if (notes !== undefined) {
      updateData.notes = notes ? String(notes).trim() : null;
    }

    const record = await prisma.shiftSheetRecord.update({
      where: { id: req.params.id },
      data: updateData,
    });

    res.json({ success: true, record });
  } catch (error) {
    console.error('Error updating shift sheet record:', error);
    res.status(500).json({ error: 'Failed to update shift sheet record' });
  }
});

// DELETE /api/shift-sheet/:id - delete (ADMIN/CUSTOMER only)
router.delete('/:id', authenticateToken, async (req, res) => {
  try {
    const { id: userId, userType } = req.user;

    if (userType === 'EMPLOYEE') {
      return res.status(403).json({ error: 'Employees are not allowed to delete shift sheet records' });
    }

    const shopId = await getUserShopId(userId, userType);
    if (!shopId) return res.status(400).json({ error: 'User not assigned to a shop' });

    const existing = await prisma.shiftSheetRecord.findFirst({
      where: { id: req.params.id, shopId },
    });
    if (!existing) return res.status(404).json({ error: 'Record not found' });

    await prisma.shiftSheetRecord.delete({ where: { id: req.params.id } });

    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting shift sheet record:', error);
    res.status(500).json({ error: 'Failed to delete shift sheet record' });
  }
});

export default router;
