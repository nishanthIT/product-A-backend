import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// Create a new bundle promotion
const createBundlePromotion = async (req, res) => {
  const { shopId, name, description, promotionType, startDate, endDate, buyItems, getItems } = req.body;

  if (!shopId || !name || !buyItems || !getItems) {
    return res.status(400).json({ 
      error: "shopId, name, buyItems, and getItems are required" 
    });
  }

  if (!Array.isArray(buyItems) || buyItems.length === 0) {
    return res.status(400).json({ error: "At least one buy item is required" });
  }

  if (!Array.isArray(getItems) || getItems.length === 0) {
    return res.status(400).json({ error: "At least one get item is required" });
  }

  try {
    // Verify shop exists
    const shop = await prisma.shop.findUnique({ where: { id: shopId } });
    if (!shop) {
      return res.status(404).json({ error: "Shop not found" });
    }

    // Create bundle promotion with buy and get items
    const bundlePromotion = await prisma.bundlePromotion.create({
      data: {
        shopId,
        name,
        description: description || null,
        promotionType: promotionType || 'BUY_X_GET_Y',
        startDate: startDate ? new Date(startDate) : null,
        endDate: endDate ? new Date(endDate) : null,
        isActive: true,
        buyItems: {
          create: buyItems.map(item => ({
            productId: item.productId,
            quantity: item.quantity || 1
          }))
        },
        getItems: {
          create: getItems.map(item => ({
            productId: item.productId,
            quantity: item.quantity || 1
          }))
        }
      },
      include: {
        buyItems: {
          include: {
            product: {
              select: { id: true, title: true, barcode: true, img: true }
            }
          }
        },
        getItems: {
          include: {
            product: {
              select: { id: true, title: true, barcode: true, img: true }
            }
          }
        },
        shop: {
          select: { id: true, name: true }
        }
      }
    });

    res.status(201).json({
      success: true,
      message: "Bundle promotion created successfully",
      data: bundlePromotion
    });
  } catch (error) {
    console.error("Error creating bundle promotion:", error);
    res.status(500).json({ error: "Internal server error" });
  }
};

// Get all bundle promotions for a shop
const getBundlePromotions = async (req, res) => {
  const { shopId } = req.params;
  const { activeOnly } = req.query;

  if (!shopId) {
    return res.status(400).json({ error: "Shop ID is required" });
  }

  try {
    const whereClause = { shopId };
    
    if (activeOnly === 'true') {
      const today = new Date();
      whereClause.isActive = true;
      whereClause.OR = [
        { startDate: null },
        { startDate: { lte: today } }
      ];
      whereClause.AND = [
        {
          OR: [
            { endDate: null },
            { endDate: { gte: today } }
          ]
        }
      ];
    }

    const bundlePromotions = await prisma.bundlePromotion.findMany({
      where: whereClause,
      include: {
        buyItems: {
          include: {
            product: {
              select: { id: true, title: true, barcode: true, img: true, rrp: true }
            }
          }
        },
        getItems: {
          include: {
            product: {
              select: { id: true, title: true, barcode: true, img: true, rrp: true }
            }
          }
        }
      },
      orderBy: { createdAt: 'desc' }
    });

    res.status(200).json({
      success: true,
      data: bundlePromotions
    });
  } catch (error) {
    console.error("Error fetching bundle promotions:", error);
    res.status(500).json({ error: "Internal server error" });
  }
};

// Get a single bundle promotion
const getBundlePromotion = async (req, res) => {
  const { promotionId } = req.params;

  if (!promotionId) {
    return res.status(400).json({ error: "Promotion ID is required" });
  }

  try {
    const bundlePromotion = await prisma.bundlePromotion.findUnique({
      where: { id: promotionId },
      include: {
        buyItems: {
          include: {
            product: {
              select: { id: true, title: true, barcode: true, img: true, rrp: true }
            }
          }
        },
        getItems: {
          include: {
            product: {
              select: { id: true, title: true, barcode: true, img: true, rrp: true }
            }
          }
        },
        shop: {
          select: { id: true, name: true }
        }
      }
    });

    if (!bundlePromotion) {
      return res.status(404).json({ error: "Bundle promotion not found" });
    }

    res.status(200).json({
      success: true,
      data: bundlePromotion
    });
  } catch (error) {
    console.error("Error fetching bundle promotion:", error);
    res.status(500).json({ error: "Internal server error" });
  }
};

// Update a bundle promotion
const updateBundlePromotion = async (req, res) => {
  const { promotionId } = req.params;
  const { name, description, promotionType, startDate, endDate, isActive, buyItems, getItems } = req.body;

  if (!promotionId) {
    return res.status(400).json({ error: "Promotion ID is required" });
  }

  try {
    // Check if promotion exists
    const existing = await prisma.bundlePromotion.findUnique({
      where: { id: promotionId }
    });

    if (!existing) {
      return res.status(404).json({ error: "Bundle promotion not found" });
    }

    // Update basic fields
    const updateData = {};
    if (name !== undefined) updateData.name = name;
    if (description !== undefined) updateData.description = description;
    if (promotionType !== undefined) updateData.promotionType = promotionType;
    if (startDate !== undefined) updateData.startDate = startDate ? new Date(startDate) : null;
    if (endDate !== undefined) updateData.endDate = endDate ? new Date(endDate) : null;
    if (isActive !== undefined) updateData.isActive = isActive;

    // If buy/get items are provided, replace them
    if (buyItems) {
      // Delete existing buy items
      await prisma.bundlePromotionBuyItem.deleteMany({
        where: { bundlePromotionId: promotionId }
      });
      
      // Create new buy items
      await prisma.bundlePromotionBuyItem.createMany({
        data: buyItems.map(item => ({
          bundlePromotionId: promotionId,
          productId: item.productId,
          quantity: item.quantity || 1
        }))
      });
    }

    if (getItems) {
      // Delete existing get items
      await prisma.bundlePromotionGetItem.deleteMany({
        where: { bundlePromotionId: promotionId }
      });
      
      // Create new get items
      await prisma.bundlePromotionGetItem.createMany({
        data: getItems.map(item => ({
          bundlePromotionId: promotionId,
          productId: item.productId,
          quantity: item.quantity || 1
        }))
      });
    }

    // Update the promotion
    const updated = await prisma.bundlePromotion.update({
      where: { id: promotionId },
      data: updateData,
      include: {
        buyItems: {
          include: {
            product: {
              select: { id: true, title: true, barcode: true, img: true }
            }
          }
        },
        getItems: {
          include: {
            product: {
              select: { id: true, title: true, barcode: true, img: true }
            }
          }
        }
      }
    });

    res.status(200).json({
      success: true,
      message: "Bundle promotion updated successfully",
      data: updated
    });
  } catch (error) {
    console.error("Error updating bundle promotion:", error);
    res.status(500).json({ error: "Internal server error" });
  }
};

// Delete a bundle promotion
const deleteBundlePromotion = async (req, res) => {
  const { promotionId } = req.params;

  if (!promotionId) {
    return res.status(400).json({ error: "Promotion ID is required" });
  }

  try {
    // Check if promotion exists
    const existing = await prisma.bundlePromotion.findUnique({
      where: { id: promotionId }
    });

    if (!existing) {
      return res.status(404).json({ error: "Bundle promotion not found" });
    }

    // Delete (cascade will handle buy/get items)
    await prisma.bundlePromotion.delete({
      where: { id: promotionId }
    });

    res.status(200).json({
      success: true,
      message: "Bundle promotion deleted successfully"
    });
  } catch (error) {
    console.error("Error deleting bundle promotion:", error);
    res.status(500).json({ error: "Internal server error" });
  }
};

// Check if a product is part of any active bundle promotion
// This is used when scanning/adding products to show relevant offers
const checkProductBundleOffers = async (req, res) => {
  const { shopId, productId } = req.params;

  if (!shopId || !productId) {
    return res.status(400).json({ error: "Shop ID and Product ID are required" });
  }

  try {
    const today = new Date();

    // Find active bundle promotions where this product is in the buy list
    const bundleOffers = await prisma.bundlePromotion.findMany({
      where: {
        shopId,
        isActive: true,
        OR: [
          { startDate: null },
          { startDate: { lte: today } }
        ],
        AND: [
          {
            OR: [
              { endDate: null },
              { endDate: { gte: today } }
            ]
          }
        ],
        buyItems: {
          some: {
            productId: productId
          }
        }
      },
      include: {
        buyItems: {
          include: {
            product: {
              select: { id: true, title: true, barcode: true, img: true }
            }
          }
        },
        getItems: {
          include: {
            product: {
              select: { id: true, title: true, barcode: true, img: true }
            }
          }
        }
      }
    });

    res.status(200).json({
      success: true,
      hasOffers: bundleOffers.length > 0,
      offers: bundleOffers
    });
  } catch (error) {
    console.error("Error checking product bundle offers:", error);
    res.status(500).json({ error: "Internal server error" });
  }
};

// Check if cart items qualify for any bundle promotion
// Pass an array of productIds and quantities
const checkCartBundleOffers = async (req, res) => {
  const { shopId } = req.params;
  const { cartItems } = req.body; // Array of { productId, quantity }

  if (!shopId) {
    return res.status(400).json({ error: "Shop ID is required" });
  }

  if (!Array.isArray(cartItems) || cartItems.length === 0) {
    return res.status(200).json({
      success: true,
      qualifiedOffers: [],
      partialOffers: []
    });
  }

  try {
    const today = new Date();
    const productIds = cartItems.map(item => item.productId);

    // Find active bundle promotions for this shop
    const bundlePromotions = await prisma.bundlePromotion.findMany({
      where: {
        shopId,
        isActive: true,
        OR: [
          { startDate: null },
          { startDate: { lte: today } }
        ],
        AND: [
          {
            OR: [
              { endDate: null },
              { endDate: { gte: today } }
            ]
          }
        ]
      },
      include: {
        buyItems: {
          include: {
            product: {
              select: { id: true, title: true, barcode: true, img: true }
            }
          }
        },
        getItems: {
          include: {
            product: {
              select: { id: true, title: true, barcode: true, img: true }
            }
          }
        }
      }
    });

    const qualifiedOffers = [];
    const partialOffers = [];

    for (const promo of bundlePromotions) {
      const buyRequirements = promo.buyItems;
      let allRequirementsMet = true;
      let anyRequirementMet = false;
      const missingItems = [];
      const metItems = [];

      for (const buyItem of buyRequirements) {
        const cartItem = cartItems.find(ci => ci.productId === buyItem.productId);
        const cartQuantity = cartItem ? cartItem.quantity : 0;
        
        if (cartQuantity >= buyItem.quantity) {
          anyRequirementMet = true;
          metItems.push({
            ...buyItem,
            product: buyItem.product,
            cartQuantity
          });
        } else {
          allRequirementsMet = false;
          missingItems.push({
            ...buyItem,
            product: buyItem.product,
            cartQuantity,
            needed: buyItem.quantity - cartQuantity
          });
        }
      }

      if (allRequirementsMet) {
        qualifiedOffers.push({
          promotion: promo,
          freeItems: promo.getItems
        });
      } else if (anyRequirementMet) {
        partialOffers.push({
          promotion: promo,
          metItems,
          missingItems,
          freeItems: promo.getItems
        });
      }
    }

    res.status(200).json({
      success: true,
      qualifiedOffers,
      partialOffers
    });
  } catch (error) {
    console.error("Error checking cart bundle offers:", error);
    res.status(500).json({ error: "Internal server error" });
  }
};

export {
  createBundlePromotion,
  getBundlePromotions,
  getBundlePromotion,
  updateBundlePromotion,
  deleteBundlePromotion,
  checkProductBundleOffers,
  checkCartBundleOffers
};
