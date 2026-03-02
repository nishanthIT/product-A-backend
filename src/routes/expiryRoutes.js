import express from 'express';
import { PrismaClient } from '@prisma/client';
import jwt from 'jsonwebtoken';

const router = express.Router();
const prisma = new PrismaClient();

// Middleware to authenticate and get user info
const authenticateToken = async (req, res, next) => {
  try {
    let token = null;
    
    if (req.cookies && req.cookies.auth_token) {
      token = req.cookies.auth_token;
    } else if (req.headers.authorization && req.headers.authorization.startsWith('Bearer ')) {
      token = req.headers.authorization.split(' ')[1];
    }
    
    if (!token) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'your-secret-key');
    req.user = decoded;
    next();
  } catch (error) {
    console.error('Auth error:', error);
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
};

// Helper to get user's shopId
const getUserShopId = async (userId, userType) => {
  if (userType === 'CUSTOMER') {
    const customer = await prisma.customer.findUnique({
      where: { id: userId },
      select: { shopId: true }
    });
    return customer?.shopId;
  } else if (userType === 'EMPLOYEE') {
    const employee = await prisma.empolyee.findUnique({
      where: { id: userId },
      select: { shopId: true }
    });
    return employee?.shopId;
  }
  return null;
};

// GET /api/expiry - Get all expiry products for user's shop
router.get('/', authenticateToken, async (req, res) => {
  try {
    const { id: userId, userType } = req.user;
    const shopId = await getUserShopId(userId, userType);
    
    if (!shopId) {
      return res.status(400).json({ error: 'No shop associated with user' });
    }

    const { filter = 'all' } = req.query; // all, expiring-soon, expired, disposed
    
    let whereClause = { shopId };
    const now = new Date();
    
    if (filter === 'expiring-soon') {
      // Items expiring in the next 10 days
      const tenDaysFromNow = new Date();
      tenDaysFromNow.setDate(tenDaysFromNow.getDate() + 10);
      whereClause.expiryDate = {
        gte: now,
        lte: tenDaysFromNow
      };
      whereClause.isDisposed = false;
    } else if (filter === 'expired') {
      whereClause.expiryDate = { lt: now };
      whereClause.isDisposed = false;
    } else if (filter === 'disposed') {
      whereClause.isDisposed = true;
    } else if (filter === 'active') {
      whereClause.isDisposed = false;
    }

    const expiryProducts = await prisma.expiryProduct.findMany({
      where: whereClause,
      include: {
        product: {
          select: {
            id: true,
            title: true,
            barcode: true,
            img: true,
            category: true,
            rrp: true
          }
        }
      },
      orderBy: { expiryDate: 'asc' }
    });

    // Calculate days until expiry and status for each product
    const formattedProducts = expiryProducts.map(ep => {
      const expiryDate = new Date(ep.expiryDate);
      const daysUntilExpiry = Math.ceil((expiryDate - now) / (1000 * 60 * 60 * 24));
      
      let status = 'OK';
      if (ep.isDisposed) {
        status = 'DISPOSED';
      } else if (daysUntilExpiry < 0) {
        status = 'EXPIRED';
      } else if (daysUntilExpiry <= 2) {
        status = 'CRITICAL';
      } else if (daysUntilExpiry <= 7) {
        status = 'WARNING';
      } else if (daysUntilExpiry <= 10) {
        status = 'NOTICE';
      }

      return {
        id: ep.id,
        productId: ep.productId,
        productName: ep.product.title,
        productBarcode: ep.product.barcode,
        productImage: ep.product.img,
        productCategory: ep.product.category,
        productRrp: ep.product.rrp,
        expiryDate: ep.expiryDate,
        quantity: ep.quantity,
        batchNumber: ep.batchNumber,
        notes: ep.notes,
        isDisposed: ep.isDisposed,
        disposedAt: ep.disposedAt,
        daysUntilExpiry,
        status,
        createdAt: ep.createdAt
      };
    });

    // Get counts for each filter
    const counts = {
      all: await prisma.expiryProduct.count({ where: { shopId, isDisposed: false } }),
      expiringSoon: await prisma.expiryProduct.count({
        where: {
          shopId,
          isDisposed: false,
          expiryDate: {
            gte: now,
            lte: new Date(now.getTime() + 10 * 24 * 60 * 60 * 1000)
          }
        }
      }),
      expired: await prisma.expiryProduct.count({
        where: { shopId, isDisposed: false, expiryDate: { lt: now } }
      }),
      disposed: await prisma.expiryProduct.count({ where: { shopId, isDisposed: true } })
    };

    res.json({
      success: true,
      products: formattedProducts,
      counts
    });
  } catch (error) {
    console.error('Error fetching expiry products:', error);
    res.status(500).json({ error: 'Failed to fetch expiry products' });
  }
});

// POST /api/expiry - Add a product to expiry tracking
router.post('/', authenticateToken, async (req, res) => {
  try {
    const { id: userId, userType } = req.user;
    const shopId = await getUserShopId(userId, userType);
    
    if (!shopId) {
      return res.status(400).json({ error: 'No shop associated with user' });
    }

    const { productId, expiryDate, quantity = 1, batchNumber, notes } = req.body;

    if (!productId || !expiryDate) {
      return res.status(400).json({ error: 'Product ID and expiry date are required' });
    }

    // Verify product exists
    const product = await prisma.product.findUnique({
      where: { id: productId },
      select: { id: true, title: true }
    });

    if (!product) {
      return res.status(404).json({ error: 'Product not found' });
    }

    const expiryProduct = await prisma.expiryProduct.create({
      data: {
        productId,
        shopId,
        expiryDate: new Date(expiryDate),
        quantity,
        batchNumber,
        notes,
        addedById: userId,
        addedByType: userType
      },
      include: {
        product: {
          select: {
            id: true,
            title: true,
            barcode: true,
            img: true,
            category: true
          }
        }
      }
    });

    res.status(201).json({
      success: true,
      message: 'Product added to expiry tracking',
      expiryProduct: {
        id: expiryProduct.id,
        productId: expiryProduct.productId,
        productName: expiryProduct.product.title,
        productBarcode: expiryProduct.product.barcode,
        productImage: expiryProduct.product.img,
        productCategory: expiryProduct.product.category,
        expiryDate: expiryProduct.expiryDate,
        quantity: expiryProduct.quantity,
        batchNumber: expiryProduct.batchNumber,
        notes: expiryProduct.notes,
        isDisposed: expiryProduct.isDisposed
      }
    });
  } catch (error) {
    console.error('Error adding expiry product:', error);
    res.status(500).json({ error: 'Failed to add product to expiry tracking' });
  }
});

// PUT /api/expiry/:id - Update expiry product (e.g., mark as disposed)
router.put('/:id', authenticateToken, async (req, res) => {
  try {
    const { id: userId, userType } = req.user;
    const shopId = await getUserShopId(userId, userType);
    const expiryId = req.params.id;
    
    if (!shopId) {
      return res.status(400).json({ error: 'No shop associated with user' });
    }

    // Verify the expiry product belongs to user's shop
    const existingProduct = await prisma.expiryProduct.findFirst({
      where: { id: expiryId, shopId }
    });

    if (!existingProduct) {
      return res.status(404).json({ error: 'Expiry product not found' });
    }

    const { isDisposed, expiryDate, quantity, batchNumber, notes } = req.body;

    const updateData = {};
    if (isDisposed !== undefined) {
      updateData.isDisposed = isDisposed;
      if (isDisposed) {
        updateData.disposedAt = new Date();
        updateData.disposedBy = `${userType}:${userId}`;
      } else {
        updateData.disposedAt = null;
        updateData.disposedBy = null;
      }
    }
    if (expiryDate) updateData.expiryDate = new Date(expiryDate);
    if (quantity) updateData.quantity = quantity;
    if (batchNumber !== undefined) updateData.batchNumber = batchNumber;
    if (notes !== undefined) updateData.notes = notes;

    const updatedProduct = await prisma.expiryProduct.update({
      where: { id: expiryId },
      data: updateData,
      include: {
        product: {
          select: {
            id: true,
            title: true,
            barcode: true,
            img: true,
            category: true
          }
        }
      }
    });

    res.json({
      success: true,
      message: isDisposed ? 'Product marked as disposed' : 'Expiry product updated',
      expiryProduct: {
        id: updatedProduct.id,
        productId: updatedProduct.productId,
        productName: updatedProduct.product.title,
        productBarcode: updatedProduct.product.barcode,
        productImage: updatedProduct.product.img,
        expiryDate: updatedProduct.expiryDate,
        quantity: updatedProduct.quantity,
        batchNumber: updatedProduct.batchNumber,
        notes: updatedProduct.notes,
        isDisposed: updatedProduct.isDisposed,
        disposedAt: updatedProduct.disposedAt
      }
    });
  } catch (error) {
    console.error('Error updating expiry product:', error);
    res.status(500).json({ error: 'Failed to update expiry product' });
  }
});

// DELETE /api/expiry/:id - Remove expiry product from tracking
router.delete('/:id', authenticateToken, async (req, res) => {
  try {
    const { id: userId, userType } = req.user;
    const shopId = await getUserShopId(userId, userType);
    const expiryId = req.params.id;
    
    if (!shopId) {
      return res.status(400).json({ error: 'No shop associated with user' });
    }

    // Verify the expiry product belongs to user's shop
    const existingProduct = await prisma.expiryProduct.findFirst({
      where: { id: expiryId, shopId }
    });

    if (!existingProduct) {
      return res.status(404).json({ error: 'Expiry product not found' });
    }

    await prisma.expiryProduct.delete({
      where: { id: expiryId }
    });

    res.json({
      success: true,
      message: 'Expiry product removed from tracking'
    });
  } catch (error) {
    console.error('Error deleting expiry product:', error);
    res.status(500).json({ error: 'Failed to delete expiry product' });
  }
});

// GET /api/expiry/notifications - Get expiry notifications for user's shop
router.get('/notifications', authenticateToken, async (req, res) => {
  try {
    const { id: userId, userType } = req.user;
    const shopId = await getUserShopId(userId, userType);
    
    if (!shopId) {
      return res.status(400).json({ error: 'No shop associated with user' });
    }

    const now = new Date();
    
    // Get products expiring soon (within 10 days) that aren't disposed
    const expiringProducts = await prisma.expiryProduct.findMany({
      where: {
        shopId,
        isDisposed: false,
        expiryDate: {
          lte: new Date(now.getTime() + 10 * 24 * 60 * 60 * 1000)
        }
      },
      include: {
        product: {
          select: {
            id: true,
            title: true,
            barcode: true,
            img: true
          }
        }
      },
      orderBy: { expiryDate: 'asc' }
    });

    const notifications = expiringProducts.map(ep => {
      const expiryDate = new Date(ep.expiryDate);
      const daysUntilExpiry = Math.ceil((expiryDate - now) / (1000 * 60 * 60 * 24));
      
      let priority = 'low';
      let message = '';
      
      if (daysUntilExpiry < 0) {
        priority = 'critical';
        message = `${ep.product.title} has EXPIRED!`;
      } else if (daysUntilExpiry <= 2) {
        priority = 'critical';
        message = `${ep.product.title} expires in ${daysUntilExpiry} day(s)!`;
      } else if (daysUntilExpiry <= 7) {
        priority = 'high';
        message = `${ep.product.title} expires in ${daysUntilExpiry} days`;
      } else {
        priority = 'medium';
        message = `${ep.product.title} expires in ${daysUntilExpiry} days`;
      }

      return {
        id: ep.id,
        productId: ep.productId,
        productName: ep.product.title,
        productImage: ep.product.img,
        expiryDate: ep.expiryDate,
        daysUntilExpiry,
        priority,
        message,
        quantity: ep.quantity
      };
    });

    res.json({
      success: true,
      notifications,
      counts: {
        critical: notifications.filter(n => n.priority === 'critical').length,
        high: notifications.filter(n => n.priority === 'high').length,
        medium: notifications.filter(n => n.priority === 'medium').length
      }
    });
  } catch (error) {
    console.error('Error fetching expiry notifications:', error);
    res.status(500).json({ error: 'Failed to fetch notifications' });
  }
});

// Search products from central database (for adding to expiry tracking)
router.get('/search-product', authenticateToken, async (req, res) => {
  try {
    const { query, barcode } = req.query;

    let whereClause = {};
    
    if (barcode) {
      whereClause.barcode = barcode;
    } else if (query) {
      whereClause.OR = [
        { title: { contains: query, mode: 'insensitive' } },
        { barcode: { contains: query, mode: 'insensitive' } }
      ];
    } else {
      return res.status(400).json({ error: 'Search query or barcode required' });
    }

    const products = await prisma.product.findMany({
      where: whereClause,
      select: {
        id: true,
        title: true,
        barcode: true,
        img: true,
        category: true,
        rrp: true,
        caseSize: true,
        packetSize: true
      },
      take: 20
    });

    res.json({
      success: true,
      products
    });
  } catch (error) {
    console.error('Error searching products:', error);
    res.status(500).json({ error: 'Failed to search products' });
  }
});

export default router;
