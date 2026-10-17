// Withdraw only unchanged, unreferenced rows created by a specific import when
// a stricter matching audit rejects them. Existing pre-import rows are never deleted.
import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import pg from 'pg';
import { hash } from './lib/productMasterPlan.js';
import { readSupplierSources,buildSupplierPricePlan,stableJson } from './lib/supplierPricePlan.js';
import { readSupplierState,verifySupplierState,preservationFingerprint } from './importSupplierPrices.js';

const args=process.argv.slice(2),value=f=>args.includes(f)?args[args.indexOf(f)+1]:undefined;
const apply=args.includes('--apply');
const originalPath=path.resolve(value('--applied-report'));
const reportPath=path.resolve(value('--report'));
const original=JSON.parse(await fs.readFile(originalPath));
const baseline=JSON.parse(await fs.readFile(`${originalPath}.before.json`));
const reviewed=apply?JSON.parse(await fs.readFile(path.resolve(value('--reviewed-report')))):null;
assert.equal(original.committed,true);
const source=await readSupplierSources(original.sourceDir);
assert.equal(source.sourceHash,original.sourceHash);
const corrected=buildSupplierPricePlan(source,baseline.state);
// This repair deliberately handles only newly created supplier base records.
// A rejected pre-existing price, RRP or quantity tier requires its own review.
for(const key of ['updates','tierCreates','rrpUpdates']) assert.equal(stableJson(corrected[key]),stableJson(original[key]),`Repair cannot change ${key}`);
for(const row of corrected.creates) assert.equal(stableJson(row),stableJson(original.creates.find(p=>p.id===row.id)));
const withdrawals=original.creates.filter(p=>!corrected.creates.some(c=>c.id===p.id));
assert.ok(withdrawals.length,'No new ambiguous rows to withdraw');
assert.ok(withdrawals.every(p=>!baseline.state.prices.some(b=>b.id===p.id)));
const db=new pg.Client({connectionString:process.env.DATABASE_URL,connectionTimeoutMillis:15000});
const write=async(file,data)=>{await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,JSON.stringify(data,null,2)+'\n',{mode:0o600,flag:'wx'});};
let committed=false;
try {
  await db.connect();await db.query(apply?'BEGIN ISOLATION LEVEL REPEATABLE READ':'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  await db.query("SET LOCAL lock_timeout='5s'");
  if(apply) await db.query('SELECT id FROM "ProductAtShop" WHERE id=ANY($1::text[]) FOR UPDATE',[withdrawals.map(p=>p.id)]);
  const state=await readSupplierState(db);
  verifySupplierState(baseline.state,state,original);
  const references=(await db.query(`SELECT c.relname AS table_name,a.attname AS column_name FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid JOIN pg_attribute a ON a.attrelid=k.conrelid AND a.attnum=k.conkey[1] WHERE k.contype='f' AND k.confrelid='"ProductAtShop"'::regclass`)).rows;
  const quote=v=>`"${v.replaceAll('"','""')}"`;
  for(const intended of withdrawals) {
    const row=state.prices.find(p=>p.id===intended.id);assert.ok(row);
    for(const [key,v] of Object.entries(intended)) {
      if(['price','offerPrice'].includes(key)) assert.equal(row[key]==null?null:Number(row[key]),v==null?null:Number(v));
      else if(key==='priceObservedAt') assert.equal(row[key]?.toISOString()??null,v);
      else assert.equal(stableJson(row[key]??null),stableJson(v??null),`Imported field changed: ${key}`);
    }
    assert.equal(row.outOfStock,false);
    for(const key of ['inHandStock','employeeId','userId','listId','card_aiel_number','locationCode']) assert.equal(row[key],null);
    assert.equal(row.createdAt?.toISOString(),row.updatedAt?.toISOString(),'Row changed after import');
    for(const ref of references) assert.equal((await db.query(`SELECT count(*)::int n FROM ${quote(ref.table_name)} WHERE ${quote(ref.column_name)}=$1`,[row.id])).rows[0].n,0,'New supplier row has relationships; cannot withdraw');
  }
  const review={mode:apply?'apply':'dry-run',originalReport:originalPath,sourceHash:source.sourceHash,snapshotHash:hash(state),correctedPlanHash:hash(corrected),withdrawals,summary:corrected.summary,reason:'Unit GTIN conflicts with another product legacy case barcode'};
  if(apply) {
    assert.equal(reviewed.mode,'dry-run');
    for(const k of ['sourceHash','snapshotHash','correctedPlanHash']) assert.equal(review[k],reviewed[k],`Stale correction review: ${k}`);
    await write(`${reportPath}.before.json`,{...review,state});
    assert.equal((await db.query('DELETE FROM "ProductAtShop" WHERE id=ANY($1::text[])',[withdrawals.map(p=>p.id)])).rowCount,withdrawals.length);
    const after=await readSupplierState(db);
    verifySupplierState(baseline.state,after,corrected);
    assert.equal(stableJson(await preservationFingerprint(db)),stableJson(baseline.preservation));
    const rerun=buildSupplierPricePlan(source,after);
    for(const k of ['creates','updates','tierCreates','rrpUpdates']) assert.equal(rerun[k].length,0);
    assert.equal(rerun.accepted.length,corrected.accepted.length);
    review.verification={withdrawn:withdrawals.length,rerunWrites:0,originalIdentitiesInventoryAndRelationshipsPreserved:true,supplierPriceCount:after.prices.length};
    await write(`${reportPath}.validated.json`,review);
  }
  await db.query('COMMIT');committed=apply;
  await write(reportPath,{...review,committed});
  if(apply) {
    const finalPath=path.resolve(value('--final-report'));
    await write(`${finalPath}.before.json`,baseline);
    await write(finalPath,{...original,...corrected,planHash:hash({creates:corrected.creates,updates:corrected.updates,tierCreates:corrected.tierCreates,rrpUpdates:corrected.rrpUpdates}),correctionReport:reportPath,generatedAt:new Date().toISOString(),verification:{...original.verification,supplierPriceCount:review.verification.supplierPriceCount,acceptedPrices:corrected.accepted.length,withdrawnAmbiguousNewPrices:withdrawals.length},committed:true});
  }
  console.log(JSON.stringify({reportPath,committed,withdrawals:withdrawals.map(p=>({id:p.id,productId:p.productId})),summary:corrected.summary,verification:review.verification},null,2));
}catch(error){if(!committed)await db.query('ROLLBACK').catch(()=>{});console.error(JSON.stringify({code:error.code||'WITHDRAWAL_FAILED',message:error.code?'Guarded withdrawal failed; existing records preserved unless committed is true':error.message,committed}));process.exitCode=1;}
finally{await db.end();}
