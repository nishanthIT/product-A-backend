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
    const customerId = parseInt(req.user.id);
    
    // Try cache first
    const cachedLists = await cacheService.getCachedUserLists(customerId);
    if (cachedLists) {
      return res.json(cachedLists);
    }

    const lists = await prisma.list.findMany({
      where: {
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

    // Cache the result
    await cacheService.cacheUserLists(customerId, lists);

    res.json(lists);
  } catch (error) {
    console.error('Error fetching lists:', error);
    res.status(500).json({ error: 'Failed to fetch lists' });
  }
});

// Get a specific list by ID
router.get('/:id', authenticateToken, async (req, res) => {
  try {
    const listId = req.params.id;
    const customerId = parseInt(req.user.id);
    
    // Skip cache check - always fetch fresh data to avoid race conditions with togglePurchased
    console.log('📦 Fetching list from DATABASE (no cache):', listId);

    const list = await withRetry(() => prisma.list.findFirst({
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
    const customerId = parseInt(req.user.id);

    if (!name) {
      return res.status(400).json({ error: 'List name is required' });
    }

    const newList = await prisma.list.create({
      data: {
        name,
        description: description || '',
        customerId,
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

    // Invalidate user's list cache
    await cacheService.invalidateUserLists(customerId);
    console.log(`🗑️ Cache invalidated: user ${customerId} lists (new list created)`);

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

      // Invalidate caches
      await cacheService.invalidateUserLists(customerId);
      await cacheService.invalidateListDetail(listId);

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
      await cacheService.invalidateUserLists(customerId);
      await cacheService.invalidateListDetail(listId);
      console.log(`🗑️ Cache invalidated: list ${listId} (product added)`);

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
    const customerId = parseInt(req.user.id);

    console.log('📦 Update quantity request:', { listId, productAtShopId, listProductId, quantity, customerId });

    if (!listId || (!productAtShopId && !listProductId) || quantity === undefined) {
      return res.status(400).json({ error: 'listId, productAtShopId (or listProductId), and quantity are required' });
    }

    if (quantity < 1) {
      return res.status(400).json({ error: 'Quantity must be at least 1' });
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

    // Find the list product - support both productAtShopId and listProductId
    let listProduct;
    if (listProductId) {
      listProduct = await prisma.listProduct.findFirst({
        where: {
          id: listProductId,
          listId,
        },
      });
    } else {
      listProduct = await prisma.listProduct.findFirst({
        where: {
          listId,
          productAtShopId,
        },
      });
    }

    if (!listProduct) {
      console.log('❌ Product not found in list:', { listId, productAtShopId, listProductId });
      return res.status(404).json({ error: 'Product not found in list' });
    }

    // Update the quantity
    const updatedProduct = await prisma.listProduct.update({
      where: {
        id: listProduct.id,
      },
      data: {
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

    // Invalidate cache
    await cacheService.invalidateListDetail(listId);

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

export default router;