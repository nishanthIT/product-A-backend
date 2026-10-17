import { getListSummaries } from './listSummaries.js';
import { presentListProduct } from './listPresentation.js';

export const isOutOfStock = name => name === 'Out of Stock' || name?.startsWith('Out of Stock · ');
export const OUT_OF_STOCK_ID = 'out-of-stock';

// All writes still run through the ordinary list controllers and authorization.
// This adapter resolves the combined view to an already-accessible real row.
export async function resolveOutOfStockList(db, user, listProductId) {
  if (typeof listProductId !== 'string' || !listProductId) throw Object.assign(new Error('An exact list item is required'), { status: 400 });
  const lists = (await getListSummaries(db, user)).filter(list => isOutOfStock(list.name));
  const item = await db.listProduct.findFirst({ where: { id: listProductId, listId: { in: lists.map(list => list.id) } }, select: { listId: true } });
  if (!item) throw Object.assign(new Error('Item not found in your Out of Stock lists'), { status: 404 });
  return item.listId;
}

async function canonicalOutOfStock(tx, user, shopId = user.shopId ?? null) {
  const ownerField = user.userType === 'EMPLOYEE' ? 'employeeId' : user.userType === 'ADMIN' ? 'adminId' : 'customerId';
  const lock = `out-of-stock:${user.userType}:${user.id}:${shopId ?? ''}`;
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${lock}, 0))::text`;
  let target = await tx.list.findFirst({
    where: { [ownerField]: user.id, creatorType: user.userType, shopId, name: 'Out of Stock' },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
  const created = !target;
  if (!target) target = await tx.list.create({ data: {
    name: 'Out of Stock', description: 'Unavailable products, grouped by supplier shop',
    creatorType: user.userType, [ownerField]: user.id, shopId,
  } });
  return { target, created };
}

export function ensureOutOfStockList(db, user) {
  return db.$transaction(tx => canonicalOutOfStock(tx, user), { maxWait: 15000, timeout: 60000 });
}

// Preserve old supplier-specific lists, chat links, tracking and item IDs. Only
// expose lists already visible under the caller's existing account/shop scope.
export async function loadOutOfStock(db, user) {
  const summaries = (await getListSummaries(db, user)).filter(list => isOutOfStock(list.name));
  const lists = summaries.length ? await db.list.findMany({
    where: { id: { in: summaries.map(list => list.id) } },
    select: { id: true, name: true, shopId: true, products: { orderBy: { id: 'desc' }, include: { productAtShop: { include: { product: true, shop: true } } } } },
  }) : [];
  const shopIds = [...new Set(lists.map(list => list.shopId).filter(Boolean))];
  const productIds = [...new Set(lists.flatMap(list => list.products.map(row => row.productAtShop.productId)))];
  const stock = shopIds.length && productIds.length ? await db.supermarketProductState.findMany({
    where: { shopId: { in: shopIds }, productId: { in: productIds } },
  }) : [];
  const stockByShop = new Map();
  for (const state of stock) {
    if (!stockByShop.has(state.shopId)) stockByShop.set(state.shopId, new Map());
    stockByShop.get(state.shopId).set(state.productId, state.inHandStock);
  }
  return { id: OUT_OF_STOCK_ID, name: 'Out of Stock', description: 'Unavailable products',
    createdAt: summaries.map(list => list.createdAt).sort((a, b) => new Date(a) - new Date(b))[0] ?? null,
    updatedAt: summaries.map(list => list.updatedAt).sort((a, b) => new Date(a) - new Date(b)).at(-1) ?? null,
    canEdit: true, isOutOfStockCollection: true,
    products: lists.flatMap(list => list.products.map(row => ({
    ...presentListProduct(row, stockByShop.get(list.shopId)),
    listId: list.id, sourceListName: list.name,
  }))) };
}

export async function moveToOutOfStock(db, user, source, item) {
  if (isOutOfStock(source.name)) throw Object.assign(new Error('Item is already in Out of Stock'), { status: 400 });
  const shopId = user.shopId ?? (user.userType === 'ADMIN' ? source.shopId : null);
  return db.$transaction(async tx => {
    const { target, created } = await canonicalOutOfStock(tx, user, shopId);
    // Keep the original item ID, quantity, supplier and flags; never delete or
    // merge old rows as a side effect of reorganizing this view.
    const moved = await tx.listProduct.updateMany({
      where: { id: item.id, listId: source.id, bundlePromotionId: null },
      data: { listId: target.id, isPurchased: false, outOfStockSourceListId: source.id },
    });
    if (!moved.count) {
      const current = await tx.listProduct.findUnique({ where: { id: item.id }, select: { listId: true } });
      if (current?.listId !== target.id) throw Object.assign(new Error('This item changed. Refresh the list and try again.'), { status: 409 });
    }
    await tx.list.updateMany({ where: { id: { in: [source.id, target.id] } }, data: { updatedAt: new Date() } });
    return { message: 'Moved to Out of Stock', targetListId: target.id, targetListName: target.name, created, merged: false };
  }, { maxWait: 15000, timeout: 60000 });
}
