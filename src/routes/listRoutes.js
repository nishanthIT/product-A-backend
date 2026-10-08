import express from 'express';
import { PrismaClient } from '@prisma/client';
import { isAuthenticated, requireShopFeature } from '../middleware/authware.js';
import { SHOP_FEATURES } from '../services/accessControl.js';
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

// Shared auth; employees additionally need an ACTIVE shop membership to touch lists
const authenticateToken = [isAuthenticated, requireShopFeature(SHOP_FEATURES.LISTS)];

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
            // cuid ids are time-ordered, so id desc = newest first
            orderBy: { id: 'desc' },
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
            orderBy: { id: 'desc' },
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
            orderBy: { id: 'desc' },
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
            id: 'desc',
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
      // Customer can view own lists + tracked lists, and read any list created in their own shop (e.g. an employee's).
      const customer = await prisma.customer.findUnique({ where: { id: userId }, select: { shopId: true } });
      const OR = [{ customerId: userId }];
      if (trackingSupported) OR.push({ trackedBy: { some: { userId, userType } } });
      if (customer?.shopId) OR.push({ shopId: customer.shopId });
      whereClause = { id: listId, OR };
    }

    const list = await withRetry(() => prisma.list.findFirst({
      where: whereClause,
      include: {
        products: {
          // cuid ids are time-ordered, so id desc = newest first
          orderBy: { id: 'desc' },
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
        },
        ...(trackingSupported && {
          trackedBy: { where: { userId, userType }, select: { id: true } },
        }),
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
      caseBarcode: lp.productAtShop?.product?.caseBarcode || '',
      retailSize: lp.productAtShop?.product?.retailSize || '',
      caseSize: lp.productAtShop?.product?.caseSize || '',
      packetSize: lp.productAtShop?.product?.packetSize || '',
      aielNumber: lp.productAtShop?.card_aiel_number || '',
      locationCode: lp.productAtShop?.locationCode || '',
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
      isUrgent: lp.isUrgent || false,
      inHandStock: lp.productAtShop?.inHandStock ?? null,
      // Bundle offer fields
      isFreeItem: lp.isFreeItem || false,
      freeQuantity: lp.freeQuantity || 0,
      bundlePromotionId: lp.bundlePromotionId || null,
    }));

    console.log('📦 Database isPurchased states:', transformedProducts.map(p => ({ id: p.id, name: p.productName, isPurchased: p.isPurchased })));

    const { trackedBy, ...listFields } = list;
    const isMine = userType === 'EMPLOYEE'
      ? list.employeeId === userId
      : userType === 'ADMIN'
      ? list.adminId === userId
      : list.customerId === userId;
    const copiedByMe = (trackedBy?.length ?? 0) > 0;
    const responseData = {
      ...listFields,
      products: transformedProducts,
      createdByName: list.employee?.name || list.admin?.name || null,
      copiedByMe,
      canEdit: isMine || copiedByMe,
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
    const userId = parseInt(req.user.id);
    const userType = req.user.userType;

    console.log('✅ Toggle purchased request:', { listId, listProductId, userId, userType });

    if (!listId || !listProductId) {
      return res.status(400).json({ error: 'listId and listProductId are required' });
    }

    const trackingSupported = !!prisma.trackedList?.findFirst;

    // Build a role-aware ownership check (same policy as GET /lists/:id)
    let whereClause = { id: listId };

    if (userType === 'ADMIN') {
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

    // Verify the list is accessible by current user (with retry for Neon cold starts)
    const list = await withRetry(() => prisma.list.findFirst({
      where: whereClause,
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

// Toggle the urgent flag on a list item (same ownership policy as togglePurchased)
router.put('/toggleUrgent', authenticateToken, async (req, res) => {
  try {
    const { listId, listProductId } = req.body;
    const userId = parseInt(req.user.id);
    const userType = req.user.userType;

    if (!listId || !listProductId) {
      return res.status(400).json({ error: 'listId and listProductId are required' });
    }

    const trackingSupported = !!prisma.trackedList?.findFirst;
    let whereClause = { id: listId };

    if (userType === 'ADMIN') {
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
      whereClause = trackingSupported
        ? { id: listId, OR: [{ employeeId: userId }, { trackedBy: { some: { userId, userType } } }] }
        : { id: listId, employeeId: userId };
    } else {
      whereClause = trackingSupported
        ? { id: listId, OR: [{ customerId: userId }, { trackedBy: { some: { userId, userType } } }] }
        : { id: listId, customerId: userId };
    }

    const list = await withRetry(() => prisma.list.findFirst({ where: whereClause }));
    if (!list) {
      return res.status(404).json({ error: 'List not found' });
    }

    const listProduct = await withRetry(() => prisma.listProduct.findFirst({
      where: { id: listProductId, listId },
    }));
    if (!listProduct) {
      return res.status(404).json({ error: 'Product not found in list' });
    }

    const updatedProduct = await withRetry(() => prisma.listProduct.update({
      where: { id: listProduct.id },
      data: { isUrgent: !listProduct.isUrgent },
      include: { productAtShop: { include: { product: true, shop: true } } },
    }));

    await cacheService.invalidateListDetail(listId);

    if (list.shopId && req.io) {
      req.io.to(`shop_${list.shopId}_lists`).emit('list_product_updated', {
        listId,
        product: updatedProduct,
        action: 'urgent_toggled',
        isUrgent: updatedProduct.isUrgent
      });
    }

    res.json({
      message: 'Product urgent status updated',
      product: updatedProduct,
      isUrgent: updatedProduct.isUrgent
    });
  } catch (error) {
    console.error('Error toggling urgent status:', error);
    res.status(500).json({ error: 'Failed to toggle urgent status' });
  }
});

// Move a list item to the SAME product at a different shop (Collect Mode)
router.put('/changeShop', authenticateToken, async (req, res) => {
  try {
    const { listId, listProductId, productAtShopId } = req.body;
    const userId = parseInt(req.user.id);
    const userType = req.user.userType;

    if (!listId || !listProductId || !productAtShopId) {
      return res.status(400).json({ error: 'listId, listProductId and productAtShopId are required' });
    }

    const trackingSupported = !!prisma.trackedList?.findFirst;
    let whereClause = { id: listId };

    if (userType === 'ADMIN') {
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
      whereClause = trackingSupported
        ? { id: listId, OR: [{ employeeId: userId }, { trackedBy: { some: { userId, userType } } }] }
        : { id: listId, employeeId: userId };
    } else {
      whereClause = trackingSupported
        ? { id: listId, OR: [{ customerId: userId }, { trackedBy: { some: { userId, userType } } }] }
        : { id: listId, customerId: userId };
    }

    const list = await withRetry(() => prisma.list.findFirst({ where: whereClause }));
    if (!list) {
      return res.status(404).json({ error: 'List not found' });
    }

    const listProduct = await withRetry(() => prisma.listProduct.findFirst({
      where: { id: listProductId, listId },
      include: { productAtShop: true },
    }));
    if (!listProduct) {
      return res.status(404).json({ error: 'Product not found in list' });
    }
    if (listProduct.bundlePromotionId) {
      return res.status(400).json({ error: 'Bundle items cannot be moved to another shop' });
    }

    const target = await withRetry(() => prisma.productAtShop.findUnique({
      where: { id: productAtShopId },
      include: { shop: true },
    }));
    if (!target) {
      return res.status(404).json({ error: 'Product not available at that shop' });
    }
    if (target.productId !== listProduct.productAtShop.productId) {
      return res.status(400).json({ error: 'Target shop does not stock this product' });
    }
    if (target.id === listProduct.productAtShopId) {
      return res.status(400).json({ error: 'Item is already assigned to this shop' });
    }

    // If the list already has this product at the target shop, merge quantities.
    const existing = await prisma.listProduct.findFirst({
      where: { listId, productAtShopId: target.id, NOT: { id: listProduct.id } },
    });

    let updatedProduct;
    if (existing) {
      updatedProduct = await prisma.listProduct.update({
        where: { id: existing.id },
        data: {
          quantity: (existing.quantity || 1) + (listProduct.quantity || 1),
          isUrgent: existing.isUrgent || listProduct.isUrgent,
        },
        include: { productAtShop: { include: { product: true, shop: true } } },
      });
      await prisma.listProduct.delete({ where: { id: listProduct.id } });
    } else {
      updatedProduct = await prisma.listProduct.update({
        where: { id: listProduct.id },
        data: { productAtShopId: target.id },
        include: { productAtShop: { include: { product: true, shop: true } } },
      });
    }

    await cacheService.invalidateListDetail(listId);

    if (list.shopId && req.io) {
      req.io.to(`shop_${list.shopId}_lists`).emit('list_product_updated', {
        listId,
        product: updatedProduct,
        action: 'shop_changed',
      });
    }

    res.json({
      message: `Moved to ${target.shop.name}`,
      product: updatedProduct,
      merged: !!existing,
    });
  } catch (error) {
    console.error('Error changing product shop:', error);
    res.status(500).json({ error: 'Failed to move product to another shop' });
  }
});

// Lists the user may modify: their own, tracked ones, and (admins) their shop's employee lists.
const buildListAccessWhere = async (listId, userId, userType) => {
  const trackingSupported = !!prisma.trackedList?.findFirst;
  if (userType === 'ADMIN') {
    const admin = await prisma.admin.findUnique({ where: { id: userId }, select: { shopId: true } });
    return { id: listId, OR: [{ adminId: userId }, { employee: { shopId: admin?.shopId } }] };
  }
  const ownerField = userType === 'EMPLOYEE' ? 'employeeId' : 'customerId';
  return trackingSupported
    ? { id: listId, OR: [{ [ownerField]: userId }, { trackedBy: { some: { userId, userType } } }] }
    : { id: listId, [ownerField]: userId };
};

const loadMovableListProduct = async (req, res) => {
  const { listId, listProductId } = req.body;
  const userId = parseInt(req.user.id);
  const userType = req.user.userType;

  if (!listId || !listProductId) {
    res.status(400).json({ error: 'listId and listProductId are required' });
    return null;
  }

  const list = await withRetry(async () =>
    prisma.list.findFirst({ where: await buildListAccessWhere(listId, userId, userType) }));
  if (!list) {
    res.status(404).json({ error: 'List not found' });
    return null;
  }

  const listProduct = await withRetry(() => prisma.listProduct.findFirst({
    where: { id: listProductId, listId },
    include: { productAtShop: { include: { shop: true } } },
  }));
  if (!listProduct) {
    res.status(404).json({ error: 'Product not found in list' });
    return null;
  }
  if (listProduct.bundlePromotionId) {
    res.status(400).json({ error: 'Bundle items cannot be moved to another list' });
    return null;
  }

  return { list, listProduct, userId, userType };
};

// Moves a list item into targetList, merging with the same shop product if already there.
const moveListProductToList = async (req, { list, listProduct, targetList, userId }) => {
  const existing = await prisma.listProduct.findFirst({
    where: { listId: targetList.id, productAtShopId: listProduct.productAtShopId, bundlePromotionId: null },
  });

  if (existing) {
    await prisma.$transaction([
      prisma.listProduct.update({
        where: { id: existing.id },
        data: {
          quantity: (existing.quantity || 1) + (listProduct.quantity || 1),
          isUrgent: existing.isUrgent || listProduct.isUrgent,
          isPurchased: false,
        },
      }),
      prisma.listProduct.delete({ where: { id: listProduct.id } }),
    ]);
  } else {
    await prisma.listProduct.update({
      where: { id: listProduct.id },
      data: { listId: targetList.id, isPurchased: false },
    });
  }

  await Promise.all([
    cacheService.invalidateListDetail(list.id),
    cacheService.invalidateListDetail(targetList.id),
    cacheService.invalidateUserLists(userId),
  ]);

  if (req.io) {
    const productId = listProduct.productAtShop?.productId;
    if (list.shopId) {
      req.io.to(`shop_${list.shopId}_lists`).emit('list_product_removed', { listId: list.id, productId });
    }
    if (targetList.shopId) {
      req.io.to(`shop_${targetList.shopId}_lists`).emit('list_product_added', { listId: targetList.id, productId });
    }
  }

  return { merged: !!existing };
};

// Move a list item to another of the user's lists (Collect Mode — product unavailable)
router.put('/moveToList', authenticateToken, async (req, res) => {
  try {
    const { targetListId } = req.body;
    if (!targetListId) {
      return res.status(400).json({ error: 'targetListId is required' });
    }

    const ctx = await loadMovableListProduct(req, res);
    if (!ctx) return;

    if (targetListId === ctx.list.id) {
      return res.status(400).json({ error: 'Item is already in this list' });
    }

    const targetList = await withRetry(async () =>
      prisma.list.findFirst({ where: await buildListAccessWhere(targetListId, ctx.userId, ctx.userType) }));
    if (!targetList) {
      return res.status(404).json({ error: 'Target list not found' });
    }

    const { merged } = await moveListProductToList(req, { ...ctx, targetList });

    res.json({
      message: `Moved to ${targetList.name}`,
      targetListId: targetList.id,
      targetListName: targetList.name,
      merged,
    });
  } catch (error) {
    console.error('Error moving product to another list:', error);
    res.status(500).json({ error: 'Failed to move product to another list' });
  }
});

// Mark a list item out of stock: move it into the user's "Out of Stock · <shop>" list (created on demand)
router.put('/markOutOfStock', authenticateToken, async (req, res) => {
  try {
    const ctx = await loadMovableListProduct(req, res);
    if (!ctx) return;
    const { userId, userType, listProduct } = ctx;

    const shopName = listProduct.productAtShop?.shop?.name || 'Unknown Shop';
    const outOfStockName = `Out of Stock · ${shopName}`;

    if (ctx.list.name === outOfStockName) {
      return res.status(400).json({ error: 'Item is already in the Out of Stock list' });
    }

    const ownerField = userType === 'EMPLOYEE' ? 'employeeId' : userType === 'ADMIN' ? 'adminId' : 'customerId';
    let targetList = await withRetry(() => prisma.list.findFirst({
      where: { [ownerField]: userId, name: outOfStockName },
      orderBy: { createdAt: 'asc' },
    }));

    let created = false;
    if (!targetList) {
      const listData = {
        name: outOfStockName,
        description: `Out of stock at ${shopName} — buy later / restock`,
        creatorType: userType,
        [ownerField]: userId,
      };
      if (userType === 'EMPLOYEE') {
        const employee = await prisma.empolyee.findUnique({ where: { id: userId }, select: { shopId: true } });
        listData.shopId = employee?.shopId;
      } else if (userType === 'ADMIN') {
        const admin = await prisma.admin.findUnique({ where: { id: userId }, select: { shopId: true } });
        listData.shopId = admin?.shopId;
      }
      targetList = await prisma.list.create({ data: listData });
      created = true;

      if (targetList.shopId && req.io) {
        req.io.to(`shop_${targetList.shopId}_lists`).emit('list_created', { listId: targetList.id });
      }
    }

    const { merged } = await moveListProductToList(req, { ...ctx, targetList });

    res.json({
      message: `Moved to ${targetList.name}`,
      targetListId: targetList.id,
      targetListName: targetList.name,
      created,
      merged,
    });
  } catch (error) {
    console.error('Error marking product out of stock:', error);
    res.status(500).json({ error: 'Failed to mark product as out of stock' });
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

    // Bundles are often configured on a sibling variant row (same title with a
    // different pack size, or the case barcode instead of the unit barcode), so
    // match against the scanned product AND all of its variants. Done as a
    // single self-join query — the DB is remote, so round trips dominate latency.
    const candidateRows = await prisma.$queryRaw`
      SELECT p2.id
      FROM "Product" p1
      JOIN "Product" p2 ON (
        p2.id = p1.id OR
        (p1.title IS NOT NULL AND LOWER(p2.title) = LOWER(p1.title)) OR
        (p1.barcode IS NOT NULL AND (p2.barcode = p1.barcode OR p2."caseBarcode" = p1.barcode)) OR
        (p1."caseBarcode" IS NOT NULL AND (p2.barcode = p1."caseBarcode" OR p2."caseBarcode" = p1."caseBarcode"))
      )
      WHERE p1.id = ${productId}
      LIMIT 50
    `;
    if (candidateRows.length === 0) {
      // The self-join always matches the product itself, so no rows = not found.
      return res.status(404).json({ error: 'Product not found', hasOffers: false });
    }
    const candidateIds = [...new Set(candidateRows.map(r => r.id))];
    const candidateIdSet = new Set(candidateIds);

    const now = new Date();

    // Fetch stock, promotions, and existing list rows in parallel — they only
    // depend on the candidate IDs, not on each other.
    const [allCandidateAtShops, bundlePromotions, existingListProducts] = await Promise.all([
      prisma.productAtShop.findMany({
        where: {
          productId: { in: candidateIds },
          outOfStock: false,
        },
        include: {
          shop: true,
          product: true,
        },
      }),
      // Active bundle promotions at ANY shop stocking this product or a variant —
      // the offer often lives at a different shop (or on a different variant row)
      // than the scanned/cheapest one.
      prisma.bundlePromotion.findMany({
        where: {
          shop: {
            products: {
              some: { productId: { in: candidateIds }, outOfStock: false },
            },
          },
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
              productId: { in: candidateIds }
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
      }),
      listId
        ? prisma.listProduct.findMany({
            where: {
              listId,
              productAtShop: { productId: { in: candidateIds } },
            },
            select: {
              quantity: true,
              productAtShop: { select: { productId: true } },
            },
          })
        : Promise.resolve([]),
    ]);

    const productAtShops = allCandidateAtShops.filter(p => p.productId === productId);

    if (productAtShops.length === 0) {
      return res.json({
        productId,
        offers: [],
        hasOffers: false,
        error: 'Product not available in any shop',
      });
    }

    // Helper function to get effective price (uses the real schema field)
    const getEffectivePrice = (productAtShop) => {
      const now = new Date();
      const hasActiveOffer = productAtShop.offerPrice != null &&
        productAtShop.offerExpiryDate != null &&
        new Date(productAtShop.offerExpiryDate) >= now;

      return {
        price: parseFloat(hasActiveOffer ? productAtShop.offerPrice : productAtShop.price),
        originalPrice: parseFloat(productAtShop.price),
        offerPrice: hasActiveOffer ? parseFloat(productAtShop.offerPrice) : null,
        hasActiveOffer
      };
    };

    // Cheapest shop overall — used for pricing and as a fallback target.
    const lowestPriceEntry = productAtShops.reduce((lowest, current) => {
      const currentEffective = getEffectivePrice(current);
      const lowestEffective = getEffectivePrice(lowest);
      return currentEffective.price < lowestEffective.price ? current : lowest;
    });

    // Claiming a bundle needs a productAtShop for the BUY item's product at the
    // SAME shop as the promotion (free items are resolved at that shop). Pick
    // the first promotion that is actually claimable and surface only offers
    // for that shop + product so the quantity math stays coherent.
    let selectedEntry = lowestPriceEntry;
    const activeBundlePromotions = [];
    for (const promo of bundlePromotions) {
      const buyItem = promo.buyItems.find(bi => candidateIdSet.has(bi.productId));
      const entry = buyItem
        ? allCandidateAtShops.find(
            p => p.shopId === promo.shopId && p.productId === buyItem.productId
          )
        : null;
      if (!entry) continue;
      if (activeBundlePromotions.length === 0) selectedEntry = entry;
      if (entry.shopId === selectedEntry.shopId && entry.productId === selectedEntry.productId) {
        activeBundlePromotions.push(promo);
      }
    }

    const productAtShopId = selectedEntry.id;
    const shopId = selectedEntry.shopId;
    const effectivePrice = getEffectivePrice(selectedEntry);

    // If product already in list, check current quantity (rows prefetched above).
    let currentQuantityInList = 0;
    const existingProduct = existingListProducts.find(
      lp => lp.productAtShop.productId === selectedEntry.productId
    );
    if (existingProduct) {
      currentQuantityInList = existingProduct.quantity || 1;
    }

    // Format the response with offer details
    const offers = activeBundlePromotions.map(promo => {
      const buyItem =
        promo.buyItems.find(bi => bi.productId === selectedEntry.productId) ??
        promo.buyItems.find(bi => candidateIdSet.has(bi.productId));
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

    console.log(`📦 Bundle check result for ${productId}: ${offers.length} offer(s), candidates=${candidateIds.length}, promos matched=${bundlePromotions.length}`);

    res.json({ 
      productId,
      productAtShopId,
      productName: selectedEntry.product.title,
      productImage: selectedEntry.product.img,
      productBarcode: selectedEntry.product.barcode,
      shopId,
      shopName: selectedEntry.shop.name,
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

    // Build ownership check (owner or tracker, so shared lists work too)
    const trackingSupported = !!prisma.trackedList?.findFirst;
    let ownershipOr;
    if (userType === 'EMPLOYEE') {
      ownershipOr = [{ employeeId: userId }];
    } else if (userType === 'ADMIN') {
      ownershipOr = [{ adminId: userId }];
    } else {
      ownershipOr = [{ customerId: userId }];
    }
    if (trackingSupported) {
      ownershipOr.push({ trackedBy: { some: { userId, userType } } });
    }

    // Verify list ownership
    const list = await prisma.list.findFirst({
      where: { id: listId, OR: ownershipOr }
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

    // Keep the shared list in sync for everyone watching this shop
    if (list.shopId && req.io) {
      req.io.to(`shop_${list.shopId}_lists`).emit('list_product_added', {
        listId,
        action: 'bundle_claimed'
      });
      console.log(`📡 Emitted list_product_added (bundle) to shop_${list.shopId}_lists`);
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