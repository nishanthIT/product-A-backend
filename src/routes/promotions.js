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
    const uploadPath = 'uploads/promotions';
    if (!fs.existsSync(uploadPath)) {
      fs.mkdirSync(uploadPath, { recursive: true });
    }
    cb(null, uploadPath);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, 'promotion-' + uniqueSuffix + path.extname(file.originalname));
  }
});

const upload = multer({
  storage,
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB limit
  },
  fileFilter: (req, file, cb) => {
    const allowedTypes = /jpeg|jpg|png|gif/;
    const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
    const mimetype = allowedTypes.test(file.mimetype);

    if (mimetype && extname) {
      return cb(null, true);
    } else {
      cb(new Error('Only image files are allowed'));
    }
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

// GET /api/promotions - Get all promotions
router.get('/', async (req, res) => {
  try {
    const { active, shopId } = req.query;
    
    const whereCondition = {};
    if (active !== undefined) {
      whereCondition.isActive = active === 'true';
    }
    if (shopId) {
      whereCondition.shopId = shopId;
    }

    const promotions = await prisma.promotion.findMany({
      where: whereCondition,
      include: {
        shop: {
          select: {
            id: true,
            name: true,
            address: true,
            mobile: true
          }
        },
        products: {
          select: {
            id: true,
            title: true,
            barcode: true,
            img: true,
            rrp: true
          }
        }
      },
      orderBy: { createdAt: 'desc' }
    });

    // Enrich products with shop-specific prices
    const enrichedPromotions = await Promise.all(
      promotions.map(async (promotion) => {
        const enrichedProducts = await Promise.all(
          promotion.products.map(async (product) => {
            // Get the shop-specific price for this product
            const productAtShop = await prisma.productAtShop.findFirst({
              where: {
                productId: product.id,
                shopId: promotion.shopId
              },
              select: {
                price: true,
                offerPrice: true
              }
            });

            return {
              ...product,
              price: productAtShop?.price || null,
              offerPrice: productAtShop?.offerPrice || null
            };
          })
        );

        return {
          ...promotion,
          products: enrichedProducts
        };
      })
    );

    res.json({ promotions: enrichedPromotions });
  } catch (error) {
    console.error('Error fetching promotions:', error);
    res.status(500).json({ error: 'Failed to fetch promotions' });
  }
});

// GET /api/promotions/:id - Get single promotion
router.get('/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;

    const promotion = await prisma.promotion.findUnique({
      where: { id },
      include: {
        shop: {
          select: {
            id: true,
            name: true,
            address: true,
            mobile: true
          }
        },
        products: {
          select: {
            id: true,
            title: true,
            barcode: true,
            img: true,
            rrp: true
          }
        }
      }
    });

    if (!promotion) {
      return res.status(404).json({ error: 'Promotion not found' });
    }

    res.json({ promotion });
  } catch (error) {
    console.error('Error fetching promotion:', error);
    res.status(500).json({ error: 'Failed to fetch promotion' });
  }
});

// POST /api/promotions - Create new promotion
router.post('/', authenticateToken, requireAdmin, upload.single('image'), async (req, res) => {
  try {
    const { title, description, shopId, productIds } = req.body;

    if (!title || !shopId || !req.file) {
      return res.status(400).json({ error: 'Title, shop, and image are required' });
    }

    let parsedProductIds = [];
    try {
      parsedProductIds = JSON.parse(productIds || '[]');
    } catch (error) {
      return res.status(400).json({ error: 'Invalid product IDs format' });
    }

    if (parsedProductIds.length === 0) {
      return res.status(400).json({ error: 'At least one product must be selected' });
    }

    // Verify shop exists
    const shop = await prisma.shop.findUnique({
      where: { id: shopId }
    });

    if (!shop) {
      return res.status(404).json({ error: 'Shop not found' });
    }

    // Verify products exist
    const products = await prisma.product.findMany({
      where: {
        id: { in: parsedProductIds }
      }
    });

    if (products.length !== parsedProductIds.length) {
      return res.status(404).json({ error: 'One or more products not found' });
    }

    // Create promotion
    const imageUrl = `${req.protocol}://${req.get('host')}/uploads/promotions/${req.file.filename}`;

    const promotion = await prisma.promotion.create({
      data: {
        title,
        description,
        imageUrl,
        shopId,
        isActive: true,
        products: {
          connect: parsedProductIds.map(id => ({ id }))
        }
      },
      include: {
        shop: {
          select: {
            id: true,
            name: true,
            address: true,
            mobile: true
          }
        },
        products: {
          select: {
            id: true,
            title: true,
            barcode: true,
            img: true,
            rrp: true
          }
        }
      }
    });

    res.status(201).json({ promotion });
  } catch (error) {
    console.error('Error creating promotion:', error);
    res.status(500).json({ error: 'Failed to create promotion' });
  }
});

// PUT /api/promotions/:id/toggle - Toggle promotion active status
router.put('/:id/toggle', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { isActive } = req.body;

    const promotion = await prisma.promotion.update({
      where: { id },
      data: { isActive },
      include: {
        shop: {
          select: {
            id: true,
            name: true,
            address: true,
            mobile: true
          }
        },
        products: {
          select: {
            id: true,
            title: true,
            barcode: true,
            img: true,
            rrp: true
          }
        }
      }
    });

    res.json({ promotion });
  } catch (error) {
    console.error('Error toggling promotion:', error);
    res.status(500).json({ error: 'Failed to update promotion' });
  }
});

// PUT /api/promotions/:id - Update promotion
router.put('/:id', authenticateToken, requireAdmin, upload.single('image'), async (req, res) => {
  try {
    const { id } = req.params;
    const { title, description, shopId, productIds } = req.body;

    const updateData = {
      title,
      description,
      shopId
    };

    // If new image uploaded, update imageUrl
    if (req.file) {
      updateData.imageUrl = `${req.protocol}://${req.get('host')}/uploads/promotions/${req.file.filename}`;
    }

    // Handle product updates
    if (productIds) {
      let parsedProductIds = [];
      try {
        parsedProductIds = JSON.parse(productIds);
      } catch (error) {
        return res.status(400).json({ error: 'Invalid product IDs format' });
      }

      // Disconnect all products and reconnect new ones
      updateData.products = {
        set: parsedProductIds.map(productId => ({ id: productId }))
      };
    }

    const promotion = await prisma.promotion.update({
      where: { id },
      data: updateData,
      include: {
        shop: {
          select: {
            id: true,
            name: true,
            address: true,
            mobile: true
          }
        },
        products: {
          select: {
            id: true,
            title: true,
            barcode: true,
            img: true,
            rrp: true
          }
        }
      }
    });

    res.json({ promotion });
  } catch (error) {
    console.error('Error updating promotion:', error);
    res.status(500).json({ error: 'Failed to update promotion' });
  }
});

// DELETE /api/promotions/:id - Delete promotion
router.delete('/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;

    // Get promotion to delete image file
    const promotion = await prisma.promotion.findUnique({
      where: { id }
    });

    if (!promotion) {
      return res.status(404).json({ error: 'Promotion not found' });
    }

    // Delete promotion
    await prisma.promotion.delete({
      where: { id }
    });

    // Delete image file
    if (promotion.imageUrl) {
      const filename = promotion.imageUrl.split('/').pop();
      const filePath = `uploads/promotions/${filename}`;
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    }

    res.json({ message: 'Promotion deleted successfully' });
  } catch (error) {
    console.error('Error deleting promotion:', error);
    res.status(500).json({ error: 'Failed to delete promotion' });
  }
});

export default router;