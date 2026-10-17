import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { getPrisma, resetDatabase, seedBase, startApp } from './helpers/harness.js';
import { warmProductSearchIndex, indexProduct, ProductSearchIndex } from '../src/services/productSearchService.js';
import { gtin } from '../src/services/productBarcodes.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const unit = '5010511482313', case1 = '5010511040445', case2 = '5000382114994';
let db, sql, app, seed, master, token, adminToken, dir;
const row = (code, count) => ({ record_id: code, rcode: 'SUPPLIER-NOT-A-GTIN', unit_barcode: unit, unit_barcodes: [unit], case_barcode: code, case_barcodes: [code], unit_size: '120g', pack_quantity: count, pack_quantity_raw: String(count), packing: `${count} x 120g`, errors: [], wholesale_price: 999 });
const run = args => execFileSync(process.execPath, ['scripts/cleanProductMaster.js', ...args], { cwd: root, env: { ...process.env, DATABASE_URL: process.env.TEST_DATABASE_URL }, encoding: 'utf8' });
const request = (method, url, body, useToken = token) => app.request(method, url, { token: useToken, body });

before(async () => {
  await resetDatabase(); db = await getPrisma(); seed = await seedBase(db);
  master = await db.product.create({ data: { title: 'Master test product', barcode: unit } });
  await db.productAtShop.create({ data: { productId: master.id, shopId: seed.wholesale.id, price: 3.25, inHandStock: 17 } });
  await db.supermarketProductState.create({ data: { productId: master.id, shopId: seed.a.shop.id, inHandStock: 9 } });
  sql = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL }); await sql.connect();
  await sql.query('DROP TABLE "ProductPackaging" CASCADE');
  await sql.query('CREATE TABLE _prisma_migrations (id varchar(36) PRIMARY KEY, checksum varchar(64) NOT NULL, finished_at timestamptz, migration_name varchar(255) NOT NULL, logs text, rolled_back_at timestamptz, started_at timestamptz NOT NULL DEFAULT now(), applied_steps_count integer NOT NULL DEFAULT 0)');
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'paymi-packaging-tests-'));
  await fs.writeFile(path.join(dir, 'source.json'), JSON.stringify({ products: [row(case1, 12), row(case2, 6), row(case1, 12)] }));
});
after(async () => { await app?.close(); await sql?.end(); await db?.$disconnect(); });

test('dry-run performs no writes; apply migrates additively, preserves inventory/prices and reruns as a no-op', async () => {
  const source = path.join(dir, 'source.json'), dry = path.join(dir, 'dry.json'), applied = path.join(dir, 'applied.json');
  run(['--source', source, '--report', dry]);
  const plan = JSON.parse(await fs.readFile(dry));
  assert.equal(plan.summary.newPackagingConfigurations, 2);
  assert.equal(plan.summary.duplicateSourceConfigurationsCollapsed, 1);
  assert.equal((await sql.query(`SELECT to_regclass('public."ProductPackaging"') AS t`)).rows[0].t, null);
  run(['--source', source, '--report', applied, '--apply', '--reviewed-report', dry]);
  const result = JSON.parse(await fs.readFile(applied));
  assert.equal(result.committed, true); assert.equal(result.verification.preservationUnchanged, true);
  assert.equal(result.verification.rerunCreates, 0); assert.equal(result.verification.rerunUpdates, 0);
  assert.equal(await db.productPackaging.count(), 2);
  assert.equal(await db.product.count(), 2);
  const after = await db.product.findUnique({ where: { id: master.id }, include: { shops: true, supermarketStock: true } });
  assert.equal(after.barcode, unit); assert.equal(after.caseBarcode, null); assert.equal(after.packetSize, '120g');
  assert.equal(after.shops[0].price.toString(), '3.25'); assert.equal(after.shops[0].inHandStock, 17); assert.equal(after.supermarketStock[0].inHandStock, 9);
  const dry2 = path.join(dir, 'dry2.json'); run(['--source', source, '--report', dry2]);
  run(['--source', source, '--report', path.join(dir,'apply2.json'), '--apply', '--reviewed-report', dry2]);
  assert.equal(await db.productPackaging.count(), 2);
  assert.equal((await sql.query('SELECT count(*)::int n FROM _prisma_migrations')).rows[0].n, 1);
  app = await startApp(); token = (await app.login(seed.a.owner.email, seed.password)).token; adminToken = (await app.login(seed.admin.email, seed.password)).token;
});

test('reviewed report becomes stale on catalog edits and application refuses before writing', async () => {
  const source = path.join(dir, 'source.json'), dry = path.join(dir, 'stale.json');
  run(['--source', source, '--report', dry]);
  await db.product.update({ where: { id: master.id }, data: { title: 'Changed title' } });
  assert.throws(() => run(['--source', source, '--report', path.join(dir,'stale-apply.json'), '--apply', '--reviewed-report', dry]), /Database or plan changed/);
  assert.equal(await db.productPackaging.count(), 2);
});

test('database constraints reject duplicate canonical cases, invalid formats, empty sizes and zero quantities', async () => {
  const existing = await db.productPackaging.findFirst();
  for (const changes of [{ id: 'duplicate', caseBarcode: `0${case1}`, caseGtin: gtin(case1) }, { id: 'bad', caseBarcode: 'SUPPLIER-ID', caseGtin: 'SUPPLIER-ID' }, { id: 'bad-checksum', caseBarcode: '5029054239422', caseGtin: '05029054239422' }, { id: 'empty', caseBarcode: '5029054239421', caseGtin: gtin('5029054239421'), packageSize: '' }, { id: 'zero', caseBarcode: '5029054239421', caseGtin: gtin('5029054239421'), unitsPerCase: 0 }]) {
    await assert.rejects(db.productPackaging.create({ data: { ...existing, ...changes } }));
  }
});

test('unit, padded unit and each case scan return the same product plus the correct case configuration', async () => {
  for (const code of [unit, `0${unit}`, case1, `0${case1}`, case2]) {
    const response = await request('GET', `/products/barcode/${code}`);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.data.id, master.id);
    assert.equal(response.body.data.packagingConfigurations.length, 2);
    assert.equal(response.body.data.matchedPackaging?.unitsPerCase ?? null, gtin(code) === gtin(case1) ? 12 : code === case2 ? 6 : null);
  }
  assert.equal((await request('GET', `/products/barcode/${unit}?field=casebarcode`)).status, 404);
  assert.equal((await request('GET', `/products/barcode/${case1}?field=barcode`)).status, 404);
  assert.equal((await request('GET', `/products/barcode/${case1}?field=casebarcode`)).status, 200);
  assert.equal((await request('GET', `/products/barcode/${case1}?field=typo`)).status, 400);
  assert.equal((await request('GET', '/products/barcode/SUPPLIER-NOT-A-GTIN')).status, 404);
  assert.equal((await app.request('GET', `/products/barcode/${case1}`)).status, 401);
});

test('legacy barcode collisions return 409 for scans, quick-add and expiry instead of selecting a product', async () => {
  const collision = await db.product.create({ data: { title: 'Collision', barcode: `0${case1}` } });
  for (const endpoint of [`/products/barcode/${case1}`, `/expiry/search-product?barcode=${case1}`]) assert.equal((await request('GET', endpoint)).status, 409);
  assert.equal((await request('POST', '/products/quick-add', { barcode: case1, title: 'Duplicate', retailSize: '120g' })).status, 409);
  await db.product.delete({ where: { id: collision.id } });
});

test('quick-add recognizes existing cases and leaves products and stock unchanged', async () => {
  const before = await db.product.count();
  const response = await request('POST', '/products/quick-add', { barcode: case2, title: 'Do not create', retailSize: '120g', inHandStock: 999 });
  assert.equal(response.status, 409); assert.equal(await db.product.count(), before);
  assert.equal((await db.supermarketProductState.findFirst({ where: { productId: master.id } })).inHandStock, 9);
});

test('detail, catalog, shop inventory, expiry and pack options expose packaging without changing prices', async () => {
  const detail = await request('GET', `/products/${master.id}`);
  assert.equal(detail.body.data.packagingConfigurations.length, 2);
  const expiry = await request('GET', `/expiry/search-product?barcode=${case2}`);
  assert.equal(expiry.status, 200); assert.equal(expiry.body.products[0].id, master.id); assert.equal(expiry.body.products[0].packagingConfigurations.length, 2);
  const packs = await request('GET', `/products/${master.id}/pack-options`);
  assert.equal(packs.status, 200); assert.equal(packs.body.options.find(p => p.productId === master.id).packagingConfigurations.length, 2);
  const filtered = await request('GET', `/filterProducts?search=${case2}&page=1`, undefined, adminToken);
  assert.equal(filtered.status, 200); assert.ok(filtered.body.products.some(p => p.id === master.id && p.packagingConfigurations.length === 2));
  const inventory = await request('GET', `/shop/${seed.wholesale.id}/products?search=${case2}`, undefined, adminToken);
  assert.equal(inventory.status, 200, JSON.stringify(inventory.body));
  const item = inventory.body.products.find(p => p.productId === master.id);
  assert.equal(item.packagingConfigurations.length, 2); assert.equal(Number(item.price), 3.25);
  const missingCases = await request('GET', `/filterProducts?search=${unit}&withoutCaseBarcode=true&page=1`, undefined, adminToken);
  assert.equal(missingCases.body.products.some(p => p.id === master.id), false);
});

test('ranked search includes every case and remains correct after legacy product refreshes', async () => {
  await warmProductSearchIndex();
  for (const code of [case1, `0${case1}`, case2]) {
    const response = await request('GET', `/products/search?q=${code}`);
    assert.equal(response.status, 200); assert.equal(response.body.data[0].id, master.id); assert.equal(response.body.data[0].packagingConfigurations.length, 2);
  }
  const row = await db.product.findUnique({ where: { id: master.id } });
  indexProduct(row); await warmProductSearchIndex();
  assert.equal((await request('GET', `/products/search?q=${case2}`)).body.data[0].id, master.id);
  const index = new ProductSearchIndex([{ ...row, packagingConfigurations: [{ caseBarcode: case1 }, { caseBarcode: case2 }] }]);
  assert.equal(index.search(`0${case2}`)[0].id, master.id);
});

test('legacy writes cannot overwrite reviewed identity or cases; ordinary title edits remain available', async () => {
  const overwrite = await request('PUT', `/editProduct/${master.id}`, { caseBarcode: '5029054239421' }, adminToken);
  assert.equal(overwrite.status, 409, JSON.stringify(overwrite.body));
  const global = await request('PATCH', '/admin/list-items/case-barcode', { itemId: master.id, caseBarcode: '5029054239421' }, adminToken);
  assert.equal(global.status, 409);
  const listDetails = await request('PATCH', '/admin/list-items', { itemId: master.id, packetSize: '100g' }, adminToken);
  assert.equal(listDetails.status, 409);
  const aliasCreate = await request('POST', '/addProduct', { title: 'Collision', barcode: `0${case1}` }, adminToken);
  assert.equal(aliasCreate.status, 409);
  const edit = await request('PUT', `/editProduct/${master.id}`, { title: 'Reviewed title' }, adminToken);
  assert.equal(edit.status, 200);
  assert.equal(await db.productPackaging.count(), 2);
});

test('scanning different cases adds to the existing product identity without multiplying inventory or quantity', async () => {
  const created = await request('POST', '/lists', { name: 'Case scans' });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const listId = created.body.list?.id ?? created.body.id;
  for (const code of [case1, case2]) {
    const scanned = await request('GET', `/products/barcode/${code}`);
    const added = await request('POST', '/lists/addProduct', { listId, productId: scanned.body.data.id, quantity: 1 });
    assert.equal(added.status, 200, JSON.stringify(added.body));
  }
  const items = await db.listProduct.findMany({ where: { listId }, include: { productAtShop: true } });
  assert.equal(items.length, 1); assert.equal(items[0].quantity, 2); assert.equal(items[0].productAtShop.productId, master.id);
  assert.equal((await db.supermarketProductState.findFirst({ where: { productId: master.id } })).inHandStock, 9);
});
