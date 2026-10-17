import { getEffectivePrice } from '../services/supplierPricing.js';
import { PrismaClient } from "@prisma/client";
import { getListSummaries } from '../services/listSummaries.js';
import { addListProduct } from '../services/listItems.js';

const prisma = new PrismaClient();

// Lists are read directly from PostgreSQL; mutations do not depend on an unused cache.

// Broadcast a shop-scoped list change so every tracker/owner stays in sync.
// No-op when the list is not bound to a shop or Socket.IO is unavailable.
const emitListSync = (req, shopId, event, payload) => {
  if (!shopId || !req?.io) return;
  try {
    req.io.to(`shop_${shopId}_lists`).emit(event, payload);
    console.log(`📡 Emitted ${event} to shop_${shopId}_lists`);
  } catch (err) {
    console.error(`Socket emit failed (${event}):`, err?.message);
  }
};

// Helper function to get effective price (considering active offers)

// Ensure a stable fallback shop/inventory row exists for unavailable products
const getOrCreateUnknownProductAtShop = async (productId) => {
  const UNKNOWN_SHOP_NAME = 'Unknown Shop';

  let unknownShop = await prisma.shop.findFirst({
    where: {
      name: UNKNOWN_SHOP_NAME,
      shopType: 'WHOLESALE',
    },
  });

  if (!unknownShop) {
    unknownShop = await prisma.shop.create({
      data: {
        name: UNKNOWN_SHOP_NAME,
        address: 'Unknown',
        mobile: 'N/A',
        shopType: 'WHOLESALE',
      },
    });
  }

  let productAtShop = await prisma.productAtShop.findFirst({
    where: {
      productId,
      shopId: unknownShop.id,
    },
    include: {
      shop: true,
      product: true,
    },
  });

  if (!productAtShop) {
    const product = await prisma.product.findUnique({
      where: { id: productId },
      select: { rrp: true },
    });

    const fallbackPrice = product?.rrp ? parseFloat(product.rrp) : 0;

    productAtShop = await prisma.productAtShop.create({
      data: {
        productId,
        shopId: unknownShop.id,
        price: fallbackPrice,
        outOfStock: false,
      },
      include: {
        shop: true,
        product: true,
      },
    });
  }

  return productAtShop;
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
    
    if (!req.user.shopId) return res.status(409).json({ error: 'Select a verified supermarket first' });
    listData.shopId = req.user.shopId;
    if (userType === 'EMPLOYEE') listData.employeeId = userId;
    else listData.customerId = userId;
    
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

    // Sync new list to everyone watching this shop (employees + owner)
    emitListSync(req, list.shopId, 'list_created', { listId: list.id });

    res.status(201).json(formattedList);
  } catch (error) {
    console.error("Error creating list:", error);
    res.status(500).json({ error: "Internal server error." });
  }
};

const addProductToList = async (req, res) => {
  const userId = req.user?.id;
  const userType = req.user?.userType;
  const { listId, productId, isUrgent, inHandStock, quantity = 1 } = req.body;

  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 2147483647) {
    return res.status(400).json({ error: "Quantity must be a positive whole number" });
  }

  // Optional flags from the scan → add flow
  const wantUrgent = isUrgent === true;
  const parsedStock = Number(inHandStock);
  const cleanInHandStock =
    inHandStock !== undefined && inHandStock !== null && Number.isInteger(parsedStock) && parsedStock >= 0
      ? parsedStock
      : null;

  // Customers, Employees and Admins can add products to lists
  if (userType !== 'CUSTOMER' && userType !== 'EMPLOYEE' && userType !== 'ADMIN') {
    return res.status(403).json({ error: "Only customers, employees and admins can add products to lists" });
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
    });
    
    if (!list) {
      return res.status(404).json({ error: "List not found-e1" });
    }
    
    // Check ownership based on user type
    const isOwner = userType === 'EMPLOYEE'
      ? list.employeeId === userId
      : userType === 'ADMIN'
      ? list.adminId === userId
      : list.customerId === userId;

    // Allow trackers to modify shared lists too
    let isTracking = false;
    if (!isOwner && prisma.trackedList?.findFirst) {
      const tracked = await prisma.trackedList.findFirst({
        where: {
          listId,
          userId,
          userType,
        },
      });
      isTracking = !!tracked;
    }

    if (!isOwner && !isTracking) {
      return res.status(403).json({ error: "You don't have permission to modify this list" });
    }

    // Find the product in all WHOLESALE shops (excluding out of stock)
    const productAtShops = await prisma.productAtShop.findMany({
      where: {
        productId,
        outOfStock: false,
        shop: {
          shopType: 'WHOLESALE'
        }
      },
      include: {
        shop: true,
        product: true,
      },
    });

    console.log(`Found ${productAtShops.length} in-stock shops with product ${productId}`);

    let candidateProductAtShops = productAtShops;

    if (candidateProductAtShops.length === 0) {
      // Keep product listable even when unavailable in active shops.
      // This preserves list behavior for out-of-stock or removed inventory scenarios.
      const productExists = await prisma.product.findUnique({ where: { id: productId }, select: { id: true } });
      if (!productExists) return res.status(404).json({ error: 'Product not found' });
      const unknownProductAtShop = await getOrCreateUnknownProductAtShop(productId);
      candidateProductAtShops = [unknownProductAtShop];
      console.log(`No active shop stock for ${productId}. Using Unknown Shop fallback.`);
    }

    // Find the shop with the lowest effective price (considering offers)
    const lowestPriceEntry = candidateProductAtShops.reduce((lowest, current) => {
      const currentEffective = getEffectivePrice(current);
      const lowestEffective = getEffectivePrice(lowest);
      return currentEffective.price < lowestEffective.price ? current : lowest;
    });

    const finalEffectivePrice = getEffectivePrice(lowestPriceEntry);
    console.log(`Adding product with lowest effective price: £${finalEffectivePrice.price} (${finalEffectivePrice.hasActiveOffer ? 'offer price' : 'regular price'}) at ${lowestPriceEntry.shop.name}`);

    const { entry: listProduct, alreadyExists } = await addListProduct(prisma, {
      listId, productId, productAtShopId: lowestPriceEntry.id, quantity,
      isUrgent: wantUrgent, shopId: list.shopId, inHandStock: cleanInHandStock,
    });
    // Existing items keep the supplier selected by the user.
    const chosenProduct = listProduct.productAtShop;
    const chosenPrice = getEffectivePrice(chosenProduct);

    emitListSync(req, list.shopId, alreadyExists ? 'list_product_updated' : 'list_product_added', {
      listId, ...(alreadyExists && { action: 'quantity_increased' }),
    });

    res.status(200).json({
      success: true,
      message: alreadyExists ? "Product quantity increased" : "Product added to list successfully.",
      alreadyExists,
      data: {
        listProductId: listProduct.id,
        productAtShopId: chosenProduct.id,
        quantity: listProduct.quantity,
        productName: chosenProduct.product.title,
        lowestPrice: chosenPrice.price,
        originalPrice: chosenPrice.originalPrice,
        offerPrice: chosenPrice.offerPrice,
        hasActiveOffer: chosenPrice.hasActiveOffer,
        shopName: chosenProduct.shop.name,
        availableInShops: productAtShops.length,
      },
    });
    
  } catch (error) {
    if (error.status) return res.status(error.status).json({ error: error.message });
    console.error("Error adding product to list:", error);
    res.status(500).json({ error: "Internal server error." });
  }
};

// --------------------------------------------------------------------------------

// Get lowest price for each product in a list
const getLowestPricesInList = async (req, res) => {
  const { listId } = req.params;
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
    const { listId, productId, listProductId } = req.body;

    if (!listId || (!productId && !listProductId)) {
      return res.status(400).json({ error: 'listId and a product or list item ID are required' });
    }

    // Verify list exists
    const list = await prisma.list.findUnique({ where: { id: listId } });

    console.log('List found?', list ? 'YES' : 'NO');

    if (!list) {
      console.log('ERROR: List not found or does not belong to user');
      return res.status(404).json({ error: "List not found-e2" });
    }

    // Owner check by creator type
    const isOwner = userType === 'EMPLOYEE'
      ? list.employeeId === userId
      : userType === 'ADMIN'
      ? list.adminId === userId
      : list.customerId === userId;

    // Tracked users are allowed to modify shared lists too
    let isTracking = false;
    if (!isOwner && prisma.trackedList?.findFirst) {
      const tracked = await prisma.trackedList.findFirst({
        where: {
          listId,
          userId,
          userType,
        },
      });
      isTracking = !!tracked;
    }

    if (!isOwner && !isTracking) {
      console.log('ERROR: List not found or does not belong to user');
      return res.status(403).json({ error: "You don't have permission to modify this list" });
    }

    // Delete all ListProduct entries for this product in this list
    const deleted = await prisma.listProduct.deleteMany({
      where: {
        listId: listId,
        ...(listProductId ? { id: listProductId } : { productAtShop: {
          productId: productId
        } })
      }
    });

    console.log('Deleted count:', deleted.count);

    if (deleted.count === 0) {
      return res.status(404).json({ error: "Product not found in list" });
    }

    emitListSync(req, list.shopId, 'list_product_removed', { listId, productId });

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
  
  // Customers, Employees and Admins can have or track lists
  if (userType !== 'CUSTOMER' && userType !== 'EMPLOYEE' && userType !== 'ADMIN') {
    return res.status(403).json({ error: "Only customers, employees and admins can have shopping lists" });
  }

  try {
    const formattedLists = await getListSummaries(prisma, req.user);

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
    const userShopId = req.user.shopId;
    const isOwner = userType === 'EMPLOYEE' ? list.employeeId === userId : list.customerId === userId;
    const isSameShop = !!userShopId && list.shopId === userShopId;
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
          locationCode: lp.productAtShop.locationCode,
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

    emitListSync(req, list.shopId, 'list_deleted', { listId });

    res.status(200).json({ 
      success: true,
      message: "List deleted successfully" 
    });
  } catch (error) {
    console.error("Error deleting list:", error);
    res.status(500).json({ error: "Internal server error" });
  }
};

// Rename a list (owner or tracker) and broadcast to the shop so the
// shared list behaves like a collaborative document.
const renameList = async (req, res) => {
  const userId = req.user?.id;
  const userType = req.user?.userType;
  const { listId } = req.params;
  const { name } = req.body;

  if (!name || !name.trim()) {
    return res.status(400).json({ error: "List name is required" });
  }

  try {
    const list = await prisma.list.findUnique({ where: { id: listId } });
    if (!list) {
      return res.status(404).json({ error: "List not found" });
    }

    const isOwner = userType === 'EMPLOYEE'
      ? list.employeeId === userId
      : userType === 'ADMIN'
      ? list.adminId === userId
      : list.customerId === userId;

    let isTracking = false;
    if (!isOwner && prisma.trackedList?.findFirst) {
      const tracked = await prisma.trackedList.findFirst({
        where: { listId, userId, userType },
      });
      isTracking = !!tracked;
    }

    if (!isOwner && !isTracking) {
      return res.status(403).json({ error: "You don't have permission to modify this list" });
    }

    const updated = await prisma.list.update({
      where: { id: listId },
      data: { name: name.trim() },
    });

    emitListSync(req, updated.shopId, 'list_updated', { listId, name: updated.name });

    res.status(200).json({ success: true, id: updated.id, name: updated.name });
  } catch (error) {
    console.error("Error renaming list:", error);
    res.status(500).json({ error: "Internal server error" });
  }
};

// Stop tracking (remove from "my lists") a shared list without deleting it
// for its owner or other trackers.
const untrackList = async (req, res) => {
  const userId = req.user?.id;
  const userType = req.user?.userType;
  const { listId } = req.params;

  try {
    if (!prisma.trackedList?.deleteMany) {
      return res.status(500).json({ error: "Tracking model is not available" });
    }

    const result = await prisma.trackedList.deleteMany({
      where: { listId, userId, userType },
    });

    res.status(200).json({ success: true, removed: result.count });
  } catch (error) {
    console.error("Error untracking list:", error);
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
  renameList,
  untrackList,
};
