import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
import pg from 'pg';
import bcrypt from 'bcryptjs';
import { Prisma } from '@prisma/client';
import { getPrisma, resetDatabase, seedBase, startApp } from './helpers/harness.js';
import { applyDefaultPlan, buildDefaultPlan, collectDefaultFacts, inspectDefaultMigration, recoverDefaultRun } from '../scripts/lib/defaultSupermarketMigration.js';
import { normalizeRegistration, provisionRegistration, registrationRequestHash, resolveSupermarketSelection } from '../src/services/supermarketProvisioning.js';

let db, app, seed, employee, beforeData, preSchemaPlan, appliedRun;
const migrationPath = new URL('../prisma/migrations/20261011120000_default_supermarket_ownership/migration.sql', import.meta.url);
const additions = new Set(['SupermarketOwnership', 'SupermarketMigrationReview', 'SupermarketMigrationRun', 'RegistrationReceipt', 'SupermarketCreationReceipt', 'SupermarketProductState', 'SupermarketAdminAccessLog']);
async function originalData() {
  const result = {};
  for (const model of Prisma.dmmf.datamodel.models.filter((m) => !additions.has(m.name))) {
    assert.match(model.name, /^[A-Za-z]+$/);
    const omit = model.name === 'Customer' ? " - 'defaultSupermarketId' - 'defaultSupermarketVersion'" : '';
    const [row] = await db.$queryRawUnsafe(`SELECT COALESCE(jsonb_agg(value ORDER BY value::text), '[]') AS data FROM (SELECT to_jsonb(t)${omit} AS value FROM "${model.name}" t) records`);
    result[model.name] = row.data;
  }
  return result;
}
const owner = (id) => ({ id, userType: 'CUSTOMER' });
const registration = (email, overrides = {}) => normalizeRegistration({ name: 'New Owner', email, password: 'Secure123!', otp: '123456', shopName: 'Original Supermarket Name', ...overrides });
const hash = (input) => registrationRequestHash(input, process.env.JWT_SECRET);
async function installOtp(input) {
  const { default: redis } = await import('../src/services/redisService.js');
  await redis.set(`otp:register:${input.email}`, {
    hash: createHmac('sha256', process.env.JWT_SECRET).update(`${input.email}:${input.otp}`).digest('hex'),
    attempts: 0, expiresAt: Date.now() + 600000,
  }, 600);
}

before(async () => {
  await resetDatabase();
  db = await getPrisma();
  seed = await seedBase(db, { ownership: false });
  employee = await db.empolyee.create({ data: {
    name: 'Existing Employee', email: 'existing-employee@shop.test', phoneNo: 'existing-employee',
    password: seed.passwordHash, shopId: seed.a.shop.id, createdByCustomerId: seed.a.owner.id,
    shopMemberships: { create: { shopId: seed.a.shop.id, permissions: ['feature.lists'], createdByCustomerId: seed.a.owner.id } },
  } });
  await db.list.create({ data: { name: 'Legacy unscoped list', description: '', customerId: seed.a.owner.id } });
  await db.expiryProduct.create({ data: { productId: seed.product.id, shopId: seed.a.shop.id, expiryDate: new Date(), addedById: seed.a.owner.id, addedByType: 'CUSTOMER' } });
  await db.fridge.create({ data: { name: 'Original Chiller', shopId: seed.a.shop.id } });
  await db.cleaningArea.create({ data: { name: 'Original Area', shopId: seed.a.shop.id } });
  beforeData = await originalData();
  // Rehearse the ACTUAL additive SQL against the preceding schema and existing data.
  // resetDatabase has already asserted this is a disposable local *test* database.
  const client = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
  await client.connect();
  try {
    await client.query(`ALTER TABLE "Customer" DROP COLUMN "defaultSupermarketId", DROP COLUMN "defaultSupermarketVersion";
      ALTER TABLE "List" DROP CONSTRAINT IF EXISTS "List_supermarket_scope_fkey";
      DROP TABLE "SupermarketCreationReceipt", "SupermarketProductState", "SupermarketAdminAccessLog";
      DROP TABLE "RegistrationReceipt", "SupermarketMigrationReview", "SupermarketMigrationRun", "SupermarketOwnership";
      DROP INDEX "Shop_id_shopType_key";`);
    preSchemaPlan = (await inspectDefaultMigration(db)).plan;
    await client.query(fs.readFileSync(migrationPath, 'utf8'));
    await client.query(fs.readFileSync(new URL('../prisma/migrations/20261011160000_multisupermarket_operations/migration.sql', import.meta.url), 'utf8'));
  } finally { await client.end(); }
  app = await startApp();
});

after(async () => { await app?.close(); await db?.$disconnect(); });

test('additive SQL and pre-schema inspection preserve every existing table row', async () => {
  assert.deepEqual(await originalData(), beforeData);
  assert.equal(preSchemaPlan.summary.ownershipsToCreate, 2);
  assert.equal(preSchemaPlan.hash, (await inspectDefaultMigration(db)).plan.hash);
});

test('single verified supermarket becomes default without changing IDs, names, employees or business data', async () => {
  appliedRun = await applyDefaultPlan(db, preSchemaPlan);
  assert.equal(appliedRun.changes.length, 2);
  for (const pair of [seed.a, seed.b]) {
    const customer = await db.customer.findUnique({ where: { id: pair.owner.id } });
    assert.equal(customer.shopId, pair.shop.id);
    assert.equal(customer.defaultSupermarketId, pair.shop.id);
    assert.equal((await resolveSupermarketSelection(db, owner(customer.id))).shop.name, pair.shop.name);
  }
  assert.deepEqual(await originalData(), beforeData);
});

test('rerunning is idempotent and stale reports are rejected', async () => {
  await assert.rejects(applyDefaultPlan(db, preSchemaPlan), /changed since dry run/);
  const plan = buildDefaultPlan(await collectDefaultFacts(db));
  assert.equal(plan.summary.unchanged, 2);
  const run = await applyDefaultPlan(db, plan);
  assert.equal(run.changes.length, 0);
  assert.equal(await db.supermarketOwnership.count(), 2);
  assert.deepEqual(await originalData(), beforeData);
});

test('default FK rejects another owner and supplier ownership fails even through direct database writes', async () => {
  await assert.rejects(db.customer.update({ where: { id: seed.a.owner.id }, data: { defaultSupermarketId: seed.b.shop.id } }));
  await assert.rejects(db.supermarketOwnership.create({ data: { customerId: seed.a.owner.id, shopId: seed.wholesale.id, source: 'TEST' } }));
  await assert.rejects(db.supermarketOwnership.create({ data: { customerId: seed.a.owner.id, shopId: seed.wholesale.id, shopType: 'WHOLESALE', source: 'TEST' } }));
});

test('multiple verified shops retain legacy/default state; explicit selection does not mutate any pointer', async () => {
  const second = await db.shop.create({ data: { name: 'Verified Second Branch', address: '', mobile: '', shopType: 'CUSTOMER' } });
  await db.supermarketOwnership.create({ data: { customerId: seed.a.owner.id, shopId: second.id, source: 'VERIFIED_TEST_ASSIGNMENT' } });
  const plan = buildDefaultPlan(await collectDefaultFacts(db));
  const item = plan.items.find((i) => i.customerId === seed.a.owner.id);
  assert.equal(item.defaultShopId, seed.a.shop.id);
  assert.equal(item.setDefault, false);
  assert.equal((await resolveSupermarketSelection(db, owner(seed.a.owner.id), second.id)).shop.id, second.id);
  assert.equal((await resolveSupermarketSelection(db, owner(seed.a.owner.id))).shop.id, seed.a.shop.id);
  assert.equal((await db.customer.findUnique({ where: { id: seed.a.owner.id } })).shopId, seed.a.shop.id);
  await assert.rejects(resolveSupermarketSelection(db, owner(seed.a.owner.id), seed.b.shop.id), { status: 403 });
  await assert.rejects(resolveSupermarketSelection(db, owner(seed.a.owner.id), seed.wholesale.id), { status: 403 });
});

test('ambiguous and incomplete ownership is reviewed without guessing, copying or creating shops', async () => {
  const missing = await db.customer.create({ data: { name: 'Missing', email: 'missing@shop.test', mobile: 'missing', password: seed.passwordHash } });
  const multi = await db.customer.create({ data: { name: 'Multiple', email: 'multi@shop.test', mobile: 'multi', password: seed.passwordHash } });
  await db.supermarketOwnership.createMany({ data: [seed.a.shop.id, seed.b.shop.id].map((shopId) => ({ customerId: multi.id, shopId, source: 'VERIFIED_TEST_ASSIGNMENT' })) });
  const supplier = await db.customer.create({ data: { name: 'Wrong legacy type', email: 'supplier@shop.test', mobile: 'supplier', password: seed.passwordHash, shopId: seed.wholesale.id } });
  const count = await db.shop.count();
  const plan = buildDefaultPlan(await collectDefaultFacts(db));
  assert.equal(plan.items.find((i) => i.customerId === missing.id).reason, 'NO_VERIFIED_SUPERMARKET');
  assert.equal(plan.items.find((i) => i.customerId === multi.id).reason, 'MULTIPLE_SHOPS_NO_VERIFIED_DEFAULT');
  assert.equal(plan.items.find((i) => i.customerId === supplier.id).reason, 'LEGACY_SHOP_MISSING_OR_SUPPLIER');
  await applyDefaultPlan(db, plan);
  await applyDefaultPlan(db, buildDefaultPlan(await collectDefaultFacts(db)));
  assert.equal(await db.shop.count(), count);
  assert.equal(await db.supermarketMigrationReview.count(), 3);
  assert.equal((await db.customer.findUnique({ where: { id: multi.id } })).defaultSupermarketId, null);
  assert.equal(await db.supermarketOwnership.count({ where: { shopId: seed.wholesale.id } }), 0);
});

test('recovery restores defaults only, retaining ownerships and all existing records; it is repeatable', async () => {
  const count = await db.supermarketOwnership.count();
  await recoverDefaultRun(db, appliedRun.id);
  await recoverDefaultRun(db, appliedRun.id);
  assert.equal((await db.customer.findUnique({ where: { id: seed.a.owner.id } })).defaultSupermarketId, null);
  assert.equal(await db.supermarketOwnership.count(), count);
  assert.equal((await db.customer.findUnique({ where: { id: seed.a.owner.id } })).shopId, seed.a.shop.id);
  const run = await applyDefaultPlan(db, buildDefaultPlan(await collectDefaultFacts(db)));
  await db.customer.update({ where: { id: seed.a.owner.id }, data: { defaultSupermarketVersion: { increment: 1 } } });
  await assert.rejects(recoverDefaultRun(db, run.id), /changed since migration/);
  assert.equal((await db.customer.findUnique({ where: { id: seed.b.owner.id } })).defaultSupermarketId, seed.b.shop.id);
});

test('existing owner and employee login still work; employee default never grants owner rights or disabled features', async () => {
  const customerLogin = await app.login('alpha-owner@shop.test', seed.password);
  assert.equal(customerLogin.status, 200);
  assert.equal(customerLogin.body.user.defaultSupermarketId, seed.a.shop.id);
  const login = await app.login(employee.email, seed.password);
  assert.equal(login.status, 200);
  assert.equal(login.body.user.shopAccess.shopId, seed.a.shop.id);
  const user = { id: employee.id, userType: 'EMPLOYEE', shopId: seed.a.shop.id };
  assert.equal((await resolveSupermarketSelection(db, user, undefined, { feature: 'feature.lists' })).shop.id, seed.a.shop.id);
  await assert.rejects(resolveSupermarketSelection(db, user, undefined, { feature: 'feature.expiry' }), { status: 403 });
  await assert.rejects(resolveSupermarketSelection(db, user, seed.b.shop.id), { status: 403 });
  assert.equal((await app.request('POST', '/shop/assign', { token: login.token, body: { shopName: 'Forbidden' } })).status, 403);
  const response = await app.request('GET', '/shop/supermarkets', { token: login.token });
  assert.deepEqual(response.body.supermarkets.map((s) => s.id), [seed.a.shop.id]);
  assert.equal(response.body.canCreateAdditional, false);
});

test('registration commits one named first shop and default; lost response retry works after OTP consumption', async () => {
  const input = registration('new@shop.test');
  await installOtp(input);
  const first = await app.request('POST', '/auth/register', { body: input });
  assert.equal(first.status, 201, JSON.stringify(first.body));
  const repeated = await app.request('POST', '/auth/register', { body: input });
  assert.equal(repeated.status, 200, JSON.stringify(repeated.body));
  assert.equal(first.body.shop.id, repeated.body.shop.id);
  assert.equal(first.body.shop.name, input.shopName);
  assert.equal(first.body.user.defaultSupermarketId, first.body.shop.id);
  assert.equal(await db.supermarketOwnership.count({ where: { customerId: first.body.user.id } }), 1);
  assert.equal('password' in first.body.user, false);
  const setup = await app.request('POST', '/shop/assign', { token: first.body.token, body: { shopName: 'Do not create a duplicate' } });
  assert.equal(setup.status, 200);
  assert.equal(setup.body.shop.id, first.body.shop.id);
  assert.equal(setup.body.shop.name, input.shopName);
  const badRetry = await app.request('POST', '/auth/register', { body: { ...input, password: 'OtherPass123!' } });
  assert.equal(badRetry.status, 400);
  await db.customer.update({ where: { id: first.body.user.id }, data: { password: await bcrypt.hash('ResetPass123!', 4) } });
  assert.equal((await app.request('POST', '/auth/register', { body: input })).status, 400, 'receipt must not bypass password reset');
});

test('concurrent registration commits one account, shop, chat and receipt', async () => {
  const input = registration('parallel@shop.test');
  const passwordHash = await bcrypt.hash(input.password, 4);
  const beforeShops = await db.shop.count();
  const beforeChats = await db.chat.count();
  const results = await Promise.all(Array.from({ length: 4 }, () => provisionRegistration(db, input, passwordHash, hash(input))));
  assert.equal(new Set(results.map((r) => r.customer.id)).size, 1);
  assert.equal(new Set(results.map((r) => r.shop.id)).size, 1);
  assert.equal(results.filter((r) => !r.replayed).length, 1);
  assert.equal(await db.shop.count(), beforeShops + 1);
  assert.equal(await db.chat.count(), beforeChats + 1);
});

test('concurrent HTTP onboarding retries all return the same committed shop', async () => {
  const input = registration('parallel-http@shop.test');
  await installOtp(input);
  const responses = await Promise.all(Array.from({ length: 4 }, () => app.request('POST', '/auth/register', { body: input })));
  assert.ok(responses.every((r) => r.status === 200 || r.status === 201), JSON.stringify(responses));
  assert.equal(responses.filter((r) => r.status === 201).length, 1);
  assert.equal(new Set(responses.map((r) => r.body.shop.id)).size, 1);
});

test('registration cannot recreate an existing employee as a customer, even with a verified code', async () => {
  const input = registration(employee.email, { userType: 'CUSTOMER' });
  const beforeShops = await db.shop.count();
  await installOtp(input);
  const response = await app.request('POST', '/auth/register', { body: input });
  assert.equal(response.status, 409);
  assert.equal(await db.customer.count({ where: { email: employee.email } }), 0);
  assert.equal(await db.shop.count(), beforeShops);
});

test('provisioning failure after account creation rolls every write back and permits retry', async () => {
  const input = registration('failure@shop.test');
  const passwordHash = await bcrypt.hash(input.password, 4);
  const beforeShops = await db.shop.count();
  const failingDb = { $transaction: (fn, options) => db.$transaction((tx) => fn(new Proxy(tx, {
    get(target, prop) { return prop === 'chat' ? { create: async () => { throw new Error('Injected chat failure'); } } : target[prop]; },
  })), options) };
  await assert.rejects(provisionRegistration(failingDb, input, passwordHash, hash(input)), /Injected chat failure/);
  assert.equal(await db.customer.count({ where: { email: input.email } }), 0);
  assert.equal(await db.shop.count(), beforeShops);
  const result = await provisionRegistration(db, input, passwordHash, hash(input));
  assert.equal(result.customer.defaultSupermarketId, result.shop.id);
});

test('supplier prices and original employees/operational data remain byte-equivalent throughout', async () => {
  const afterData = await originalData();
  for (const name of ['Product', 'ProductAtShop', 'Empolyee', 'ShopEmployeeMembership', 'CompanyStaffMembership', 'List', 'ExpiryProduct', 'Fridge', 'CleaningArea']) {
    // Authentication updates lastActiveAt by design; verify membership/identity fields separately.
    if (name === 'Empolyee' || name === 'ShopEmployeeMembership') {
      const strip = (rows) => rows.map(({ lastActiveAt, updatedAt, ...rest }) => rest);
      assert.deepEqual(strip(afterData[name]), strip(beforeData[name]), name);
    } else assert.deepEqual(afterData[name], beforeData[name], name);
  }
  assert.deepEqual(afterData.Shop.find((s) => s.id === seed.wholesale.id), beforeData.Shop.find((s) => s.id === seed.wholesale.id));
});

test('pure classification never infers a second owner from operational records or missing defaults', () => {
  const facts = {
    customers: [{ id: 1, shopId: 'a', defaultSupermarketId: null, defaultSupermarketVersion: 0 }],
    shops: [{ id: 'a', shopType: 'CUSTOMER' }, { id: 'b', shopType: 'CUSTOMER' }],
    ownerships: [], links: [{ customerId: 1, shopId: 'b', kind: 'TASK' }],
  };
  assert.equal(buildDefaultPlan(facts).items[0].reason, 'CONFLICTING_OPERATIONAL_RELATIONSHIPS');
  facts.links = [];
  facts.customers.push({ id: 2, shopId: 'a', defaultSupermarketId: null, defaultSupermarketVersion: 0 });
  assert.ok(buildDefaultPlan(facts).items.every((i) => i.reason === 'MULTIPLE_LEGACY_OWNERS'));
});

test('CLI requires a target, binds reports to it, supports reviewed local apply/recovery and refuses unapproved remote writes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paymi-default-cli-'));
  const report = path.join(dir, 'plan.json');
  const cli = new URL('../scripts/migrateDefaultSupermarkets.js', import.meta.url);
  const run = (args, url = process.env.TEST_DATABASE_URL) => execFileSync(process.execPath, [cli.pathname, ...args], {
    env: { ...process.env, MIGRATION_DATABASE_URL: url }, encoding: 'utf8', stdio: 'pipe',
  });
  try {
    assert.throws(() => run([`--report=${report}`], ''), /MIGRATION_DATABASE_URL/);
    assert.throws(() => run([`--apply=${report}`], 'postgresql://example.invalid/paymi'), /explicit production approval/);
    assert.equal(JSON.parse(run([`--report=${report}`])).dryRun, true);
    const saved = JSON.parse(fs.readFileSync(report));
    fs.writeFileSync(report, JSON.stringify({ ...saved, targetFingerprint: 'wrong-target' }));
    assert.throws(() => run([`--apply=${report}`]), /different database target/);
    fs.writeFileSync(report, JSON.stringify(saved));
    const applied = JSON.parse(run([`--apply=${report}`]));
    assert.ok(applied.appliedRunId);
    assert.equal(JSON.parse(run([`--recover=${applied.appliedRunId}`])).ownershipsRetained, true);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
