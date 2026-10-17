import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import pg from 'pg';
import { createCompanyStaff, getPrisma, resetDatabase, seedBase, startApp } from './helpers/harness.js';
import { processDeletion, requestDeletion } from '../src/services/accountDeletion.js';

let db, app, seed, employee, reviewer, distantEmployee;
const tokens = {}, reports = {};
const reportBody = price => ({ productId: seed.product.id, shopId: seed.wholesale.id, reportedPrice: price });
const submit = (role, price = '2.00') => app.request('POST', '/price-reports', { token: tokens[role], body: reportBody(price) });
function assertSafeIdentity(report, expected) {
  assert.equal(report.reporter.userType, expected);
  assert.deepEqual(Object.keys(report.reporter).sort(), ['email', 'id', 'name', 'userType']);
  assert.equal(report.reporterEmployee, undefined);
  assert.equal(report.reporterAdmin, undefined);
}

before(async () => {
  await resetDatabase(); db = await getPrisma(); seed = await seedBase(db); app = await startApp();
  const response = await app.login(seed.a.owner.email, seed.password); tokens.customer = response.token;
  tokens.admin = (await app.login(seed.admin.email, seed.password)).token;
  const created = await app.request('POST', '/employees', { token: tokens.customer, body: { name: 'Shop worker', email: 'price-worker@shop.test', password: 'Secret123' } });
  assert.equal(created.status, 201); employee = created.body.employee;
  tokens.employee = (await app.login(employee.email, 'Secret123')).token;
  assert.equal(employee.id, seed.a.owner.id); assert.equal(seed.admin.id, seed.a.owner.id);
  reviewer = await createCompanyStaff(db, { email: 'reviewer@company.test', passwordHash: seed.passwordHash, permissions: ['price_reports.review'] });
  tokens.reviewer = (await app.login(reviewer.email, seed.password)).token;
  distantEmployee = await db.empolyee.create({ data: { id: 500, name: 'Distant employee', email: 'distant@company.test', phoneNo: 'distant', password: seed.passwordHash, companyMembership: { create: { permissions: [] } } } });
  tokens.distant = (await app.login(distantEmployee.email, seed.password)).token;
});
after(async () => { await app?.close(); await db?.$disconnect(); });

test('additive migration preserves historical customer reports and earnings and enforces typed ownership', async () => {
  const legacy = await db.priceReport.create({ data: { reporterId: seed.b.owner.id, productId: seed.product.id, shopId: seed.wholesale.id, reportedPrice: 1.75, currentPrice: 1.25, status: 'APPROVED', pointsAwarded: true } });
  await db.customer.update({ where: { id: seed.b.owner.id }, data: { earnings: 7 } });
  const client = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
  await client.connect();
  try {
    await client.query('ALTER TABLE "PriceReport" DROP COLUMN "reporterType", DROP COLUMN "reporterEmployeeId", DROP COLUMN "reporterAdminId", DROP COLUMN "reviewedByEmployeeId"; ALTER TABLE "PriceReport" ALTER COLUMN "reporterId" SET NOT NULL;');
    const before = (await client.query('SELECT * FROM "PriceReport" WHERE "id" = $1', [legacy.id])).rows[0];
    await client.query(await fs.readFile(new URL('../prisma/migrations/20261017160000_typed_price_reporters/migration.sql', import.meta.url), 'utf8'));
    const after = (await client.query('SELECT * FROM "PriceReport" WHERE "id" = $1', [legacy.id])).rows[0];
    for (const key of Object.keys(before)) assert.deepEqual(after[key], before[key]);
    assert.equal(after.reporterType, 'CUSTOMER');
    assert.equal(Number((await db.customer.findUnique({ where: { id: seed.b.owner.id } })).earnings), 7);
    await assert.rejects(client.query('UPDATE "PriceReport" SET "reporterType" = \'EMPLOYEE\' WHERE "id" = $1', [legacy.id]), error => error.code === '23514');
    assert.equal((await db.priceReport.findUnique({ where: { id: legacy.id } })).reporterId, seed.b.owner.id);
  } finally { await client.end(); }
});

test('colliding customer/employee/admin IDs submit attributable reports and read only their own history', async () => {
  for (const [role, type, field] of [['customer', 'CUSTOMER', 'reporterId'], ['employee', 'EMPLOYEE', 'reporterEmployeeId'], ['admin', 'ADMIN', 'reporterAdminId']]) {
    const response = await submit(role);
    assert.equal(response.status, 201, JSON.stringify(response.body));
    reports[role] = response.body.report;
    assert.equal(reports[role].reporterType, type);
    assert.equal(reports[role][field], seed.a.owner.id);
    for (const otherField of ['reporterId', 'reporterEmployeeId', 'reporterAdminId'].filter(value => value !== field)) assert.equal(reports[role][otherField], null);
  }
  for (const role of ['customer', 'employee', 'admin']) {
    const response = await app.request('GET', '/price-reports', { token: tokens[role] });
    assert.equal(response.status, 200);
    assert.deepEqual(response.body.reports.map(row => row.id), [reports[role].id]);
    assert.equal(Number(response.body.earnings), 0);
  }
  const distant = await submit('distant', '0.00');
  assert.equal(distant.status, 201, JSON.stringify(distant.body));
  assert.equal(distant.body.report.reporterEmployeeId, 500);
  assert.equal(Number(distant.body.report.reportedPrice), 0);
  assert.equal(await db.customer.findUnique({ where: { id: 500 } }), null);
});

test('only authorized reviewers see identities and responses never expose account credentials', async () => {
  for (const token of [undefined, tokens.customer, tokens.employee, tokens.distant]) {
    assert.equal((await app.request('GET', '/price-reports/admin/pending', { token })).status, token ? 403 : 401);
    assert.equal((await app.request('GET', '/price-reports/admin/all', { token })).status, token ? 403 : 401);
    assert.equal((await app.request('POST', `/price-reports/admin/approve/${reports.customer.id}`, { token, body: {} })).status, token ? 403 : 401);
  }
  const response = await app.request('GET', '/price-reports/admin/pending', { token: tokens.reviewer });
  assert.equal(response.status, 200); assert.ok(Array.isArray(response.body));
  for (const role of ['customer', 'employee', 'admin']) {
    const row = response.body.find(value => value.id === reports[role].id);
    assertSafeIdentity(row, role.toUpperCase());
  }
});

test('both approval aliases preserve customer-only rewards and record the actual reviewer type', async () => {
  const before = await db.customer.findUnique({ where: { id: seed.a.owner.id } });
  const employeeReview = await app.request('PUT', `/price-reports/admin/${reports.employee.id}/approve`, { token: tokens.reviewer, body: { adminNotes: 'Verified supplier shelf price' } });
  assert.equal(employeeReview.status, 200, JSON.stringify(employeeReview.body));
  assert.equal(employeeReview.body.pointsAwarded, 0); assert.equal(employeeReview.body.report.pointsAwarded, false);
  assert.equal(employeeReview.body.report.reviewedByEmployeeId, reviewer.id); assert.equal(employeeReview.body.report.reviewedBy, null);
  assertSafeIdentity(employeeReview.body.report, 'EMPLOYEE');
  const adminReview = await app.request('POST', `/price-reports/admin/approve/${reports.admin.id}`, { token: tokens.admin, body: {} });
  assert.equal(adminReview.status, 200); assert.equal(adminReview.body.pointsAwarded, 0);
  assert.equal(adminReview.body.report.reviewedBy, seed.admin.id); assert.equal(adminReview.body.report.reviewedByEmployeeId, null);
  assertSafeIdentity(adminReview.body.report, 'ADMIN');
  assert.equal(Number((await db.customer.findUnique({ where: { id: seed.a.owner.id } })).earnings), Number(before.earnings));
  assert.equal(Number((await db.productAtShop.findUnique({ where: { shopId_productId: { productId: seed.product.id, shopId: seed.wholesale.id } } })).price), 2);
});

test('concurrent customer approvals award once and terminal reports cannot be re-rejected', async () => {
  const results = await Promise.all([
    app.request('POST', `/price-reports/admin/approve/${reports.customer.id}`, { token: tokens.admin, body: {} }),
    app.request('PUT', `/price-reports/admin/${reports.customer.id}/approve`, { token: tokens.reviewer, body: {} }),
  ]);
  assert.deepEqual(results.map(result => result.status).sort(), [200, 400]);
  assertSafeIdentity(results.find(result => result.status === 200).body.report, 'CUSTOMER');
  assert.equal(Number((await db.customer.findUnique({ where: { id: seed.a.owner.id } })).earnings), 1);
  assert.equal((await app.request('POST', `/price-reports/admin/reject/${reports.customer.id}`, { token: tokens.admin, body: {} })).status, 400);
  const employeeHistory = await app.request('GET', '/price-reports', { token: tokens.employee });
  assert.equal(Number(employeeHistory.body.earnings), 0, 'employee must not receive colliding customer earnings');
});

test('reject aliases retain typed attribution, do not award earnings, and return not-found accurately', async () => {
  for (const [role, method] of [['employee', 'PUT'], ['admin', 'POST']]) {
    const submitted = await submit(role, '3.50');
    const id = submitted.body.report.id;
    const url = method === 'PUT' ? `/price-reports/admin/${id}/reject` : `/price-reports/admin/reject/${id}`;
    const result = await app.request(method, url, { token: tokens.reviewer, body: { adminNotes: 'Unverified' } });
    assert.equal(result.status, 200); assert.equal(result.body.pointsAwarded, 0);
    assert.equal(result.body.report.status, 'REJECTED');
    assertSafeIdentity(result.body.report, role.toUpperCase());
  }
  assert.equal((await app.request('PUT', '/price-reports/admin/missing/reject', { token: tokens.admin, body: {} })).status, 404);
});

test('invalid prices do not create malformed reports and zero current prices are preserved', async () => {
  const count = await db.priceReport.count();
  for (const value of [-1, '2.10oops', '', 'NaN', 'Infinity', true, null, '1.001', 1000000001]) {
    assert.equal((await submit('employee', value)).status, 400, JSON.stringify(value));
  }
  const invalidCurrent = await app.request('POST', '/price-reports', { token: tokens.employee, body: { ...reportBody('2'), currentPrice: '-1' } });
  assert.equal(invalidCurrent.status, 400);
  assert.equal(await db.priceReport.count(), count);
  const zero = await app.request('POST', '/price-reports', { token: tokens.employee, body: { ...reportBody('2'), currentPrice: 0 } });
  assert.equal(zero.status, 201); assert.equal(Number(zero.body.report.currentPrice), 0);
});

test('personal deletion cascades only typed authored reports and clears reviewer links without harming colliding accounts', async () => {
  const customerBefore = await db.customer.findUnique({ where: { id: seed.a.owner.id } });
  const customerReports = await db.priceReport.findMany({ where: { reporterId: seed.a.owner.id }, orderBy: { id: 'asc' } });
  const options = { purgeCaches: async () => {}, persistJournal: async () => {} };
  for (const [id, userType] of [[employee.id, 'EMPLOYEE'], [reviewer.id, 'EMPLOYEE'], [seed.admin.id, 'ADMIN']]) {
    const job = await requestDeletion(db, { id, userType });
    assert.equal((await processDeletion(db, job.id, options)).status, 'EXTERNAL_REVIEW');
  }
  assert.equal(await db.priceReport.count({ where: { reporterEmployeeId: employee.id } }), 0);
  assert.equal(await db.priceReport.count({ where: { reporterAdminId: seed.admin.id } }), 0);
  assert.equal(await db.priceReport.count({ where: { reporterEmployeeId: distantEmployee.id } }), 1);
  const remaining = await db.priceReport.findMany({ where: { reporterId: seed.a.owner.id }, orderBy: { id: 'asc' } });
  assert.deepEqual(remaining.map(row => ({ ...row, reviewedBy: null, reviewedByEmployeeId: null, updatedAt: null })), customerReports.map(row => ({ ...row, reviewedBy: null, reviewedByEmployeeId: null, updatedAt: null })));
  assert.ok(remaining.every(row => row.reviewedBy === null && row.reviewedByEmployeeId === null));
  assert.deepEqual(await db.customer.findUnique({ where: { id: seed.a.owner.id } }), customerBefore);
});
