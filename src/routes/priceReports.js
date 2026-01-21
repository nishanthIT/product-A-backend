import express from 'express';
import { PrismaClient } from '@prisma/client';
import jwt from 'jsonwebtoken';

const router = express.Router();
const prisma = new PrismaClient();

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

// GET /api/price-reports - Get user's price reports
router.get('/', authenticateToken, async (req, res) => {
  try {
    const userId = parseInt(req.user.id);
    
    const reports = await prisma.priceReport.findMany({
      where: { reporterId: userId },
      include: {
        product: true,
        shop: true
      },
      orderBy: { createdAt: 'desc' }
    });

    // Get user's earnings/points
    const user = await prisma.customer.findUnique({
      where: { id: userId },
      select: { earnings: true }
    });

    res.json({
      reports,
      earnings: user?.earnings || 0
    });
  } catch (error) {
    console.error('Error fetching price reports:', error);
    res.status(500).json({ error: 'Failed to fetch reports' });
  }
});

// POST /api/price-reports - Submit a new price report
router.post('/', authenticateToken, async (req, res) => {
  try {
    const userId = parseInt(req.user.id);
    const { productId, shopId, reportedPrice, currentPrice, notes, productAtShopId } = req.body;

    // Validate required fields
    if (!reportedPrice) {
      return res.status(400).json({ error: 'Reported Price is required' });
    }

    if (!productId && !productAtShopId) {
      return res.status(400).json({ error: 'Either productId with shopId, or productAtShopId is required' });
    }

    let finalProductId = productId;
    let finalShopId = shopId;
    let productAtShop;

    // If productAtShopId is provided, look up the product and shop
    if (productAtShopId) {
      productAtShop = await prisma.productAtShop.findUnique({
        where: { id: productAtShopId },
        include: {
          product: true,
          shop: true
        }
      });

      if (!productAtShop) {
        return res.status(404).json({ error: 'Product not found' });
      }

      finalProductId = productAtShop.productId;
      finalShopId = productAtShop.shopId;
    } else if (productId && shopId) {
      // Check if product exists at this shop
      productAtShop = await prisma.productAtShop.findUnique({
        where: { shopId_productId: { shopId, productId } },
        include: {
          product: true,
          shop: true
        }
      });

      if (!productAtShop) {
        return res.status(404).json({ error: 'Product not found at this shop' });
      }
    } else {
      return res.status(400).json({ error: 'Product and Shop information required' });
    }

    // Create price report
    const report = await prisma.priceReport.create({
      data: {
        reporterId: userId,
        productId: finalProductId,
        shopId: finalShopId,
        currentPrice: currentPrice || productAtShop.price,
        reportedPrice: parseFloat(reportedPrice),
        status: 'PENDING',
        adminNotes: notes || null
      },
      include: {
        product: true,
        shop: true
      }
    });

    console.log(`📋 New price report created by user ${userId} for product ${finalProductId} at shop ${finalShopId}`);

    res.status(201).json({
      message: 'Price report submitted successfully',
      report
    });
  } catch (error) {
    console.error('Error creating price report:', error);
    res.status(500).json({ error: 'Failed to submit price report' });
  }
});

// ADMIN ENDPOINTS

// GET /api/price-reports/admin/pending - Get pending reports for admin approval
router.get('/admin/pending', async (req, res) => {
  try {
    const reports = await prisma.priceReport.findMany({
      where: { status: 'PENDING' },
      include: {
        reporter: {
          select: { id: true, name: true, email: true }
        },
        product: true,
        shop: true
      },
      orderBy: { createdAt: 'asc' }
    });

    res.json(reports);
  } catch (error) {
    console.error('Error fetching pending reports:', error);
    res.status(500).json({ error: 'Failed to fetch pending reports' });
  }
});

// PUT /api/price-reports/admin/:reportId/approve - Approve a price report
router.put('/admin/:reportId/approve', async (req, res) => {
  try {
    const { reportId } = req.params;
    const { adminNotes } = req.body;

    // Get the report with product and shop info
    const report = await prisma.priceReport.findUnique({
      where: { id: reportId },
      include: {
        reporter: true,
        product: true,
        shop: true
      }
    });

    if (!report) {
      return res.status(404).json({ error: 'Report not found' });
    }

    if (report.status !== 'PENDING') {
      return res.status(400).json({ error: 'Report is not pending approval' });
    }

    // Start transaction to update price and award points
    const result = await prisma.$transaction(async (tx) => {
      // 1. Update the price in ProductAtShop
      await tx.productAtShop.update({
        where: {
          shopId_productId: {
            shopId: report.shopId,
            productId: report.productId
          }
        },
        data: {
          price: report.reportedPrice,
          updatedAt: new Date()
        }
      });

      // 2. Award 1 point to the user
      await tx.customer.update({
        where: { id: report.reporterId },
        data: {
          earnings: {
            increment: 1
          }
        }
      });

      // 3. Update the report status
      const updatedReport = await tx.priceReport.update({
        where: { id: reportId },
        data: {
          status: 'APPROVED',
          adminNotes: adminNotes || null,
          pointsAwarded: true,
          reviewedAt: new Date(),
          reviewedBy: 1 // TODO: Get actual admin ID
        },
        include: {
          reporter: true,
          product: true,
          shop: true
        }
      });

      return updatedReport;
    });

    console.log(`✅ Price report ${reportId} approved. User ${report.reporterId} earned 1 point. Price updated from ${report.currentPrice} to ${report.reportedPrice}`);

    res.json({
      message: 'Report approved and price updated successfully',
      report: result
    });
  } catch (error) {
    console.error('Error approving price report:', error);
    res.status(500).json({ error: 'Failed to approve report' });
  }
});

// PUT /api/price-reports/admin/:reportId/reject - Reject a price report
router.put('/admin/:reportId/reject', async (req, res) => {
  try {
    const { reportId } = req.params;
    const { adminNotes } = req.body;

    const updatedReport = await prisma.priceReport.update({
      where: { id: reportId },
      data: {
        status: 'REJECTED',
        adminNotes: adminNotes || null,
        reviewedAt: new Date(),
        reviewedBy: 1 // TODO: Get actual admin ID
      },
      include: {
        reporter: true,
        product: true,
        shop: true
      }
    });

    console.log(`❌ Price report ${reportId} rejected`);

    res.json({
      message: 'Report rejected',
      report: updatedReport
    });
  } catch (error) {
    console.error('Error rejecting price report:', error);
    res.status(500).json({ error: 'Failed to reject report' });
  }
});

// GET /api/price-reports/product/:productId/shop/:shopId/price - Get current price for a product at a shop
router.get('/product/:productId/shop/:shopId/price', authenticateToken, async (req, res) => {
  try {
    const { productId, shopId } = req.params;

    const productAtShop = await prisma.productAtShop.findUnique({
      where: {
        shopId_productId: {
          shopId,
          productId
        }
      },
      select: {
        price: true,
        offerPrice: true,
        offerExpiryDate: true,
        updatedAt: true
      }
    });

    if (!productAtShop) {
      return res.status(404).json({ error: 'Product not found at this shop' });
    }

    // Check if there's an active offer
    const currentDate = new Date();
    const hasActiveOffer = productAtShop.offerPrice && 
                          productAtShop.offerExpiryDate && 
                          new Date(productAtShop.offerExpiryDate) > currentDate;

    res.json({
      price: hasActiveOffer ? productAtShop.offerPrice : productAtShop.price,
      originalPrice: productAtShop.price,
      offerPrice: productAtShop.offerPrice,
      offerExpiryDate: productAtShop.offerExpiryDate,
      hasActiveOffer,
      lastUpdated: productAtShop.updatedAt
    });
  } catch (error) {
    console.error('Error fetching product price:', error);
    res.status(500).json({ error: 'Failed to fetch product price' });
  }
});

// GET /api/price-reports/products/search - Search products for price reporting
router.get('/products/search', authenticateToken, async (req, res) => {
  try {
    const { q, limit = 10 } = req.query;

    if (!q || q.trim().length < 2) {
      return res.json({ products: [] });
    }

    const products = await prisma.product.findMany({
      where: {
        OR: [
          { title: { contains: q, mode: 'insensitive' } },
          { barcode: { contains: q, mode: 'insensitive' } }
        ]
      },
      select: {
        id: true,
        title: true,
        barcode: true,
        img: true
      },
      take: parseInt(limit),
      orderBy: { title: 'asc' }
    });

    res.json({ products });
  } catch (error) {
    console.error('Error searching products:', error);
    res.status(500).json({ error: 'Failed to search products' });
  }
});

// GET /api/price-reports/products/:productId/shops/search - Search shops that have a specific product
router.get('/products/:productId/shops/search', authenticateToken, async (req, res) => {
  try {
    const { productId } = req.params;
    const { q, limit = 10 } = req.query;

    // Build the where condition
    const whereCondition = {
      productId: productId,
    };

    // Only add search filters if query is provided and has enough characters
    if (q && q.trim().length >= 2) {
      whereCondition.shop = {
        OR: [
          { name: { contains: q, mode: 'insensitive' } },
          { address: { contains: q, mode: 'insensitive' } }
        ]
      };
    }

    // Find shops that have this product (with optional search filter)
    const shopsWithProduct = await prisma.productAtShop.findMany({
      where: whereCondition,
      include: {
        shop: {
          select: {
            id: true,
            name: true,
            address: true,
            mobile: true
          }
        }
      },
      take: parseInt(limit),
      orderBy: { shop: { name: 'asc' } }
    });

    const shops = shopsWithProduct.map(item => item.shop);
    res.json({ shops });
  } catch (error) {
    console.error('Error searching shops:', error);
    res.status(500).json({ error: 'Failed to search shops' });
  }
});

// GET /api/price-reports/products/:productId/shops - Get all shops that have a specific product
router.get('/products/:productId/shops', authenticateToken, async (req, res) => {
  try {
    const { productId } = req.params;
    const { limit = 50 } = req.query; // Higher default limit for showing all shops

    // Find all shops that have this product
    const shopsWithProduct = await prisma.productAtShop.findMany({
      where: {
        productId: productId,
      },
      include: {
        shop: {
          select: {
            id: true,
            name: true,
            address: true,
            mobile: true
          }
        }
      },
      take: parseInt(limit),
      orderBy: { shop: { name: 'asc' } }
    });

    const shops = shopsWithProduct.map(item => item.shop);
    res.json({ shops });
  } catch (error) {
    console.error('Error fetching shops for product:', error);
    res.status(500).json({ error: 'Failed to fetch shops' });
  }
});

// ============ ADMIN ENDPOINTS ============

// GET /api/price-reports/admin/pending - Get all pending price reports for admin review
router.get('/admin/pending', authenticateToken, async (req, res) => {
  try {
    // Check if user is admin (you can modify this logic based on your user roles)
    if (req.user.userType !== 'EMPLOYEE' && req.user.userType !== 'ADMIN') {
      return res.status(403).json({ error: 'Admin access required' });
    }

    const pendingReports = await prisma.priceReport.findMany({
      where: { status: 'PENDING' },
      include: {
        reporter: {
          select: { id: true, name: true, email: true }
        },
        product: {
          select: { id: true, title: true, barcode: true, img: true }
        },
        shop: {
          select: { id: true, name: true, address: true, mobile: true }
        }
      },
      orderBy: { createdAt: 'desc' }
    });

    res.json({ reports: pendingReports });
  } catch (error) {
    console.error('Error fetching pending reports:', error);
    res.status(500).json({ error: 'Failed to fetch pending reports' });
  }
});

// POST /api/price-reports/admin/approve/:reportId - Approve a price report
router.post('/admin/approve/:reportId', authenticateToken, async (req, res) => {
  try {
    // Check if user is admin
    if (req.user.userType !== 'EMPLOYEE' && req.user.userType !== 'ADMIN') {
      return res.status(403).json({ error: 'Admin access required' });
    }

    const { reportId } = req.params;
    const { adminNotes } = req.body;

    // Get the report details
    const report = await prisma.priceReport.findUnique({
      where: { id: reportId },
      include: { reporter: true }
    });

    if (!report) {
      return res.status(404).json({ error: 'Report not found' });
    }

    if (report.status !== 'PENDING') {
      return res.status(400).json({ error: 'Report already processed' });
    }

    // Start transaction to update price and award points
    await prisma.$transaction(async (tx) => {
      // 1. Update the price report status
      await tx.priceReport.update({
        where: { id: reportId },
        data: {
          status: 'APPROVED',
          adminNotes: adminNotes || 'Price report approved',
          reviewedAt: new Date(),
          pointsAwarded: true
        }
      });

      // 2. Update the product price at the shop
      await tx.productAtShop.updateMany({
        where: {
          productId: report.productId,
          shopId: report.shopId
        },
        data: {
          price: report.reportedPrice.toString(),
          updatedAt: new Date()
        }
      });

      // 3. Award 1 point to the reporter
      await tx.customer.update({
        where: { id: report.reporterId },
        data: {
          earnings: {
            increment: 1
          }
        }
      });
    });

    res.json({ 
      message: 'Report approved successfully', 
      pointsAwarded: 1,
      priceUpdated: true 
    });

  } catch (error) {
    console.error('Error approving report:', error);
    res.status(500).json({ error: 'Failed to approve report' });
  }
});

// POST /api/price-reports/admin/reject/:reportId - Reject a price report
router.post('/admin/reject/:reportId', authenticateToken, async (req, res) => {
  try {
    // Check if user is admin
    if (req.user.userType !== 'EMPLOYEE' && req.user.userType !== 'ADMIN') {
      return res.status(403).json({ error: 'Admin access required' });
    }

    const { reportId } = req.params;
    const { adminNotes } = req.body;

    // Get the report details
    const report = await prisma.priceReport.findUnique({
      where: { id: reportId }
    });

    if (!report) {
      return res.status(404).json({ error: 'Report not found' });
    }

    if (report.status !== 'PENDING') {
      return res.status(400).json({ error: 'Report already processed' });
    }

    // Update the price report status
    await prisma.priceReport.update({
      where: { id: reportId },
      data: {
        status: 'REJECTED',
        adminNotes: adminNotes || 'Price report rejected',
        reviewedAt: new Date(),
        pointsAwarded: false
      }
    });

    res.json({ 
      message: 'Report rejected successfully'
    });

  } catch (error) {
    console.error('Error rejecting report:', error);
    res.status(500).json({ error: 'Failed to reject report' });
  }
});

// GET /api/price-reports/admin/all - Get all price reports with filters
router.get('/admin/all', authenticateToken, async (req, res) => {
  try {
    // Check if user is admin
    if (req.user.userType !== 'EMPLOYEE' && req.user.userType !== 'ADMIN') {
      return res.status(403).json({ error: 'Admin access required' });
    }

    const { status, limit = 50 } = req.query;

    const whereCondition = status ? { status } : {};

    const reports = await prisma.priceReport.findMany({
      where: whereCondition,
      include: {
        reporter: {
          select: { id: true, name: true, email: true }
        },
        product: {
          select: { id: true, title: true, barcode: true, img: true }
        },
        shop: {
          select: { id: true, name: true, address: true, mobile: true }
        }
      },
      orderBy: { createdAt: 'desc' },
      take: parseInt(limit)
    });

    res.json({ reports });
  } catch (error) {
    console.error('Error fetching all reports:', error);
    res.status(500).json({ error: 'Failed to fetch reports' });
  }
});

export default router;