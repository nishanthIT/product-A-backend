import { PrismaClient } from '@prisma/client';
const db = new PrismaClient();
/** Supplier administration must never accept a CUSTOMER Shop row. */
export async function requireSupplierScope(req, res, next) {
  try {
    const ids = [req.params.shopId, req.body?.shopId, req.body?.sourceShopId, req.body?.targetShopId, req.body?.destinationShopId];
    if (/^\/(editShop|getshop|shops)\//.test(req.path)) ids.push(req.params.id);
    if (req.params.promotionId) {
      if (req.path.startsWith('/product-promotions/')) {
        const promotion = await db.productPromotion.findUnique({ where: { id: req.params.promotionId }, select: { productAtShop: { select: { shopId: true } } } });
        ids.push(promotion?.productAtShop.shopId);
      } else if (req.path.startsWith('/bundle-promotions/')) {
        const promotion = await db.bundlePromotion.findUnique({ where: { id: req.params.promotionId }, select: { shopId: true } });
        ids.push(promotion?.shopId);
      }
    }
    for (const id of new Set(ids.filter(Boolean))) {
      if (typeof id !== 'string' || !(await db.shop.findFirst({ where: { id, shopType: 'WHOLESALE' }, select: { id: true } }))) {
        return res.status(404).json({ error: 'Cash & Carry supplier not found' });
      }
    }
    next();
  } catch (err) { next(err); }
}
