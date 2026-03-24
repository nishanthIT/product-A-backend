import express from 'express';
import { PrismaClient } from '@prisma/client';
import jwt from 'jsonwebtoken';
import cacheService from '../services/cacheService.js';

const router = express.Router();
const prisma = new PrismaClient();

// Retry wrapper for database operations (handles Neon cold starts)
const withRetry = async (operation, maxRetries = 3, delayMs = 1000) => {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error) {
      const isConnectionError = error.code === 'P1001' || 
        error.message?.includes("Can't reach database server") ||
        error.message?.includes('Connection refused');
      
      if (isConnectionError && attempt < maxRetries) {
        console.log(`⏳ Database connection failed (attempt ${attempt}/${maxRetries}), retrying in ${delayMs}ms...`);
        await new Promise(resolve => setTimeout(resolve, delayMs));
        continue;
      }
      throw error;
    }
  }
};

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

// Get all lists for the authenticated user
router.get('/', authenticateToken, async (req, res) => {
  try {
    const userId = parseInt(req.user.id);
    const userType = req.user.userType;
    
    // Try cache first (only for CUSTOMER type for backwards compatibility)
    if (userType === 'CUSTOMER') {
      const cachedLists = await cacheService.getCachedUserLists(userId);
      if (cachedLists) {
        return res.json(cachedLists);
      }
    }

    let lists;
    
    if (userType === 'EMPLOYEE') {
      // Employee: get their own lists
      lists = await prisma.list.findMany({
        where: {
          employeeId: userId,
          creatorType: 'EMPLOYEE'
        },
        include: {
          products: {
            include: {
              productAtShop: {
                include: {
                  product: true,
                  shop: true,
                },
              },
            },
          },
        },
        orderBy: { createdAt: 'desc' }
      });
    } else if (userType === 'ADMIN') {
      // Admin: get their own lists
      lists = await prisma.list.findMany({
        where: {
          adminId: userId,
          creatorType: 'ADMIN'
        },
        include: {
          products: {
            include: {
              productAtShop: {
                include: {
                  product: true,
                  shop: true,
                },
              },
            },
          },
        },
        orderBy: { createdAt: 'desc' }
      });
    } else {
      // Customer (default): get customer lists
      lists = await prisma.list.findMany({
        where: {
          customerId: userId,
        },
        include: {
          products: {
            include: {
              productAtShop: {
                include: {
                  product: true,
                  shop: true,
                },
              },
            },
          },
        },
        orderBy: { createdAt: 'desc' }
      });

      // Cache the result for customers
      await cacheService.cacheUserLists(userId, lists);
    }

    res.json(lists);
  } catch (error) {
    console.error('Error fetching lists:', error);
    res.status(500).json({ error: 'Failed to fetch lists' });
  }
});

// Get all lists for a shop (for Admin/Shop Owner to see all employee lists)
router.get('/shop/all', authenticateToken, async (req, res) => {
  try {
    const userId = parseInt(req.user.id);
    const userType = req.user.userType;
    
    let shopId = null;
    
    if (userType === 'ADMIN') {
      // Get admin's shop
      const admin = await prisma.admin.findUnique({
        where: { id: userId },
        select: { shopId: true }
      });
      shopId = admin?.shopId;
    } else if (userType === 'CUSTOMER') {
      // Check if customer owns a shop
      const customer = await prisma.customer.findUnique({
        where: { id: userId },
        select: { shopId: true }
      });
      shopId = customer?.shopId;
    } else if (userType === 'EMPLOYEE') {
      // Get employee's shop
      const employee = await prisma.empolyee.findUnique({
        where: { id: userId },
        select: { shopId: true }
      });
      shopId = employee?.shopId;
    }
    
    if (!shopId) {
      return res.status(403).json({ error: 'You are not associated with any shop' });
    }
    
    // Get all lists for this shop (employee lists + admin lists)
    const lists = await prisma.list.findMany({
      where: {
        shopId: shopId
      },
      include: {
        products: {
          orderBy: {
            id: 'asc',
          },
          include: {
            productAtShop: {
              include: {
                product: true,
                shop: true,
              },
            },
          },
        },
        employee: {
          select: { id: true, name: true }
        },
        admin: {
          select: { id: true, name: true }
        }
      },
      orderBy: { createdAt: 'desc' }
    });
    
    // Add shopId to response for frontend to join socket room
    res.json({ lists, shopId });
  } catch (error) {
    console.error('Error fetching shop lists:', error);
    res.status(500).json({ error: 'Failed to fetch shop lists' });
  }
});

// Get a specific list by ID
router.get('/:id', authenticateToken, async (req, res) => {
  try {
    const listId = req.params.id;
    const userId = parseInt(req.user.id);
    const userType = req.user.userType;
    
    // Skip cache check - always fetch fresh data to avoid race conditions with togglePurchased
    console.log('📦 Fetching list from DATABASE (no cache):', listId);

    const trackingSupported = !!prisma.trackedList?.findFirst;

    // Build the where clause based on user type
    let whereClause = { id: listId };
    
    // Check ownership or allow Admin to view shop lists
    if (userType === 'ADMIN') {
      // Admin can view their own lists OR any employee list in their shop
      const admin = await prisma.admin.findUnique({
        where: { id: userId },
        select: { shopId: true }
      });
      
      whereClause = {
        id: listId,
        OR: [
          { adminId: userId },
          { employee: { shopId: admin?.shopId } }
        ]
      };
    } else if (userType === 'EMPLOYEE') {
      // Employee can view own lists + tracked lists
      whereClause = trackingSupported
        ? {
            id: listId,
            OR: [
              { employeeId: userId },
              { trackedBy: { some: { userId, userType } } }
            ]
          }
        : {
            id: listId,
            employeeId: userId
          };
    } else {
      // Customer can view own lists + tracked lists
      whereClause = trackingSupported
        ? {
            id: listId,
            OR: [
              { customerId: userId },
              { trackedBy: { some: { userId, userType } } }
            ]
          }
        : {
            id: listId,
            customerId: userId
          };
    }

    const list = await withRetry(() => prisma.list.findFirst({
      where: whereClause,
      include: {
        products: {
          include: {
            productAtShop: {
              include: {
                product: true,
                shop: true,
              },
            },
          },
        },
        employee: {
          select: { id: true, name: true }
        },
        admin: {
          select: { id: true, name: true }
        }
      },
    }));

    if (!list) {
      return res.status(404).json({ error: 'List not found' });
    }

    // Transform products to frontend-friendly format
    const transformedProducts = list.products.map(lp => ({
      id: lp.id,
      productId: lp.productAtShop?.product?.id || lp.productAtShopId,
      productAtShopId: lp.productAtShopId,
      productName: lp.productAtShop?.product?.title || 'Unknown Product',
      barcode: lp.productAtShop?.product?.barcode || '',
      aielNumber: lp.productAtShop?.card_aiel_number || '',
      category: lp.productAtShop?.product?.category || 'Uncategorized',
      lowestPrice: Number(lp.productAtShop?.price) || 0,
      originalPrice: Number(lp.productAtShop?.price) || 0,
      offerPrice: lp.productAtShop?.offerPrice ? Number(lp.productAtShop.offerPrice) : null,
      hasActiveOffer: lp.productAtShop?.offerPrice && lp.productAtShop?.offerExpiryDate 
        ? new Date(lp.productAtShop.offerExpiryDate) > new Date() 
        : false,
      shopName: lp.productAtShop?.shop?.name || 'Unknown Shop',
      shopId: lp.productAtShop?.shop?.id || '',
      img: lp.productAtShop?.product?.img || null,
      quantity: lp.quantity || 1,
      isPurchased: lp.isPurchased || false,
      // Bundle offer fields
      isFreeItem: lp.isFreeItem || false,
      freeQuantity: lp.freeQuantity || 0,
      bundlePromotionId: lp.bundlePromotionId || null,
    }));

    console.log('📦 Database isPurchased states:', transformedProducts.map(p => ({ id: p.id, name: p.productName, isPurchased: p.isPurchased })));

    const responseData = {
      ...list,
      products: transformedProducts,
    };

    // Don't cache - to avoid race conditions with togglePurchased operations
    // await cacheService.cacheListDetail(listId, responseData);

    res.json(responseData);
  } catch (error) {
    console.error('Error fetching list:', error.message);
    res.status(500).json({ error: 'Failed to fetch list' });
  }
});

// Create a new list
router.post('/', authenticateToken, async (req, res) => {
  try {
    const { name, description } = req.body;
    const userId = parseInt(req.user.id);
    const userType = req.user.userType;

    if (!name) {
      return res.status(400).json({ error: 'List name is required' });
    }

    // Build list data based on user type
    const listData = {
      name,
      description: description || '',
      creatorType: userType
    };

    if (userType === 'EMPLOYEE') {
      // Get employee's shop
      const employee = await prisma.empolyee.findUnique({
        where: { id: userId },
        select: { shopId: true }
      });
      listData.employeeId = userId;
      listData.shopId = employee?.shopId;
    } else if (userType === 'ADMIN') {
      // Get admin's shop
      const admin = await prisma.admin.findUnique({
        where: { id: userId },
        select: { shopId: true }
      });
      listData.adminId = userId;
      listData.shopId = admin?.shopId;
    } else {
      // Customer (default)
      listData.customerId = userId;
    }

    const newList = await prisma.list.create({
      data: listData,
      include: {
        products: {
          include: {
            productAtShop: {
              include: {
                product: true,
                shop: true,
              },
            },
          },
        },
      },
    });

    // Invalidate user's list cache (for customers)
    if (userType === 'CUSTOMER') {
      await cacheService.invalidateUserLists(userId);
      console.log(`🗑️ Cache invalidated: user ${userId} lists (new list created)`);
    }

    // Emit socket event for shop list sync (if list has shopId)
    if (newList.shopId && req.io) {
      req.io.to(`shop_${newList.shopId}_lists`).emit('list_created', {
        list: newList,
        creatorType: userType,
        creatorId: userId
      });
      console.log(`📡 Emitted list_created to shop_${newList.shopId}_lists`);
    }

    res.status(201).json(newList);
  } catch (error) {
    console.error('Error creating list:', error);
    res.status(500).json({ error: 'Failed to create list' });
  }
});

// Add a product to a list
router.post('/addProduct', authenticateToken, async (req, res) => {
  try {
    const { listId, productAtShopId, quantity = 1 } = req.body;
    const userId = parseInt(req.user.id);
    const userType = req.user.userType;

    if (!listId || !productAtShopId) {
      return res.status(400).json({ error: 'listId and productAtShopId are required' });
    }

    // Verify user can modify this list: owner or tracker
    const list = await prisma.list.findUnique({ where: { id: listId } });

    if (!list) {
      return res.status(404).json({ error: 'List not found or access denied' });
    }

    const isOwner = (list.creatorType === 'CUSTOMER' && list.customerId === userId) ||
                    (list.creatorType === 'ADMIN' && list.adminId === userId) ||
                    (list.creatorType === 'EMPLOYEE' && list.employeeId === userId);

    let isTracking = false;
    if (!isOwner) {
      if (prisma.trackedList?.findFirst) {
        const tracked = await prisma.trackedList.findFirst({
          where: {
            listId,
            userId,
            userType,
          },
        });
        isTracking = !!tracked;
      }
    }

    if (!isOwner && !isTracking) {
      return res.status(403).json({ error: 'List not found or access denied' });
    }

    // Check if the product already exists in the list
    const existingProduct = await prisma.listProduct.findFirst({
      where: {
        listId,
        productAtShopId,
      },
    });

    if (existingProduct) {
      // Update quantity if product already exists
      const updatedProduct = await prisma.listProduct.update({
        where: {
          id: existingProduct.id,
        },
        data: {
          quantity: existingProduct.quantity + quantity,
        },
        include: {
          productAtShop: {
            include: {
              product: true,
              shop: true,
            },
          },
        },
      });

      // Invalidate caches (only for customers)
      if (userType === 'CUSTOMER') {
        await cacheService.invalidateUserLists(userId);
        await cacheService.invalidateListDetail(listId);
      }

      // Emit socket event for shop list sync
      if (list.shopId && req.io) {
        req.io.to(`shop_${list.shopId}_lists`).emit('list_product_updated', {
          listId,
          product: updatedProduct,
          action: 'quantity_increased'
        });
        console.log(`📡 Emitted list_product_updated to shop_${list.shopId}_lists`);
      }

      res.json({ message: 'Product quantity updated', product: updatedProduct });
    } else {
      // Add new product to list
      const listProduct = await prisma.listProduct.create({
        data: {
          listId,
          productAtShopId,
          quantity,
        },
        include: {
          productAtShop: {
            include: {
              product: true,
              shop: true,
            },
          },
        },
      });

      // Invalidate caches
      if (userType === 'CUSTOMER') {
        await cacheService.invalidateUserLists(userId);
      }
      await cacheService.invalidateListDetail(listId);
      console.log(`🗑️ Cache invalidated: list ${listId} (product added)`);

      // Emit socket event for shop list sync
      if (list.shopId && req.io) {
        req.io.to(`shop_${list.shopId}_lists`).emit('list_product_added', {
          listId,
          product: listProduct
        });
        console.log(`📡 Emitted list_product_added to shop_${list.shopId}_lists`);
      }

      res.status(201).json({ message: 'Product added to list', product: listProduct });
    }
  } catch (error) {
    console.error('Error adding product to list:', error);
    res.status(500).json({ error: 'Failed to add product to list' });
  }
});

// Update product quantity in a list
router.put('/updateQuantity', authenticateToken, async (req, res) => {
  try {
    const { listId, productAtShopId, listProductId, quantity } = req.body;
    const userId = parseInt(req.user.id);
    const userType = req.user.userType;

    console.log('📦 Update quantity request:', { listId, productAtShopId, listProductId, quantity, userId, userType });

    if (!listId || (!productAtShopId && !listProductId) || quantity === undefined) {
      return res.status(400).json({ error: 'listId, productAtShopId (or listProductId), and quantity are required' });
    }

    if (quantity < 0) {
      return res.status(400).json({ error: 'Quantity must be a non-negative number.' });
    }

    // --- Authorization Check ---
    // Find the original list to get ownership and shop details
    const originalList = await prisma.list.findUnique({
      where: { id: listId },
    });

    if (!originalList) {
      return res.status(404).json({ error: 'List not found' });
    }

    // Check if the user is the owner (customer, admin, or employee)
    const isOwner = (originalList.creatorType === 'CUSTOMER' && originalList.customerId === userId) ||
                    (originalList.creatorType === 'ADMIN' && originalList.adminId === userId) ||
                    (originalList.creatorType === 'EMPLOYEE' && originalList.employeeId === userId);

    // Check if the user is tracking the list (only if not owner and model exists)
    let isTracking = false;
    if (!isOwner) {
      if (prisma.trackedList?.findFirst) {
        const tracked = await prisma.trackedList.findFirst({
          where: {
            listId,
            userId,
            userType,
          },
        });
        isTracking = !!tracked;
      } else {
        console.warn('TrackedList model not available in Prisma client. Skipping tracking permission check.');
      }
    }

    if (!isOwner && !isTracking) {
      return res.status(403).json({ error: 'You do not have permission to modify this list.' });
    }
    // --- End Authorization Check ---


    // Find the list product to update
    let listProduct;
    if (listProductId) {
      listProduct = await prisma.listProduct.findFirst({ where: { id: listProductId, listId } });
    } else {
      listProduct = await prisma.listProduct.findFirst({ where: { listId, productAtShopId } });
    }

    if (!listProduct) {
      console.log('❌ Product not found in list:', { listId, productAtShopId, listProductId });
      return res.status(404).json({ error: 'Product not found in list' });
    }

    // If quantity is 0, remove the product from the list
    if (quantity === 0) {
      await prisma.listProduct.delete({
        where: { id: listProduct.id },
      });

      // Invalidate cache and emit socket event for removal
      await cacheService.invalidateListDetail(listId);
      if (originalList.shopId && req.io) {
        req.io.to(`shop_${originalList.shopId}_lists`).emit('list_product_removed', {
          listId,
          listProductId: listProduct.id,
        });
        console.log(`📡 Emitted list_product_removed to shop_${originalList.shopId}_lists`);
      }
      return res.json({ message: 'Product removed from list' });
    }

    // Otherwise, update the quantity
    const updatedProduct = await prisma.listProduct.update({
      where: { id: listProduct.id },
      data: { quantity },
      include: {
        productAtShop: {
          include: { product: true, shop: true },
        },
      },
    });

    // Invalidate cache
    await cacheService.invalidateListDetail(listId);

    // Emit socket event for shop list sync using the original list's shopId
    if (originalList.shopId && req.io) {
      req.io.to(`shop_${originalList.shopId}_lists`).emit('list_product_updated', {
        listId,
        product: updatedProduct,
        action: 'quantity_changed'
      });
      console.log(`📡 Emitted list_product_updated to shop_${originalList.shopId}_lists`);
    }

    console.log('✅ Quantity updated:', { listProductId: listProduct.id, quantity });
    res.json({ message: 'Product quantity updated', product: updatedProduct });
  } catch (error) {
    console.error('Error updating product quantity:', error);
    res.status(500).json({ error: 'Failed to update product quantity' });
  }
});

// Toggle purchased status of a product in a list
router.put('/togglePurchased', authenticateToken, async (req, res) => {
  try {
    const { listId, listProductId } = req.body;
    const customerId = parseInt(req.user.id);

    console.log('✅ Toggle purchased request:', { listId, listProductId, customerId });

    if (!listId || !listProductId) {
      return res.status(400).json({ error: 'listId and listProductId are required' });
    }

    // Verify the list belongs to the user (with retry for Neon cold starts)
    const list = await withRetry(() => prisma.list.findFirst({
      where: {
        id: listId,
        customerId: customerId,
      },
    }));

    if (!list) {
      return res.status(404).json({ error: 'List not found' });
    }

    // Find the list product (with retry)
    const listProduct = await withRetry(() => prisma.listProduct.findFirst({
      where: {
        id: listProductId,
        listId,
      },
    }));

    if (!listProduct) {
      console.log('❌ Product not found in list:', { listId, listProductId });
      return res.status(404).json({ error: 'Product not found in list' });
    }

    console.log('🔄 Current isPurchased state:', listProduct.isPurchased);

    // Toggle the purchased status (with retry)
    const updatedProduct = await withRetry(() => prisma.listProduct.update({
      where: {
        id: listProduct.id,
      },
      data: {
        isPurchased: !listProduct.isPurchased,
      },
      include: {
        productAtShop: {
          include: {
            product: true,
            shop: true,
          },
        },
      },
    }));

    console.log('🔄 New isPurchased state:', updatedProduct.isPurchased);

    // Invalidate cache
    await cacheService.invalidateListDetail(listId);
    console.log('🗑️ Cache invalidated for list:', listId);

    // Emit socket event for shop list sync
    if (list.shopId && req.io) {
      req.io.to(`shop_${list.shopId}_lists`).emit('list_product_updated', {
        listId,
        product: updatedProduct,
        action: 'purchased_toggled',
        isPurchased: updatedProduct.isPurchased
      });
      console.log(`📡 Emitted list_product_updated to shop_${list.shopId}_lists`);
    }

    console.log('✅ Purchased status toggled:', { 
      listProductId: listProduct.id, 
      isPurchased: updatedProduct.isPurchased 
    });
    
    res.json({ 
      message: 'Product purchased status updated', 
      product: updatedProduct,
      isPurchased: updatedProduct.isPurchased
    });
  } catch (error) {
    console.error('Error toggling purchased status:', error);
    res.status(500).json({ error: 'Failed to toggle purchased status' });
  }
});

// Remove a product from a list
router.delete('/removeProduct', authenticateToken, async (req, res) => {
  try {
    const { listId, productAtShopId } = req.body;
    const customerId = parseInt(req.user.id);

    if (!listId || !productAtShopId) {
      return res.status(400).json({ error: 'listId and productAtShopId are required' });
    }

    // Verify the list belongs to the user
    const list = await prisma.list.findFirst({
      where: {
        id: listId,
        customerId: customerId,
      },
    });

    if (!list) {
      return res.status(404).json({ error: 'List not found' });
    }

    // Find and delete the list product
    const listProduct = await prisma.listProduct.findFirst({
      where: {
        listId,
        productAtShopId,
      },
    });

    if (!listProduct) {
      return res.status(404).json({ error: 'Product not found in list' });
    }

    await prisma.listProduct.delete({
      where: {
        id: listProduct.id,
      },
    });

    // Invalidate caches
    await cacheService.invalidateUserLists(customerId);
    await cacheService.invalidateListDetail(listId);
    console.log(`🗑️ Cache invalidated: list ${listId} (product removed)`);

    // Emit socket event for shop list sync
    if (list.shopId && req.io) {
      req.io.to(`shop_${list.shopId}_lists`).emit('list_product_removed', {
        listId,
        productAtShopId,
        listProductId: listProduct.id
      });
      console.log(`📡 Emitted list_product_removed to shop_${list.shopId}_lists`);
    }

    res.json({ message: 'Product removed from list' });
  } catch (error) {
    console.error('Error removing product from list:', error);
    res.status(500).json({ error: 'Failed to remove product from list' });
  }
});

// Delete a list
router.delete('/:id', authenticateToken, async (req, res) => {
  try {
    const listId = req.params.id;
    const customerId = parseInt(req.user.id);

    // Verify the list belongs to the user
    const list = await prisma.list.findFirst({
      where: {
        id: listId,
        customerId: customerId,
      },
    });

    if (!list) {
      return res.status(404).json({ error: 'List not found' });
    }

    // Delete the list (cascade will delete related list products)
    await prisma.list.delete({
      where: {
        id: listId,
      },
    });

    // Invalidate caches
    await cacheService.invalidateUserLists(customerId);
    await cacheService.invalidateListDetail(listId);
    console.log(`🗑️ Cache invalidated: list ${listId} deleted`);

    // Emit socket event for shop list sync
    if (list.shopId && req.io) {
      req.io.to(`shop_${list.shopId}_lists`).emit('list_deleted', {
        listId,
        shopId: list.shopId
      });
      console.log(`📡 Emitted list_deleted to shop_${list.shopId}_lists`);
    }

    res.json({ message: 'List deleted successfully' });
  } catch (error) {
    console.error('Error deleting list:', error);
    res.status(500).json({ error: 'Failed to delete list' });
  }
});

// Get lowest prices for products in a list
router.get('/:id/lowest-prices', authenticateToken, async (req, res) => {
  try {
    const listId = req.params.id;
    const customerId = parseInt(req.user.id);

    // Verify the list belongs to the user
    const list = await prisma.list.findFirst({
      where: {
        id: listId,
        customerId: customerId,
      },
      include: {
        products: {
          include: {
            productAtShop: {
              include: {
                product: true,
                shop: true,
              },
            },
          },
        },
      },
    });

    if (!list) {
      return res.status(404).json({ error: 'List not found' });
    }

    // Find all product prices for products in the list
    const productIds = list.products.map(p => p.productAtShop.productId);
    
    const allPrices = await prisma.productAtShop.findMany({
      where: {
        productId: {
          in: productIds,
        },
      },
      include: {
        product: true,
        shop: true,
      },
    });

    // Group prices by product and find lowest for each
    const lowestPrices = {};
    productIds.forEach(productId => {
      const prices = allPrices.filter(price => price.productId === productId);
      if (prices.length > 0) {
        lowestPrices[productId] = prices.reduce((lowest, current) => 
          current.price < lowest.price ? current : lowest
        );
      }
    });

    res.json({ lowestPrices });
  } catch (error) {
    console.error('Error fetching lowest prices:', error);
    res.status(500).json({ error: 'Failed to fetch lowest prices' });
  }
});

// Check bundle offers BEFORE adding a product (by productId)
// This is called before adding to show popup if bundle offer exists
router.post('/check-bundle-before-add', authenticateToken, async (req, res) => {
  try {
    const { productId, listId } = req.body;
    console.log('📦 Check bundle before add:', { productId, listId });

    if (!productId) {
      return res.status(400).json({ error: 'productId is required', hasOffers: false });
    }

    // Find the product in all shops (excluding out of stock)
    const productAtShops = await prisma.productAtShop.findMany({
      where: {
        productId,
        outOfStock: false,
      },
      include: {
        shop: true,
        product: true,
      },
    });

    if (productAtShops.length === 0) {
      return res.status(404).json({ 
        error: 'Product not available in any shop',
        hasOffers: false
      });
    }

    // Helper function to get effective price
    const getEffectivePrice = (productAtShop) => {
      const now = new Date();
      const hasActiveOffer = productAtShop.offerPrice !== null && 
        productAtShop.offerStartDate !== null &&
        productAtShop.offerEndDate !== null &&
        new Date(productAtShop.offerStartDate) <= now && 
        new Date(productAtShop.offerEndDate) >= now;
      
      return {
        price: parseFloat(hasActiveOffer ? productAtShop.offerPrice : productAtShop.price),
        originalPrice: parseFloat(productAtShop.price),
        offerPrice: hasActiveOffer ? parseFloat(productAtShop.offerPrice) : null,
        hasActiveOffer
      };
    };

    // Find the shop with the lowest effective price
    const lowestPriceEntry = productAtShops.reduce((lowest, current) => {
      const currentEffective = getEffectivePrice(current);
      const lowestEffective = getEffectivePrice(lowest);
      return currentEffective.price < lowestEffective.price ? current : lowest;
    });

    const productAtShopId = lowestPriceEntry.id;
    const shopId = lowestPriceEntry.shopId;
    const now = new Date();

    // Find active bundle promotions for this product at this shop
    const bundlePromotions = await prisma.bundlePromotion.findMany({
      where: {
        shopId,
        isActive: true,
        OR: [
          { startDate: null },
          { startDate: { lte: now } }
        ],
        AND: [
          {
            OR: [
              { endDate: null },
              { endDate: { gte: now } }
            ]
          }
        ],
        buyItems: {
          some: {
            productId
          }
        }
      },
      include: {
        buyItems: {
          include: {
            product: {
              select: { id: true, title: true, img: true, barcode: true }
            }
          }
        },
        getItems: {
          include: {
            product: {
              select: { id: true, title: true, img: true, barcode: true }
            }
          }
        }
      }
    });

    const effectivePrice = getEffectivePrice(lowestPriceEntry);

    // If product already in list, check current quantity
    let currentQuantityInList = 0;
    if (listId) {
      const existingProduct = await prisma.listProduct.findFirst({
        where: { 
          listId, 
          productAtShopId: {
            in: productAtShops.map(p => p.id)
          }
        }
      });
      if (existingProduct) {
        currentQuantityInList = existingProduct.quantity || 1;
      }
    }

    // Format the response with offer details
    const offers = bundlePromotions.map(promo => {
      const buyItem = promo.buyItems.find(bi => bi.productId === productId);
      const totalBuyQuantity = buyItem?.quantity || 1;
      const additionalNeeded = Math.max(0, totalBuyQuantity - currentQuantityInList);
      
      const freeItems = promo.getItems.map(gi => ({
        productId: gi.productId,
        productName: gi.product.title,
        productImage: gi.product.img,
        freeQuantity: gi.quantity
      }));

      return {
        bundlePromotionId: promo.id,
        name: promo.name,
        description: promo.description,
        promotionType: promo.promotionType,
        buyQuantityRequired: totalBuyQuantity,
        currentQuantityInList,
        additionalNeeded,
        isEligible: additionalNeeded === 0,
        freeItems,
        offerMessage: additionalNeeded > 0 
          ? `Add ${additionalNeeded} more to get ${freeItems.map(f => `${f.freeQuantity}x ${f.productName}`).join(', ')} FREE!`
          : `You qualify! Get ${freeItems.map(f => `${f.freeQuantity}x ${f.productName}`).join(', ')} FREE!`
      };
    });

    res.json({ 
      productId,
      productAtShopId,
      productName: lowestPriceEntry.product.title,
      productImage: lowestPriceEntry.product.img,
      productBarcode: lowestPriceEntry.product.barcode,
      shopId,
      shopName: lowestPriceEntry.shop.name,
      price: effectivePrice.price,
      originalPrice: effectivePrice.originalPrice,
      offerPrice: effectivePrice.offerPrice,
      hasActiveOffer: effectivePrice.hasActiveOffer,
      availableInShops: productAtShops.length,
      offers,
      hasOffers: offers.length > 0,
      currentQuantityInList
    });
  } catch (error) {
    console.error('Error checking bundle before add:', error);
    res.status(500).json({ error: 'Failed to check bundle offers', hasOffers: false });
  }
});

// Check bundle promotions for a product
router.get('/bundle-offers/:productAtShopId', authenticateToken, async (req, res) => {
  try {
    const { productAtShopId } = req.params;
    const { currentQuantity = 1 } = req.query;

    // Get the product and its shop
    const productAtShop = await prisma.productAtShop.findUnique({
      where: { id: productAtShopId },
      include: {
        product: true,
        shop: true,
      }
    });

    if (!productAtShop) {
      return res.status(404).json({ error: 'Product not found' });
    }

    const productId = productAtShop.productId;
    const shopId = productAtShop.shopId;
    const now = new Date();

    // Find active bundle promotions for this product at this shop
    const bundlePromotions = await prisma.bundlePromotion.findMany({
      where: {
        shopId,
        isActive: true,
        OR: [
          { startDate: null },
          { startDate: { lte: now } }
        ],
        AND: [
          {
            OR: [
              { endDate: null },
              { endDate: { gte: now } }
            ]
          }
        ],
        buyItems: {
          some: {
            productId
          }
        }
      },
      include: {
        buyItems: {
          include: {
            product: {
              select: { id: true, title: true, img: true }
            }
          }
        },
        getItems: {
          include: {
            product: {
              select: { id: true, title: true, img: true }
            }
          }
        }
      }
    });

    // Format the response with offer details
    const offers = bundlePromotions.map(promo => {
      const buyItem = promo.buyItems.find(bi => bi.productId === productId);
      const totalBuyQuantity = buyItem?.quantity || 1;
      const additionalNeeded = Math.max(0, totalBuyQuantity - parseInt(currentQuantity));
      
      const freeItems = promo.getItems.map(gi => ({
        productId: gi.productId,
        productName: gi.product.title,
        productImage: gi.product.img,
        freeQuantity: gi.quantity
      }));

      return {
        bundlePromotionId: promo.id,
        name: promo.name,
        description: promo.description,
        promotionType: promo.promotionType,
        buyQuantityRequired: totalBuyQuantity,
        currentQuantity: parseInt(currentQuantity),
        additionalNeeded,
        isEligible: additionalNeeded === 0,
        freeItems,
        // Generate user-friendly message
        offerMessage: additionalNeeded > 0 
          ? `Add ${additionalNeeded} more to get ${freeItems.map(f => `${f.freeQuantity}x ${f.productName}`).join(', ')} FREE!`
          : `You qualify! Get ${freeItems.map(f => `${f.freeQuantity}x ${f.productName}`).join(', ')} FREE!`
      };
    });

    res.json({ 
      productId,
      productName: productAtShop.product.title,
      offers,
      hasOffers: offers.length > 0
    });
  } catch (error) {
    console.error('Error checking bundle offers:', error);
    res.status(500).json({ error: 'Failed to check bundle offers' });
  }
});

// Claim a bundle offer and add products to list
router.post('/claim-bundle', authenticateToken, async (req, res) => {
  try {
    const { listId, productAtShopId, bundlePromotionId, quantity } = req.body;
    const userId = parseInt(req.user.id);
    const userType = req.user.userType;

    if (!listId || !productAtShopId || !bundlePromotionId || !quantity) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Build ownership check
    let ownershipCheck;
    if (userType === 'EMPLOYEE') {
      ownershipCheck = { id: listId, employeeId: userId };
    } else if (userType === 'ADMIN') {
      ownershipCheck = { id: listId, adminId: userId };
    } else {
      ownershipCheck = { id: listId, customerId: userId };
    }

    // Verify list ownership
    const list = await prisma.list.findFirst({
      where: ownershipCheck
    });

    if (!list) {
      return res.status(404).json({ error: 'List not found or access denied' });
    }

    // Get the bundle promotion with items
    const bundlePromotion = await prisma.bundlePromotion.findUnique({
      where: { id: bundlePromotionId },
      include: {
        buyItems: {
          include: {
            product: true
          }
        },
        getItems: {
          include: {
            product: true
          }
        }
      }
    });

    if (!bundlePromotion || !bundlePromotion.isActive) {
      return res.status(404).json({ error: 'Bundle promotion not found or inactive' });
    }

    // Get product details
    const productAtShop = await prisma.productAtShop.findUnique({
      where: { id: productAtShopId },
      include: { product: true, shop: true }
    });

    if (!productAtShop) {
      return res.status(404).json({ error: 'Product not found' });
    }

    // Verify quantity meets bundle requirement
    const buyItem = bundlePromotion.buyItems.find(bi => bi.productId === productAtShop.productId);
    if (!buyItem || quantity < buyItem.quantity) {
      return res.status(400).json({ 
        error: `Need at least ${buyItem?.quantity || 1} items to claim this offer` 
      });
    }

    // Calculate free items earned
    const bundlesEarned = Math.floor(quantity / buyItem.quantity);
    
    // Start transaction to add/update products
    const result = await prisma.$transaction(async (tx) => {
      // Check if main product already exists in list
      const existingProduct = await tx.listProduct.findFirst({
        where: { listId, productAtShopId }
      });

      let mainProduct;
      const freeQuantityForMain = bundlePromotion.getItems
        .filter(gi => gi.productId === productAtShop.productId)
        .reduce((sum, gi) => sum + (gi.quantity * bundlesEarned), 0);

      if (existingProduct) {
        // Update existing product
        mainProduct = await tx.listProduct.update({
          where: { id: existingProduct.id },
          data: {
            quantity,
            freeQuantity: freeQuantityForMain,
            bundlePromotionId: freeQuantityForMain > 0 ? bundlePromotionId : existingProduct.bundlePromotionId,
            isFreeItem: false
          },
          include: {
            productAtShop: {
              include: { product: true, shop: true }
            }
          }
        });
      } else {
        // Create new product entry
        mainProduct = await tx.listProduct.create({
          data: {
            listId,
            productAtShopId,
            quantity,
            freeQuantity: freeQuantityForMain,
            bundlePromotionId: freeQuantityForMain > 0 ? bundlePromotionId : null,
            isFreeItem: false
          },
          include: {
            productAtShop: {
              include: { product: true, shop: true }
            }
          }
        });
      }

      // Add free items that are different products
      const freeProducts = [];
      for (const getItem of bundlePromotion.getItems) {
        // Skip if it's the same product (already handled above)
        if (getItem.productId === productAtShop.productId) continue;

        const freeQty = getItem.quantity * bundlesEarned;
        if (freeQty <= 0) continue;

        // Find productAtShop for the free item in the same shop
        const freeProductAtShop = await tx.productAtShop.findFirst({
          where: {
            productId: getItem.productId,
            shopId: productAtShop.shopId
          }
        });

        if (!freeProductAtShop) continue;

        // Check if free product already in list
        const existingFreeProduct = await tx.listProduct.findFirst({
          where: { 
            listId, 
            productAtShopId: freeProductAtShop.id 
          }
        });

        let freeProduct;
        if (existingFreeProduct) {
          freeProduct = await tx.listProduct.update({
            where: { id: existingFreeProduct.id },
            data: {
              quantity: existingFreeProduct.quantity + freeQty,
              freeQuantity: (existingFreeProduct.freeQuantity || 0) + freeQty,
              bundlePromotionId,
              isFreeItem: true
            },
            include: {
              productAtShop: {
                include: { product: true, shop: true }
              }
            }
          });
        } else {
          freeProduct = await tx.listProduct.create({
            data: {
              listId,
              productAtShopId: freeProductAtShop.id,
              quantity: freeQty,
              freeQuantity: freeQty,
              bundlePromotionId,
              isFreeItem: true
            },
            include: {
              productAtShop: {
                include: { product: true, shop: true }
              }
            }
          });
        }
        freeProducts.push(freeProduct);
      }

      return { mainProduct, freeProducts };
    });

    // Invalidate caches
    if (userType === 'CUSTOMER') {
      await cacheService.invalidateUserLists(userId);
      await cacheService.invalidateListDetail(listId);
    }

    res.json({
      success: true,
      message: 'Bundle offer claimed!',
      mainProduct: result.mainProduct,
      freeProducts: result.freeProducts,
      bundlePromotion: {
        id: bundlePromotion.id,
        name: bundlePromotion.name
      }
    });
  } catch (error) {
    console.error('Error claiming bundle offer:', error);
    res.status(500).json({ error: 'Failed to claim bundle offer' });
  }
});

export default router;