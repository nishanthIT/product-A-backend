import express from 'express';
import { PrismaClient } from '@prisma/client';
import jwt from 'jsonwebtoken';

const router = express.Router();
const prisma = new PrismaClient();

const authenticateToken = async (req, res, next) => {
  try {
    let token = null;
    if (req.cookies && req.cookies.auth_token) token = req.cookies.auth_token;
    else if (req.headers.authorization && req.headers.authorization.startsWith('Bearer ')) token = req.headers.authorization.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Authentication required' });
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'your-secret-key');
    req.user = decoded;
    next();
  } catch (error) {
    console.error('Auth error in waste route:', error);
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
};

const getUserShopId = async (userId, userType) => {
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

// GET /api/waste - list records and optional summary
router.get('/', authenticateToken, async (req, res) => {
  try {
    const { id: userId, userType } = req.user;
    const shopId = await getUserShopId(userId, userType);
    if (!shopId) return res.status(400).json({ error: 'User not assigned to a shop' });

    const { startDate, endDate, limit = 200 } = req.query;

    const where = { shopId };
    if (startDate || endDate) {
      where.disposedAt = {};
      if (startDate) where.disposedAt.gte = new Date(startDate);
      if (endDate) where.disposedAt.lte = new Date(endDate);
    }

    const records = await prisma.wasteRecord.findMany({ where, orderBy: { disposedAt: 'desc' }, take: parseInt(limit, 10) });

    // Summary totals
    const totals = await prisma.wasteRecord.aggregate({
      _sum: { totalLoss: true },
      where: { shopId }
    });

    res.json({ success: true, records, summary: { totalLoss: totals._sum.totalLoss || 0 } });
  } catch (error) {
    console.error('Error fetching waste records:', error);
    res.status(500).json({ error: 'Failed to fetch waste records' });
  }
});

// POST /api/waste - create record
router.post('/', authenticateToken, async (req, res) => {
  try {
    const { id: userId, userType } = req.user;
    const shopId = await getUserShopId(userId, userType);
    if (!shopId) return res.status(400).json({ error: 'User not assigned to a shop' });

    const {
      productId,
      itemName,
      quantityWasted,
      originalPrice,
      reducedPrice,
      priceReduced,
      priceReducedBy,
      priceReductionReason,
      priceReductionReasonNote,
      disposedBy,
      disposedAt,
    } = req.body;

    if (!itemName || !itemName.trim()) return res.status(400).json({ error: 'Item name is required' });
    if (!quantityWasted || Number(quantityWasted) <= 0) return res.status(400).json({ error: 'Quantity must be > 0' });
    if (!originalPrice || Number(originalPrice) <= 0) return res.status(400).json({ error: 'Original price must be > 0' });
    if (priceReduced && (!reducedPrice || Number(reducedPrice) <= 0)) return res.status(400).json({ error: 'Reduced price is required when priceReduced is true' });
    if (priceReduced && !priceReductionReason) return res.status(400).json({ error: 'Price reduction reason is required' });

    const finalPrice = priceReduced ? Number(reducedPrice) : Number(originalPrice);
    const totalLoss = Number(quantityWasted) * finalPrice;

    const record = await prisma.wasteRecord.create({
      data: {
        shopId,
        productId: productId || null,
        itemName: itemName.trim(),
        quantityWasted: Number(quantityWasted),
        originalPrice: Number(originalPrice),
        reducedPrice: priceReduced ? Number(reducedPrice) : null,
        finalPrice,
        totalLoss,
        priceReduced: Boolean(priceReduced),
        priceReducedBy: priceReducedBy || null,
        priceReductionReason: priceReductionReason || null,
        priceReductionReasonNote: priceReductionReasonNote || null,
        disposedBy: disposedBy || 'Unknown',
        disposedAt: disposedAt ? new Date(disposedAt) : new Date(),
        createdById: userId,
        createdByType: userType,
      }
    });

    res.status(201).json({ success: true, record });
  } catch (error) {
    console.error('Error creating waste record:', error);
    res.status(500).json({ error: 'Failed to create waste record' });
  }
});

export default router;
