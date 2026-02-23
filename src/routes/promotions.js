import express from 'express';
import { PrismaClient } from '@prisma/client';
import jwt from 'jsonwebtoken';
import multer from 'multer';
import path from 'path';
import fs from 'fs';

const router = express.Router();
const prisma = new PrismaClient();

// Configure multer for image and PDF uploads
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
    const prefix = file.fieldname === 'pdf' ? 'promotion-pdf-' : 'promotion-';
    cb(null, prefix + uniqueSuffix + path.extname(file.originalname));
  }
});

const upload = multer({
  storage,
  limits: {
    fileSize: 20 * 1024 * 1024, // 20MB limit for PDFs
  },
  fileFilter: (req, file, cb) => {
    // Allow images and PDFs
    const imageTypes = /jpeg|jpg|png|gif/;
    const pdfType = /pdf/;
    const extname = path.extname(file.originalname).toLowerCase();
    
    if (file.fieldname === 'pdf') {
      // PDF field - only allow PDFs
      if (pdfType.test(extname) || file.mimetype === 'application/pdf') {
        return cb(null, true);
      } else {
        cb(new Error('Only PDF files are allowed for this field'));
      }
    } else {
      // Image fields - only allow images
      const isImageExt = imageTypes.test(extname.replace('.', ''));
      const isImageMime = file.mimetype.startsWith('image/');
      if (isImageExt || isImageMime) {
        return cb(null, true);
      } else {
        cb(new Error('Only image files are allowed'));
      }
    }
  }
});

// Multi-file upload configuration
const uploadFields = upload.fields([
  { name: 'image', maxCount: 1 },      // Single primary image (legacy support)
  { name: 'images', maxCount: 10 },    // Multiple images for carousel
  { name: 'pdf', maxCount: 1 }         // Single PDF document
]);

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

    // Debug: Log first promotion to verify fields
    if (enrichedPromotions.length > 0) {
      console.log('First promotion fields:', {
        id: enrichedPromotions[0].id,
        title: enrichedPromotions[0].title,
        imageUrl: enrichedPromotions[0].imageUrl,
        imageUrls: enrichedPromotions[0].imageUrls,
        pdfUrl: enrichedPromotions[0].pdfUrl
      });
    }

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

// Helper middleware to handle multer errors
const handleUpload = (req, res, next) => {
  uploadFields(req, res, (err) => {
    if (err) {
      console.error('Multer error:', err);
      return res.status(400).json({ error: err.message || 'File upload error' });
    }
    next();
  });
};

// POST /api/promotions - Create new promotion
router.post('/', authenticateToken, requireAdmin, handleUpload, async (req, res) => {
  try {
    console.log('Creating promotion - Body:', req.body);
    console.log('Creating promotion - Files:', req.files);
    
    const { title, description, shopId, productIds, productPrices } = req.body;
    const files = req.files;

    // Check for at least one image (either single 'image' or multiple 'images')
    const hasImage = files?.image?.length > 0 || files?.images?.length > 0;
    
    if (!title || !shopId || !hasImage) {
      return res.status(400).json({ error: 'Title, shop, and at least one image are required' });
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

    // Parse product prices
    let parsedPrices = [];
    try {
      parsedPrices = JSON.parse(productPrices || '[]');
    } catch (error) {
      console.error('Invalid product prices format:', error);
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

    // Update offer prices in ProductAtShop for each product
    for (const priceData of parsedPrices) {
      if (priceData.productId && priceData.offerPrice) {
        try {
          await prisma.productAtShop.updateMany({
            where: {
              productId: priceData.productId,
              shopId: shopId
            },
            data: {
              offerPrice: parseFloat(priceData.offerPrice)
            }
          });
          console.log(`Updated offer price for product ${priceData.productId}: £${priceData.offerPrice}`);
        } catch (priceError) {
          console.error(`Error updating offer price for product ${priceData.productId}:`, priceError);
        }
      }
    }

    // Build URLs for uploaded files
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    
    // Primary image URL (from 'image' field or first of 'images')
    let imageUrl;
    let imageUrls = [];
    
    if (files?.image?.length > 0) {
      imageUrl = `${baseUrl}/uploads/promotions/${files.image[0].filename}`;
    }
    
    if (files?.images?.length > 0) {
      imageUrls = files.images.map(f => `${baseUrl}/uploads/promotions/${f.filename}`);
      // If no single image provided, use first of multiple as primary
      if (!imageUrl) {
        imageUrl = imageUrls[0];
      }
    }
    
    // PDF URL if provided
    let pdfUrl = null;
    if (files?.pdf?.length > 0) {
      pdfUrl = `${baseUrl}/uploads/promotions/${files.pdf[0].filename}`;
    }

    // Create promotion
    const promotion = await prisma.promotion.create({
      data: {
        title,
        description,
        imageUrl,
        imageUrls,
        pdfUrl,
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
    console.error('Error details:', error.message);
    console.error('Error stack:', error.stack);
    res.status(500).json({ 
      error: 'Failed to create promotion',
      details: error.message 
    });
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
router.put('/:id', authenticateToken, requireAdmin, handleUpload, async (req, res) => {
  try {
    const { id } = req.params;
    const { 
      title, 
      description, 
      shopId, 
      productIds, 
      productPrices,
      keepExistingImageUrls,
      keepExistingPrimaryImage,
      keepExistingPdf
    } = req.body;
    const files = req.files;

    console.log('Updating promotion:', id);
    console.log('Body:', req.body);
    console.log('Files:', files);

    // Get current promotion to handle image cleanup
    const currentPromotion = await prisma.promotion.findUnique({
      where: { id }
    });

    if (!currentPromotion) {
      return res.status(404).json({ error: 'Promotion not found' });
    }

    const updateData = {
      title,
      description,
      shopId
    };

    const baseUrl = `${req.protocol}://${req.get('host')}`;

    // Handle primary image
    if (files?.image?.length > 0) {
      // New primary image uploaded
      updateData.imageUrl = `${baseUrl}/uploads/promotions/${files.image[0].filename}`;
    } else if (keepExistingPrimaryImage !== 'true') {
      // Primary image was removed
      updateData.imageUrl = null;
    }
    // else: keep existing imageUrl (don't update)

    // Handle carousel images
    let existingUrls = [];
    try {
      existingUrls = JSON.parse(keepExistingImageUrls || '[]');
    } catch (e) {
      existingUrls = [];
    }

    // Add new uploaded images to the list
    let newImageUrls = [];
    if (files?.images?.length > 0) {
      newImageUrls = files.images.map(f => `${baseUrl}/uploads/promotions/${f.filename}`);
    }

    // Combine existing and new images
    updateData.imageUrls = [...existingUrls, ...newImageUrls];

    // Handle PDF
    if (files?.pdf?.length > 0) {
      updateData.pdfUrl = `${baseUrl}/uploads/promotions/${files.pdf[0].filename}`;
    } else if (keepExistingPdf !== 'true') {
      updateData.pdfUrl = null;
    }
    // else: keep existing pdfUrl

    // Handle product updates
    if (productIds) {
      let parsedProductIds = [];
      try {
        parsedProductIds = JSON.parse(productIds);
      } catch (error) {
        return res.status(400).json({ error: 'Invalid product IDs format' });
      }

      // Update products connection
      updateData.products = {
        set: parsedProductIds.map(productId => ({ id: productId }))
      };

      // Handle product prices if provided
      if (productPrices) {
        let parsedPrices = [];
        try {
          parsedPrices = JSON.parse(productPrices);
        } catch (error) {
          console.error('Invalid product prices format:', error);
        }

        // Update ProductAtShop prices for each product
        for (const priceData of parsedPrices) {
          if (priceData.productId && (priceData.price || priceData.offerPrice)) {
            try {
              await prisma.productAtShop.updateMany({
                where: {
                  productId: priceData.productId,
                  shopId: shopId
                },
                data: {
                  ...(priceData.price && { price: parseFloat(priceData.price) }),
                  ...(priceData.offerPrice && { offerPrice: parseFloat(priceData.offerPrice) })
                }
              });
            } catch (priceError) {
              console.error(`Error updating price for product ${priceData.productId}:`, priceError);
            }
          }
        }
      }
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