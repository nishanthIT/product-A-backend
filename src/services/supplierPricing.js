// One selector for scanning, comparison and list totals. Undated legacy offers
// remain inactive. Only a verified Dhamecha import can select an undated current price.
export function getEffectivePrice(row, now = new Date()) {
  const originalPrice = Number(row.price);
  const offerPrice = row.offerPrice == null ? null : Number(row.offerPrice);
  const importedCurrent = row.offerPriceSource === 'DHAMECHA_CURRENT' && offerPrice > 0;
  const datedOffer = offerPrice != null && row.offerExpiryDate != null && new Date(row.offerExpiryDate) > now;
  const price = importedCurrent || datedOffer ? offerPrice : originalPrice;
  const unitsPerPack = row.unitsPerPack ?? 1;
  return {
    price, originalPrice, offerPrice,
    hasActiveOffer: Boolean(datedOffer || (importedCurrent && row.sourcePricing?.promotion === true && offerPrice < originalPrice)),
    isSupplierCurrentPrice: importedCurrent,
    unitsPerPack,
    unitPrice: price / unitsPerPack,
    packagingId: row.packagingId ?? null,
    pricedUnitSize: row.pricedUnitSize ?? null,
    priceObservedAt: row.priceObservedAt ?? null,
  };
}

export function presentSupplierPrice(row, matchedPackaging = null) {
  const base = getEffectivePrice(row);
  const tiers = (row.priceTiers || []).map(t => ({
    id: t.id, quantity: t.quantity, price: Number(t.price), packagingId: t.packagingId ?? null,
    priceObservedAt: t.priceObservedAt ?? null,
  }));
  // A case scan may only select that exact case. Never silently return a unit
  // price (or a different case's price) as the price of the scanned case.
  let scannedPrice = null;
  if (matchedPackaging) {
    if (row.packagingId === matchedPackaging.id) scannedPrice = { ...base, type: 'base' };
    else {
      const tier = tiers.find(t => t.packagingId === matchedPackaging.id);
      if (tier) scannedPrice = { ...tier, unitsPerPack: tier.quantity, unitPrice: tier.price / tier.quantity, type: 'case_tier' };
    }
  }
  return {
    shopId: row.shopId, productAtShopId: row.id,
    name: row.shop?.name, location: row.shop?.address,
    ...base, effectivePrice: base.price, offerExpiryDate: row.offerExpiryDate ?? null,
    priceTiers: tiers, scannedPrice,
    ...(matchedPackaging && {
      basePrice: base.price,
      price: scannedPrice?.price ?? null,
      effectivePrice: scannedPrice?.price ?? null,
      originalPrice: scannedPrice?.originalPrice ?? scannedPrice?.price ?? null,
      offerPrice: scannedPrice?.offerPrice ?? null,
      hasActiveOffer: scannedPrice?.hasActiveOffer ?? false,
      isSupplierCurrentPrice: scannedPrice?.isSupplierCurrentPrice ?? false,
      unitPrice: scannedPrice?.unitPrice ?? null,
      unitsPerPack: matchedPackaging.unitsPerCase,
      pricedUnitSize: matchedPackaging.packageSize,
      packagingId: matchedPackaging.id,
      availableForScannedPackaging: scannedPrice !== null,
    }),
  };
}
