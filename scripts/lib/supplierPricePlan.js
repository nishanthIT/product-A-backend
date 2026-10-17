import fs from 'node:fs/promises';
import path from 'node:path';
import { gtin } from '../../src/services/productBarcodes.js';
import { hash, packageSize } from './productMasterPlan.js';

export const SUPPLIERS = {
  DHAMECHA: { id: 'cmhmfswa60000dgqs90qv3x02', name: 'DAM&CHA CASH & CARRY' },
  BESTWAY: { id: 'cmlxrkf550002caussfk5azlh', name: 'Bestway' },
};
export function money(value) {
  if (value == null || !/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(String(value).trim())) return null;
  const [whole, fraction = ''] = String(value).trim().split('.');
  if (/[^0]/.test(fraction.slice(2)) || whole.length > 8) return null;
  const cents = BigInt(whole) * 100n + BigInt((fraction + '00').slice(0, 2));
  return cents > 0n ? `${cents / 100n}.${String(cents % 100n).padStart(2, '0')}` : null;
}
const add = (map, key, value) => { if (key) map.set(key, [...(map.get(key) || []), value]); };
const normalizeSize = value => packageSize(value) || (/^(sgl|each)$/i.test(String(value).trim()) ? '1each' : null);
const sizeKey = value => typeof value === 'string' ? value.toLowerCase().replace(/\s/g,'').replace(/×/g,'x') : '';
const asDate = value => value && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;

export function bestwayBarcode(record) {
  const typed = [];
  if (Array.isArray(record.barcodes)) {
    for (const item of record.barcodes) {
      if (/^(?:retail[ _-]?(?:ean|barcode)|unit[ _-]?(?:ean|barcode))$/i.test(item.label || item.role || '')) typed.push(item.value);
      if (item.retail_barcode != null) typed.push(item.retail_barcode);
    }
  } else if (record.barcodes && typeof record.barcodes === 'object') {
    if (record.barcodes.retail_barcode != null) typed.push(record.barcodes.retail_barcode);
  }
  if (record.retail_barcode != null) typed.push(record.retail_barcode);
  // The older flattened exports explicitly name the retail barcode `barcode`.
  const values = typed.length ? typed : record.barcodes != null ? [] : [record.barcode];
  const codes = [...new Set(values.map(gtin))];
  if (codes.length !== 1 || !codes[0]) return { code: null, reason: values.length ? 'invalid_or_ambiguous_barcode' : 'missing_retail_barcode' };
  if (record.barcode != null && gtin(record.barcode) !== codes[0]) return { code: null, reason: 'conflicting_retail_barcode_fields' };
  return { code: codes[0], barcode: values[0], evidence: typed.length ? 'typed_retail_barcode' : 'flattened_retail_barcode' };
}

export async function readSupplierSources(directory) {
  const files = [];
  async function walk(dir) {
    for (const entry of (await fs.readdir(dir, { withFileTypes: true })).sort((a,b) => a.name.localeCompare(b.name))) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(file); else if (entry.isFile()) files.push(file);
    }
  }
  await walk(directory);
  const manifest = [], records = [], sourceUnresolved = [];
  for (const file of files) {
    const relative = path.relative(directory, file).split(path.sep).join('/');
    const supplier = /^Dhamecha\//i.test(relative) ? 'DHAMECHA' : /^bestway\//i.test(relative) ? 'BESTWAY' : null;
    const bytes = await fs.readFile(file);
    const entry = { file: relative, bytes: bytes.length, sha256: hash(bytes.toString()), supplier, excluded: !supplier };
    manifest.push(entry);
    if (!supplier) continue; // Active Hub is inventoried, never a source of writes.
    const doc = file.endsWith('.jsonl') ? bytes.toString().split(/\r?\n/).filter(line => line.trim()).map(line => JSON.parse(line)) : JSON.parse(bytes);
    const rows = Array.isArray(doc) ? doc : doc.products;
    if (!Array.isArray(rows)) throw new Error(`Unrecognized supplier schema: ${relative}`);
    entry.records = rows.length;
    entry.rootType = Array.isArray(doc) ? 'array' : 'object';
    entry.recordKeys = [...new Set(rows.flatMap(row => Object.keys(row)))].sort();
    entry.schemaVersion = doc.schema_version ?? null;
    entry.sourceIncomplete = doc.status === 'stopped';
    if (!Array.isArray(doc)) {
      entry.pricingContext = doc.pricing_context ?? null;
      for (const [index, record] of (doc.unresolved_products || []).entries()) sourceUnresolved.push({ supplier, file: relative, row: index + 1, barcode: record.barcode, url: record.url, reasons: record.warnings || ['source_unresolved'] });
    }
    rows.forEach((raw, index) => {
      const ref = { file: relative, row: index + 1 };
      if (supplier === 'DHAMECHA') {
        const r = raw.result, p = r?.pricing || {}, pack = r?.packaging || {};
        if (!r) throw new Error(`Unrecognized Dhamecha row: ${relative}:${index+1}`);
        records.push({ supplier, ref, barcode: r.barcode, code: gtin(r.barcode), status: r.status, regularPrice: money(p.original_price_1), currentPrice: money(p.product_price), rrp: money(p.rrp), units: pack.pack_count, unitSize: pack.unit_size, packDisplay: pack.pack_size,
          observedAt: asDate(raw.evidence?.response?.captured_at),
          evidence: { sourceProductCode: r.product_id, rawPricing: p, rawPackaging: pack, promotion: r.web_metadata?.promotion ?? null, promotionName: r.web_metadata?.promotion_name ?? null, promotionId: r.web_metadata?.promotion_id ?? null, depot: raw.evidence?.request?.depot ?? null },
          inputProblems: raw.evidence?.request?.barcode !== r.barcode || raw.evidence?.response?.barcode !== r.barcode ? ['scan_evidence_mismatch'] : [],
        });
      } else {
        const barcode = bestwayBarcode(raw);
        const display = typeof raw.pack_display === 'string' ? raw.pack_display.match(/^(.+?)\s*[×x]\s*(\d+)\s*$/i) : null;
        const count = raw.units_per_priced_pack ?? (display ? Number(display[2]) : null);
        records.push({ supplier, ref, barcode: barcode.barcode ?? raw.barcode, code: barcode.code, status: raw.import_ready === false ? 'source_unresolved' : 'found', regularPrice: money(raw.wholesale_price), currentPrice: null, rrp: null, units: count, unitSize: raw.pack_size, packDisplay: raw.pack_display,
          observedAt: asDate(raw.observed_at_utc || doc.updated_at_utc),
          evidence: { sourceProductCode: raw.product_code ?? null, sku: raw.sku ?? null, url: raw.url ?? null, barcodeEvidence: barcode.evidence, rawPricing: { wholesale_price: raw.wholesale_price, currency: raw.currency, price_excludes_vat: raw.price_excludes_vat ?? null, vat_rate_text: raw.vat_rate_text ?? null }, rawPackaging: { pack_size: raw.pack_size, pack_display: raw.pack_display, units_per_priced_pack: raw.units_per_priced_pack ?? null }, depot: doc.pricing_context?.depot ?? null },
          inputProblems: [barcode.reason, raw.currency !== 'GBP' ? 'unsupported_currency' : null, !display || sizeKey(display[1]) !== sizeKey(raw.pack_size) || Number(display[2]) !== count ? 'conflicting_pack_fields' : null].filter(Boolean),
        });
      }
    });
  }
  if (manifest.filter(f => f.supplier === 'BESTWAY').length !== 4) throw new Error('Expected all four audited Bestway files; review changed source inventory');
  return { manifest, records, sourceUnresolved, sourceHash: hash(manifest) };
}

export const stableJson = value => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
const priceEqual = (a,b) => a == null || b == null ? a == null && b == null : Math.abs(Number(a)-Number(b)) < 1e-9;
const comparable = row => ({ price: row.price, offerPrice: row.offerPrice ?? null, offerExpiryDate: row.offerExpiryDate ?? null, packagingId: row.packagingId ?? null, unitsPerPack: row.unitsPerPack ?? null, pricedUnitSize: row.pricedUnitSize ?? null, offerPriceSource: row.offerPriceSource ?? null, sourcePricing: row.sourcePricing ?? null, priceObservedAt: row.priceObservedAt ? asDate(row.priceObservedAt) : null });
function samePriceRow(existing, intended) {
  const a = comparable(existing), b = comparable(intended);
  return priceEqual(a.price,b.price) && priceEqual(a.offerPrice,b.offerPrice) && stableJson({ ...a, price: null, offerPrice: null }) === stableJson({ ...b, price: null, offerPrice: null });
}

export function buildSupplierPricePlan(source, state, suppliers = SUPPLIERS) {
  for (const [key, shop] of Object.entries(suppliers)) if (!state.shops.some(s => s.id === shop.id && s.name === shop.name && s.shopType === 'WHOLESALE')) throw new Error(`Existing supplier identity mismatch: ${key}`);
  const byUnit = new Map(), byCase = new Map(), byLegacyCase = new Map(), packagingByProduct = new Map(), byProduct = new Map(state.products.map(p => [p.id,p]));
  for (const p of state.products) { add(byUnit, gtin(p.barcode), p); add(byLegacyCase, gtin(p.caseBarcode), p); }
  for (const p of state.packaging) { add(byCase, p.caseGtin, p); add(packagingByProduct,p.productId,p); }
  const unresolved = [], matched = [], warnings = [], candidates = new Map(), rrps = new Map();
  for (const r of source.records) {
    const reasons = [...r.inputProblems], ref = { supplier: r.supplier, ...r.ref, barcode: r.barcode, units: r.units, unitSize: r.unitSize };
    if (r.status !== 'found') { unresolved.push({ ...ref, reasons: [r.status === 'not_available' ? 'source_not_available' : 'source_unresolved'] }); continue; }
    if (!r.code) reasons.push('missing_or_invalid_gtin');
    const units = byUnit.get(r.code) || [], cases = byCase.get(r.code) || [];
    const legacyCases = byLegacyCase.get(r.code) || [];
    const productIds = [...new Set([...units.map(p => p.id), ...cases.map(c => c.productId), ...legacyCases.map(p => p.id)])];
    const product = productIds.length === 1 ? byProduct.get(productIds[0]) : null;
    if (!productIds.length) reasons.push('unmatched_product');
    if (legacyCases.length && !units.length && !cases.length) reasons.push('unverified_legacy_case_barcode');
    if (productIds.length > 1 || units.length > 1) reasons.push('ambiguous_product_match');
    // RRP describes the scanned retail unit, independently of an uncertain case count.
    if (r.supplier === 'DHAMECHA' && r.rrp && product && units.length === 1 && !r.inputProblems.length) add(rrps, product.id, r.rrp);
    if (!r.regularPrice || (r.supplier === 'DHAMECHA' && !r.currentPrice)) reasons.push('missing_or_invalid_price');
    if (r.currentPrice && r.regularPrice && Number(r.currentPrice) > Number(r.regularPrice)) reasons.push('current_price_above_original');
    const normalizedSize = normalizeSize(r.unitSize);
    if (!Number.isInteger(r.units) || r.units < 1 || r.units > 2147483647 || !normalizedSize) reasons.push('ambiguous_packaging');
    if (r.supplier === 'DHAMECHA' && normalizedSize && r.units && sizeKey(r.packDisplay) !== sizeKey(`${r.units}x${r.unitSize}`)) reasons.push('conflicting_pack_fields');
    let packaging = null;
    if (product && normalizedSize && Number.isInteger(r.units)) {
      const known = packagingByProduct.get(product.id) || [];
      const storedSize = normalizeSize(product.packetSize);
      if (r.units === 1 && !cases.length && storedSize && storedSize !== normalizedSize) reasons.push('master_unit_size_mismatch');
      if (r.units > 1 || cases.length) {
        const matching = known.filter(p => p.unitsPerCase === r.units && p.packageSizeKey === normalizedSize && (!cases.length || cases.some(c => c.id === p.id)));
        if (matching.length === 1) packaging = matching[0];
        else reasons.push(matching.length ? 'ambiguous_case_configuration' : 'no_matching_case_configuration');
      }
    }
    if (reasons.length) { unresolved.push({ ...ref, productIds, reasons: [...new Set(reasons)] }); continue; }
    const key = `${r.supplier}:${product.id}:${r.units}`;
    const candidate = { ...r, productId: product.id, packagingId: packaging?.id ?? null, normalizedSize, ref };
    add(candidates, key, candidate);
    matched.push({ ...ref, productId: product.id, packagingId: candidate.packagingId, match: cases.length ? 'verified_case_gtin' : 'unit_gtin' });
  }
  const groups = new Map(); let collapsed = 0;
  for (const group of candidates.values()) {
    const signatures = new Set(group.map(r => JSON.stringify([r.regularPrice,r.currentPrice,r.packagingId,r.normalizedSize,r.rrp])));
    if (signatures.size !== 1) { for (const r of group) unresolved.push({ ...r.ref, productId:r.productId, reasons:['conflicting_source_prices_or_packages'] }); continue; }
    const latest = [...group].sort((a,b) => Number(Boolean(b.observedAt))-Number(Boolean(a.observedAt)) || String(b.observedAt || '').localeCompare(String(a.observedAt || '')) || Number(Boolean(b.evidence.url))-Number(Boolean(a.evidence.url)))[0];
    const row = { ...latest, references: group.map(r => r.ref), sourceEvidence: group.map(r => ({ ...r.evidence, observedAt: r.observedAt, ...r.ref })) };
    collapsed += group.length - 1;
    add(groups,`${row.supplier}:${row.productId}`,row);
  }
  const priceMap = new Map(state.prices.map(p => [`${p.shopId}:${p.productId}`,p]));
  const tierMap = new Map(state.tiers.map(t => [`${t.productAtShopId}:${t.quantity}`,t]));
  const creates = [], updates = [], tierCreates = [], rrpUpdates = [], accepted = [];
  const evidence = r => ({ supplier:r.supplier, importedBy:'SUPPLIER_PRICES_V1', observedAt:r.observedAt, promotion:r.evidence.promotion ?? null, records:r.sourceEvidence });
  for (const rows of groups.values()) {
    const first = rows[0], shopId = suppliers[first.supplier].id, existing = priceMap.get(`${shopId}:${first.productId}`);
    const unit = rows.find(r => r.units === 1);
    const base = unit || (rows.length === 1 ? first : null);
    const reject = reason => { for (const r of rows) unresolved.push({ ...r.ref, productId:r.productId, reasons:[reason], references:r.references }); };
    if (!base) { reject('multiple_cases_without_unit_price'); continue; }
    const data = { price:base.regularPrice, packagingId:base.packagingId, unitsPerPack:base.units, pricedUnitSize:base.unitSize, sourcePricing:evidence(base), priceObservedAt:base.observedAt };
    if (base.supplier === 'DHAMECHA') Object.assign(data,{ offerPrice:base.currentPrice, offerPriceSource:'DHAMECHA_CURRENT', offerExpiryDate:null });
    else if (existing) Object.assign(data,{ offerPrice:existing.offerPrice, offerExpiryDate:existing.offerExpiryDate, offerPriceSource:existing.offerPriceSource ?? null });
    else Object.assign(data,{ offerPrice:null, offerExpiryDate:null, offerPriceSource:null });
    if (existing && base.units > 1 && state.tiers.some(t => t.productAtShopId === existing.id) && existing.unitsPerPack !== base.units) { reject('existing_quantity_tier_basis_unknown'); continue; }
    const alreadyImported = existing && samePriceRow(existing,data);
    if (existing && !alreadyImported) {
      if (!base.observedAt && !priceEqual(existing.price,data.price)) { reject('unknown_source_date_for_existing_price'); continue; }
      if ((existing.priceObservedAt || existing.updatedAt) && base.observedAt && new Date(existing.priceObservedAt || existing.updatedAt) > new Date(base.observedAt) && (!priceEqual(existing.price,data.price) || (base.supplier === 'DHAMECHA' && !priceEqual(existing.offerPrice ?? existing.price, data.offerPrice)))) { reject('newer_existing_supplier_price'); continue; }
      if (existing.unitsPerPack != null && existing.unitsPerPack !== base.units) { reject('existing_pricing_basis_mismatch'); continue; }
      if (base.supplier === 'DHAMECHA' && existing.offerPrice != null && existing.offerPriceSource !== 'DHAMECHA_CURRENT' && (!existing.offerExpiryDate || new Date(existing.offerExpiryDate) > new Date(base.observedAt))) { reject('existing_promotion_preserved'); continue; }
    }
    const pasId = existing?.id || `sp_${hash(`${shopId}:${base.productId}`).slice(0,32)}`;
    if (!existing) creates.push({ id:pasId, shopId, productId:base.productId, ...data });
    else if (!alreadyImported) updates.push({ id:pasId, shopId, productId:base.productId, before:existing, data });
    accepted.push({ supplier:base.supplier, productId:base.productId, productAtShopId:pasId, type:'base', units:base.units, packagingId:base.packagingId, price:base.regularPrice, currentPrice:base.currentPrice, references:base.references });
    for (const row of rows.filter(r => r !== base)) {
      const existingTier = tierMap.get(`${pasId}:${row.units}`);
      const tier = { id:`st_${hash(`${pasId}:${row.units}`).slice(0,32)}`, productAtShopId:pasId, quantity:row.units, price:row.regularPrice, packagingId:row.packagingId, sourcePricing:evidence(row), priceObservedAt:row.observedAt };
      if (base.supplier !== 'BESTWAY' || base.units !== 1 || !row.packagingId) { unresolved.push({ ...row.ref,productId:row.productId,reasons:['unsupported_alternate_price_basis'] }); continue; }
      if (existingTier && (!priceEqual(existingTier.price,tier.price) || existingTier.packagingId !== tier.packagingId || stableJson(existingTier.sourcePricing) !== stableJson(tier.sourcePricing))) { unresolved.push({ ...row.ref,productId:row.productId,reasons:['existing_quantity_tier_preserved'] }); continue; }
      if (!existingTier) tierCreates.push(tier);
      accepted.push({ supplier:row.supplier, productId:row.productId, productAtShopId:pasId, type:'case_tier', units:row.units, packagingId:row.packagingId, price:row.regularPrice, references:row.references });
    }
  }
  for (const [productId, values] of rrps) {
    const product = byProduct.get(productId);
    if (product.rrp != null) continue;
    if (new Set(values).size !== 1) { warnings.push({ productId, reason:'conflicting_rrp_values', values }); continue; }
    rrpUpdates.push({ productId, before:null, rrp:values[0] });
  }
  const reasonCounts = {};
  unresolved.forEach(r => r.reasons.forEach(reason => { reasonCounts[reason] = (reasonCounts[reason] || 0) + 1; }));
  const supplierSummary = {};
  for (const supplier of Object.keys(suppliers)) supplierSummary[supplier] = {
    sourceRows:source.records.filter(r => r.supplier === supplier).length,
    matchedRows:matched.filter(r => r.supplier === supplier).length,
    acceptedBasePrices:accepted.filter(r => r.supplier === supplier && r.type === 'base').length,
    acceptedCaseTiers:accepted.filter(r => r.supplier === supplier && r.type === 'case_tier').length,
    createPrices:creates.filter(r => r.shopId === suppliers[supplier].id).length,
    updatePrices:updates.filter(r => r.shopId === suppliers[supplier].id).length,
    unresolvedRows:unresolved.filter(r => r.supplier === supplier).length,
  };
  return { summary:{ suppliers:supplierSummary, duplicateSourceRowsCollapsed:collapsed, newQuantityTiers:tierCreates.length, rrpUpdates:rrpUpdates.length, reasonCounts }, creates, updates, tierCreates, rrpUpdates, matched, accepted, unresolved, warnings, sourceUnresolved:source.sourceUnresolved };
}
