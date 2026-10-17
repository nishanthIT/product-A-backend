import { createHash } from 'node:crypto';
import { gtin } from '../../src/services/productBarcodes.js';

export const hash = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
export const missing = value => value == null || (typeof value === 'string' && /^(?:\s*|null|undefined|n\/a)$/i.test(value.trim()));
const compact = value => typeof value === 'string' ? value.toLowerCase().replace(/[\s'’]/g, '').replace(/×/g, 'x') : '';

// Count the saleable units, not the items inside a multipack. Preserve that inner expression.
export function packageSize(value) {
  const text = compact(value);
  const parts = text.split('x');
  const inner = parts.pop();
  if (parts.some(p => !/^[1-9]\d*$/.test(p))) return null;
  const match = inner.match(/^(\d+(?:\.\d+)?)(ml|cl|l|ltr|litre|litres|g|gm|kg|oz|s|pk|pack|pc|pcs|pce|roll|rolls|sheet|sheets|m|mtr|mm|cm|tabs|caps|ct|stk)$/);
  if (!match || Number(match[1]) <= 0) return null;
  const factors = { ml: ['ml', 1], cl: ['ml', 10], l: ['ml', 1000], ltr: ['ml', 1000], litre: ['ml', 1000], litres: ['ml', 1000], g: ['g', 1], gm: ['g', 1], kg: ['g', 1000], mtr: ['m', 1], pcs: ['pc', 1], pce: ['pc', 1], rolls: ['roll', 1], sheets: ['sheet', 1] };
  const [unit, factor] = factors[match[2]] || [match[2], 1];
  return [...parts, `${Number((Number(match[1]) * factor).toFixed(6))}${unit}`].join('x');
}

function parsePacking(record) {
  const quantity = record.pack_quantity;
  const size = packageSize(record.unit_size);
  if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > 2147483647 || !/^\d+$/.test(String(record.pack_quantity_raw)) || Number(record.pack_quantity_raw) !== quantity) return null;
  const packing = compact(record.packing).match(/^([1-9]\d*)x(.+)$/);
  if (!size || !packing || Number(packing[1]) !== quantity || packageSize(packing[2]) !== size) return null;
  return { unitsPerCase: quantity, packageSize: record.unit_size.trim(), packageSizeKey: size, packing: record.packing.trim() };
}

function add(map, key, value) {
  if (key) map.set(key, [...(map.get(key) || []), value]);
}

export function buildProductMasterPlan(records, products, packaging = []) {
  const units = new Map(), legacyCases = new Map(), sourceUnits = new Map(), sourceCases = new Map();
  const existingCases = new Map(packaging.map(p => [p.caseGtin, p]));
  for (const product of products) {
    add(units, gtin(product.barcode), product);
    add(legacyCases, gtin(product.caseBarcode), product);
  }
  const rows = records.map((r, index) => ({ r, index, unit: gtin(r.unit_barcode), caseCode: gtin(r.case_barcode), pack: parsePacking(r), reasons: [] }));
  for (const row of rows) { add(sourceUnits, row.unit, row); add(sourceCases, row.caseCode, row); }
  const matched = [], unresolved = [], warnings = [], candidates = new Map();
  const sourceIdentityConflicts = new Set([...sourceUnits].filter(([, group]) => new Set(group.map(row => row.pack?.packageSizeKey).filter(Boolean)).size > 1).map(([code]) => code));
  for (const row of rows) {
    const { r, unit, caseCode, pack, reasons } = row;
    const ref = { row: row.index + 1, recordId: r.record_id ?? null, sourceProductCode: r.rcode ?? null, productUrl: r.product_url ?? null, unitBarcode: r.unit_barcode, caseBarcode: r.case_barcode, packing: r.packing };
    const matches = unit ? units.get(unit) || [] : [];
    if (!unit) reasons.push(missing(r.unit_barcode) ? 'missing_unit_barcode' : 'invalid_unit_gtin');
    else if (!matches.length) reasons.push('no_existing_unit_match');
    else if (matches.length > 1) reasons.push('duplicate_database_unit_gtin');
    const product = matches.length === 1 ? matches[0] : null;
    if (product) matched.push({ ...ref, productId: product.id, match: product.barcode === r.unit_barcode ? 'exact_unit' : 'equivalent_gtin' });
    if (!caseCode) reasons.push(missing(r.case_barcode) ? 'missing_case_barcode' : 'invalid_case_gtin');
    if (!pack) reasons.push('ambiguous_packaging');
    if (r.errors?.length) reasons.push('source_extraction_error');
    // Array/scalar disagreement must never silently select the first token.
    if (!Array.isArray(r.unit_barcodes) || r.unit_barcodes.length !== 1 || gtin(r.unit_barcodes[0]) !== unit ||
        (caseCode && (!Array.isArray(r.case_barcodes) || r.case_barcodes.length !== 1 || gtin(r.case_barcodes[0]) !== caseCode))) reasons.push('ambiguous_source_barcodes');
    if (sourceIdentityConflicts.has(unit)) reasons.push('conflicting_source_unit_sizes');
    if (caseCode) {
      const group = sourceCases.get(caseCode);
      if (new Set(group.map(other => other.unit || `invalid:${other.r.unit_barcode}`)).size > 1) reasons.push('case_gtin_shared_by_source_products');
      if (new Set(group.map(other => other.pack ? `${other.pack.unitsPerCase}:${other.pack.packageSizeKey}` : `unknown:${other.r.packing}`)).size > 1) reasons.push('conflicting_source_case_configurations');
      if ((units.get(caseCode)?.length || sourceUnits.has(caseCode))) reasons.push('case_gtin_is_unit_gtin');
      if (product && (legacyCases.get(caseCode) || []).some(p => p.id !== product.id)) reasons.push('case_gtin_owned_by_other_product');
    }
    if (product && pack) {
      const storedSize = packageSize(product.packetSize);
      if (storedSize && storedSize !== pack.packageSizeKey) reasons.push('existing_unit_size_conflict');
      const previous = existingCases.get(caseCode);
      if (previous && (previous.productId !== product.id || previous.unitsPerCase !== pack.unitsPerCase || previous.packageSizeKey !== pack.packageSizeKey)) reasons.push('existing_packaging_conflict');
      if (gtin(product.caseBarcode) === caseCode && !missing(product.caseSize)) {
        const storedCase = compact(product.caseSize);
        const count = /^\d+$/.test(storedCase) ? Number(storedCase) : Number(storedCase.match(/^(\d+)x/)?.[1]);
        if (count && count !== pack.unitsPerCase) reasons.push('existing_case_quantity_conflict');
      }
    }
    if (reasons.length) {
      unresolved.push({ ...ref, productId: product?.id ?? null, matchedProductIds: matches.map(p => p.id), reasons: [...new Set(reasons)],
        caseCodeUnitOwners: (units.get(caseCode) || []).map(p => ({ productId: p.id, barcode: p.barcode, title: p.title })),
        caseCodeLegacyOwners: (legacyCases.get(caseCode) || []).map(p => ({ productId: p.id, caseBarcode: p.caseBarcode })),
        existingPackaging: existingCases.get(caseCode) || null,
        existingPacketSize: product?.packetSize ?? null,
        existingCaseSize: product?.caseSize ?? null,
      });
      continue;
    }
    const key = `${product.id}:${caseCode}`;
    if (!candidates.has(key)) candidates.set(key, { id: `pm_${hash(key).slice(0,32)}`, productId: product.id, caseBarcode: r.case_barcode.trim(), caseGtin: caseCode, ...pack, source: 'REDNEVAL_PRODUCT_MASTER', sourceReferences: [] });
    candidates.get(key).sourceReferences.push({ ...ref, unitSize: r.unit_size, packQuantityRaw: r.pack_quantity_raw, layerQuantity: r.layer_quantity, layerQuantityRaw: r.layer_quantity_raw, layerQuantityBasis: r.layer_quantity_basis, palletQuantity: r.pallet_quantity, palletQuantityRaw: r.pallet_quantity_raw, palletQuantityBasis: r.pallet_quantity_basis });
  }
  const configurations = [...candidates.values()].sort((a,b) => a.caseGtin.localeCompare(b.caseGtin));
  const creates = configurations.filter(c => !existingCases.has(c.caseGtin));
  const updates = [];
  const configsByProduct = new Map(), existingByProduct = new Map();
  for (const c of configurations) add(configsByProduct, c.productId, c);
  for (const c of packaging) add(existingByProduct, c.productId, c);
  for (const product of products) {
    const configs = configsByProduct.get(product.id) || [];
    if (!configs.length) continue;
    const changes = {};
    // Preserve every nonempty legacy value. Never select an arbitrary default case.
    const allConfigs = new Set([...configs.map(c => c.caseGtin), ...(existingByProduct.get(product.id) || []).map(c => c.caseGtin)]);
    const sourceGroup = sourceUnits.get(gtin(product.barcode)) || [];
    const allSourceSafe = sourceGroup.every(row => row.reasons.length === 0);
    if (allSourceSafe && new Set(configs.map(c => c.packageSizeKey)).size === 1 && missing(product.packetSize)) changes.packetSize = configs[0].packageSize;
    if (allSourceSafe && allConfigs.size === 1) {
      const config = configs[0];
      if (missing(product.caseBarcode)) changes.caseBarcode = config.caseBarcode;
      if (missing(product.caseSize)) changes.caseSize = config.packing;
    }
    for (const field of ['caseBarcode','caseSize','packetSize']) {
      if (!missing(product[field]) && configs.length && (field !== 'caseBarcode' || !configs.some(c => gtin(product[field]) === c.caseGtin))) {
        warnings.push({ productId: product.id, field, retainedValue: product[field], reason: 'existing_legacy_value_preserved' });
      }
    }
    if (allConfigs.size > 1) warnings.push({ productId: product.id, reason: 'multiple_cases_no_default_selected', caseGtins: [...allConfigs] });
    if (Object.keys(changes).length) updates.push({ productId: product.id, before: Object.fromEntries(Object.keys(changes).map(field => [field, product[field]])), changes });
  }
  const reasons = {};
  unresolved.forEach(row => row.reasons.forEach(reason => { reasons[reason] = (reasons[reason] || 0) + 1; }));
  const databaseIssues = {
    missingUnitBarcodes: products.filter(p => missing(p.barcode)).map(p => p.id),
    invalidUnitBarcodes: products.filter(p => !missing(p.barcode) && !gtin(p.barcode)).map(p => ({ productId: p.id, barcode: p.barcode })),
    invalidLegacyCaseBarcodes: products.filter(p => !missing(p.caseBarcode) && !gtin(p.caseBarcode)).map(p => ({ productId: p.id, caseBarcode: p.caseBarcode })),
    duplicateUnitGtins: [...units].filter(([, ps]) => ps.length > 1).map(([code, ps]) => ({ gtin: code, productIds: ps.map(p => p.id) })),
    duplicateLegacyCaseGtins: [...legacyCases].filter(([, ps]) => ps.length > 1).map(([code, ps]) => ({ gtin: code, productIds: ps.map(p => p.id) })),
  };
  return {
    summary: { sourceRecords: records.length, databaseProducts: products.length, matchedSourceRecords: matched.length, matchedProducts: new Set(matched.map(r => r.productId)).size, newPackagingConfigurations: creates.length, existingPackagingConfigurations: configurations.length - creates.length, productsToUpdate: updates.length, safeSourceRecords: rows.length - unresolved.length, duplicateSourceConfigurationsCollapsed: rows.length - unresolved.length - configurations.length, unresolvedRecords: unresolved.length, reasons },
    matched, creates, updates, unresolved, warnings, databaseIssues,
  };
}
