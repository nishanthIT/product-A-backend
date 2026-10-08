import express from 'express';
import { PrismaClient } from '@prisma/client';
import { isAuthenticated, requireShopFeature } from '../middleware/authware.js';
import { SHOP_FEATURES } from '../services/accessControl.js';

const router = express.Router();
const prisma = new PrismaClient();

const VALID_GENDERS = ['MALE', 'FEMALE'];

// Shared auth: verifies the token and reloads employee memberships each request
const authenticateToken = [isAuthenticated, requireShopFeature(SHOP_FEATURES.AGE_RECORDS)];

const getUserShopId = async (userId, userType) => {
  if (userType === 'ADMIN') {
    const admin = await prisma.admin.findUnique({
      where: { id: userId },
      select: { shopId: true },
    });
    return admin?.shopId;
  }

  if (userType === 'CUSTOMER') {
    const customer = await prisma.customer.findUnique({
      where: { id: userId },
      select: { shopId: true },
    });
    return customer?.shopId;
  }

  if (userType === 'EMPLOYEE') {
    const employee = await prisma.empolyee.findUnique({
      where: { id: userId },
      select: { shopId: true },
    });
    return employee?.shopId;
  }

  return null;
};

const resolveUserName = async (userId, userType) => {
  if (userType === 'ADMIN') {
    const admin = await prisma.admin.findUnique({
      where: { id: userId },
      select: { name: true },
    });
    return admin?.name || 'Admin';
  }

  if (userType === 'CUSTOMER') {
    const customer = await prisma.customer.findUnique({
      where: { id: userId },
      select: { name: true },
    });
    return customer?.name || 'Shop Owner';
  }

  if (userType === 'EMPLOYEE') {
    const employee = await prisma.empolyee.findUnique({
      where: { id: userId },
      select: { name: true },
    });
    return employee?.name || 'Employee';
  }

  return 'Unknown';
};

// GET /api/age-restricted-records - list records with filters
router.get('/', authenticateToken, async (req, res) => {
  try {
    const { id: userId, userType } = req.user;
    const shopId = await getUserShopId(userId, userType);

    if (!shopId) {
      return res.status(400).json({ error: 'User not assigned to a shop' });
    }

    const {
      startDate,
      endDate,
      recordedBy,
      productCategory,
      childGender,
      q,
      limit = 500,
    } = req.query;

    const whereClause = { shopId };

    if (startDate || endDate) {
      whereClause.requestedAt = {};
      if (startDate) {
        whereClause.requestedAt.gte = new Date(`${startDate}T00:00:00.000Z`);
      }
      if (endDate) {
        whereClause.requestedAt.lte = new Date(`${endDate}T23:59:59.999Z`);
      }
    }

    if (childGender && VALID_GENDERS.includes(String(childGender).toUpperCase())) {
      whereClause.childGender = String(childGender).toUpperCase();
    }

    if (productCategory && String(productCategory).trim()) {
      whereClause.productCategory = {
        equals: String(productCategory).trim(),
        mode: 'insensitive',
      };
    }

    if (recordedBy && String(recordedBy).trim()) {
      whereClause.recordedBy = {
        equals: String(recordedBy).trim(),
        mode: 'insensitive',
      };
    }

    if (q && String(q).trim()) {
      const term = String(q).trim();
      whereClause.OR = [
        {
          productName: {
            contains: term,
            mode: 'insensitive',
          },
        },
        {
          recordedBy: {
            contains: term,
            mode: 'insensitive',
          },
        },
      ];
    }

    const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 500, 1), 5000);

    const records = await prisma.ageRestrictedRecord.findMany({
      where: whereClause,
      orderBy: { requestedAt: 'desc' },
      take: safeLimit,
    });

    res.json({ success: true, records });
  } catch (error) {
    console.error('Error fetching age restricted records:', error);
    res.status(500).json({ error: 'Failed to fetch age restricted records' });
  }
});

// POST /api/age-restricted-records - create record
router.post('/', authenticateToken, async (req, res) => {
  try {
    const { id: userId, userType } = req.user;
    const shopId = await getUserShopId(userId, userType);

    if (!shopId) {
      return res.status(400).json({ error: 'User not assigned to a shop' });
    }

    const { requestedAt, childGender, productCategory, productName, description } = req.body;

    const normalizedGender = String(childGender || '').toUpperCase();

    if (!VALID_GENDERS.includes(normalizedGender)) {
      return res.status(400).json({ error: 'Child gender must be MALE or FEMALE' });
    }

    if (!productCategory || !String(productCategory).trim()) {
      return res.status(400).json({ error: 'Product category is required' });
    }

    if (!productName || !String(productName).trim()) {
      return res.status(400).json({ error: 'Product name is required' });
    }

    const parsedRequestedAt = requestedAt ? new Date(requestedAt) : new Date();
    if (Number.isNaN(parsedRequestedAt.getTime())) {
      return res.status(400).json({ error: 'Requested date and time is invalid' });
    }

    const recordedBy = await resolveUserName(userId, userType);

    const record = await prisma.ageRestrictedRecord.create({
      data: {
        shopId,
        requestedAt: parsedRequestedAt,
        childGender: normalizedGender,
        productCategory: String(productCategory).trim(),
        productName: String(productName).trim(),
        description: description ? String(description).trim() : null,
        recordedBy,
        createdById: userId,
        createdByType: userType,
      },
    });

    res.status(201).json({ success: true, record });
  } catch (error) {
    console.error('Error creating age restricted record:', error);
    res.status(500).json({ error: 'Failed to create age restricted record' });
  }
});

export default router;
