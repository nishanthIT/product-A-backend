// Migration tests: classification of legacy employee rows, safe apply, idempotent rerun, rollback.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import { getPrisma, resetDatabase, seedBase, startApp } from './helpers/harness.js';
import {
  MIGRATION_SOURCE,
  OUTCOME,
  applyPlan,
  buildPlan,
  collectFacts,
  rollbackRun,
} from '../scripts/lib/employeeMembershipMigration.js';

let prisma;
let app;
let seed;
const E = {};

// Legacy rows exactly as the old code produced them: no memberships at all.
async function legacyEmployee(key, data) {
  E[key] = await prisma.empolyee.create({
    data: {
      name: data.name ?? key,
      email: data.email ?? `${key}@legacy.test`,
      phoneNo: `p-${key}`,
      password: seed.passwordHash,
      createdAt: data.createdAt,
      shopId: data.shopId ?? null,
      createdByCustomerId: data.createdByCustomerId ?? null,
      createdByAdminId: data.createdByAdminId ?? null,
    },
  });
  return E[key];
}

const counts = async () => ({
  employees: await prisma.empolyee.count(),
  lists: await prisma.list.count(),
  company: await prisma.companyStaffMembership.count(),
  shop: await prisma.shopEmployeeMembership.count(),
  reviews: await prisma.employeeAccessReview.count(),
});

before(async () => {
  await resetDatabase();
  prisma = await getPrisma();
  seed = await seedBase(prisma);
  app = await startApp();

  const orphanOwner = await prisma.customer.create({
    data: { name: 'Shopless Owner', email: 'shopless@shop.test', mobile: 'm-shopless', password: seed.passwordHash },
  });

  await legacyEmployee('legacyStaff', { createdAt: new Date('2026-02-01') });
  await legacyEmployee('adminCreated', { createdAt: new Date('2026-06-01'), createdByAdminId: seed.admin.id });
  await legacyEmployee('shopEmp', { createdAt: new Date('2026-05-01'), shopId: seed.a.shop.id, createdByCustomerId: seed.a.owner.id });
  // Looks like company staff by name/email domain, but provenance says Bravo's shop.
  await legacyEmployee('lookalike', {
    name: 'Company Staff Member',
    email: 'staff@company.test',
    createdAt: new Date('2026-05-02'),
    shopId: seed.b.shop.id,
    createdByCustomerId: seed.b.owner.id,
  });
  await legacyEmployee('orphanCreator', { createdAt: new Date('2026-05-03'), createdByCustomerId: orphanOwner.id });
  await legacyEmployee('mismatch', { createdAt: new Date('2026-05-04'), shopId: seed.a.shop.id, createdByCustomerId: seed.b.owner.id });
  await legacyEmployee('postCutoff', { createdAt: new Date('2026-05-05') });
  await legacyEmployee('shopNoCreator', { createdAt: new Date('2026-01-05'), shopId: seed.a.shop.id });
  await legacyEmployee('conflicting', { createdAt: new Date('2026-05-06'), shopId: seed.a.shop.id, createdByCustomerId: seed.a.owner.id });
  await legacyEmployee('dual', { createdAt: new Date('2026-05-07'), shopId: seed.b.shop.id, createdByCustomerId: seed.b.owner.id });

  // Evidence and history that must be preserved.
  const logAction = (employeeId, shopId) =>
    prisma.actionLog.create({ data: { employeeId, shopId, productId: seed.product.id, actionType: 'ADD' } });
  await logAction(E.legacyStaff.id, seed.wholesale.id);
  await logAction(E.postCutoff.id, seed.wholesale.id);
  await logAction(E.orphanCreator.id, seed.wholesale.id);
  await prisma.list.create({ data: { name: 'A list', description: '', employeeId: E.shopEmp.id, shopId: seed.a.shop.id, creatorType: 'EMPLOYEE' } });
  await prisma.list.create({ data: { name: 'Lost shop list', description: '', employeeId: E.orphanCreator.id, shopId: 'deleted-shop-id', creatorType: 'EMPLOYEE' } });
  await prisma.list.create({ data: { name: 'Other shop list', description: '', employeeId: E.conflicting.id, shopId: seed.b.shop.id, creatorType: 'EMPLOYEE' } });
  await prisma.chatParticipant.create({ data: { chatId: seed.a.shop.groupChatId, userId: E.shopEmp.id, userType: 'EMPLOYEE' } });

  // Independently authorized company access that must survive.
  await prisma.companyStaffMembership.create({
    data: { employeeId: E.dual.id, permissions: ['catalog.read'], source: 'COMPANY_STAFF_FLOW', grantedByAdminId: seed.admin.id },
  });
});

after(async () => {
  await app?.close();
  await prisma?.$disconnect();
});

describe('employee membership migration', () => {
  let plan;
  let byKey;
  let before;
  let oldShopEmpToken;

  test('dry run classifies by provenance and writes nothing', async () => {
    before = await counts();
    oldShopEmpToken = jwt.sign({ id: E.shopEmp.id, email: E.shopEmp.email, userType: 'EMPLOYEE' }, process.env.JWT_SECRET);

    plan = buildPlan(await collectFacts(prisma));
    byKey = Object.fromEntries(Object.entries(E).map(([k, e]) => [k, plan.items.find((i) => i.employeeId === e.id)]));

    assert.equal(byKey.legacyStaff.outcome, OUTCOME.COMPANY_STAFF);
    assert.equal(byKey.adminCreated.outcome, OUTCOME.COMPANY_STAFF);
    assert.equal(byKey.shopEmp.outcome, OUTCOME.SHOP_EMPLOYEE);
    assert.equal(byKey.shopEmp.shopId, seed.a.shop.id);
    assert.equal(byKey.lookalike.outcome, OUTCOME.SHOP_EMPLOYEE, 'must not infer company staff from name/email');
    assert.equal(byKey.lookalike.shopId, seed.b.shop.id);
    assert.equal(byKey.orphanCreator.reason, 'CREATOR_SHOP_MISSING');
    assert.equal(byKey.mismatch.reason, 'SHOP_MISMATCH');
    assert.equal(byKey.postCutoff.reason, 'NO_PROVENANCE_AFTER_SHOP_FLOW');
    assert.equal(byKey.shopNoCreator.reason, 'SHOP_WITHOUT_CREATOR');
    assert.equal(byKey.conflicting.reason, 'CONFLICTING_SHOP_EVIDENCE');
    assert.equal(byKey.dual.outcome, OUTCOME.SHOP_EMPLOYEE);
    assert.ok(!byKey.dual.actions.includes('INVALIDATE_SESSIONS'), 'independently authorized company access is kept');

    assert.equal(plan.summary.needsReview, 5);
    assert.deepEqual(await counts(), before);
  });

  test('apply maps employees to the right shop, removes unverified company access and keeps history', async () => {
    const created = await applyPlan(prisma, plan);
    const after = await counts();
    assert.equal(after.employees, before.employees, 'no accounts deleted');
    assert.equal(after.lists, before.lists, 'no lists deleted');
    assert.equal(created.shopMemberships.length, 3);
    assert.equal(created.companyMemberships.length, 2);
    assert.equal(created.reviews.length, 5);

    const shopEmp = await prisma.shopEmployeeMembership.findMany({ where: { employeeId: E.shopEmp.id } });
    assert.deepEqual(shopEmp.map((m) => [m.shopId, m.status, m.source]), [[seed.a.shop.id, 'ACTIVE', MIGRATION_SOURCE]]);
    assert.equal(await prisma.companyStaffMembership.count({ where: { employeeId: E.shopEmp.id } }), 0);
    const list = await prisma.list.findFirst({ where: { employeeId: E.shopEmp.id } });
    assert.equal(list.shopId, seed.a.shop.id);

    const lookalike = await prisma.shopEmployeeMembership.findFirst({ where: { employeeId: E.lookalike.id } });
    assert.equal(lookalike.shopId, seed.b.shop.id);
    assert.equal(await prisma.companyStaffMembership.count({ where: { employeeId: E.lookalike.id } }), 0);

    for (const key of ['orphanCreator', 'mismatch', 'postCutoff', 'shopNoCreator', 'conflicting']) {
      const emp = await prisma.empolyee.findUnique({
        where: { id: E[key].id },
        include: { companyMembership: true, shopMemberships: true, accessReviews: true },
      });
      assert.equal(emp.companyMembership, null, `${key} kept company access`);
      assert.equal(emp.shopMemberships.length, 0, `${key} was guessed into a shop`);
      assert.equal(emp.accessReviews.length, 1);
      assert.equal(emp.shopId, null);
      assert.equal(emp.sessionVersion, 1);
    }
    const orphanList = await prisma.list.findFirst({ where: { employeeId: E.orphanCreator.id } });
    assert.equal(orphanList.shopId, 'deleted-shop-id');

    const staff = await prisma.empolyee.findUnique({ where: { id: E.legacyStaff.id }, include: { companyMembership: true } });
    assert.equal(staff.companyMembership.status, 'ACTIVE');
    assert.equal(staff.sessionVersion, 0, 'genuine staff stay signed in');
    const dual = await prisma.companyStaffMembership.findUnique({ where: { employeeId: E.dual.id } });
    assert.equal(dual.source, 'COMPANY_STAFF_FLOW');
    assert.deepEqual(dual.permissions, ['catalog.read']);
  });

  test('migrated accounts get the right access and stale tokens stop working', async () => {
    assert.equal((await app.request('GET', '/admin/list-items', { token: oldShopEmpToken })).status, 401);

    const shopLogin = await app.login(E.shopEmp.email, seed.password);
    assert.equal(shopLogin.status, 200);
    assert.equal(shopLogin.body.user.companyAccess, null);
    assert.equal(shopLogin.body.user.shopAccess.shopId, seed.a.shop.id);
    assert.equal((await app.request('GET', '/admin/list-items', { token: shopLogin.token })).status, 403);

    const ambiguous = await app.login(E.postCutoff.email, seed.password);
    assert.equal(ambiguous.status, 403);

    const staffLogin = await app.login(E.legacyStaff.email, seed.password);
    assert.equal(staffLogin.status, 200);
    assert.equal((await app.request('GET', '/admin/list-items', { token: staffLogin.token })).status, 200);
    assert.equal((await app.request('GET', '/admin/customers', { token: staffLogin.token })).status, 403);

    const reviews = await app.login('admin@company.test', seed.password);
    const queue = await app.request('GET', '/admin/access-reviews', { token: reviews.token });
    assert.equal(queue.status, 200);
    assert.equal(queue.body.data.length, 5);
  });

  test('rerunning is a no-op and does not duplicate memberships or re-invalidate sessions', async () => {
    const before2 = await counts();
    const versions = await prisma.empolyee.findMany({ select: { id: true, sessionVersion: true }, orderBy: { id: 'asc' } });
    const rerun = buildPlan(await collectFacts(prisma));
    assert.equal(rerun.summary.alreadyMigrated, rerun.summary.totalEmployees);
    const created = await applyPlan(prisma, rerun);
    assert.deepEqual(created, { companyMemberships: [], shopMemberships: [], reviews: [], sessionsInvalidated: [] });
    assert.deepEqual(await counts(), before2);
    assert.deepEqual(await prisma.empolyee.findMany({ select: { id: true, sessionVersion: true }, orderBy: { id: 'asc' } }), versions);
  });

  test('resolving a review explicitly assigns a shop without touching lists', async () => {
    const admin = await app.login('admin@company.test', seed.password);
    const review = await prisma.employeeAccessReview.findFirst({ where: { employeeId: E.mismatch.id } });
    const shops = await app.request('GET', `/admin/access-reviews/assignable-shops?reviewId=${review.id}`, { token: admin.token });
    assert.equal(shops.status, 200);
    assert.deepEqual(shops.body.data.map((s) => s.id).sort(), [seed.a.shop.id, seed.b.shop.id].sort());
    assert.equal(shops.body.data[0].id, seed.b.shop.id, 'creator-owned shop is suggested first');
    assert.equal(shops.body.data[0].suggested, true);
    const searched = await app.request('GET', '/admin/access-reviews/assignable-shops?search=alpha', { token: admin.token });
    assert.deepEqual(searched.body.data.map((s) => s.id), [seed.a.shop.id]);

    const noNote = await app.request('POST', `/admin/access-reviews/${review.id}/resolve`, {
      token: admin.token,
      body: { action: 'ASSIGN_SHOP', shopId: seed.a.shop.id },
    });
    assert.equal(noNote.status, 400);
    const res = await app.request('POST', `/admin/access-reviews/${review.id}/resolve`, {
      token: admin.token,
      body: { action: 'ASSIGN_SHOP', shopId: seed.a.shop.id, permissions: ['feature.lists', 'feature.tasks'], note: 'Confirmed with Alpha owner by phone' },
    });
    assert.equal(res.status, 200);
    const m = await prisma.shopEmployeeMembership.findFirst({ where: { employeeId: E.mismatch.id } });
    assert.equal(m.shopId, seed.a.shop.id);
    assert.equal(m.source, 'ACCESS_REVIEW');
    assert.deepEqual(m.permissions.sort(), ['feature.lists', 'feature.tasks']);
    assert.equal(await prisma.companyStaffMembership.count({ where: { employeeId: E.mismatch.id } }), 0);
  });

  test('rollback removes only rows the run created', async () => {
    const runPlan = buildPlan(await collectFacts(prisma));
    assert.equal(runPlan.summary.alreadyMigrated, runPlan.summary.totalEmployees);
    const created = {
      companyMemberships: (await prisma.companyStaffMembership.findMany({ where: { source: MIGRATION_SOURCE } })).map((m) => m.id),
      shopMemberships: (await prisma.shopEmployeeMembership.findMany({ where: { source: MIGRATION_SOURCE } })).map((m) => m.id),
      reviews: (await prisma.employeeAccessReview.findMany({ where: { status: 'OPEN' } })).map((r) => r.id),
    };
    const snapshot = [{ id: E.shopEmp.id, shopId: seed.a.shop.id }];
    await rollbackRun(prisma, { created, snapshot });
    assert.equal(await prisma.shopEmployeeMembership.count({ where: { source: MIGRATION_SOURCE } }), 0);
    assert.equal(await prisma.companyStaffMembership.count({ where: { source: MIGRATION_SOURCE } }), 0);
    assert.ok(await prisma.companyStaffMembership.findUnique({ where: { employeeId: E.dual.id } }));
    assert.ok(await prisma.shopEmployeeMembership.findFirst({ where: { source: 'ACCESS_REVIEW' } }));
    assert.equal((await counts()).lists, before.lists);
  });
});
