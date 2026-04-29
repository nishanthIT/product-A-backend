import express from 'express';
import { PrismaClient } from '@prisma/client';
import jwt from 'jsonwebtoken';
import multer from 'multer';
import path from 'path';
import fs from 'fs';

const router = express.Router();
const prisma = new PrismaClient();

const VALID_SEVERITIES = ['LOW', 'MEDIUM', 'HIGH'];
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || 'https://backend.h7tex.com').replace(/\/+$/, '');

const normalizeAssetUrl = (url) => {
  if (!url) return null;

  let normalized = String(url).trim();
  if (!normalized) return null;

  if (normalized.startsWith('/')) {
    return `${PUBLIC_BASE_URL}${normalized}`;
  }

  normalized = normalized.replace(/^http:\/\/localhost:\d+/i, PUBLIC_BASE_URL);
  normalized = normalized.replace(/^http:\/\/backend\.h7tex\.com/i, PUBLIC_BASE_URL);
  normalized = normalized.replace(/^http:\/\//i, 'https://');

  return normalized;
};

const requireCustomer = (req, res, next) => {
  if (req.user.userType !== 'CUSTOMER') {
    return res.status(403).json({ error: 'Shop owner access required for this action' });
  }
  next();
};

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadPath = 'uploads/incidents';
    if (!fs.existsSync(uploadPath)) {
      fs.mkdirSync(uploadPath, { recursive: true });
    }
    cb(null, uploadPath);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(null, 'incident-' + uniqueSuffix + path.extname(file.originalname));
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) {
      return cb(null, true);
    }
    cb(new Error('Only image files are allowed'));
  },
});

// Middleware to verify JWT token
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Access token required' });
  }

  jwt.verify(token, process.env.JWT_SECRET || 'your-secret-key', (err, user) => {
    if (err) {
      return res.status(403).json({ error: 'Invalid token' });
    }
    req.user = user;
    next();
  });
};

const getUserShopId = async (userId, userType) => {
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

const toDate = (date, time) => {
  if (!date || !time) return null;
  const candidate = new Date(`${date}T${time}:00`);
  return Number.isNaN(candidate.getTime()) ? null : candidate;
};

// GET /api/incidents - list logs with optional filters
router.get('/', authenticateToken, async (req, res) => {
  try {
    const { id: userId, userType } = req.user;
    const shopId = await getUserShopId(userId, userType);

    if (!shopId) {
      return res.status(400).json({ error: 'User not assigned to a shop' });
    }

    const { startDate, endDate, severity, q, limit } = req.query;

    const whereClause = { shopId };

    if (severity && VALID_SEVERITIES.includes(String(severity).toUpperCase())) {
      whereClause.severity = String(severity).toUpperCase();
    }

    if (startDate || endDate) {
      whereClause.incidentAt = {};
      if (startDate) {
        whereClause.incidentAt.gte = new Date(`${startDate}T00:00:00.000Z`);
      }
      if (endDate) {
        whereClause.incidentAt.lte = new Date(`${endDate}T23:59:59.999Z`);
      }
    }

    if (q && String(q).trim()) {
      whereClause.description = {
        contains: String(q).trim(),
        mode: 'insensitive',
      };
    }

    const logs = await prisma.incidentLog.findMany({
      where: whereClause,
      orderBy: { incidentAt: 'desc' },
      take: limit ? parseInt(limit, 10) : 200,
    });

    const logsWithUsers = await Promise.all(
      logs.map(async (log) => {
        const createdByName = await resolveUserName(log.createdById, log.createdByType);
        const updatedByName = log.updatedById && log.updatedByType
          ? await resolveUserName(log.updatedById, log.updatedByType)
          : null;

        return {
          ...log,
          imageUrl: normalizeAssetUrl(log.imageUrl),
          createdByName,
          updatedByName,
        };
      })
    );

    res.json({ success: true, logs: logsWithUsers });
  } catch (error) {
    console.error('Error fetching incident logs:', error);
    res.status(500).json({ error: 'Failed to fetch incident logs' });
  }
});

// POST /api/incidents - create new incident log
router.post('/', authenticateToken, upload.single('image'), async (req, res) => {
  try {
    const { id: userId, userType } = req.user;
    const shopId = await getUserShopId(userId, userType);

    if (!shopId) {
      return res.status(400).json({ error: 'User not assigned to a shop' });
    }

    const { date, time, description, severity } = req.body;

    if (!description || !String(description).trim()) {
      return res.status(400).json({ error: 'Description is required' });
    }

    const incidentAt = toDate(date, time);
    if (!incidentAt) {
      return res.status(400).json({ error: 'Valid date and time are required' });
    }

    const normalizedSeverity = VALID_SEVERITIES.includes(String(severity).toUpperCase())
      ? String(severity).toUpperCase()
      : 'MEDIUM';

    const createData = {
      shopId,
      incidentAt,
      description: String(description).trim(),
      severity: normalizedSeverity,
      createdById: userId,
      createdByType: userType,
    };

    if (req.file) {
      createData.imageUrl = normalizeAssetUrl(`/uploads/incidents/${req.file.filename}`);
    }

    const log = await prisma.incidentLog.create({
      data: createData,
    });

    const createdByName = await resolveUserName(log.createdById, log.createdByType);

    res.status(201).json({
      success: true,
      message: 'Incident log created successfully',
      log: {
        ...log,
        imageUrl: normalizeAssetUrl(log.imageUrl),
        createdByName,
        updatedByName: null,
      },
    });
  } catch (error) {
    console.error('Error creating incident log:', error);
    res.status(500).json({ error: 'Failed to create incident log' });
  }
});

// PUT /api/incidents/:id - update incident log
router.put('/:id', authenticateToken, requireCustomer, upload.single('image'), async (req, res) => {
  try {
    const { id: userId, userType } = req.user;
    const shopId = await getUserShopId(userId, userType);

    if (!shopId) {
      return res.status(400).json({ error: 'User not assigned to a shop' });
    }

    const logId = req.params.id;
    const { date, time, description, severity } = req.body;

    const existing = await prisma.incidentLog.findFirst({
      where: { id: logId, shopId },
    });

    if (!existing) {
      return res.status(404).json({ error: 'Incident log not found' });
    }

    const updateData = {
      updatedById: userId,
      updatedByType: userType,
    };

    if (description !== undefined) {
      const value = String(description).trim();
      if (!value) {
        return res.status(400).json({ error: 'Description cannot be empty' });
      }
      updateData.description = value;
    }

    if (date !== undefined || time !== undefined) {
      const currentDate = new Date(existing.incidentAt).toISOString().slice(0, 10);
      const currentTime = new Date(existing.incidentAt).toTimeString().slice(0, 5);
      const dateValue = date !== undefined ? date : currentDate;
      const timeValue = time !== undefined ? time : currentTime;

      const incidentAt = toDate(dateValue, timeValue);
      if (!incidentAt) {
        return res.status(400).json({ error: 'Valid date and time are required' });
      }
      updateData.incidentAt = incidentAt;
    }

    if (severity !== undefined) {
      if (!VALID_SEVERITIES.includes(String(severity).toUpperCase())) {
        return res.status(400).json({ error: 'Severity must be LOW, MEDIUM, or HIGH' });
      }
      updateData.severity = String(severity).toUpperCase();
    }

    if (req.file) {
      updateData.imageUrl = normalizeAssetUrl(`/uploads/incidents/${req.file.filename}`);
    }

    const log = await prisma.incidentLog.update({
      where: { id: logId },
      data: updateData,
    });

    const createdByName = await resolveUserName(log.createdById, log.createdByType);
    const updatedByName = await resolveUserName(log.updatedById, log.updatedByType);

    res.json({
      success: true,
      message: 'Incident log updated successfully',
      log: {
        ...log,
        imageUrl: normalizeAssetUrl(log.imageUrl),
        createdByName,
        updatedByName,
      },
    });
  } catch (error) {
    console.error('Error updating incident log:', error);
    res.status(500).json({ error: 'Failed to update incident log' });
  }
});

// DELETE /api/incidents/:id - delete incident log
router.delete('/:id', authenticateToken, requireCustomer, async (req, res) => {
  try {
    const { id: userId, userType } = req.user;
    const shopId = await getUserShopId(userId, userType);

    if (!shopId) {
      return res.status(400).json({ error: 'User not assigned to a shop' });
    }

    const logId = req.params.id;

    const existing = await prisma.incidentLog.findFirst({
      where: { id: logId, shopId },
    });

    if (!existing) {
      return res.status(404).json({ error: 'Incident log not found' });
    }

    await prisma.incidentLog.delete({ where: { id: logId } });

    res.json({ success: true, message: 'Incident log deleted successfully' });
  } catch (error) {
    console.error('Error deleting incident log:', error);
    res.status(500).json({ error: 'Failed to delete incident log' });
  }
});

export default router;
