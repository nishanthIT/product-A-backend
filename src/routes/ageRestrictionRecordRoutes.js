import express from 'express';
import { PrismaClient } from '@prisma/client';
import { isAuthenticated, requireShopFeature } from '../middleware/authware.js';
import { SHOP_FEATURES } from '../services/accessControl.js';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';

const router = express.Router();
const prisma = new PrismaClient();

const UPLOAD_DIR = 'uploads/age-restriction-records';
const MAX_DESCRIPTION = 500;
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');

// Extension is derived from the mimetype so a spoofed filename can't be served as HTML/JS.
const IMAGE_EXTENSIONS = {
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'image/heic': '.heic',
  'image/heif': '.heif',
};

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
    cb(null, UPLOAD_DIR);
  },
  filename: (req, file, cb) => {
    cb(null, `age-${Date.now()}-${crypto.randomBytes(6).toString('hex')}${IMAGE_EXTENSIONS[file.mimetype]}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 15 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => {
    if (IMAGE_EXTENSIONS[file.mimetype]) return cb(null, true);
    cb(new Error('Only JPG, PNG, WEBP, GIF or HEIC images are allowed'));
  },
});

const uploadImage = (req, res, next) => {
  upload.single('image')(req, res, (err) => {
    if (!err) return next();
    const message = err.code === 'LIMIT_FILE_SIZE' ? 'Image must be 15 MB or smaller' : err.message;
    res.status(400).json({ error: message || 'Invalid image upload' });
  });
};

// Shared auth: verifies the token and reloads employee memberships each request
const authenticateToken = [isAuthenticated, requireShopFeature(SHOP_FEATURES.AGE_RECORDS)];

const getUserShopId = async (userId, userType) => {
  if (userType === 'CUSTOMER') {
    const customer = await prisma.customer.findUnique({ where: { id: userId }, select: { shopId: true } });
    return customer?.shopId;
  }
  if (userType === 'EMPLOYEE') {
    const employee = await prisma.empolyee.findUnique({ where: { id: userId }, select: { shopId: true } });
    return employee?.shopId;
  }
  return null;
};

const loadUserNames = async (records) => {
  const customerIds = new Set();
  const employeeIds = new Set();
  for (const record of records) {
    for (const [id, type] of [
      [record.createdById, record.createdByType],
      [record.updatedById, record.updatedByType],
    ]) {
      if (id == null) continue;
      if (type === 'CUSTOMER') customerIds.add(id);
      if (type === 'EMPLOYEE') employeeIds.add(id);
    }
  }
  const [customers, employees] = await Promise.all([
    customerIds.size
      ? prisma.customer.findMany({ where: { id: { in: [...customerIds] } }, select: { id: true, name: true } })
      : [],
    employeeIds.size
      ? prisma.empolyee.findMany({ where: { id: { in: [...employeeIds] } }, select: { id: true, name: true } })
      : [],
  ]);
  const names = new Map();
  customers.forEach((c) => names.set(`CUSTOMER:${c.id}`, c.name || 'Shop Owner'));
  employees.forEach((e) => names.set(`EMPLOYEE:${e.id}`, e.name || 'Employee'));
  return (id, type) => {
    if (id == null || !type) return null;
    return names.get(`${type}:${id}`) || (type === 'CUSTOMER' ? 'Shop Owner' : 'Employee');
  };
};

const baseUrl = (req) => PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`;

const canManage = (record, user) =>
  user.userType === 'CUSTOMER' ||
  (record.createdById === user.id && record.createdByType === user.userType);

const serialize = (req, record, nameOf) => ({
  id: record.id,
  occurredAt: record.occurredAt,
  description: record.description,
  imageUrl: record.imageUrl ? `${baseUrl(req)}${record.imageUrl}` : null,
  createdByName: nameOf(record.createdById, record.createdByType),
  updatedByName: nameOf(record.updatedById, record.updatedByType),
  canManage: canManage(record, req.user),
  createdAt: record.createdAt,
  updatedAt: record.updatedAt,
});

const parseOccurredAt = (value) => {
  if (!value) return null;
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) return null;
  // Allow a small clock skew between device and server.
  if (date.getTime() > Date.now() + 5 * 60 * 1000) return null;
  return date;
};

const parseDescription = (value) => {
  const text = String(value ?? '').trim();
  if (!text) return { error: 'A short description is required' };
  if (text.length > MAX_DESCRIPTION) return { error: `Description must be ${MAX_DESCRIPTION} characters or fewer` };
  return { text };
};

const removeStoredImage = (imageUrl) => {
  if (!imageUrl) return;
  const file = path.join(UPLOAD_DIR, path.basename(imageUrl));
  fs.promises.unlink(file).catch(() => {});
};

const discardUpload = (req) => {
  if (req.file) fs.promises.unlink(req.file.path).catch(() => {});
};

// GET /api/age-restriction-records
router.get('/', authenticateToken, async (req, res) => {
  try {
    const shopId = await getUserShopId(req.user.id, req.user.userType);
    if (!shopId) {
      return res.status(400).json({ error: 'User not assigned to a shop' });
    }

    const { from, to, q, limit } = req.query;
    const where = { shopId };

    const fromDate = from ? new Date(String(from)) : null;
    const toDate = to ? new Date(String(to)) : null;
    if ((fromDate && !Number.isNaN(fromDate.getTime())) || (toDate && !Number.isNaN(toDate.getTime()))) {
      where.occurredAt = {};
      if (fromDate && !Number.isNaN(fromDate.getTime())) where.occurredAt.gte = fromDate;
      if (toDate && !Number.isNaN(toDate.getTime())) where.occurredAt.lte = toDate;
    }

    if (q && String(q).trim()) {
      where.description = { contains: String(q).trim(), mode: 'insensitive' };
    }

    const take = Math.min(Math.max(parseInt(limit, 10) || 200, 1), 1000);
    const records = await prisma.ageRestrictionRecord.findMany({
      where,
      orderBy: { occurredAt: 'desc' },
      take,
    });

    const nameOf = await loadUserNames(records);
    res.json({ success: true, records: records.map((record) => serialize(req, record, nameOf)) });
  } catch (error) {
    console.error('Error fetching age restriction records:', error);
    res.status(500).json({ error: 'Failed to fetch age restriction records' });
  }
});

// POST /api/age-restriction-records
router.post('/', authenticateToken, uploadImage, async (req, res) => {
  try {
    const { id: userId, userType } = req.user;
    const shopId = await getUserShopId(userId, userType);
    if (!shopId) {
      discardUpload(req);
      return res.status(400).json({ error: 'User not assigned to a shop' });
    }

    const occurredAt = parseOccurredAt(req.body.occurredAt);
    if (!occurredAt) {
      discardUpload(req);
      return res.status(400).json({ error: 'A valid date and time (not in the future) is required' });
    }

    const description = parseDescription(req.body.description);
    if (description.error) {
      discardUpload(req);
      return res.status(400).json({ error: description.error });
    }

    const record = await prisma.ageRestrictionRecord.create({
      data: {
        shopId,
        occurredAt,
        description: description.text,
        imageUrl: req.file ? `/${UPLOAD_DIR}/${req.file.filename}` : null,
        createdById: userId,
        createdByType: userType,
      },
    });

    const nameOf = await loadUserNames([record]);
    res.status(201).json({ success: true, record: serialize(req, record, nameOf) });
  } catch (error) {
    discardUpload(req);
    console.error('Error creating age restriction record:', error);
    res.status(500).json({ error: 'Failed to create age restriction record' });
  }
});

// PUT /api/age-restriction-records/:id
router.put('/:id', authenticateToken, uploadImage, async (req, res) => {
  try {
    const { id: userId, userType } = req.user;
    const shopId = await getUserShopId(userId, userType);
    if (!shopId) {
      discardUpload(req);
      return res.status(400).json({ error: 'User not assigned to a shop' });
    }

    const existing = await prisma.ageRestrictionRecord.findFirst({ where: { id: req.params.id, shopId } });
    if (!existing) {
      discardUpload(req);
      return res.status(404).json({ error: 'Record not found' });
    }
    if (!canManage(existing, req.user)) {
      discardUpload(req);
      return res.status(403).json({ error: 'Only the shop owner or the person who recorded this can edit it' });
    }

    const data = { updatedById: userId, updatedByType: userType };

    if (req.body.occurredAt !== undefined) {
      const occurredAt = parseOccurredAt(req.body.occurredAt);
      if (!occurredAt) {
        discardUpload(req);
        return res.status(400).json({ error: 'A valid date and time (not in the future) is required' });
      }
      data.occurredAt = occurredAt;
    }

    if (req.body.description !== undefined) {
      const description = parseDescription(req.body.description);
      if (description.error) {
        discardUpload(req);
        return res.status(400).json({ error: description.error });
      }
      data.description = description.text;
    }

    if (req.file) {
      data.imageUrl = `/${UPLOAD_DIR}/${req.file.filename}`;
    } else if (req.body.removeImage === 'true') {
      data.imageUrl = null;
    }

    const record = await prisma.ageRestrictionRecord.update({ where: { id: existing.id }, data });
    if (data.imageUrl !== undefined && existing.imageUrl !== record.imageUrl) {
      removeStoredImage(existing.imageUrl);
    }

    const nameOf = await loadUserNames([record]);
    res.json({ success: true, record: serialize(req, record, nameOf) });
  } catch (error) {
    discardUpload(req);
    console.error('Error updating age restriction record:', error);
    res.status(500).json({ error: 'Failed to update age restriction record' });
  }
});

// DELETE /api/age-restriction-records/:id
router.delete('/:id', authenticateToken, async (req, res) => {
  try {
    const shopId = await getUserShopId(req.user.id, req.user.userType);
    if (!shopId) {
      return res.status(400).json({ error: 'User not assigned to a shop' });
    }

    const existing = await prisma.ageRestrictionRecord.findFirst({ where: { id: req.params.id, shopId } });
    if (!existing) {
      return res.status(404).json({ error: 'Record not found' });
    }
    if (!canManage(existing, req.user)) {
      return res.status(403).json({ error: 'Only the shop owner or the person who recorded this can delete it' });
    }

    await prisma.ageRestrictionRecord.delete({ where: { id: existing.id } });
    removeStoredImage(existing.imageUrl);

    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting age restriction record:', error);
    res.status(500).json({ error: 'Failed to delete age restriction record' });
  }
});

export default router;
