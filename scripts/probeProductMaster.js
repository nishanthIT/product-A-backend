// Read-only verification against the configured database. No test accounts or fixtures.
import 'dotenv/config';
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import pg from 'pg';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { readMaster } from './cleanProductMaster.js';
import { buildProductMasterPlan, hash } from './lib/productMasterPlan.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const db = new pg.Client({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 15000 });
const report = { checkedAt: new Date().toISOString(), readOnly: true, probes: [] };
async function invoke(handler, req) {
  let status = 200, body;
  await handler({ params: {}, query: {}, ...req }, { status(value) { status = value; return this; }, json(value) { body = value; return this; } });
  return { status, body };
}
try {
  await db.connect();
  await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  const state = await readMaster(db);
  const source = JSON.parse(await fs.readFile(path.join(root, '../data_product/redneval_products.json'), 'utf8'));
  const rerun = buildProductMasterPlan(source.products, state.products, state.packaging);
  assert.equal(rerun.creates.length, 0); assert.equal(rerun.updates.length, 0);
  report.rerun = rerun.summary;
  report.integrity = (await db.query(`SELECT
    (SELECT count(*)::int FROM "ProductPackaging" c LEFT JOIN "Product" p ON p.id=c."productId" WHERE p.id IS NULL) AS orphans,
    (SELECT count(*)::int FROM (SELECT "caseGtin" FROM "ProductPackaging" GROUP BY "caseGtin" HAVING count(*)>1) x) AS duplicate_case_gtins,
    (SELECT count(*)::int FROM "ProductPackaging" c JOIN "Product" p ON btrim(p.barcode) ~ '^(\\d{8}|\\d{12}|\\d{13}|\\d{14})$' AND lpad(btrim(p.barcode),14,'0')=c."caseGtin") AS case_unit_collisions,
    (SELECT count(*)::int FROM "ProductPackaging" c JOIN "Product" p ON p.id<>c."productId" AND btrim(p."caseBarcode") ~ '^(\\d{8}|\\d{12}|\\d{13}|\\d{14})$' AND lpad(btrim(p."caseBarcode"),14,'0')=c."caseGtin") AS case_owner_collisions`)).rows[0];
  for (const count of Object.values(report.integrity)) assert.equal(count, 0);
  const migrationSql = await fs.readFile(path.join(root, 'prisma/migrations/20261017170000_product_packaging/migration.sql'), 'utf8');
  report.migration = (await db.query(`SELECT migration_name, checksum, finished_at, rolled_back_at FROM _prisma_migrations WHERE migration_name='20261017170000_product_packaging'`)).rows;
  assert.equal(report.migration.length, 1); assert.equal(report.migration[0].checksum, hash(migrationSql)); assert.ok(report.migration[0].finished_at); assert.equal(report.migration[0].rolled_back_at, null);
  const counts = new Map(); state.packaging.forEach(c => counts.set(c.productId, (counts.get(c.productId) || 0) + 1));
  report.productsWithMultipleCases = [...counts.values()].filter(n => n > 1).length;
  await db.query('COMMIT');

  const { getProductByBarcode, getProductById, searchProducts } = await import('../src/controller/addProduct.js');
  const { warmProductSearchIndex } = await import('../src/services/productSearchService.js');
  const multiple = state.packaging.filter(c => counts.get(c.productId) > 1).slice(0, 4);
  const samples = [state.packaging[0], ...multiple];
  for (const config of samples) {
    const product = state.products.find(p => p.id === config.productId);
    for (const code of [config.caseBarcode, config.caseGtin, product.barcode]) {
      const response = await invoke(getProductByBarcode, { params: { barcode: code } });
      assert.equal(response.status, 200); assert.equal(response.body.data.id, config.productId);
      if (code !== product.barcode) {
        assert.equal(response.body.data.matchedPackaging.id, config.id);
        assert.equal(response.body.data.matchedPackaging.unitsPerCase, config.unitsPerCase);
      }
      report.probes.push({ endpoint: '/products/barcode/:barcode', barcode: code, productId: config.productId, packagingId: response.body.data.matchedPackaging?.id ?? null, status: response.status });
    }
    const detail = await invoke(getProductById, { params: { id: config.productId } });
    assert.equal(detail.status, 200); assert.equal(detail.body.data.packagingConfigurations.length, counts.get(config.productId));
  }
  await warmProductSearchIndex();
  for (const config of samples.slice(0, 3)) {
    const result = await invoke(searchProducts, { query: { q: config.caseGtin } });
    assert.equal(result.status, 200); assert.equal(result.body.data[0].id, config.productId);
    report.probes.push({ endpoint: '/products/search', barcode: config.caseGtin, productId: config.productId, status: result.status });
  }
  // Existing ambiguous legacy barcodes must fail closed without altering either identity.
  const duplicate = rerun.databaseIssues.duplicateUnitGtins[0];
  if (duplicate) {
    const response = await invoke(getProductByBarcode, { params: { barcode: duplicate.gtin } });
    assert.equal(response.status, 409);
    report.probes.push({ endpoint: '/products/barcode/:barcode', barcode: duplicate.gtin, expectedConflict: true, status: response.status });
  }
  report.valid = true;
  const reportArgument = process.argv.indexOf('--report');
  const reportPath = path.resolve(reportArgument >= 0 ? process.argv[reportArgument + 1] : path.join(root, `reports/product-master/verification-${new Date().toISOString().replaceAll(':', '-')}.json`));
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.writeFile(reportPath, JSON.stringify(report, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  console.log(JSON.stringify({ reportPath, valid: true, integrity: report.integrity, productsWithMultipleCases: report.productsWithMultipleCases, rerunCreates: rerun.creates.length, rerunUpdates: rerun.updates.length, apiProbes: report.probes.length }, null, 2));
} catch (error) {
  await db.query('ROLLBACK').catch(() => {});
  console.error(JSON.stringify({ code: error.code || 'VALIDATION_FAILED', message: error.code ? 'Product-master verification failed' : error.message }));
  process.exitCode = 1;
} finally { await db.end(); }
