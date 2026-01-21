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
  // Get customerId from authenticated user (from JWT token via middleware)
  const customerId = req.user?.id;
  const userType = req.user?.userType;
  
  // Only customers can create lists
  if (userType !== 'CUSTOMER') {
    return res.status(403).json({ error: "Only customers can create shopping lists" });
  }
  
  const { name, description } = req.body;

  if (!name) {
    return res.status(400).json({ error: "List name is required" });
  }

  try {
    const list = await prisma.list.create({
      data: {
        name,
        description: description || '',
        customerId,
      },
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
    
    // Invalidate user's lists cache
    await cacheService.invalidateUserLists(customerId);
    
    res.status(201).json(formattedList);
  } catch (error) {
    console.error("Error creating list:", error);
    res.status(500).json({ error: "Internal server error." });
  }
};

const addProductToList = async (req, res) => {
  const customerId = req.user?.id;
  const userType = req.user?.userType;
  const { listId, productId } = req.body;

  // Only customers can add products to lists
  if (userType !== 'CUSTOMER') {
    return res.status(403).json({ error: "Only customers can add products to lists" });
  }

  if (!listId || !productId) {
    return res.status(400).json({ error: "listId and productId are required" });
  }

  try {
    // Check if the list exists and belongs to the customer
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
    
    if (list.customerId !== customerId) {
      return res.status(403).json({ error: "You don't have permission to modify this list" });
    }

    // Find the product in all shops
    const productAtShops = await prisma.productAtShop.findMany({
      where: {
        productId,
      },
      include: {
        shop: true,
        product: true,
      },
    });

    console.log(`Found ${productAtShops.length} shops with product ${productId}`);

    if (productAtShops.length === 0) {
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
    
    // Invalidate cache for this list and user's lists
    await cacheService.invalidateAllUserListCache(customerId, listId);
    
  } catch (error) {
    console.error("Error adding product to list:", error);
    res.status(500).json({ error: "Internal server error." });
  }
};

// --------------------------------------------------------------------------------

// Get lowest price for each product in a list
const getLowestPricesInList = async (req, res) => {
  const { listId, customerId } = req.body;

  try {
    // Step 1: Verify the list belongs to the given customer
    const list = await prisma.list.findUnique({
      where: { id: listId },
      include: { customer: true },
    });

    if (!list || list.customerId !== parseInt(customerId, 10)) {
      return res
        .status(404)
        .json({ error: "List not found or does not belong to the customer." });
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
    const customerId = req.user?.id;
    const { listId, productId } = req.body;
    
    // Verify the list exists and belongs to this customer
    const list = await prisma.list.findFirst({
      where: { 
        id: listId,
        customerId: customerId 
      }
    });

    console.log('List found?', list ? 'YES' : 'NO');

    if (!list) {
      console.log('ERROR: List not found or does not belong to customer');
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

    // Invalidate cache for this list and user's lists
    await cacheService.invalidateAllUserListCache(customerId, listId);

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
  const customerId = req.user?.id;
  const userType = req.user?.userType;
  
  // Only customers have lists
  if (userType !== 'CUSTOMER') {
    return res.status(403).json({ error: "Only customers can have shopping lists" });
  }

  try {
    // Try cache first
    const cachedLists = await cacheService.getCachedUserLists(customerId);
    if (cachedLists) {
      console.log(`⚡ Returning cached lists for user ${customerId}`);
      return res.status(200).json(cachedLists);
    }

    const lists = await prisma.list.findMany({
      where: {
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
      orderBy: {
        id: 'desc', // Most recent first
      },
    });

    // Group products by productId to count unique products
    const formattedLists = lists.map(list => {
      const uniqueProducts = new Set();
      list.products.forEach(lp => {
        uniqueProducts.add(lp.productAtShop.productId);
      });
      
      return {
        id: list.id,
        name: list.name,
        description: list.description,
        itemCount: uniqueProducts.size,
        createdAt: list.createdAt,
        updatedAt: list.updatedAt,
      };
    });

    // Cache the result
    await cacheService.cacheUserLists(customerId, formattedLists);

    res.status(200).json(formattedLists);
  } catch (error) {
    console.error("Error fetching lists:", error);
    res.status(500).json({ error: "Internal server error" });
  }
};

// Get a specific list by ID
const getListById = async (req, res) => {
  console.log("Yes i am printing from here-------")
  const customerId = req.user?.id;
  const userType = req.user?.userType;
  const { listId } = req.params;
  
  if (userType !== 'CUSTOMER') {
    return res.status(403).json({ error: "Only customers can access shopping lists" });
  }

  try {
    // Try cache first
    const cachedList = await cacheService.getCachedListDetail(listId);
    if (cachedList && cachedList.customerId === customerId) {
      console.log(`⚡ Returning cached list detail for ${listId}`);
      return res.status(200).json(cachedList);
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

    // Verify the list belongs to the customer
    if (list.customerId !== customerId) {
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
  const customerId = req.user?.id;
  const userType = req.user?.userType;
  const { listId } = req.params;
  
  if (userType !== 'CUSTOMER') {
    return res.status(403).json({ error: "Only customers can delete shopping lists" });
  }

  try {
    // First verify the list exists and belongs to the customer
    const list = await prisma.list.findUnique({
      where: { id: listId },
    });

    if (!list) {
      return res.status(404).json({ error: "List not found-e4" });
    }

    if (list.customerId !== customerId) {
      return res.status(403).json({ error: "You don't have permission to delete this list" });
    }

    // Delete the list (cascade will handle ListProduct entries)
    await prisma.list.delete({
      where: { id: listId },
    });

    // Invalidate cache for this list and user's lists
    await cacheService.invalidateAllUserListCache(customerId, listId);

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
