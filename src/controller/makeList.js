import { PrismaClient } from "@prisma/client";
import cacheService from '../services/cacheService.js';

const prisma = new PrismaClient();

// Cache TTL for lists (in seconds)
const LIST_CACHE_TTL = 300; // 5 minutes
const LIST_DETAIL_CACHE_TTL = 180; // 3 minutes

// Helper function to get effective price (considering active offers)
const getEffectivePrice = (productAtShop) => {
  const currentDate = new Date();
  const hasActiveOffer = productAtShop.offerPrice && 
                        productAtShop.offerExpiryDate && 
                        new Date(productAtShop.offerExpiryDate) > currentDate;
  
  const effectivePrice = hasActiveOffer ? productAtShop.offerPrice : productAtShop.price;
  return {
    price: parseFloat(effectivePrice),
    originalPrice: parseFloat(productAtShop.price),
    offerPrice: productAtShop.offerPrice ? parseFloat(productAtShop.offerPrice) : null,
    hasActiveOffer,
    shopName: productAtShop.shop.name
  };
};

const makeList = async (req, res) => {
  // Get userId from authenticated user (from JWT token via middleware)
  const userId = req.user?.id;
  const userType = req.user?.userType;
  
  // Customers and Employees can create lists
  if (userType !== 'CUSTOMER' && userType !== 'EMPLOYEE') {
    return res.status(403).json({ error: "Only customers and employees can create shopping lists" });
  }
  
  const { name, description } = req.body;

  if (!name) {
    return res.status(400).json({ error: "List name is required" });
  }

  try {
    // Build list data based on user type
    const listData = {
      name,
      description: description || '',
      creatorType: userType,
    };
    
    if (userType === 'EMPLOYEE') {
      // Get employee's shop
      const employee = await prisma.empolyee.findUnique({
        where: { id: userId },
        select: { shopId: true }
      });
      listData.employeeId = userId;
      listData.shopId = employee?.shopId;
    } else {
      listData.customerId = userId;
    }
    
    const list = await prisma.list.create({
      data: listData,
      include: {
        products: true, // Include products to get count
      },
    });
    
    // Format response to match getUserLists format
    const formattedList = {
      id: list.id,
      name: list.name,
      description: list.description,
      itemCount: list.products.length,
      createdAt: list.createdAt,
      updatedAt: list.updatedAt,
    };
    
    // Invalidate user's lists cache (for customers)
    if (userType === 'CUSTOMER') {
      await cacheService.invalidateUserLists(userId);
    }
    
    res.status(201).json(formattedList);
  } catch (error) {
    console.error("Error creating list:", error);
    res.status(500).json({ error: "Internal server error." });
  }
};

const addProductToList = async (req, res) => {
  const userId = req.user?.id;
  const userType = req.user?.userType;
  const { listId, productId } = req.body;

  // Customers and Employees can add products to lists
  if (userType !== 'CUSTOMER' && userType !== 'EMPLOYEE') {
    return res.status(403).json({ error: "Only customers and employees can add products to lists" });
  }

  if (!listId || !productId) {
    return res.status(400).json({ error: "listId and productId are required" });
  }

  try {
    // Check if the list exists and belongs to the user
    const list = await prisma.list.findUnique({
      where: {
        id: listId,
      },
      include: {
        customer: true,
      },
    });
    
    if (!list) {
      return res.status(404).json({ error: "List not found-e1" });
    }
    
    // Check ownership based on user type
    const isOwner = userType === 'EMPLOYEE' 
      ? list.employeeId === userId
      : list.customerId === userId;
    
    if (!isOwner) {
      return res.status(403).json({ error: "You don't have permission to modify this list" });
    }

    // Find the product in all shops (excluding out of stock)
    const productAtShops = await prisma.productAtShop.findMany({
      where: {
        productId,
        outOfStock: false, // Exclude out of stock products
      },
      include: {
        shop: true,
        product: true,
      },
    });

    console.log(`Found ${productAtShops.length} in-stock shops with product ${productId}`);

    if (productAtShops.length === 0) {
      // Check if product exists but is out of stock everywhere
      const outOfStockProducts = await prisma.productAtShop.count({
        where: {
          productId,
          outOfStock: true,
        },
      });
      
      if (outOfStockProducts > 0) {
        return res.status(404).json({ 
          error: "This product is currently out of stock in all shops." 
        });
      }
      
      return res.status(404).json({ 
        error: "Product not available in any shop yet. Please ask an employee to add it to a shop first." 
      });
    }

    // Check if product is already in the list
    const existingProducts = await prisma.listProduct.findMany({
      where: {
        listId,
        productAtShopId: {
          in: productAtShops.map(p => p.id),
        },
      },
    });

    if (existingProducts.length > 0) {
      // Product already exists - return success without error
      console.log(`Product ${productId} already in list ${listId} - returning success`);
      
      // Get the existing product details
      const existingEntry = await prisma.listProduct.findFirst({
        where: {
          listId,
          productAtShopId: {
            in: productAtShops.map(p => p.id),
          },
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

      return res.status(200).json({
        success: true,
        message: "Product is already in this list",
        alreadyExists: true,
        data: {
          productName: existingEntry.productAtShop.product.title,
          lowestPrice: parseFloat(existingEntry.productAtShop.price),
          shopName: existingEntry.productAtShop.shop.name,
          availableInShops: productAtShops.length,
        },
      });
    }

    // Find the shop with the lowest effective price (considering offers)
    const lowestPriceEntry = productAtShops.reduce((lowest, current) => {
      const currentEffective = getEffectivePrice(current);
      const lowestEffective = getEffectivePrice(lowest);
      return currentEffective.price < lowestEffective.price ? current : lowest;
    });

    const finalEffectivePrice = getEffectivePrice(lowestPriceEntry);
    console.log(`Adding product with lowest effective price: £${finalEffectivePrice.price} (${finalEffectivePrice.hasActiveOffer ? 'offer price' : 'regular price'}) at ${lowestPriceEntry.shop.name}`);

    // Add ONLY the productAtShop entry with the lowest price to the list
    const listProduct = await prisma.listProduct.create({
      data: {
        listId,
        productAtShopId: lowestPriceEntry.id,
      },
    });

    // Invalidate cache for this list and user's lists (before sending response)
    try {
      await cacheService.invalidateAllUserListCache(userId, listId);
    } catch (cacheError) {
      console.error("Cache invalidation error (non-fatal):", cacheError);
    }

    res.status(200).json({
      success: true,
      message: "Product added to list successfully.",
      data: {
        productName: lowestPriceEntry.product.title,
        lowestPrice: finalEffectivePrice.price,
        originalPrice: finalEffectivePrice.originalPrice,
        offerPrice: finalEffectivePrice.offerPrice,
        hasActiveOffer: finalEffectivePrice.hasActiveOffer,
        shopName: lowestPriceEntry.shop.name,
        availableInShops: productAtShops.length,
      },
    });
    
  } catch (error) {
    console.error("Error adding product to list:", error);
    res.status(500).json({ error: "Internal server error." });
  }
};

// --------------------------------------------------------------------------------

// Get lowest price for each product in a list
const getLowestPricesInList = async (req, res) => {
  const { listId } = req.body;
  const userId = req.user?.id;
  const userType = req.user?.userType;

  try {
    // Step 1: Verify the list belongs to the given user
    const list = await prisma.list.findUnique({
      where: { id: listId },
      include: { customer: true },
    });

    if (!list) {
      return res
        .status(404)
        .json({ error: "List not found." });
    }
    
    // Check ownership based on user type
    const isOwner = userType === 'EMPLOYEE' 
      ? list.employeeId === userId
      : list.customerId === userId;
    
    if (!isOwner) {
      return res
        .status(403)
        .json({ error: "You don't have permission to access this list." });
    }

    // Step 2: Fetch all products in the list along with their associated shops
    const productsInList = await prisma.listProduct.findMany({
      where: { listId },
      include: {
        productAtShop: {
          include: {
            product: true,
            shop: true,
          },
        },
      },
    });

    if (!productsInList.length) {
      return res.status(404).json({ error: "No products found in the list." });
    }

    // Step 3: Group products by shop and calculate lowest price for each product
    const shopsMap = new Map();

    productsInList.forEach((listProduct) => {
      const shop = listProduct.productAtShop.shop;
      const product = listProduct.productAtShop.product;
      const effectivePrice = getEffectivePrice(listProduct.productAtShop);

      if (!shopsMap.has(shop.id)) {
        shopsMap.set(shop.id, {
          shopName: shop.name,
          shopAddress: shop.address,
          shopMobile: shop.mobile,
          items: [],
        });
      }

      const shopData = shopsMap.get(shop.id);
      shopData.items.push({
        productId: product.id,
        productName: product.title,
        lowestPrice: effectivePrice.price,
        originalPrice: effectivePrice.originalPrice,
        offerPrice: effectivePrice.offerPrice,
        hasActiveOffer: effectivePrice.hasActiveOffer,
      });
    });

    // Step 4: Prepare response
    const response = Array.from(shopsMap.values());

    res.status(200).json({
      success: true,
      message: "Fetched products with their lowest prices grouped by shop.",
      data: response,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Internal server error." });
  }
};

const removeProductFromList = async (req, res) => {
  try {
    const userId = req.user?.id;
    const userType = req.user?.userType;
    const { listId, productId } = req.body;
    
    // Build where clause based on user type
    const whereClause = {
      id: listId,
      ...(userType === 'EMPLOYEE' 
        ? { employeeId: userId }
        : { customerId: userId })
    };
    
    // Verify the list exists and belongs to this user
    const list = await prisma.list.findFirst({
      where: whereClause
    });

    console.log('List found?', list ? 'YES' : 'NO');

    if (!list) {
      console.log('ERROR: List not found or does not belong to user');
      return res.status(404).json({ error: "List not found-e2" });
    }

    // Delete all ListProduct entries for this product in this list
    const deleted = await prisma.listProduct.deleteMany({
      where: {
        listId: listId,
        productAtShop: {
          productId: productId
        }
      }
    });

    console.log('Deleted count:', deleted.count);

    if (deleted.count === 0) {
      return res.status(404).json({ error: "Product not found in list" });
    }

    // Invalidate cache for this list and user's lists (only for customers)
    if (userType === 'CUSTOMER') {
      await cacheService.invalidateAllUserListCache(userId, listId);
    }

    return res.status(200).json({
      success: true,
      message: "Product removed from list"
    });

  } catch (error) {
    console.error("DELETE ERROR:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
};

// Get all lists for the authenticated user
const getUserLists = async (req, res) => {
  const userId = req.user?.id;
  const userType = req.user?.userType;
  
  // Customers and Employees have lists
  if (userType !== 'CUSTOMER' && userType !== 'EMPLOYEE') {
    return res.status(403).json({ error: "Only customers and employees can have shopping lists" });
  }

  try {
    // Try cache first (only for customers)
    if (userType === 'CUSTOMER') {
      const cachedLists = await cacheService.getCachedUserLists(userId);
      if (cachedLists) {
        console.log(`⚡ Returning cached lists for user ${userId}`);
        return res.status(200).json({ lists: cachedLists });
      }
    }

    // Build where clause based on user type
    const whereClause = userType === 'EMPLOYEE' 
      ? { employeeId: userId }
      : { customerId: userId };

    const lists = await prisma.list.findMany({
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
      },
      orderBy: {
        id: 'desc', // Most recent first
      },
    });

    // Group products by productId to count unique products
    const formattedLists = await Promise.all(lists.map(async (list) => {
      const uniqueProducts = new Set();
      list.products.forEach(lp => {
        uniqueProducts.add(lp.productAtShop.productId);
      });
      
      // If copied from another list, get the creator name
      let copiedFromName = null;
      if (list.copiedFromId) {
        const originalList = await prisma.list.findUnique({
          where: { id: list.copiedFromId },
          include: {
            employee: { select: { name: true } },
            customer: { select: { name: true } }
          }
        });
        if (originalList) {
          copiedFromName = originalList.employee?.name || originalList.customer?.name || 'Unknown';
        }
      }
      
      return {
        id: list.id,
        name: list.name,
        description: list.description,
        itemCount: uniqueProducts.size,
        copiedFromId: list.copiedFromId,
        copiedFromName: copiedFromName,
        createdAt: list.createdAt,
        updatedAt: list.updatedAt,
      };
    }));

    // Cache the result (only for customers)
    if (userType === 'CUSTOMER') {
      await cacheService.cacheUserLists(userId, formattedLists);
    }

    res.status(200).json({ lists: formattedLists });
  } catch (error) {
    console.error("Error fetching lists:", error);
    res.status(500).json({ error: "Internal server error" });
  }
};

// Get a specific list by ID
const getListById = async (req, res) => {
  console.log("Yes i am printing from here-------")
  const userId = req.user?.id;
  const userType = req.user?.userType;
  const { listId } = req.params;
  
  if (userType !== 'CUSTOMER' && userType !== 'EMPLOYEE') {
    return res.status(403).json({ error: "Only customers and employees can access shopping lists" });
  }

  try {
    // Try cache first (for customers)
    if (userType === 'CUSTOMER') {
      const cachedList = await cacheService.getCachedListDetail(listId);
      if (cachedList && cachedList.customerId === userId) {
        console.log(`⚡ Returning cached list detail for ${listId}`);
        return res.status(200).json(cachedList);
      }
    }

    const list = await prisma.list.findUnique({
      where: {
        id: listId,
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
      return res.status(404).json({ error: "List not found-e3" });
    }

    // Get user's shop to check access
    let userShopId = null;
    if (userType === 'EMPLOYEE') {
      const employee = await prisma.empolyee.findUnique({
        where: { id: userId },
        select: { shopId: true }
      });
      userShopId = employee?.shopId;
    } else {
      const customer = await prisma.customer.findUnique({
        where: { id: userId },
        select: { shopId: true }
      });
      userShopId = customer?.shopId;
    }

    // Verify the list belongs to the user OR is from the same shop (for shared lists)
    const isOwner = userType === 'EMPLOYEE' 
      ? list.employeeId === userId
      : list.customerId === userId;
    
    // Check if list is from same shop (allows viewing shared lists)
    const isSameShop = list.shopId === userShopId || 
      (list.customerId && userShopId && await (async () => {
        const listOwner = await prisma.customer.findUnique({
          where: { id: list.customerId },
          select: { shopId: true }
        });
        return listOwner?.shopId === userShopId;
      })());
    
    if (!isOwner && !isSameShop) {
      return res.status(403).json({ error: "You don't have permission to access this list" });
    }

    console.log('🔍 First product raw data:', JSON.stringify(list.products[0]?.productAtShop, null, 2));

    // Group by productId and keep only the entry with lowest effective price (including offers)
    const productMap = new Map();
    list.products.forEach(lp => {
      const productId = lp.productAtShop.productId;
      const effectivePrice = getEffectivePrice(lp.productAtShop);
      
      console.log('Processing product:', {
        productId,
        productName: lp.productAtShop.product.title,
        shopName: lp.productAtShop.shop?.name,
        shopData: lp.productAtShop.shop,
        regularPrice: parseFloat(lp.productAtShop.price),
        effectivePrice: effectivePrice.price,
        hasActiveOffer: effectivePrice.hasActiveOffer,
        offerPrice: effectivePrice.offerPrice,
        aielNumber: lp.productAtShop.card_aiel_number,
        productAtShopId: lp.productAtShop.id
      });
    
      if (!productMap.has(productId) || effectivePrice.price < productMap.get(productId).lowestPrice) {
        productMap.set(productId, {
          id: lp.id,
          productId: productId,
          productName: lp.productAtShop.product.title,
          barcode: lp.productAtShop.product.barcode,
          aielNumber: lp.productAtShop.card_aiel_number,
          lowestPrice: effectivePrice.price,
          originalPrice: effectivePrice.originalPrice,
          offerPrice: effectivePrice.offerPrice,
          hasActiveOffer: effectivePrice.hasActiveOffer,
          shopName: lp.productAtShop.shop?.name || 'No Shop',
          img: lp.productAtShop.product.img,
          quantity: lp.quantity || 1,
        });
        
        console.log(`✅ Set product in map with effective price £${effectivePrice.price} ${effectivePrice.hasActiveOffer ? '(OFFER)' : '(REGULAR)'} - aiel: ${lp.productAtShop.card_aiel_number}`);
      }
    });

    // Format products to show only the lowest price for each product
    const formattedList = {
      id: list.id,
      name: list.name,
      description: list.description,
      customerId: list.customerId,
      createdAt: list.createdAt,
      updatedAt: list.updatedAt,
      products: Array.from(productMap.values()),
    };

    console.log('📦 Sending formatted list with products and aiel numbers:', 
      JSON.stringify(formattedList.products.map(p => ({
        name: p.productName,
        aielNumber: p.aielNumber,
        barcode: p.barcode,
        quantity: p.quantity
      })), null, 2)
    );

    // Cache the list detail
    await cacheService.cacheListDetail(listId, formattedList);

    res.status(200).json(formattedList);
  } catch (error) {
    console.error("Error fetching list:", error);
    res.status(500).json({ error: "Internal server error" });
  }
};

// Delete a list
const deleteList = async (req, res) => {
  const userId = req.user?.id;
  const userType = req.user?.userType;
  const { listId } = req.params;
  
  if (userType !== 'CUSTOMER' && userType !== 'EMPLOYEE') {
    return res.status(403).json({ error: "Only customers and employees can delete shopping lists" });
  }

  try {
    // First verify the list exists and belongs to the user
    const list = await prisma.list.findUnique({
      where: { id: listId },
    });

    if (!list) {
      return res.status(404).json({ error: "List not found-e4" });
    }

    // Check ownership based on user type
    const isOwner = userType === 'EMPLOYEE' 
      ? list.employeeId === userId
      : list.customerId === userId;
    
    if (!isOwner) {
      return res.status(403).json({ error: "You don't have permission to delete this list" });
    }

    // Delete the list (cascade will handle ListProduct entries)
    await prisma.list.delete({
      where: { id: listId },
    });

    // Invalidate cache for this list and user's lists (only for customers)
    if (userType === 'CUSTOMER') {
      await cacheService.invalidateAllUserListCache(userId, listId);
    }

    res.status(200).json({ 
      success: true,
      message: "List deleted successfully" 
    });
  } catch (error) {
    console.error("Error deleting list:", error);
    res.status(500).json({ error: "Internal server error" });
  }
};

export {
  makeList,
  addProductToList,
  getLowestPricesInList,
  removeProductFromList,
  getUserLists,
  getListById,
  deleteList,
};
