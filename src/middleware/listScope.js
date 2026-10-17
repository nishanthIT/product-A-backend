import { PrismaClient } from '@prisma/client';
import { OUT_OF_STOCK_ID, ensureOutOfStockList, resolveOutOfStockList } from '../services/outOfStock.js';
const db = new PrismaClient();

/** Shared by BOTH list routers. Supplier IDs in item payloads are not supermarket IDs. */
export async function requireListScope(req, res, next) {
  try {
    if (req.body?.listId === OUT_OF_STOCK_ID) {
      if (req.body.listProductId) {
        req.body.listId = await resolveOutOfStockList(db, req.user, req.body.listProductId);
      } else if (req.method === 'POST') {
        req.body.listId = (await ensureOutOfStockList(db, req.user)).target.id;
      } else {
        return res.status(400).json({ error: 'An exact list item is required' });
      }
    }
    const ids = [req.params.listId, req.params.id, req.body?.listId, req.body?.targetListId, req.query?.listId].filter(Boolean);
    for (const id of new Set(ids)) {
      if (typeof id !== 'string') return res.status(400).json({ error: 'Invalid list ID' });
      const list = await db.list.findUnique({ where: { id }, select: { shopId: true, adminId: true, employeeId: true, customerId: true } });
      if (!list) return res.status(404).json({ error: 'List not found' });
      // Company lists remain account-scoped. Customer records always require current membership.
      if (req.user.userType === 'ADMIN' && list.adminId === req.user.id) continue;
      if (!req.user.shopId || list.shopId !== req.user.shopId) return res.status(404).json({ error: 'List not found in the selected supermarket', code: 'SUPERMARKET_ACCESS_REQUIRED' });
    }
    const supplierProductId = req.body?.productAtShopId ?? req.params.productAtShopId;
    if (supplierProductId) {
      if (typeof supplierProductId !== 'string' || !(await db.productAtShop.findFirst({ where: { id: supplierProductId, shop: { shopType: 'WHOLESALE' } }, select: { id: true } }))) return res.status(404).json({ error: 'Supplier product not found' });
    }
    next();
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
}
