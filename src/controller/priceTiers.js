import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const toMoney = (value) => Math.round(parseFloat(value) * 100) / 100;

// ---- Employee/admin: manage quantity price tiers for a product at a shop ----

// GET /shop/:shopId/product/:productId/price-tiers
export const getShopProductPriceTiers = async (req, res) => {
  const { shopId, productId } = req.params;
  try {
    const productAtShop = await prisma.productAtShop.findUnique({
      where: { shopId_productId: { shopId, productId } },
      include: { priceTiers: { orderBy: { quantity: "asc" } } },
    });
    if (!productAtShop) {
      return res.status(404).json({ error: "Product not found at the specified shop." });
    }
    res.json({
      productAtShopId: productAtShop.id,
      basePrice: toMoney(productAtShop.price),
      tiers: productAtShop.priceTiers.map((t) => ({
        id: t.id,
        quantity: t.quantity,
        price: toMoney(t.price),
      })),
    });
  } catch (error) {
    console.error("Error fetching price tiers:", error);
    res.status(500).json({ error: "Failed to fetch price tiers." });
  }
};

// PUT /shop/:shopId/product/:productId/price-tiers
// Body: { tiers: [{ quantity, price }] } — replaces the full tier list.
export const setShopProductPriceTiers = async (req, res) => {
  const { shopId, productId } = req.params;
  const { tiers } = req.body;

  if (!Array.isArray(tiers)) {
    return res.status(400).json({ error: "tiers must be an array of { quantity, price }." });
  }

  const cleaned = [];
  const seen = new Set();
  for (const tier of tiers) {
    const quantity = parseInt(tier.quantity, 10);
    const price = parseFloat(tier.price);
    if (!Number.isInteger(quantity) || quantity < 2) {
      return res.status(400).json({ error: "Each tier quantity must be a whole number of 2 or more." });
    }
    if (isNaN(price) || price <= 0) {
      return res.status(400).json({ error: "Each tier price must be greater than 0." });
    }
    if (seen.has(quantity)) {
      return res.status(400).json({ error: `Duplicate tier for quantity ${quantity}.` });
    }
    seen.add(quantity);
    cleaned.push({ quantity, price });
  }

  try {
    const productAtShop = await prisma.productAtShop.findUnique({
      where: { shopId_productId: { shopId, productId } },
    });
    if (!productAtShop) {
      return res.status(404).json({ error: "Product not found at the specified shop." });
    }

    await prisma.$transaction([
      prisma.priceTier.deleteMany({ where: { productAtShopId: productAtShop.id } }),
      ...(cleaned.length
        ? [
            prisma.priceTier.createMany({
              data: cleaned.map((t) => ({ ...t, productAtShopId: productAtShop.id })),
            }),
          ]
        : []),
    ]);

    const saved = await prisma.priceTier.findMany({
      where: { productAtShopId: productAtShop.id },
      orderBy: { quantity: "asc" },
    });

    res.json({
      success: true,
      tiers: saved.map((t) => ({ id: t.id, quantity: t.quantity, price: toMoney(t.price) })),
    });
  } catch (error) {
    console.error("Error saving price tiers:", error);
    res.status(500).json({ error: "Failed to save price tiers." });
  }
};

// ---- Customer app: tiers for the lowest-priced in-stock shop entry ----

// GET /products/:id/price-tiers
export const getProductPriceTiers = async (req, res) => {
  const { id: productId } = req.params;
  try {
    const productAtShops = await prisma.productAtShop.findMany({
      where: { productId, outOfStock: false },
      include: {
        shop: { select: { name: true } },
        priceTiers: { orderBy: { quantity: "asc" } },
      },
    });

    if (productAtShops.length === 0) {
      return res.json({ productId, basePrice: null, shopName: null, tiers: [], hasTiers: false });
    }

    const now = new Date();
    const effectivePrice = (pas) => {
      const hasActiveOffer =
        pas.offerPrice !== null &&
        pas.offerExpiryDate !== null &&
        new Date(pas.offerExpiryDate) >= now;
      return parseFloat(hasActiveOffer ? pas.offerPrice : pas.price);
    };

    const lowest = productAtShops.reduce((best, current) =>
      effectivePrice(current) < effectivePrice(best) ? current : best,
    );

    const basePrice = effectivePrice(lowest);
    const tiers = lowest.priceTiers.map((t) => {
      const price = toMoney(t.price);
      return {
        quantity: t.quantity,
        price,
        unitPrice: Math.round((price / t.quantity) * 100) / 100,
        savings:
          basePrice > 0 ? Math.max(0, toMoney(basePrice * t.quantity - price)) : null,
      };
    });

    res.json({
      productId,
      shopName: lowest.shop?.name ?? null,
      basePrice: toMoney(basePrice),
      tiers,
      hasTiers: tiers.length > 0,
    });
  } catch (error) {
    console.error("Error fetching product price tiers:", error);
    res.status(500).json({ error: "Failed to fetch price tiers." });
  }
};
