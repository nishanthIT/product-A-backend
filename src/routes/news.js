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
    const uploadPath = 'uploads/news';
    if (!fs.existsSync(uploadPath)) {
      fs.mkdirSync(uploadPath, { recursive: true });
    }
    cb(null, uploadPath);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, 'news-' + uniqueSuffix + path.extname(file.originalname));
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

// GET /api/news - Get all active news (public)
router.get('/', async (req, res) => {
  try {
    const { all, limit } = req.query;
    
    const whereCondition = all === 'true' ? {} : { isActive: true };

    const news = await prisma.news.findMany({
      where: whereCondition,
      orderBy: { publishedAt: 'desc' },
      take: limit ? parseInt(limit) : undefined
    });

    res.json({ news });
  } catch (error) {
    console.error('Error fetching news:', error);
    res.status(500).json({ error: 'Failed to fetch news' });
  }
});

// GET /api/news/:id - Get single news item
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const news = await prisma.news.findUnique({
      where: { id }
    });

    if (!news) {
      return res.status(404).json({ error: 'News not found' });
    }

    res.json({ news });
  } catch (error) {
    console.error('Error fetching news:', error);
    res.status(500).json({ error: 'Failed to fetch news' });
  }
});

// POST /api/news - Create new news item (admin only)
router.post('/', authenticateToken, requireAdmin, upload.single('image'), async (req, res) => {
  try {
    const { title, description, sourceUrl, publishedAt } = req.body;

    if (!title || !description) {
      return res.status(400).json({ error: 'Title and description are required' });
    }

    let imageUrl = null;
    if (req.file) {
      const baseUrl = `${req.protocol}://${req.get('host')}`;
      imageUrl = `${baseUrl}/uploads/news/${req.file.filename}`;
    }

    const news = await prisma.news.create({
      data: {
        title,
        description,
        imageUrl,
        sourceUrl: sourceUrl || null,
        isActive: true,
        publishedAt: publishedAt ? new Date(publishedAt) : new Date()
      }
    });

    res.status(201).json({ news });
  } catch (error) {
    console.error('Error creating news:', error);
    res.status(500).json({ error: 'Failed to create news' });
  }
});

// PUT /api/news/:id - Update news item (admin only)
router.put('/:id', authenticateToken, requireAdmin, upload.single('image'), async (req, res) => {
  try {
    const { id } = req.params;
    const { title, description, sourceUrl, isActive, publishedAt } = req.body;

    const updateData = {};
    if (title) updateData.title = title;
    if (description) updateData.description = description;
    if (sourceUrl !== undefined) updateData.sourceUrl = sourceUrl || null;
    if (isActive !== undefined) updateData.isActive = isActive === 'true' || isActive === true;
    if (publishedAt) updateData.publishedAt = new Date(publishedAt);

    if (req.file) {
      const baseUrl = `${req.protocol}://${req.get('host')}`;
      updateData.imageUrl = `${baseUrl}/uploads/news/${req.file.filename}`;
    }

    const news = await prisma.news.update({
      where: { id },
      data: updateData
    });

    res.json({ news });
  } catch (error) {
    console.error('Error updating news:', error);
    res.status(500).json({ error: 'Failed to update news' });
  }
});

// DELETE /api/news/:id - Delete news item (admin only)
router.delete('/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;

    await prisma.news.delete({
      where: { id }
    });

    res.json({ message: 'News deleted successfully' });
  } catch (error) {
    console.error('Error deleting news:', error);
    res.status(500).json({ error: 'Failed to delete news' });
  }
});

export default router;
