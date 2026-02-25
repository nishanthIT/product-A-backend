import express from "express";
import { PrismaClient } from "@prisma/client";
import { isAuthenticated, isEmployee } from "../middleware/authware.js";

const router = express.Router();
const prisma = new PrismaClient();

/**
 * Get the current best (lowest) promotion price for a product at a shop
 * Takes into account all active promotions where today's date falls within start-end range
 * If endDate is null, the promotion never expires
 */
const getCurrentBestPrice = (promotions, regularPrice) => {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  
  // Filter active promotions that are currently valid
  const activePromotions = promotions.filter(promo => {
    if (!promo.isActive) return false;
    const startDate = new Date(promo.startDate);
    startDate.setHours(0, 0, 0, 0);
    
    // Check if promotion has started
    if (today < startDate) return false;
    
    // If no end date, promotion never expires
    if (!promo.endDate) return true;
    
    const endDate = new Date(promo.endDate);
    endDate.setHours(23, 59, 59, 999);
    return today <= endDate;
  });
  
  if (activePromotions.length === 0) {
    return {
      currentPrice: regularPrice,
      isPromotion: false,
      activePromotion: null
    };
  }
  
  // Find the lowest price among active promotions
  const lowestPromotion = activePromotions.reduce((lowest, current) => {
    const currentPrice = parseFloat(current.promotionPrice);
    const lowestPrice = parseFloat(lowest.promotionPrice);
    return currentPrice < lowestPrice ? current : lowest;
  });
  
  return {
    currentPrice: parseFloat(lowestPromotion.promotionPrice),
    isPromotion: true,
    activePromotion: lowestPromotion,
    allActivePromotions: activePromotions
  };
};

/**
 * GET /api/product-promotions/:shopId/:productId
 * Get all promotions for a product at a shop
 */
router.get("/:shopId/:productId", isAuthenticated, isEmployee, async (req, res) => {
  const { shopId, productId } = req.params;
  
  try {
    // Find the ProductAtShop record
    const productAtShop = await prisma.productAtShop.findUnique({
      where: {
        shopId_productId: { shopId, productId }
      },
      include: {
        promotions: {
          orderBy: { startDate: 'asc' }
        },
        product: {
          select: {
            title: true,
            barcode: true
          }
        }
      }
    });
    
    if (!productAtShop) {
      return res.status(404).json({ error: "Product not found at this shop" });
    }
    
    const bestPrice = getCurrentBestPrice(productAtShop.promotions, productAtShop.price);
    
    res.status(200).json({
      success: true,
      data: {
        productAtShopId: productAtShop.id,
        productTitle: productAtShop.product.title,
        barcode: productAtShop.product.barcode,
        regularPrice: parseFloat(productAtShop.price),
        promotions: productAtShop.promotions.map(p => ({
          ...p,
          promotionPrice: parseFloat(p.promotionPrice)
        })),
        ...bestPrice
      }
    });
  } catch (error) {
    console.error("Error fetching product promotions:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * POST /api/product-promotions/:shopId/:productId
 * Add multiple promotions for a product at a shop
 * Body: { promotions: [{ startDate, endDate, promotionPrice, description? }] }
 */
router.post("/:shopId/:productId", isAuthenticated, isEmployee, async (req, res) => {
  const { shopId, productId } = req.params;
  const { promotions } = req.body;
  
  if (!promotions || !Array.isArray(promotions) || promotions.length === 0) {
    return res.status(400).json({ error: "Promotions array is required" });
  }
  
  // Validate each promotion
  for (const promo of promotions) {
    if (!promo.startDate || promo.promotionPrice === undefined) {
      return res.status(400).json({ 
        error: "Each promotion must have startDate and promotionPrice" 
      });
    }
    
    // If end date is provided, validate it's after start date
    if (promo.endDate) {
      const startDate = new Date(promo.startDate);
      const endDate = new Date(promo.endDate);
      
      if (endDate < startDate) {
        return res.status(400).json({ 
          error: "End date must be after start date" 
        });
      }
    }
  }
  
  try {
    // Find the ProductAtShop record
    const productAtShop = await prisma.productAtShop.findUnique({
      where: {
        shopId_productId: { shopId, productId }
      }
    });
    
    if (!productAtShop) {
      return res.status(404).json({ error: "Product not found at this shop" });
    }
    
    // Create all promotions
    const createdPromotions = await prisma.productPromotion.createMany({
      data: promotions.map(promo => ({
        productAtShopId: productAtShop.id,
        startDate: new Date(promo.startDate),
        endDate: promo.endDate ? new Date(promo.endDate) : null, // Optional end date
        promotionPrice: promo.promotionPrice,
        description: promo.description || null,
        isActive: true
      }))
    });
    
    // Fetch all promotions including newly created ones
    const allPromotions = await prisma.productPromotion.findMany({
      where: { productAtShopId: productAtShop.id },
      orderBy: { startDate: 'asc' }
    });
    
    const bestPrice = getCurrentBestPrice(allPromotions, productAtShop.price);
    
    // Update the ProductAtShop with the current best offer price
    if (bestPrice.isPromotion) {
      await prisma.productAtShop.update({
        where: { id: productAtShop.id },
        data: {
          offerPrice: bestPrice.currentPrice,
          offerExpiryDate: bestPrice.activePromotion.endDate
        }
      });
    }
    
    res.status(201).json({
      success: true,
      message: `${createdPromotions.count} promotions added successfully`,
      data: {
        promotions: allPromotions.map(p => ({
          ...p,
          promotionPrice: parseFloat(p.promotionPrice)
        })),
        ...bestPrice
      }
    });
  } catch (error) {
    console.error("Error adding product promotions:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * PUT /api/product-promotions/:promotionId
 * Update a single promotion
 */
router.put("/:promotionId", isAuthenticated, isEmployee, async (req, res) => {
  const { promotionId } = req.params;
  const { startDate, endDate, promotionPrice, description, isActive } = req.body;
  
  try {
    const promotion = await prisma.productPromotion.findUnique({
      where: { id: promotionId },
      include: { productAtShop: true }
    });
    
    if (!promotion) {
      return res.status(404).json({ error: "Promotion not found" });
    }
    
    const updatedPromotion = await prisma.productPromotion.update({
      where: { id: promotionId },
      data: {
        ...(startDate && { startDate: new Date(startDate) }),
        ...(endDate && { endDate: new Date(endDate) }),
        ...(promotionPrice !== undefined && { promotionPrice }),
        ...(description !== undefined && { description }),
        ...(isActive !== undefined && { isActive })
      }
    });
    
    // Recalculate best price
    const allPromotions = await prisma.productPromotion.findMany({
      where: { productAtShopId: promotion.productAtShopId },
      orderBy: { startDate: 'asc' }
    });
    
    const bestPrice = getCurrentBestPrice(allPromotions, promotion.productAtShop.price);
    
    // Update ProductAtShop with new best offer
    await prisma.productAtShop.update({
      where: { id: promotion.productAtShopId },
      data: {
        offerPrice: bestPrice.isPromotion ? bestPrice.currentPrice : null,
        offerExpiryDate: bestPrice.isPromotion ? bestPrice.activePromotion.endDate : null
      }
    });
    
    res.status(200).json({
      success: true,
      data: {
        promotion: {
          ...updatedPromotion,
          promotionPrice: parseFloat(updatedPromotion.promotionPrice)
        },
        ...bestPrice
      }
    });
  } catch (error) {
    console.error("Error updating promotion:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * DELETE /api/product-promotions/:promotionId
 * Delete a single promotion
 */
router.delete("/:promotionId", isAuthenticated, isEmployee, async (req, res) => {
  const { promotionId } = req.params;
  
  try {
    const promotion = await prisma.productPromotion.findUnique({
      where: { id: promotionId },
      include: { productAtShop: true }
    });
    
    if (!promotion) {
      return res.status(404).json({ error: "Promotion not found" });
    }
    
    await prisma.productPromotion.delete({
      where: { id: promotionId }
    });
    
    // Recalculate best price
    const allPromotions = await prisma.productPromotion.findMany({
      where: { productAtShopId: promotion.productAtShopId },
      orderBy: { startDate: 'asc' }
    });
    
    const bestPrice = getCurrentBestPrice(allPromotions, promotion.productAtShop.price);
    
    // Update ProductAtShop with new best offer
    await prisma.productAtShop.update({
      where: { id: promotion.productAtShopId },
      data: {
        offerPrice: bestPrice.isPromotion ? bestPrice.currentPrice : null,
        offerExpiryDate: bestPrice.isPromotion ? bestPrice.activePromotion.endDate : null
      }
    });
    
    res.status(200).json({
      success: true,
      message: "Promotion deleted successfully",
      data: bestPrice
    });
  } catch (error) {
    console.error("Error deleting promotion:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * POST /api/product-promotions/refresh-prices
 * Refresh all product prices based on current active promotions
 * This can be called by a cron job or manually
 */
router.post("/refresh-prices", isAuthenticated, isEmployee, async (req, res) => {
  const { shopId } = req.body;
  
  try {
    // Get all products at shop with their promotions
    const whereClause = shopId ? { shopId } : {};
    
    const productsAtShop = await prisma.productAtShop.findMany({
      where: whereClause,
      include: {
        promotions: true
      }
    });
    
    let updatedCount = 0;
    
    for (const product of productsAtShop) {
      const bestPrice = getCurrentBestPrice(product.promotions, product.price);
      
      const currentOfferPrice = product.offerPrice ? parseFloat(product.offerPrice) : null;
      const newOfferPrice = bestPrice.isPromotion ? bestPrice.currentPrice : null;
      
      // Only update if the offer price has changed
      if (currentOfferPrice !== newOfferPrice) {
        await prisma.productAtShop.update({
          where: { id: product.id },
          data: {
            offerPrice: newOfferPrice,
            offerExpiryDate: bestPrice.isPromotion ? bestPrice.activePromotion.endDate : null
          }
        });
        updatedCount++;
      }
    }
    
    res.status(200).json({
      success: true,
      message: `Refreshed ${updatedCount} product prices`,
      totalProducts: productsAtShop.length,
      updatedProducts: updatedCount
    });
  } catch (error) {
    console.error("Error refreshing prices:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * GET /api/product-promotions/shop/:shopId/all
 * Get all products with their promotions at a shop
 */
router.get("/shop/:shopId/all", isAuthenticated, isEmployee, async (req, res) => {
  const { shopId } = req.params;
  
  try {
    const productsWithPromotions = await prisma.productAtShop.findMany({
      where: { 
        shopId,
        promotions: {
          some: {} // Only products that have promotions
        }
      },
      include: {
        promotions: {
          orderBy: { startDate: 'asc' }
        },
        product: {
          select: {
            title: true,
            barcode: true,
            img: true
          }
        }
      }
    });
    
    const result = productsWithPromotions.map(product => {
      const bestPrice = getCurrentBestPrice(product.promotions, product.price);
      return {
        productAtShopId: product.id,
        productId: product.productId,
        productTitle: product.product.title,
        barcode: product.product.barcode,
        img: product.product.img,
        regularPrice: parseFloat(product.price),
        promotions: product.promotions.map(p => ({
          ...p,
          promotionPrice: parseFloat(p.promotionPrice)
        })),
        ...bestPrice
      };
    });
    
    res.status(200).json({
      success: true,
      data: result
    });
  } catch (error) {
    console.error("Error fetching shop promotions:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * POST /api/product-promotions/auto-deactivate
 * Automatically deactivate promotions that have passed their end date
 * This can be called by a cron job daily
 */
router.post("/auto-deactivate", isAuthenticated, isEmployee, async (req, res) => {
  try {
    const today = new Date();
    today.setHours(23, 59, 59, 999);
    
    // Find all promotions that have an end date that has passed and are still active
    const expiredPromotions = await prisma.productPromotion.findMany({
      where: {
        isActive: true,
        endDate: {
          not: null,
          lt: today
        }
      }
    });
    
    if (expiredPromotions.length === 0) {
      return res.status(200).json({
        success: true,
        message: "No expired promotions found",
        deactivatedCount: 0
      });
    }
    
    // Deactivate all expired promotions
    const result = await prisma.productPromotion.updateMany({
      where: {
        isActive: true,
        endDate: {
          not: null,
          lt: today
        }
      },
      data: {
        isActive: false
      }
    });
    
    // Get unique productAtShopIds that were affected
    const affectedProductAtShopIds = [...new Set(expiredPromotions.map(p => p.productAtShopId))];
    
    // Update offer prices for affected products
    for (const productAtShopId of affectedProductAtShopIds) {
      const productAtShop = await prisma.productAtShop.findUnique({
        where: { id: productAtShopId },
        include: { promotions: true }
      });
      
      if (productAtShop) {
        const bestPrice = getCurrentBestPrice(productAtShop.promotions, productAtShop.price);
        await prisma.productAtShop.update({
          where: { id: productAtShopId },
          data: {
            offerPrice: bestPrice.isPromotion ? bestPrice.currentPrice : null,
            offerExpiryDate: bestPrice.isPromotion && bestPrice.activePromotion.endDate 
              ? bestPrice.activePromotion.endDate 
              : null
          }
        });
      }
    }
    
    res.status(200).json({
      success: true,
      message: `Deactivated ${result.count} expired promotions`,
      deactivatedCount: result.count,
      affectedProducts: affectedProductAtShopIds.length
    });
  } catch (error) {
    console.error("Error auto-deactivating promotions:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
