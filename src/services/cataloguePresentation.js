// Public-to-account catalogue fields. Import provenance and supplier operations
// remain in the database and company administration paths.
const productFields = ['id', 'title', 'caseSize', 'packetSize', 'barcode', 'img', 'retailSize', 'caseBarcode', 'rrp', 'category', 'barcodeMatchType'];
const packagingFields = ['id', 'productId', 'caseBarcode', 'caseGtin', 'unitsPerCase', 'packageSize'];
const pick = (row, fields) => Object.fromEntries(fields.filter(key => row?.[key] !== undefined).map(key => [key, row[key]]));
export function presentCatalogueProduct(product) {
  return {
    ...pick(product, productFields),
    ...(product.packagingConfigurations && { packagingConfigurations: product.packagingConfigurations.map(row => pick(row, packagingFields)) }),
    ...(product.matchedPackaging !== undefined && { matchedPackaging: product.matchedPackaging ? pick(product.matchedPackaging, packagingFields) : null }),
  };
}

export function boundedPage(raw, fallback = 1, maximum = 1000) {
  if (raw === undefined) return fallback;
  if (!/^[1-9]\d*$/.test(String(raw)) || !Number.isSafeInteger(Number(raw)) || Number(raw) > maximum) return null;
  return Number(raw);
}
