import express from 'express';
import { PrismaClient } from '@prisma/client';
import { isAuthenticated } from '../middleware/authware.js';

const router = express.Router();
const prisma = new PrismaClient();

// Shared auth: verifies the token and reloads employee memberships each request
const authenticateToken = isAuthenticated;

const num = (v) => (v == null ? null : Number.parseFloat(v));

/**
 * Everything needed to compare a product across shops in one round trip:
 * product info, per-shop pricing (with offers), quantity price tiers, and
 * bundle promotions. Remote DB latency dominates, so we do one wave of
 * parallel queries and let the client compute effective unit prices.
 */
router.get('/:id/compare', authenticateToken, async (req, res) => {
  const started = Date.now();
  try {
    const { id: productId } = req.params;
    if (!productId) return res.status(400).json({ error: 'Product ID is required' });

    const product = await prisma.product.findUnique({
      where: { id: productId },
      select: {
        id: true,
        title: true,
        barcode: true,
        img: true,
        category: true,
        packetSize: true,
        retailSize: true,
        rrp: true,
      },
    });
    if (!product) return res.status(404).json({ error: 'Product not found' });

    const now = new Date();
    const [productAtShops, bundlePromotions] = await Promise.all([
      prisma.productAtShop.findMany({
        where: { productId, outOfStock: false },
        include: {
          shop: { select: { id: true, name: true, address: true, mobile: true } },
          priceTiers: { orderBy: { quantity: 'asc' } },
        },
      }),
      prisma.bundlePromotion.findMany({
        where: {
          isActive: true,
          OR: [{ startDate: null }, { startDate: { lte: now } }],
          AND: [{ OR: [{ endDate: null }, { endDate: { gte: now } }] }],
          buyItems: { some: { productId } },
        },
        include: {
          shop: { select: { id: true, name: true, address: true } },
          buyItems: {
            include: { product: { select: { id: true, title: true, img: true, barcode: true } } },
          },
          getItems: {
            include: { product: { select: { id: true, title: true, img: true, barcode: true } } },
          },
        },
      }),
    ]);

    const shops = productAtShops.map((pas) => {
      const hasActiveOffer =
        pas.offerPrice != null &&
        pas.offerExpiryDate != null &&
        new Date(pas.offerExpiryDate) >= now;
      const basePrice = num(pas.price);
      const offerPrice = hasActiveOffer ? num(pas.offerPrice) : null;
      const effectivePrice = hasActiveOffer ? offerPrice : basePrice;
      return {
        productAtShopId: pas.id,
        shopId: pas.shop.id,
        shopName: pas.shop.name,
        shopAddress: pas.shop.address,
        shopMobile: pas.shop.mobile,
        price: basePrice,
        offerPrice,
        offerExpiryDate: pas.offerExpiryDate,
        hasActiveOffer,
        effectivePrice,
        priceTiers: pas.priceTiers.map((t) => ({
          quantity: t.quantity,
          price: num(t.price),
        })),
      };
    });

    const bundles = bundlePromotions.map((promo) => ({
      id: promo.id,
      name: promo.name,
      description: promo.description,
      promotionType: promo.promotionType,
      shopId: promo.shop.id,
      shopName: promo.shop.name,
      startDate: promo.startDate,
      endDate: promo.endDate,
      buyItems: promo.buyItems.map((bi) => ({
        productId: bi.productId,
        productName: bi.product.title,
        productImage: bi.product.img,
        productBarcode: bi.product.barcode,
        quantity: bi.quantity,
      })),
      getItems: promo.getItems.map((gi) => ({
        productId: gi.productId,
        productName: gi.product.title,
        productImage: gi.product.img,
        productBarcode: gi.product.barcode,
        quantity: gi.quantity,
      })),
    }));

    console.log(
      `🔎 /products/${productId}/compare → ${shops.length} shops, ${bundles.length} bundles (${Date.now() - started}ms)`,
    );

    res.json({ success: true, product, shops, bundles });
  } catch (error) {
    console.error('Error building compare payload:', error);
    res.status(500).json({ error: 'Failed to load comparison data' });
  }
});

export default router;
