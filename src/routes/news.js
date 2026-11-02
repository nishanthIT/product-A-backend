import { safeLogger } from '../services/safeLogger.js';
const securityLog = safeLogger('routes/news.js');
import express from 'express';
import { PrismaClient } from '@prisma/client';
import { isAuthenticated } from '../middleware/authware.js';
import multer from '../middleware/secureUpload.js';
import path from 'path';
import fs from 'fs';

const router = express.Router();
const prisma = new PrismaClient();

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

const normalizeNews = (item) => ({
  ...item,
  imageUrl: normalizeAssetUrl(item.imageUrl),
});

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

// Shared auth: verifies the token and reloads employee memberships each request
const authenticateToken = isAuthenticated;

// Check admin permission
const requireAdmin = (req, res, next) => {
  if (req.user.userType !== 'ADMIN') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
};

const publicListingAccess = (req, res, next) => req.query.all === 'true'
  ? isAuthenticated(req, res, () => requireAdmin(req, res, next)) : next();

// GET /api/news - Get all active news (public)
router.get('/', publicListingAccess, async (req, res) => {
  try {
    const { all, limit, page = 1 } = req.query;
    
    const whereCondition = all === 'true' ? {} : { isActive: true };

    const news = await prisma.news.findMany({
      where: whereCondition,
      orderBy: [{ publishedAt: 'desc' }, { id: 'asc' }],
      take: Math.min(Number(limit) || 100, 100) + 1,
      skip: (Number(page) - 1) * Math.min(Number(limit) || 100, 100)
    });

    const pageSize = Math.min(Number(limit) || 100, 100);
    res.json({ news: news.slice(0, pageSize).map(normalizeNews), page: Number(page), hasMore: news.length > pageSize });
  } catch (error) {
    securityLog.error('Error fetching news:', error);
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

    if (!news.isActive) {
      if (!req.headers.authorization && !req.cookies?.auth_token) return res.status(404).json({ error: 'News not found' });
      return isAuthenticated(req, res, () => requireAdmin(req, res, () => res.json({ news: normalizeNews(news) })));
    }
    res.json({ news: normalizeNews(news) });
  } catch (error) {
    securityLog.error('Error fetching news:', error);
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
      imageUrl = normalizeAssetUrl(`/uploads/news/${req.file.filename}`);
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

    res.status(201).json({ news: normalizeNews(news) });
  } catch (error) {
    securityLog.error('Error creating news:', error);
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
      updateData.imageUrl = normalizeAssetUrl(`/uploads/news/${req.file.filename}`);
    }

    const news = await prisma.news.update({
      where: { id },
      data: updateData
    });

    res.json({ news: normalizeNews(news) });
  } catch (error) {
    securityLog.error('Error updating news:', error);
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
    securityLog.error('Error deleting news:', error);
    res.status(500).json({ error: 'Failed to delete news' });
  }
});

export default router;
