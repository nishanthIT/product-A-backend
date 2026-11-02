import { gtin } from '../../src/services/productBarcodes.js';
import { hash, packageSize } from './productMasterPlan.js';

const add = (map,key,value) => { if(key) map.set(key,[...(map.get(key)||[]),value]); };

// Stage new identities/configurations only; the pricing planner subsequently
// discards any staged object not referenced by an accepted supplier price.
export function prepareCostcutterMaster(source,state) {
  const units=new Map(), owners=new Map(), groups=new Map();
  for(const p of state.products) {
    add(units,gtin(p.barcode),p);add(owners,gtin(p.barcode),p.id);add(owners,gtin(p.caseBarcode),p.id);
  }
  for(const c of state.packaging) add(owners,c.caseGtin,c.productId);
  for(const r of source.records.filter(r=>r.supplier==='COSTCUTTER')) add(groups,r.code,r);
  const productCreates=[],packagingCreates=[];
  for(const [code,rows] of groups) {
    const matches=units.get(code)||[], identities=[...new Set(owners.get(code)||[])];
    if(matches.length>1||identities.length>1) continue;
    if(!matches.length&&identities.length) {rows.forEach(r=>r.inputProblems.push('source_inner_barcode_is_case'));continue;}
    const sizes=new Set(rows.map(r=>packageSize(r.unitSize)).filter(Boolean));
    if(sizes.size>1) {rows.forEach(r=>r.inputProblems.push('conflicting_source_unit_sizes'));continue;}
    const eligible=rows.filter(r=>r.status==='found'&&!r.inputProblems.length&&r.sourceProductId&&r.productName?.trim()&&r.regularPrice&&Number.isInteger(r.units)&&r.units>0&&r.units<=2147483647&&packageSize(r.unitSize));
    if(!eligible.length) continue;
    let product=matches[0];
    if(!product) {
      if(new Set(eligible.map(r=>r.productName.trim())).size>1) {rows.forEach(r=>r.inputProblems.push('conflicting_new_product_names'));continue;}
      const r=eligible[0];
      product={id:`cp_${hash(code).slice(0,32)}`,title:r.productName.trim(),barcode:r.barcode.trim(),packetSize:r.unitSize,caseBarcode:null,caseSize:null,retailSize:null,rrp:null};
      productCreates.push(product);
    }
    for(const r of eligible) {
      const size=packageSize(r.unitSize),storedSize=packageSize(product.packetSize);
      if(storedSize&&storedSize!==size) {r.inputProblems.push('master_unit_size_mismatch');continue;}
      if(r.units===1) continue;
      const existing=[...state.packaging,...packagingCreates].filter(c=>c.productId===product.id&&c.unitsPerCase===r.units&&c.packageSizeKey===size);
      if(existing.length) continue; // The common planner rejects multiple matching configurations.
      packagingCreates.push({id:`cpk_${hash(`${product.id}:${r.units}:${size}`).slice(0,32)}`,productId:product.id,caseBarcode:null,caseGtin:null,unitsPerCase:r.units,packageSize:r.unitSize,packageSizeKey:size,packing:r.packDisplay,source:'COSTCUTTER_INVOICE_CASE',sourceReferences:rows.filter(m=>m.units===r.units&&packageSize(m.unitSize)===size).map(m=>({...m.ref,sourceProductCode:m.sourceProductId,innerBarcode:m.barcode,pack:m.evidence.rawPackaging}))});
    }
  }
  return {productCreates,packagingCreates,state:{...state,products:[...state.products,...productCreates],packaging:[...state.packaging,...packagingCreates]}};
}
