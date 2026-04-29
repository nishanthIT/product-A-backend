import express from 'express';
import { PrismaClient } from '@prisma/client';
import jwt from 'jsonwebtoken';
import multer from 'multer';
import path from 'path';
import fs from 'fs';

const router = express.Router();
const prisma = new PrismaClient();

const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
const CERTIFICATE_ROOT = path.resolve('certificates');
const CERTIFICATE_TYPES = ['INSPECTION', 'INSURANCE', 'ELECTRIC', 'HYGIENE'];

const typeToFolder = {
  INSPECTION: 'inspection',
  INSURANCE: 'insurance',
  ELECTRIC: 'electric',
  HYGIENE: 'hygiene',
};

const normalizeType = (value) => {
  const type = String(value || '').trim().toUpperCase();
  return CERTIFICATE_TYPES.includes(type) ? type : null;
};

const sanitizeUserFolder = (value) => {
  const base = String(value || 'user').split('@')[0].trim().toLowerCase();
  const cleaned = base.replace(/[^a-z0-9._-]/g, '_');
  return cleaned || 'user';
};

const safeUnlink = (filePath) => {
  try {
    if (filePath && fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch (error) {
    console.error('Error deleting certificate file:', error.message);
  }
};

const parseDate = (value) => {
  if (!value) return null;
  const date = new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date;
};

const parseNumber = (value) => {
  if (value === undefined || value === null || value === '') return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
};

const getRelevantDate = (certificate) => {
  if (certificate.type === 'INSURANCE') return certificate.renewalDate;
  if (certificate.type === 'ELECTRIC') return certificate.contractRenewalDate;
  if (certificate.type === 'HYGIENE') return certificate.expiryDate;
  return certificate.expiryDate;
};

const computeStatus = (certificate) => {
  const relevantDate = getRelevantDate(certificate);
  if (!relevantDate) {
    return { status: 'ACTIVE', expiringSoon: false, expired: false, relevantDate: null };
  }

  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const target = new Date(relevantDate);
  const reminderDays = certificate.reminderDays || 7;
  const warningDate = new Date(target);
  warningDate.setDate(warningDate.getDate() - reminderDays);

  if (target < todayStart) {
    return { status: 'EXPIRED', expiringSoon: false, expired: true, relevantDate: target };
  }

  if (todayStart >= warningDate) {
    return { status: 'EXPIRING_SOON', expiringSoon: true, expired: false, relevantDate: target };
  }

  return { status: 'ACTIVE', expiringSoon: false, expired: false, relevantDate: target };
};

const getRequestBaseUrl = (req) => {
  if (PUBLIC_BASE_URL) return PUBLIC_BASE_URL;

  const forwardedProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  const proto = forwardedProto || req.protocol || 'http';
  const host = req.headers['x-forwarded-host'] || req.get('host');
  if (!host) return '';

  return `${proto}://${host}`.replace(/\/+$/, '');
};

const attachComputedFields = (certificate, req) => {
  const computed = computeStatus(certificate);
  const baseUrl = getRequestBaseUrl(req);
  return {
    ...certificate,
    status: computed.status,
    expiringSoon: computed.expiringSoon,
    expired: computed.expired,
    relevantDate: computed.relevantDate,
    imageUrl: `${baseUrl}/api/certificates/${certificate.id}/image`,
  };
};

const authenticateToken = (req, res, next) => {
  const authHeader = req.headers.authorization;
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

const requireCustomer = (req, res, next) => {
  if (req.user.userType !== 'CUSTOMER') {
    return res.status(403).json({ error: 'Shop owner access required for this action' });
  }
  next();
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

const resolveUserIdentifier = async (userId, userType) => {
  if (userType === 'CUSTOMER') {
    const customer = await prisma.customer.findUnique({
      where: { id: userId },
      select: { email: true, name: true },
    });
    return {
      folder: sanitizeUserFolder(customer?.email || `customer_${userId}`),
      name: customer?.name || 'Shop Owner',
    };
  }

  if (userType === 'EMPLOYEE') {
    const employee = await prisma.empolyee.findUnique({
      where: { id: userId },
      select: { email: true, name: true },
    });
    return {
      folder: sanitizeUserFolder(employee?.email || `employee_${userId}`),
      name: employee?.name || 'Employee',
    };
  }

  return { folder: `user_${userId}`, name: 'Unknown' };
};

const storage = multer.diskStorage({
  destination: async (req, file, cb) => {
    try {
      const type = normalizeType(req.body?.type) || 'INSPECTION';
      const userInfo = await resolveUserIdentifier(req.user.id, req.user.userType);
      const dirPath = path.join(CERTIFICATE_ROOT, userInfo.folder, typeToFolder[type]);
      fs.mkdirSync(dirPath, { recursive: true });
      cb(null, dirPath);
    } catch (error) {
      cb(error);
    }
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase() || '.jpg';
    const uniqueSuffix = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
    cb(null, `certificate-${uniqueSuffix}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!file.mimetype || !file.mimetype.startsWith('image/')) {
      return cb(new Error('Only image files are allowed'));
    }
    cb(null, true);
  },
});

const validateByType = (type, data, isCreate) => {
  const errors = [];

  if (type === 'INSPECTION') {
    if (isCreate && !data.issuedDate) {
      errors.push('Issued date is required for inspection certificate');
    }
  }

  if (type === 'INSURANCE') {
    if (!data.renewalDate) errors.push('Renewal date is required for insurance certificate');
    if (data.premiumAmount === null) errors.push('Premium amount is required for insurance certificate');
    if (!data.companyDetails) errors.push('Company details are required for insurance certificate');
  }

  if (type === 'ELECTRIC') {
    if (data.unitRate === null) errors.push('Unit rate is required for electric bill');
    if (!data.readingDateDay) errors.push('Day reading date is required for electric bill');
    if (!data.readingDateNight) errors.push('Night reading date is required for electric bill');
    if (!data.contractRenewalDate) errors.push('Contract renewal date is required for electric bill');
  }

  if (type === 'HYGIENE') {
    // Issued/expiry dates are optional for hygiene.
  }

  return errors;
};

router.get('/', authenticateToken, async (req, res) => {
  try {
    const { id: userId, userType } = req.user;
    const shopId = await getUserShopId(userId, userType);

    if (!shopId) {
      return res.status(400).json({ error: 'User not assigned to a shop' });
    }

    const type = normalizeType(req.query.type);
    const status = String(req.query.status || '').trim().toUpperCase();
    const sort = String(req.query.sort || 'UPDATED').trim().toUpperCase();

    const whereClause = { shopId };
    if (type) whereClause.type = type;

    const certificates = await prisma.shopCertificate.findMany({
      where: whereClause,
      orderBy: { updatedAt: 'desc' },
      take: 400,
    });

    let items = certificates.map((certificate) => attachComputedFields(certificate, req));

    if (status === 'ACTIVE' || status === 'EXPIRING_SOON' || status === 'EXPIRED') {
      items = items.filter((item) => item.status === status);
    }

    if (sort === 'RELEVANT_DATE') {
      items = items.sort((a, b) => {
        const ad = a.relevantDate ? new Date(a.relevantDate).getTime() : Number.MAX_SAFE_INTEGER;
        const bd = b.relevantDate ? new Date(b.relevantDate).getTime() : Number.MAX_SAFE_INTEGER;
        return ad - bd;
      });
    }

    res.json({ success: true, certificates: items });
  } catch (error) {
    console.error('Error fetching certificates:', error);
    res.status(500).json({ error: 'Failed to fetch certificates' });
  }
});

router.get('/alerts', authenticateToken, async (req, res) => {
  try {
    const { id: userId, userType } = req.user;
    const shopId = await getUserShopId(userId, userType);

    if (!shopId) {
      return res.status(400).json({ error: 'User not assigned to a shop' });
    }

    const certificates = await prisma.shopCertificate.findMany({
      where: { shopId },
      orderBy: { updatedAt: 'desc' },
      take: 400,
    });

    const items = certificates
      .map((certificate) => attachComputedFields(certificate, req))
      .filter((item) => item.status === 'EXPIRING_SOON' || item.status === 'EXPIRED');

    res.json({ success: true, alerts: items, count: items.length });
  } catch (error) {
    console.error('Error fetching certificate alerts:', error);
    res.status(500).json({ error: 'Failed to fetch certificate alerts' });
  }
});

router.get('/:id/image', authenticateToken, async (req, res) => {
  try {
    const { id: userId, userType } = req.user;
    const shopId = await getUserShopId(userId, userType);

    if (!shopId) {
      return res.status(400).json({ error: 'User not assigned to a shop' });
    }

    const certificate = await prisma.shopCertificate.findFirst({
      where: { id: req.params.id, shopId },
      select: { imagePath: true },
    });

    if (!certificate) {
      return res.status(404).json({ error: 'Certificate not found' });
    }

    const absolutePath = path.resolve(certificate.imagePath);
    if (!absolutePath.startsWith(CERTIFICATE_ROOT)) {
      return res.status(403).json({ error: 'Invalid file path' });
    }

    if (!fs.existsSync(absolutePath)) {
      return res.status(404).json({ error: 'Image not found' });
    }

    return res.sendFile(absolutePath);
  } catch (error) {
    console.error('Error serving certificate image:', error);
    res.status(500).json({ error: 'Failed to load image' });
  }
});

router.post('/', authenticateToken, requireCustomer, upload.single('image'), async (req, res) => {
  try {
    const { id: userId, userType } = req.user;
    const shopId = await getUserShopId(userId, userType);

    if (!shopId) {
      if (req.file?.path) safeUnlink(req.file.path);
      return res.status(400).json({ error: 'User not assigned to a shop' });
    }

    const type = normalizeType(req.body.type);
    if (!type) {
      if (req.file?.path) safeUnlink(req.file.path);
      return res.status(400).json({ error: 'Valid certificate type is required' });
    }

    if (!req.file?.path) {
      return res.status(400).json({ error: 'Certificate image is required' });
    }

    const data = {
      issuedDate: parseDate(req.body.issuedDate),
      expiryDate: parseDate(req.body.expiryDate),
      renewalDate: parseDate(req.body.renewalDate),
      premiumAmount: parseNumber(req.body.premiumAmount),
      companyDetails: req.body.companyDetails ? String(req.body.companyDetails).trim() : null,
      unitRate: parseNumber(req.body.unitRate),
      readingDateDay: parseDate(req.body.readingDateDay),
      readingDateNight: parseDate(req.body.readingDateNight),
      contractRenewalDate: parseDate(req.body.contractRenewalDate),
      reminderDays: parseInt(String(req.body.reminderDays || '7'), 10),
    };

    if (!Number.isFinite(data.reminderDays) || data.reminderDays < 1 || data.reminderDays > 60) {
      safeUnlink(req.file.path);
      return res.status(400).json({ error: 'Reminder days must be between 1 and 60' });
    }

    const validationErrors = validateByType(type, data, true);
    if (validationErrors.length > 0) {
      safeUnlink(req.file.path);
      return res.status(400).json({ error: validationErrors.join(', ') });
    }

    const certificate = await prisma.shopCertificate.create({
      data: {
        shopId,
        type,
        imagePath: req.file.path,
        ...data,
        createdById: userId,
        createdByType: userType,
      },
    });

    res.status(201).json({
      success: true,
      message: 'Certificate created successfully',
      certificate: attachComputedFields(certificate, req),
    });
  } catch (error) {
    if (req.file?.path) safeUnlink(req.file.path);
    console.error('Error creating certificate:', error);
    res.status(500).json({ error: 'Failed to create certificate' });
  }
});

router.put('/:id', authenticateToken, requireCustomer, upload.single('image'), async (req, res) => {
  try {
    const { id: userId, userType } = req.user;
    const shopId = await getUserShopId(userId, userType);

    if (!shopId) {
      if (req.file?.path) safeUnlink(req.file.path);
      return res.status(400).json({ error: 'User not assigned to a shop' });
    }

    const existing = await prisma.shopCertificate.findFirst({
      where: { id: req.params.id, shopId },
    });

    if (!existing) {
      if (req.file?.path) safeUnlink(req.file.path);
      return res.status(404).json({ error: 'Certificate not found' });
    }

    const type = normalizeType(req.body.type) || existing.type;
    const data = {
      issuedDate: req.body.issuedDate !== undefined ? parseDate(req.body.issuedDate) : existing.issuedDate,
      expiryDate: req.body.expiryDate !== undefined ? parseDate(req.body.expiryDate) : existing.expiryDate,
      renewalDate: req.body.renewalDate !== undefined ? parseDate(req.body.renewalDate) : existing.renewalDate,
      premiumAmount: req.body.premiumAmount !== undefined ? parseNumber(req.body.premiumAmount) : existing.premiumAmount,
      companyDetails: req.body.companyDetails !== undefined ? (req.body.companyDetails ? String(req.body.companyDetails).trim() : null) : existing.companyDetails,
      unitRate: req.body.unitRate !== undefined ? parseNumber(req.body.unitRate) : existing.unitRate,
      readingDateDay: req.body.readingDateDay !== undefined ? parseDate(req.body.readingDateDay) : existing.readingDateDay,
      readingDateNight: req.body.readingDateNight !== undefined ? parseDate(req.body.readingDateNight) : existing.readingDateNight,
      contractRenewalDate: req.body.contractRenewalDate !== undefined ? parseDate(req.body.contractRenewalDate) : existing.contractRenewalDate,
      reminderDays: req.body.reminderDays !== undefined ? parseInt(String(req.body.reminderDays), 10) : existing.reminderDays,
    };

    if (!Number.isFinite(data.reminderDays) || data.reminderDays < 1 || data.reminderDays > 60) {
      if (req.file?.path) safeUnlink(req.file.path);
      return res.status(400).json({ error: 'Reminder days must be between 1 and 60' });
    }

    const validationErrors = validateByType(type, data, false);
    if (validationErrors.length > 0) {
      if (req.file?.path) safeUnlink(req.file.path);
      return res.status(400).json({ error: validationErrors.join(', ') });
    }

    let imagePath = existing.imagePath;
    if (req.file?.path) {
      imagePath = req.file.path;
    }

    const updated = await prisma.shopCertificate.update({
      where: { id: existing.id },
      data: {
        type,
        imagePath,
        ...data,
        updatedById: userId,
        updatedByType: userType,
      },
    });

    if (req.file?.path && existing.imagePath && existing.imagePath !== req.file.path) {
      safeUnlink(existing.imagePath);
    }

    res.json({
      success: true,
      message: 'Certificate updated successfully',
      certificate: attachComputedFields(updated, req),
    });
  } catch (error) {
    if (req.file?.path) safeUnlink(req.file.path);
    console.error('Error updating certificate:', error);
    res.status(500).json({ error: 'Failed to update certificate' });
  }
});

router.delete('/:id', authenticateToken, requireCustomer, async (req, res) => {
  try {
    const { id: userId, userType } = req.user;
    const shopId = await getUserShopId(userId, userType);

    if (!shopId) {
      return res.status(400).json({ error: 'User not assigned to a shop' });
    }

    const existing = await prisma.shopCertificate.findFirst({
      where: { id: req.params.id, shopId },
    });

    if (!existing) {
      return res.status(404).json({ error: 'Certificate not found' });
    }

    await prisma.shopCertificate.delete({ where: { id: existing.id } });
    safeUnlink(existing.imagePath);

    res.json({ success: true, message: 'Certificate deleted successfully' });
  } catch (error) {
    console.error('Error deleting certificate:', error);
    res.status(500).json({ error: 'Failed to delete certificate' });
  }
});

export default router;
