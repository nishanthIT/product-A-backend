// Keep identifiers as strings. Only checksum-valid GS1 formats have padded aliases.
export function gtin(value) {
  if (typeof value !== 'string') return null;
  const code = value.trim();
  if (!/^(?:\d{8}|\d{12}|\d{13}|\d{14})$/.test(code) || /^0+$/.test(code)) return null;
  let sum = 0;
  for (let i = code.length - 2, weight = 3; i >= 0; i--, weight = 4 - weight) sum += Number(code[i]) * weight;
  return (10 - sum % 10) % 10 === Number(code.at(-1)) ? code.padStart(14, '0') : null;
}

export function barcodeAliases(value) {
  const raw = typeof value === 'string' ? value.trim() : '';
  const normalized = gtin(raw);
  if (!normalized) return raw ? [raw] : [];
  return [...new Set([raw, ...[8, 12, 13, 14].filter(length => /^0*$/.test(normalized.slice(0, 14 - length))).map(length => normalized.slice(-length))])];
}

export function barcodeWhere(value, field = '') {
  const aliases = barcodeAliases(value);
  const unit = { barcode: { in: aliases } };
  const cases = [{ caseBarcode: { in: aliases } }, { packagingConfigurations: { some: { caseBarcode: { in: aliases } } } }];
  return { OR: field === 'barcode' ? [unit] : field === 'casebarcode' ? cases : [unit, ...cases] };
}

export async function resolveProductBarcode(prisma, barcode, { field = '', include = {} } = {}) {
  const products = await prisma.product.findMany({
    where: barcodeWhere(barcode, field),
    include: { ...include, packagingConfigurations: { orderBy: { caseGtin: 'asc' } } },
    take: 2,
  });
  if (products.length > 1) {
    const error = new Error('Barcode matches multiple products; catalog review is required.');
    error.statusCode = 409;
    error.code = 'AMBIGUOUS_BARCODE';
    throw error;
  }
  if (!products.length) return null;
  const product = products[0];
  const aliases = barcodeAliases(barcode);
  const matchedPackaging = field === 'barcode' ? null : product.packagingConfigurations.find(p => aliases.includes(p.caseBarcode)) ?? null;
  return { ...product, matchedPackaging, barcodeMatchType: matchedPackaging ? 'case' : aliases.includes(product.barcode) ? 'unit' : 'legacy_case' };
}

// Legacy edit forms cannot silently invalidate reviewed case configurations.
export async function assertProductMasterWrite(prisma, productId, data) {
  const fields = ['barcode', 'caseBarcode', 'caseSize', 'packetSize'];
  if (!fields.some(field => data[field] !== undefined)) return;
  const current = productId ? await prisma.product.findUnique({ where: { id: productId }, include: { packagingConfigurations: true } }) : null;
  const fail = message => { throw Object.assign(new Error(message), { statusCode: 409, code: 'PRODUCT_MASTER_CONFLICT' }); };
  if (current?.packagingConfigurations.length && fields.some(field => data[field] !== undefined && data[field] !== current[field])) {
    fail('This product has reviewed case configurations. Barcode and packaging changes require a reviewed product-master update.');
  }
  for (const field of ['barcode', 'caseBarcode']) {
    if (!data[field] || data[field] === current?.[field]) continue;
    const conflicts = await prisma.product.findMany({ where: { AND: [barcodeWhere(String(data[field])), ...(productId ? [{ id: { not: productId } }] : [])] }, select: { id: true }, take: 1 });
    if (conflicts.length) fail('Barcode is already assigned to a product or case configuration.');
  }
}
