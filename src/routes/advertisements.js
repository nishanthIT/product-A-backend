import express from 'express';
import { PrismaClient } from '@prisma/client';
import jwt from 'jsonwebtoken';
import multer from 'multer';
import path from 'path';
import fs from 'fs';

const router = express.Router();
const prisma = new PrismaClient();

// Configure multer for image uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadPath = 'uploads/advertisements';
    if (!fs.existsSync(uploadPath)) {
      fs.mkdirSync(uploadPath, { recursive: true });
    }
    cb(null, uploadPath);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, 'ad-' + uniqueSuffix + path.extname(file.originalname));
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const isImage = file.mimetype.startsWith('image/');
    if (isImage) {
      return cb(null, true);
    }
    cb(new Error('Only image files are allowed'));
  }
});

// Middleware to verify JWT token
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Access token required' });
  }

  jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
    if (err) {
      return res.status(403).json({ error: 'Invalid token' });
    }
    req.user = user;
    next();
  });
};

// Check admin permission
const requireAdmin = (req, res, next) => {
  if (req.user.userType !== 'ADMIN') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
};

// GET /api/advertisements - Get all active advertisements (public)
router.get('/', async (req, res) => {
  try {
    const { all } = req.query;
    
    const whereCondition = all === 'true' ? {} : { isActive: true };

    const advertisements = await prisma.advertisement.findMany({
      where: whereCondition,
      orderBy: { sortOrder: 'asc' }
    });

    res.json({ advertisements });
  } catch (error) {
    console.error('Error fetching advertisements:', error);
    res.status(500).json({ error: 'Failed to fetch advertisements' });
  }
});

// POST /api/advertisements - Create new advertisement (admin only)
router.post('/', authenticateToken, requireAdmin, upload.single('image'), async (req, res) => {
  try {
    const { title, linkUrl, sortOrder } = req.body;

    if (!title || !req.file) {
      return res.status(400).json({ error: 'Title and image are required' });
    }

    const baseUrl = `${req.protocol}://${req.get('host')}`;
    const imageUrl = `${baseUrl}/uploads/advertisements/${req.file.filename}`;

    const advertisement = await prisma.advertisement.create({
      data: {
        title,
        imageUrl,
        linkUrl: linkUrl || null,
        sortOrder: parseInt(sortOrder) || 0,
        isActive: true
      }
    });

    res.status(201).json({ advertisement });
  } catch (error) {
    console.error('Error creating advertisement:', error);
    res.status(500).json({ error: 'Failed to create advertisement' });
  }
});

// PUT /api/advertisements/:id - Update advertisement (admin only)
router.put('/:id', authenticateToken, requireAdmin, upload.single('image'), async (req, res) => {
  try {
    const { id } = req.params;
    const { title, linkUrl, sortOrder, isActive } = req.body;

    const updateData = {};
    if (title) updateData.title = title;
    if (linkUrl !== undefined) updateData.linkUrl = linkUrl || null;
    if (sortOrder !== undefined) updateData.sortOrder = parseInt(sortOrder);
    if (isActive !== undefined) updateData.isActive = isActive === 'true' || isActive === true;

    if (req.file) {
      const baseUrl = `${req.protocol}://${req.get('host')}`;
      updateData.imageUrl = `${baseUrl}/uploads/advertisements/${req.file.filename}`;
    }

    const advertisement = await prisma.advertisement.update({
      where: { id },
      data: updateData
    });

    res.json({ advertisement });
  } catch (error) {
    console.error('Error updating advertisement:', error);
    res.status(500).json({ error: 'Failed to update advertisement' });
  }
});

// DELETE /api/advertisements/:id - Delete advertisement (admin only)
router.delete('/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;

    await prisma.advertisement.delete({
      where: { id }
    });

    res.json({ message: 'Advertisement deleted successfully' });
  } catch (error) {
    console.error('Error deleting advertisement:', error);
    res.status(500).json({ error: 'Failed to delete advertisement' });
  }
});

export default router;
