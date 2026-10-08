// Authorization tests for the company staff / shop employee separation.
// Run with: TEST_DATABASE_URL=postgresql://postgres@localhost:54329/paymi_test npm test
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import { createCompanyStaff, getPrisma, resetDatabase, seedBase, startApp } from './helpers/harness.js';

let prisma;
let app;
let seed;
let ownerA;
let ownerB;
let adminToken;

const createShopEmployee = async (ownerToken, email, extra = {}) => {
  const res = await app.request('POST', '/employees', {
    token: ownerToken,
    body: { name: email.split('@')[0], email, password: 'Secret123', ...extra },
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.employee;
};

before(async () => {
  await resetDatabase();
  prisma = await getPrisma();
  seed = await seedBase(prisma);
  app = await startApp();
  ownerA = (await app.login('alpha-owner@shop.test', seed.password)).token;
  ownerB = (await app.login('bravo-owner@shop.test', seed.password)).token;
  adminToken = (await app.login('admin@company.test', seed.password)).token;
  assert.ok(ownerA && ownerB && adminToken);
});

after(async () => {
  await app?.close();
  await prisma?.$disconnect();
});

describe('shop owner creates employees', () => {
  test('creates only a shop membership in the owner\'s own shop, never company membership', async () => {
    const employee = await createShopEmployee(ownerA, 'alice@shop.test', { shopId: undefined });
    assert.equal(employee.shopId, seed.a.shop.id);
    assert.equal(employee.status, 'ACTIVE');
    assert.equal(employee.role, 'EMPLOYEE');

    const company = await prisma.companyStaffMembership.findUnique({ where: { employeeId: employee.id } });
    assert.equal(company, null);
    const memberships = await prisma.shopEmployeeMembership.findMany({ where: { employeeId: employee.id } });
    assert.deepEqual(memberships.map((m) => m.shopId), [seed.a.shop.id]);

    const staffList = await app.request('GET', '/getallemploy', { token: adminToken });
    assert.equal(staffList.status, 200);
    assert.ok(!staffList.body.data.some((s) => s.id === employee.id), 'shop employee leaked into company staff list');
  });

  test('a client-submitted shopId for another shop is rejected', async () => {
    const res = await app.request('POST', '/employees', {
      token: ownerA,
      body: { name: 'Mallory', email: 'mallory@shop.test', password: 'Secret123', shopId: seed.b.shop.id },
    });
    assert.equal(res.status, 403);
    assert.equal(await prisma.empolyee.count({ where: { email: 'mallory@shop.test' } }), 0);
  });

  test('a shop owner cannot assign company roles or permissions', async () => {
    const attempts = [
      { role: 'ADMIN' },
      { role: 'STAFF' },
      { permissions: ['catalog.write'] },
      { permissions: ['staff.manage'] },
      { companyRole: 'MANAGER' },
      { companyPermissions: ['catalog.read'] },
      { userType: 'ADMIN' },
    ];
    for (const [i, extra] of attempts.entries()) {
      const email = `escalate${i}@shop.test`;
      const res = await app.request('POST', '/employees', {
        token: ownerA,
        body: { name: 'Esc', email, password: 'Secret123', ...extra },
      });
      assert.equal(res.status, 400, `attempt ${JSON.stringify(extra)} => ${res.status}`);
      assert.equal(await prisma.empolyee.count({ where: { email } }), 0);
    }

    const employee = await createShopEmployee(ownerA, 'bob@shop.test');
    const update = await app.request('PUT', `/employees/${employee.id}`, {
      token: ownerA,
      body: { role: 'ADMIN', permissions: ['customers.manage'] },
    });
    assert.equal(update.status, 400);
    assert.equal(await prisma.companyStaffMembership.count({ where: { employeeId: employee.id } }), 0);
  });
});

describe('shop employees and owners cannot reach company administration', () => {
  let employeeToken;

  before(async () => {
    await createShopEmployee(ownerA, 'carol@shop.test');
    const login = await app.login('carol@shop.test', 'Secret123');
    assert.equal(login.status, 200);
    assert.equal(login.body.user.companyAccess, null);
    assert.equal(login.body.user.shopAccess.shopId, seed.a.shop.id);
    employeeToken = login.token;
  });

  const companyEndpoints = () => [
    ['GET', '/getallemploy'],
    ['POST', '/addEmployee', { name: 'x', email: 'x@x.test', password: 'Secret123' }],
    ['GET', '/filterProducts'],
    ['POST', '/addProduct', { title: 'Hack' }],
    ['PUT', `/editProduct/${seed.product.id}`, { title: 'Hacked' }],
    ['GET', '/getAllshop'],
    ['GET', `/shop/${seed.wholesale.id}/products`],
    ['PUT', `/shop/${seed.wholesale.id}/updateProductPrice`, { productId: seed.product.id, price: 0.01 }],
    ['GET', '/products/pending-submissions'],
    ['GET', '/employee/dashboard-data'],
    ['GET', '/admin/dashboard'],
    ['GET', '/admin/customers'],
    ['GET', `/admin/customers/${seed.a.owner.id}/employees`],
    ['DELETE', `/admin/customers/${seed.b.owner.id}`],
    ['GET', '/admin/list-items'],
    ['POST', '/admin/staff/grant', { employeeId: 1 }],
    ['GET', '/price-reports/admin/pending'],
    ['GET', '/price-reports/admin/all'],
  ];

  test('shop employee gets 403 on every company endpoint', async () => {
    for (const [method, url, body] of companyEndpoints()) {
      const res = await app.request(method, url, { token: employeeToken, body });
      assert.equal(res.status, 403, `${method} ${url} => ${res.status}`);
    }
    const product = await prisma.product.findUnique({ where: { id: seed.product.id } });
    assert.equal(product.title, 'Test Cola 330ml');
    assert.ok(await prisma.customer.findUnique({ where: { id: seed.b.owner.id } }));
  });

  test('shop owner gets 403 on every company endpoint', async () => {
    for (const [method, url, body] of companyEndpoints()) {
      const res = await app.request(method, url, { token: ownerA, body });
      assert.equal(res.status, 403, `${method} ${url} => ${res.status}`);
    }
  });

  test('previously unauthenticated company endpoints now require a token', async () => {
    for (const [method, url] of [
      ['GET', '/admin/customers'],
      ['GET', '/admin/dashboard'],
      ['DELETE', `/admin/customers/${seed.b.owner.id}`],
      ['GET', '/price-reports/admin/pending'],
    ]) {
      const res = await app.request(method, url);
      assert.equal(res.status, 401, `${method} ${url} => ${res.status}`);
    }
  });

  test('a forged EMPLOYEE token for a shop employee still has no company access', async () => {
    const carol = await prisma.empolyee.findUnique({ where: { email: 'carol@shop.test' } });
    const forged = jwt.sign({ id: carol.id, email: carol.email, userType: 'EMPLOYEE', sv: 0, role: 'ADMIN' }, process.env.JWT_SECRET);
    const res = await app.request('GET', '/admin/customers', { token: forged });
    assert.equal(res.status, 403);
    const me = await app.request('GET', '/auth/me', { token: forged });
    assert.equal(me.body.user.companyAccess, null);
  });
});

describe('cross-shop isolation', () => {
  let alphaEmployee;
  let alphaToken;
  let alphaListId;

  before(async () => {
    alphaEmployee = await createShopEmployee(ownerA, 'dave@shop.test');
    await createShopEmployee(ownerB, 'erin@shop.test');
    alphaToken = (await app.login('dave@shop.test', 'Secret123')).token;
    const list = await app.request('POST', '/lists', { token: alphaToken, body: { name: 'Alpha restock' } });
    assert.equal(list.status, 201, JSON.stringify(list.body));
    alphaListId = list.body.id;
    const stored = await prisma.list.findUnique({ where: { id: alphaListId } });
    assert.equal(stored.shopId, seed.a.shop.id);
  });

  test('owner B only sees Bravo employees', async () => {
    const res = await app.request('GET', '/employees?status=ALL', { token: ownerB });
    assert.equal(res.status, 200);
    assert.ok(res.body.employees.length > 0);
    assert.ok(res.body.employees.every((e) => e.shopId === seed.b.shop.id));
  });

  test('owner B cannot read or change an Alpha employee by id', async () => {
    const id = alphaEmployee.id;
    const results = await Promise.all([
      app.request('PUT', `/employees/${id}`, { token: ownerB, body: { name: 'Pwned' } }),
      app.request('PATCH', `/employees/${id}/status`, { token: ownerB, body: { status: 'INACTIVE' } }),
      app.request('DELETE', `/employees/${id}`, { token: ownerB }),
      app.request('GET', `/employees/${id}/lists`, { token: ownerB }),
    ]);
    results.forEach((r) => assert.equal(r.status, 404));
    const membership = await prisma.shopEmployeeMembership.findUnique({
      where: { employeeId_shopId: { employeeId: id, shopId: seed.a.shop.id } },
      include: { employee: true },
    });
    assert.equal(membership.status, 'ACTIVE');
    assert.equal(membership.employee.name, 'dave');
  });

  test('owner B cannot track, read or claim Alpha lists or shop', async () => {
    const track = await app.request('POST', `/shop/copy-list/${alphaListId}`, { token: ownerB });
    assert.equal(track.status, 403);
    const read = await app.request('GET', `/lists/${alphaListId}`, { token: ownerB });
    assert.equal(read.status, 404);
    const claim = await app.request('POST', '/shop/assign', { token: ownerB, body: { shopId: seed.a.shop.id } });
    assert.equal(claim.status, 403);
    const ownerBRow = await prisma.customer.findUnique({ where: { id: seed.b.owner.id } });
    assert.equal(ownerBRow.shopId, seed.b.shop.id);
  });

  test('Bravo employee cannot read Alpha lists', async () => {
    const erinToken = (await app.login('erin@shop.test', 'Secret123')).token;
    const read = await app.request('GET', `/lists/${alphaListId}`, { token: erinToken });
    assert.equal(read.status, 404);
    const track = await app.request('POST', `/shop/employee-copy-list/${alphaListId}`, { token: erinToken });
    assert.equal(track.status, 403);
  });

  test('admin customer view cannot be pointed at another customer\'s shop', async () => {
    const res = await app.request('GET', `/admin/customers/${seed.b.owner.id}/employees?shopId=${seed.a.shop.id}`, { token: adminToken });
    assert.equal(res.status, 404);
  });
});

describe('deactivation and stale sessions', () => {
  test('inactive employee loses access on an existing token; lists are kept', async () => {
    const employee = await createShopEmployee(ownerA, 'frank@shop.test');
    const token = (await app.login('frank@shop.test', 'Secret123')).token;
    const list = await app.request('POST', '/lists', { token, body: { name: 'Frank list' } });
    assert.equal(list.status, 201);
    assert.equal((await app.request('GET', '/lists', { token })).status, 200);

    const off = await app.request('PATCH', `/employees/${employee.id}/status`, { token: ownerA, body: { status: 'INACTIVE' } });
    assert.equal(off.status, 200);
    assert.equal(off.body.employee.status, 'INACTIVE');

    const reuse = await app.request('GET', '/lists', { token });
    assert.equal(reuse.status, 401);
    assert.equal(reuse.body.code, 'ACCESS_REVOKED');
    assert.equal((await app.login('frank@shop.test', 'Secret123')).status, 403);

    const stillThere = await prisma.list.findUnique({ where: { id: list.body.id } });
    assert.equal(stillThere.employeeId, employee.id);
    assert.equal(stillThere.shopId, seed.a.shop.id);
    const ownerView = await app.request('GET', '/employees?status=INACTIVE', { token: ownerA });
    const frank = ownerView.body.employees.find((e) => e.id === employee.id);
    assert.equal(frank.lists.length, 1);
    const allLists = await app.request('GET', '/shop/all-lists', { token: ownerA });
    assert.ok(allLists.body.lists.employeeLists.some((l) => l.id === list.body.id));

    const groupChat = await prisma.chatParticipant.findFirst({
      where: { chatId: seed.a.shop.groupChatId, userId: employee.id, userType: 'EMPLOYEE' },
    });
    assert.equal(groupChat, null);

    const on = await app.request('PATCH', `/employees/${employee.id}/status`, { token: ownerA, body: { status: 'ACTIVE' } });
    assert.equal(on.status, 200);
    assert.equal((await app.login('frank@shop.test', 'Secret123')).status, 200);
  });

  test('removing an employee keeps the account and lists but revokes access', async () => {
    const employee = await createShopEmployee(ownerA, 'gina@shop.test');
    const token = (await app.login('gina@shop.test', 'Secret123')).token;
    await app.request('POST', '/lists', { token, body: { name: 'Gina list' } });

    const res = await app.request('DELETE', `/employees/${employee.id}`, { token: ownerA });
    assert.equal(res.status, 200);
    assert.ok(await prisma.empolyee.findUnique({ where: { id: employee.id } }));
    assert.equal(await prisma.list.count({ where: { employeeId: employee.id } }), 1);
    assert.equal((await app.request('GET', '/lists', { token })).status, 401);
    const visible = await app.request('GET', '/employees', { token: ownerA });
    assert.ok(!visible.body.employees.some((e) => e.id === employee.id));
  });

  test('bumping the session version invalidates old tokens', async () => {
    const employee = await createShopEmployee(ownerA, 'hank@shop.test');
    const token = (await app.login('hank@shop.test', 'Secret123')).token;
    assert.equal((await app.request('GET', '/lists', { token })).status, 200);
    await prisma.empolyee.update({ where: { id: employee.id }, data: { sessionVersion: { increment: 1 } } });
    const res = await app.request('GET', '/lists', { token });
    assert.equal(res.status, 401);
    assert.equal(res.body.code, 'SESSION_REVOKED');
    const legacy = jwt.sign({ id: employee.id, email: 'hank@shop.test', userType: 'EMPLOYEE' }, process.env.JWT_SECRET);
    assert.equal((await app.request('GET', '/lists', { token: legacy })).status, 401);
  });
});

describe('single shop role', () => {
  test('the shop manager role no longer exists and only the owner manages employees', async () => {
    const asManager = await app.request('POST', '/employees', {
      token: ownerA,
      body: { name: 'Mia', email: 'mia@shop.test', password: 'Secret123', role: 'MANAGER' },
    });
    assert.equal(asManager.status, 400);
    const withPerm = await app.request('POST', '/employees', {
      token: ownerA,
      body: { name: 'Mia', email: 'mia@shop.test', password: 'Secret123', permissions: ['employees.manage'] },
    });
    assert.equal(withPerm.status, 400);
    assert.equal(await prisma.empolyee.count({ where: { email: 'mia@shop.test' } }), 0);

    // A legacy manager membership grants nothing beyond being an employee.
    const legacy = await createShopEmployee(ownerA, 'legacy-mgr@shop.test');
    await prisma.shopEmployeeMembership.update({
      where: { id: legacy.membershipId },
      data: { role: 'MANAGER', permissions: { push: ['employees.view', 'employees.manage'] } },
    });
    const legacyToken = (await app.login('legacy-mgr@shop.test', 'Secret123')).token;
    assert.equal((await app.request('GET', '/employees', { token: legacyToken })).status, 403);
    const create = await app.request('POST', '/employees', {
      token: legacyToken,
      body: { name: 'Nate', email: 'nate@shop.test', password: 'Secret123' },
    });
    assert.equal(create.status, 403);
  });

  test('a regular shop employee cannot manage employees', async () => {
    await createShopEmployee(ownerA, 'pat@shop.test');
    const token = (await app.login('pat@shop.test', 'Secret123')).token;
    assert.equal((await app.request('GET', '/employees', { token })).status, 403);
    const res = await app.request('POST', '/employees', { token, body: { name: 'Q', email: 'q@shop.test', password: 'Secret123' } });
    assert.equal(res.status, 403);
  });
});

describe('company staff', () => {
  test('staff keep exactly their granted company permissions', async () => {
    await createCompanyStaff(prisma, { email: 'reader@company.test', passwordHash: seed.passwordHash, permissions: ['catalog.read'] });
    const login = await app.login('reader@company.test', seed.password);
    assert.equal(login.status, 200);
    assert.deepEqual(login.body.user.companyAccess.permissions, ['catalog.read']);
    assert.equal(login.body.user.shopAccess, null);
    const token = login.token;

    assert.equal((await app.request('GET', `/getProductById/${seed.product.id}`, { token })).status, 200);
    assert.equal((await app.request('PUT', `/editProduct/${seed.product.id}`, { token, body: { title: 'x' } })).status, 403);
    assert.equal((await app.request('GET', '/admin/customers', { token })).status, 403);
    assert.equal((await app.request('GET', '/getallemploy', { token })).status, 403);
    assert.equal((await app.request('GET', '/admin/list-items', { token })).status, 403);
    assert.equal((await app.request('GET', '/employees', { token })).status, 403);
    assert.equal((await app.request('GET', '/lists', { token })).status, 403);
  });

  test('deactivated company membership revokes existing sessions', async () => {
    const staff = await createCompanyStaff(prisma, { email: 'ops@company.test', passwordHash: seed.passwordHash, permissions: ['list_items.manage'] });
    const token = (await app.login('ops@company.test', seed.password)).token;
    assert.equal((await app.request('GET', '/admin/list-items', { token })).status, 200);

    const res = await app.request('PATCH', `/admin/staff/${staff.id}/status`, { token: adminToken, body: { status: 'INACTIVE' } });
    assert.equal(res.status, 200);
    assert.equal((await app.request('GET', '/admin/list-items', { token })).status, 401);
  });

  test('company staff list contains only company staff', async () => {
    const res = await app.request('GET', '/getallemploy', { token: adminToken });
    assert.equal(res.status, 200);
    const ids = res.body.data.map((s) => s.id);
    const shopOnly = await prisma.empolyee.findMany({ where: { companyMembership: null }, select: { id: true } });
    assert.ok(shopOnly.length > 0);
    shopOnly.forEach(({ id }) => assert.ok(!ids.includes(id)));
    assert.ok(res.body.data.every((s) => s.status && s.permissions));
  });

  test('staff managers cannot grant permissions they do not hold', async () => {
    await createCompanyStaff(prisma, {
      email: 'lead@company.test',
      passwordHash: seed.passwordHash,
      permissions: ['staff.manage', 'catalog.read'],
    });
    const token = (await app.login('lead@company.test', seed.password)).token;
    const res = await app.request('POST', '/addEmployee', {
      token,
      body: { name: 'New', email: 'new@company.test', password: 'Secret123', permissions: ['customers.manage'] },
    });
    assert.equal(res.status, 400);
    const ok = await app.request('POST', '/addEmployee', {
      token,
      body: { name: 'New', email: 'new@company.test', password: 'Secret123', permissions: ['catalog.read'] },
    });
    assert.equal(ok.status, 201);
    assert.deepEqual(ok.body.employee.permissions, ['catalog.read']);
  });
});

describe('dual membership', () => {
  test('company and shop permissions are checked independently', async () => {
    const shopEmployee = await createShopEmployee(ownerA, 'quinn@shop.test');
    const grant = await app.request('POST', '/admin/staff/grant', {
      token: adminToken,
      body: { employeeId: shopEmployee.id, permissions: ['catalog.read'] },
    });
    assert.equal(grant.status, 200);

    let token = (await app.login('quinn@shop.test', 'Secret123')).token;
    assert.equal((await app.request('GET', `/getProductById/${seed.product.id}`, { token })).status, 200);
    assert.equal((await app.request('GET', '/lists', { token })).status, 200);
    assert.equal((await app.request('GET', '/admin/customers', { token })).status, 403);

    // Shop deactivation leaves company access intact.
    await app.request('PATCH', `/employees/${shopEmployee.id}/status`, { token: ownerA, body: { status: 'INACTIVE' } });
    assert.equal((await app.request('GET', '/lists', { token })).status, 403);
    assert.equal((await app.request('GET', `/getProductById/${seed.product.id}`, { token })).status, 200);
    const me = await app.request('GET', '/auth/me', { token });
    assert.equal(me.body.user.shopAccess, null);
    assert.ok(me.body.user.companyAccess);

    // Shop owner cannot change credentials of an account that also holds company access.
    await app.request('PATCH', `/employees/${shopEmployee.id}/status`, { token: ownerA, body: { status: 'ACTIVE' } });
    const pw = await app.request('PUT', `/employees/${shopEmployee.id}`, { token: ownerA, body: { password: 'Changed123' } });
    assert.equal(pw.status, 403);

    // Company revocation leaves shop access intact.
    await app.request('DELETE', `/deleteEmployee/${shopEmployee.id}`, { token: adminToken });
    token = (await app.login('quinn@shop.test', 'Secret123')).token;
    assert.equal((await app.request('GET', '/lists', { token })).status, 200);
    assert.equal((await app.request('GET', `/getProductById/${seed.product.id}`, { token })).status, 403);
    assert.ok(await prisma.shopEmployeeMembership.findFirst({ where: { employeeId: shopEmployee.id, status: 'ACTIVE' } }));
  });

  test('a shop owner cannot attach an existing company staff account to their shop', async () => {
    await createCompanyStaff(prisma, { email: 'ray@company.test', passwordHash: seed.passwordHash, permissions: ['catalog.read'] });
    const res = await app.request('POST', '/employees', {
      token: ownerB,
      body: { name: 'Ray', email: 'ray@company.test', password: 'Secret123' },
    });
    assert.equal(res.status, 400);
    const ray = await prisma.empolyee.findUnique({ where: { email: 'ray@company.test' }, include: { shopMemberships: true } });
    assert.equal(ray.shopMemberships.length, 0);
  });
});

describe('Customers → Customer details → Employees', () => {
  test('shows the customer\'s shop employees, status counts and their lists', async () => {
    const res = await app.request('GET', `/admin/customers/${seed.a.owner.id}/employees`, { token: adminToken });
    assert.equal(res.status, 200);
    const { shops, counts } = res.body.data;
    assert.equal(shops.length, 1);
    assert.equal(shops[0].shop.id, seed.a.shop.id);

    const dbCounts = await prisma.shopEmployeeMembership.groupBy({ by: ['status'], where: { shopId: seed.a.shop.id }, _count: { _all: true } });
    for (const row of dbCounts) assert.equal(counts[row.status], row._count._all);
    assert.equal(counts.total, dbCounts.reduce((s, r) => s + r._count._all, 0));

    const employees = shops[0].employees;
    assert.ok(employees.every((e) => e.shopId === seed.a.shop.id && e.email && e.role && e.status));
    assert.ok(!employees.some((e) => e.email === 'erin@shop.test'));
    const dave = employees.find((e) => e.email === 'dave@shop.test');
    assert.equal(dave.lists.length, 1);
    assert.equal(dave.lists[0].name, 'Alpha restock');

    const list = await app.request('GET', `/admin/lists/${dave.lists[0].id}`, { token: adminToken });
    assert.equal(list.status, 200);
    assert.equal(list.body.data.shop.id, seed.a.shop.id);

    const statusFiltered = await app.request('GET', `/admin/customers/${seed.a.owner.id}/employees?status=INACTIVE`, { token: adminToken });
    assert.ok(statusFiltered.body.data.shops[0].employees.every((e) => e.status === 'INACTIVE'));
  });

  test('viewing customer employees grants them no company access', async () => {
    const before = await prisma.companyStaffMembership.count();
    await app.request('GET', `/admin/customers/${seed.a.owner.id}/employees`, { token: adminToken });
    assert.equal(await prisma.companyStaffMembership.count(), before);
    const token = (await app.login('dave@shop.test', 'Secret123')).token;
    assert.equal((await app.request('GET', '/admin/customers', { token })).status, 403);
  });
});

describe('realtime shop rooms', () => {
  test('only members/owner of a shop may join its list room', async () => {
    const { canAccessShop } = await import('../src/services/accessControl.js');
    const dave = await prisma.empolyee.findUnique({ where: { email: 'dave@shop.test' } });
    const daveClaims = { id: dave.id, userType: 'EMPLOYEE', sv: dave.sessionVersion };
    assert.equal(await canAccessShop(daveClaims, seed.a.shop.id), true);
    assert.equal(await canAccessShop(daveClaims, seed.b.shop.id), false);
    assert.equal(await canAccessShop({ id: seed.b.owner.id, userType: 'CUSTOMER' }, seed.a.shop.id), false);
    assert.equal(await canAccessShop(null, seed.a.shop.id), false);
  });
});
