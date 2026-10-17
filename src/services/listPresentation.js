import { getEffectivePrice } from './supplierPricing.js';
// Shared presentation for ordinary and consolidated out-of-stock list rows.
export function presentListProduct(lp, stockByProduct = new Map()) {
  const pricing = getEffectivePrice(lp.productAtShop || { price: 0 });
  return {
    id: lp.id,
    outOfStockSourceListId: lp.outOfStockSourceListId ?? null,
    productId: lp.productAtShop?.product?.id || lp.productAtShopId,
    productAtShopId: lp.productAtShopId,
    productName: lp.productAtShop?.product?.title || 'Unknown Product',
    barcode: lp.productAtShop?.product?.barcode || '',
    caseBarcode: lp.productAtShop?.product?.caseBarcode || '',
    retailSize: lp.productAtShop?.product?.retailSize || '',
    caseSize: lp.productAtShop?.unitsPerPack != null ? String(lp.productAtShop.unitsPerPack) : lp.productAtShop?.product?.caseSize || '',
    packetSize: lp.productAtShop?.pricedUnitSize || lp.productAtShop?.product?.packetSize || '',
    aielNumber: lp.productAtShop?.card_aiel_number || '',
    locationCode: lp.productAtShop?.locationCode || '',
    category: lp.productAtShop?.product?.category || 'Uncategorized',
    ...pricing,
    lowestPrice: pricing.price,
    originalPrice: Number(lp.productAtShop?.price) || 0,
    offerPrice: lp.productAtShop?.offerPrice ? Number(lp.productAtShop.offerPrice) : null,
    hasActiveOffer: pricing.hasActiveOffer,
    shopName: lp.productAtShop?.shop?.name || 'Unknown Shop',
    shopId: lp.productAtShop?.shop?.id || '',
    img: lp.productAtShop?.product?.img || null,
    quantity: lp.quantity || 1,
    isPurchased: lp.isPurchased || false,
    isUrgent: lp.isUrgent || false,
    inHandStock: stockByProduct.get(lp.productAtShop?.productId) ?? null,
    // Bundle offer fields
    isFreeItem: lp.isFreeItem || false,
    freeQuantity: lp.freeQuantity || 0,
    bundlePromotionId: lp.bundlePromotionId || null,

  };
}
