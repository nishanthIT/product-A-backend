/** Add the requested number of cases once, including concurrent additions. */
export async function addListProduct(db, { listId, productId, productAtShopId, quantity, isUrgent, shopId, inHandStock }) {
  return db.$transaction(async (tx) => {
    // A logical product may have prices at multiple suppliers. Lock by list and
    // product, rather than supplier row, before checking whether it is present.
    const key = `list-product:${listId}:${productId}`;
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))::text`;
    const existing = await tx.listProduct.findFirst({
      // Direct additions have no prior list; do not assign another item's origin.
      where: { listId, productAtShop: { productId }, outOfStockSourceListId: null },
      orderBy: { id: 'asc' },
    });
    if (existing && existing.quantity + quantity > 2147483647) {
      throw Object.assign(new Error('Quantity exceeds the supported whole-number range'), { status: 400 });
    }
    const include = { productAtShop: { include: { product: true, shop: true } } };
    const entry = existing
      ? await tx.listProduct.update({
          where: { id: existing.id },
          data: { quantity: { increment: quantity }, ...(isUrgent && { isUrgent: true }) },
          include,
        })
      : await tx.listProduct.create({
          data: { listId, productAtShopId, quantity, isUrgent },
          include,
        });
    if (inHandStock != null && shopId) {
      await tx.supermarketProductState.upsert({
        where: { shopId_productId: { shopId, productId } },
        create: { shopId, productId, inHandStock },
        update: { inHandStock },
      });
    }
    await tx.list.update({ where: { id: listId }, data: { updatedAt: new Date() } });
    return { entry, alreadyExists: !!existing };
  }, { maxWait: 15000, timeout: 60000 });
}
