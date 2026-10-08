// End-to-end checks for features that depend on employee records: chats (REST + sockets),
// tasks, lists, notifications and employee selectors, across two shops and company staff.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createCompanyStaff, getPrisma, resetDatabase, seedBase, startApp } from './helpers/harness.js';

let prisma;
let app;
let seed;
const T = {};
const E = {};

const waitFor = async (predicate, ms = 1500) => {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return predicate();
};
const got = (socket, event) => socket.received.filter((r) => r.event === event);

before(async () => {
  await resetDatabase();
  prisma = await getPrisma();
  seed = await seedBase(prisma);
  app = await startApp();

  T.ownerA = (await app.login('alpha-owner@shop.test', seed.password)).token;
  T.ownerB = (await app.login('bravo-owner@shop.test', seed.password)).token;
  T.admin = (await app.login('admin@company.test', seed.password)).token;

  // First employee gets id 1, colliding with customer id 1 (owner A) on purpose.
  for (const [key, owner, email] of [['a1', T.ownerA, 'a1@shop.test'], ['a2', T.ownerA, 'a2@shop.test'], ['b1', T.ownerB, 'b1@shop.test']]) {
    const res = await app.request('POST', '/employees', { token: owner, body: { name: key.toUpperCase(), email, password: 'Secret123' } });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    E[key] = res.body.employee;
    T[key] = (await app.login(email, 'Secret123')).token;
  }
  assert.equal(E.a1.id, seed.a.owner.id, 'test relies on an employee/customer id collision');

  await createCompanyStaff(prisma, { email: 'support@company.test', passwordHash: seed.passwordHash, permissions: ['catalog.read'] });
  T.staff = (await app.login('support@company.test', seed.password)).token;

  // Pre-existing history that must survive membership changes.
  const allChat = await prisma.chat.create({ data: { name: 'ALL Chat', type: 'GROUP' } });
  T.allChatId = allChat.id;
  const personal = await prisma.chat.create({
    data: {
      type: 'PERSONAL',
      participants: { create: [{ userId: seed.a.owner.id, userType: 'CUSTOMER' }, { userId: E.a1.id, userType: 'EMPLOYEE' }] },
      messages: { create: [{ content: 'old hello', senderId: seed.a.owner.id, senderType: 'CUSTOMER' }] },
    },
  });
  T.personalChatId = personal.id;
});

after(async () => {
  await app?.close();
  await prisma?.$disconnect();
});

describe('chats', () => {
  test('shop employees use their own shop group chat but not another shop\'s', async () => {
    const chats = await app.request('GET', '/chat', { token: T.a1 });
    assert.equal(chats.status, 200);
    assert.ok(chats.body.chats.some((c) => c.id === seed.a.shop.groupChatId));
    assert.ok(!chats.body.chats.some((c) => c.id === seed.b.shop.groupChatId));

    assert.equal((await app.request('GET', `/chat/${seed.a.shop.groupChatId}`, { token: T.a1 })).status, 200);
    const sent = await app.request('POST', '/chat/message', { token: T.a1, body: { chatId: seed.a.shop.groupChatId, content: 'hi team' } });
    assert.equal(sent.status, 201);

    assert.equal((await app.request('GET', `/chat/${seed.a.shop.groupChatId}`, { token: T.b1 })).status, 403);
    const intrude = await app.request('POST', '/chat/message', { token: T.b1, body: { chatId: seed.a.shop.groupChatId, content: 'sneaky' } });
    assert.equal(intrude.status, 403);
    assert.equal(await prisma.chatParticipant.count({ where: { chatId: seed.a.shop.groupChatId, userId: E.b1.id, userType: 'EMPLOYEE' } }), 0);
    assert.equal((await app.request('GET', `/chat/${T.personalChatId}`, { token: T.b1 })).status, 403);
    assert.equal((await app.request('GET', `/chat/${T.personalChatId}`, { token: T.ownerB })).status, 403);
  });

  test('existing conversations still load and accept messages', async () => {
    const thread = await app.request('GET', `/chat/${T.personalChatId}`, { token: T.a1 });
    assert.equal(thread.status, 200);
    assert.ok(thread.body.chat.messages.some((m) => m.content === 'old hello'));
    const reply = await app.request('POST', '/chat/message', { token: T.a1, body: { chatId: T.personalChatId, content: 'still here' } });
    assert.equal(reply.status, 201);
    const global = await app.request('POST', '/chat/message', { token: T.b1, body: { chatId: T.allChatId, content: 'hello all' } });
    assert.equal(global.status, 201);
  });

  test('chat user selectors are scoped: owner sees own shop employees, company staff can reach customers for support', async () => {
    const ownerUsers = await app.request('GET', '/chat/users', { token: T.ownerA });
    const ownerEmployees = ownerUsers.body.users.filter((u) => u.userType === 'EMPLOYEE').map((u) => Number(u.id));
    assert.deepEqual(ownerEmployees.sort(), [E.a1.id, E.a2.id].sort());
    assert.ok(ownerUsers.body.users.some((u) => u.userType === 'ADMIN'), 'customers can still reach company admins');

    const employeeUsers = await app.request('GET', '/chat/users', { token: T.a1 });
    assert.deepEqual(employeeUsers.body.users.map((u) => [u.userType, Number(u.id)]), [['CUSTOMER', seed.a.owner.id]]);

    const staffUsers = await app.request('GET', '/chat/users', { token: T.staff });
    const staffCustomers = staffUsers.body.users.filter((u) => u.userType === 'CUSTOMER').map((u) => Number(u.id));
    assert.ok(staffCustomers.includes(seed.a.owner.id) && staffCustomers.includes(seed.b.owner.id));

    const support = await app.request('POST', '/chat', {
      token: T.staff,
      body: { type: 'PERSONAL', participantIds: [{ userId: seed.b.owner.id, userType: 'CUSTOMER' }] },
    });
    assert.equal(support.status, 201);
    const answer = await app.request('POST', '/chat/message', { token: T.ownerB, body: { chatId: support.body.chat.id, content: 'thanks' } });
    assert.equal(answer.status, 201);
  });

  test('sockets: rooms are authorized and per-user events do not leak across account types', async () => {
    const a1 = await app.connectSocket(T.a1);
    const b1 = await app.connectSocket(T.b1);
    const ownerA = await app.connectSocket(T.ownerA);
    const anon = await app.connectSocket(null);

    b1.emit('join_chat', seed.a.shop.groupChatId);
    a1.emit('join_chat', seed.a.shop.groupChatId);
    anon.emit('join_chat', seed.a.shop.groupChatId);
    b1.emit('join_user_room', seed.a.owner.id);
    anon.emit('join_user_room', E.a1.id);
    assert.ok(await waitFor(() => got(b1, 'chat_join_denied').length === 1));
    assert.ok(await waitFor(() => got(anon, 'chat_join_denied').length === 1));

    const sent = await app.request('POST', '/chat/message', { token: T.ownerA, body: { chatId: seed.a.shop.groupChatId, content: 'live' } });
    assert.equal(sent.status, 201);
    assert.ok(await waitFor(() => got(a1, 'message_received').some((m) => m.payload.content === 'live')));
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(got(b1, 'message_received').filter((m) => m.payload.content === 'live').length, 0);
    assert.equal(got(anon, 'message_received').length, 0);

    // Employee 1 and customer 1 share a numeric id; a task for the employee must not reach the owner.
    const task = await app.request('POST', '/tasks', { token: T.ownerA, body: { title: 'Count stock', employeeIds: [E.a1.id] } });
    assert.equal(task.status, 201);
    assert.ok(await waitFor(() => got(a1, 'task_assigned').length === 1));
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(got(ownerA, 'task_assigned').length, 0);
    assert.equal(got(b1, 'task_assigned').length, 0);
    assert.equal(got(anon, 'task_assigned').length, 0);

    b1.emit('join_shop_lists', seed.a.shop.id);
    assert.ok(await waitFor(() => got(b1, 'shop_lists_denied').length === 1));
  });
});

describe('tasks', () => {
  let taskId;
  let assignmentId;

  test('owner assigns only own active shop employees; employee works the task', async () => {
    const foreign = await app.request('POST', '/tasks', { token: T.ownerA, body: { title: 'x', employeeIds: [E.b1.id] } });
    assert.equal(foreign.status, 400);

    const created = await app.request('POST', '/tasks', { token: T.ownerA, body: { title: 'Restock', employeeIds: [E.a1.id, E.a2.id] } });
    assert.equal(created.status, 201);
    taskId = created.body.task.id;

    const mine = await app.request('GET', '/tasks/my-tasks', { token: T.a1 });
    const entry = mine.body.tasks.find((t) => t.id === taskId);
    assignmentId = entry.assignmentId;
    assert.equal((await app.request('PUT', `/tasks/start/${assignmentId}`, { token: T.a1, body: { isStarted: true } })).status, 200);
    assert.equal((await app.request('PUT', `/tasks/complete/${assignmentId}`, { token: T.a1, body: { isCompleted: true } })).status, 200);

    assert.equal((await app.request('PUT', `/tasks/complete/${assignmentId}`, { token: T.b1, body: { isCompleted: false } })).status, 404);
    assert.equal((await app.request('GET', '/tasks', { token: T.ownerB })).body.tasks?.some((t) => t.id === taskId) ?? false, false);
  });

  test('editing a task keeps existing assignments and their progress, including deactivated employees', async () => {
    const off = await app.request('PATCH', `/employees/${E.a1.id}/status`, { token: T.ownerA, body: { status: 'INACTIVE' } });
    assert.equal(off.status, 200);

    const edit = await app.request('PUT', `/tasks/${taskId}`, { token: T.ownerA, body: { title: 'Restock aisle 3', employeeIds: [E.a1.id, E.a2.id] } });
    assert.equal(edit.status, 200, JSON.stringify(edit.body));
    const kept = await prisma.taskAssignment.findUnique({ where: { id: assignmentId } });
    assert.equal(kept.isCompleted, true);

    const addInactive = await app.request('POST', '/tasks', { token: T.ownerA, body: { title: 'y', employeeIds: [E.a1.id] } });
    assert.equal(addInactive.status, 400);

    const removeA2 = await app.request('PUT', `/tasks/${taskId}`, { token: T.ownerA, body: { employeeIds: [E.a1.id] } });
    assert.equal(removeA2.status, 200);
    assert.deepEqual((await prisma.taskAssignment.findMany({ where: { taskId } })).map((a) => a.employeeId), [E.a1.id]);
  });
});

describe('deactivation side effects', () => {
  test('deactivated employee leaves the shop chat, notifications and selectors; history is kept; reactivation restores', async () => {
    // a1 was deactivated above.
    assert.equal((await app.login('a1@shop.test', 'Secret123')).status, 403);
    assert.equal(await prisma.chatParticipant.count({ where: { chatId: seed.a.shop.groupChatId, userId: E.a1.id, userType: 'EMPLOYEE' } }), 0);
    assert.ok(await prisma.message.count({ where: { senderId: E.a1.id, senderType: 'EMPLOYEE' } }) >= 2, 'messages kept');

    const { default: expiry } = await import('../src/services/expiryNotificationService.js');
    const recipients = await expiry.getShopRecipients(seed.a.shop.id);
    const employeeRecipients = recipients.filter((r) => r.userType === 'EMPLOYEE').map((r) => r.userId);
    assert.deepEqual(employeeRecipients, [E.a2.id]);

    const ownerUsers = await app.request('GET', '/chat/users', { token: T.ownerA });
    assert.ok(!ownerUsers.body.users.some((u) => u.userType === 'EMPLOYEE' && Number(u.id) === E.a1.id));
    const ownerView = await app.request('GET', '/employees', { token: T.ownerA });
    assert.equal(ownerView.body.employees.find((e) => e.id === E.a1.id).status, 'INACTIVE');
    assert.equal(ownerView.body.counts.INACTIVE, 1);

    const on = await app.request('PATCH', `/employees/${E.a1.id}/status`, { token: T.ownerA, body: { status: 'ACTIVE' } });
    assert.equal(on.status, 200);
    const relog = await app.login('a1@shop.test', 'Secret123');
    assert.equal(relog.status, 200);
    T.a1 = relog.token;
    assert.equal((await app.request('GET', `/chat/${seed.a.shop.groupChatId}`, { token: T.a1 })).status, 200);
    assert.equal(await prisma.chatParticipant.count({ where: { chatId: seed.a.shop.groupChatId, userId: E.a1.id, userType: 'EMPLOYEE' } }), 1);
    const mine = await app.request('GET', '/tasks/my-tasks', { token: T.a1 });
    assert.ok(mine.body.tasks.some((t) => t.isCompleted));
  });

  test('status survives a refresh and failed actions report errors', async () => {
    const refreshed = await app.request('GET', '/employees', { token: T.ownerA });
    assert.equal(refreshed.body.employees.find((e) => e.id === E.a1.id).status, 'ACTIVE');
    const bad = await app.request('PATCH', `/employees/${E.a1.id}/status`, { token: T.ownerA, body: { status: 'SUPERUSER' } });
    assert.equal(bad.status, 400);
    assert.ok(bad.body.error);
    const other = await app.request('PATCH', `/employees/${E.b1.id}/status`, { token: T.ownerA, body: { status: 'INACTIVE' } });
    assert.equal(other.status, 404);
    const b1 = await prisma.shopEmployeeMembership.findFirst({ where: { employeeId: E.b1.id } });
    assert.equal(b1.status, 'ACTIVE');
  });

  test('lists stay with their shop and creator', async () => {
    const list = await app.request('POST', '/lists', { token: T.a1, body: { name: 'A1 list' } });
    assert.equal(list.status, 201);
    const ownerLists = await app.request('GET', '/shop/all-lists', { token: T.ownerA });
    assert.ok(ownerLists.body.lists.employeeLists.some((l) => l.id === list.body.id && l.employee.id === E.a1.id));
    const otherOwner = await app.request('GET', '/shop/all-lists', { token: T.ownerB });
    assert.ok(!otherOwner.body.lists.all.some((l) => l.id === list.body.id));
    const shopLists = await app.request('GET', '/lists/shop/all', { token: T.a2 });
    assert.ok(shopLists.body.lists.some((l) => l.id === list.body.id));
    assert.equal((await app.request('GET', '/lists/shop/all', { token: T.b1 })).body.lists.some((l) => l.id === list.body.id), false);
  });
});

describe('per-tool shop access (read / write / edit)', () => {
  const LISTS_FULL = ['feature.lists', 'feature.lists.write', 'feature.lists.edit'];

  test('owner switches tools and access levels for one employee; API and notifications follow', async () => {
    const restricted = await app.request('PUT', `/employees/${E.a2.id}`, {
      token: T.ownerA,
      body: { permissions: ['feature.lists'] },
    });
    assert.equal(restricted.status, 200, JSON.stringify(restricted.body));
    assert.deepEqual(restricted.body.employee.permissions, ['feature.lists']);

    // Read only: can view lists but not create or change them.
    assert.equal((await app.request('GET', '/lists', { token: T.a2 })).status, 200);
    const create = await app.request('POST', '/lists', { token: T.a2, body: { name: 'nope' } });
    assert.equal(create.status, 403);
    assert.equal(create.body.level, 'write');
    const tasks = await app.request('GET', '/tasks/my-tasks', { token: T.a2 });
    assert.equal(tasks.status, 403);
    assert.equal(tasks.body.code, 'SHOP_FEATURE_DISABLED');
    const assign = await app.request('POST', '/tasks', { token: T.ownerA, body: { title: 'z', employeeIds: [E.a2.id] } });
    assert.equal(assign.status, 400);
    const me = await app.request('GET', '/auth/me', { token: T.a2 });
    assert.deepEqual(me.body.user.shopAccess.permissions, ['feature.lists']);

    const { default: expiry } = await import('../src/services/expiryNotificationService.js');
    const recipients = await expiry.getShopRecipients(seed.a.shop.id);
    assert.ok(!recipients.some((r) => r.userType === 'EMPLOYEE' && r.userId === E.a2.id));

    // Write implies read; without edit, existing records cannot be changed.
    const writer = await app.request('PUT', `/employees/${E.a2.id}`, { token: T.ownerA, body: { permissions: ['feature.lists.write'] } });
    assert.deepEqual(writer.body.employee.permissions, ['feature.lists', 'feature.lists.write']);
    const created = await app.request('POST', '/lists', { token: T.a2, body: { name: 'Draft' } });
    assert.equal(created.status, 201);
    const rename = await app.request('PUT', `/lists/${created.body.id}/rename`, { token: T.a2, body: { name: 'Renamed' } });
    assert.equal(rename.status, 403);
    assert.equal(rename.body.level, 'edit');

    // Editing details keeps the custom access; the manager role is gone.
    await app.request('PUT', `/employees/${E.a2.id}`, { token: T.ownerA, body: { name: 'A2 renamed', role: 'EMPLOYEE' } });
    const kept = await prisma.shopEmployeeMembership.findFirst({ where: { employeeId: E.a2.id } });
    assert.deepEqual(kept.permissions, ['feature.lists', 'feature.lists.write']);
    const manager = await app.request('PUT', `/employees/${E.a2.id}`, { token: T.ownerA, body: { role: 'MANAGER' } });
    assert.equal(manager.status, 400);

    const restored = await app.request('PUT', `/employees/${E.a2.id}`, {
      token: T.ownerA,
      body: { permissions: [...LISTS_FULL, 'feature.tasks', 'feature.tasks.write', 'feature.expiry'] },
    });
    assert.equal(restored.status, 200);
    assert.equal((await app.request('GET', '/tasks/my-tasks', { token: T.a2 })).status, 200);
    assert.equal((await app.request('PUT', `/lists/${created.body.id}/rename`, { token: T.a2, body: { name: 'Renamed' } })).status, 200);
  });

  test('task progress needs write access, not edit', async () => {
    const task = await app.request('POST', '/tasks', { token: T.ownerA, body: { title: 'Face up', employeeIds: [E.a2.id] } });
    assert.equal(task.status, 201);
    const mine = await app.request('GET', '/tasks/my-tasks', { token: T.a2 });
    const { assignmentId } = mine.body.tasks.find((t) => t.id === task.body.task.id);
    assert.equal((await app.request('PUT', `/tasks/complete/${assignmentId}`, { token: T.a2, body: { isCompleted: true } })).status, 200);

    const forEmployee = await app.request('GET', `/tasks?employeeId=${E.a2.id}`, { token: T.ownerA });
    const row = forEmployee.body.tasks.find((t) => t.id === task.body.task.id);
    assert.equal(row.assignments[0].isCompleted, true);
    assert.equal(typeof row.assignments[0].isStarted, 'boolean');
  });
});

describe('employee lists: owner views, copies and stays in sync', () => {
  test('owner opens an employee list, copies it, and sees new items live', async () => {
    const created = await app.request('POST', '/lists', { token: T.a2, body: { name: 'Weekly restock' } });
    assert.equal(created.status, 201);
    const listId = created.body.id;

    const employeeLists = await app.request('GET', `/employees/${E.a2.id}/lists`, { token: T.ownerA });
    assert.equal(employeeLists.status, 200);
    const summary = employeeLists.body.lists.find((l) => l.id === listId);
    assert.deepEqual([summary.name, summary.itemCount, summary.copiedByMe], ['Weekly restock', 0, false]);

    // Readable before copying, but not changeable.
    const preview = await app.request('GET', `/lists/${listId}`, { token: T.ownerA });
    assert.equal(preview.status, 200);
    assert.deepEqual([preview.body.createdByName, preview.body.copiedByMe, preview.body.canEdit], ['A2 renamed', false, false]);
    const sneaky = await app.request('POST', '/lists/addProduct', { token: T.ownerA, body: { listId, productId: seed.product.id } });
    assert.equal(sneaky.status, 403);
    assert.equal((await app.request('GET', `/lists/${listId}`, { token: T.ownerB })).status, 404);

    await app.request('GET', '/lists', { token: T.ownerA }); // warm the owner's list cache
    const copy = await app.request('POST', `/shop/copy-list/${listId}`, { token: T.ownerA });
    assert.equal(copy.status, 200);
    const mine = (await app.request('GET', '/lists', { token: T.ownerA })).body.lists.find((l) => l.id === listId);
    assert.deepEqual([mine.name, mine.copiedFromName, mine.isShared, mine.itemCount], ['Weekly restock', 'A2 renamed', true, 0]);
    const again = await app.request('POST', `/shop/copy-list/${listId}`, { token: T.ownerA });
    assert.equal(again.body.alreadyTracked, true);
    assert.equal(await prisma.list.count({ where: { name: 'Weekly restock' } }), 1, 'copy stays one shared list');

    const me = await app.request('GET', '/auth/me', { token: T.ownerA });
    assert.equal(me.body.user.shopId, seed.a.shop.id, 'owner needs shopId to join the live list room');
    const ownerSocket = await app.connectSocket(T.ownerA);
    const otherOwner = await app.connectSocket(T.ownerB);
    ownerSocket.emit('join_shop_lists', me.body.user.shopId);
    otherOwner.emit('join_shop_lists', seed.b.shop.id);
    await new Promise((r) => setTimeout(r, 300));

    const add = await app.request('POST', '/lists/addProduct', { token: T.a2, body: { listId, productId: seed.product.id } });
    assert.equal(add.status, 200, JSON.stringify(add.body));
    assert.ok(await waitFor(() => got(ownerSocket, 'list_product_added').some((e) => e.payload.listId === listId)));
    assert.equal(got(otherOwner, 'list_product_added').length, 0);

    const refreshed = (await app.request('GET', '/lists', { token: T.ownerA })).body.lists.find((l) => l.id === listId);
    assert.equal(refreshed.itemCount, 1, 'copied list count is not served stale from cache');
    const detail = await app.request('GET', `/lists/${listId}`, { token: T.ownerA });
    assert.equal(detail.body.products.length, 1);
    assert.deepEqual([detail.body.copiedByMe, detail.body.canEdit], [true, true]);
    const after = await app.request('GET', `/employees/${E.a2.id}/lists`, { token: T.ownerA });
    const updated = after.body.lists.find((l) => l.id === listId);
    assert.deepEqual([updated.itemCount, updated.copiedByMe], [1, true]);
  });
});

describe('company views', () => {
  test('company staff page never lists shop employees; customer details lists them per shop', async () => {
    const staff = await app.request('GET', '/getallemploy', { token: T.admin });
    const ids = staff.body.data.map((s) => s.id);
    for (const e of Object.values(E)) assert.ok(!ids.includes(e.id));
    assert.equal(await prisma.companyStaffMembership.count({ where: { employeeId: { in: Object.values(E).map((e) => e.id) } } }), 0);

    const details = await app.request('GET', `/admin/customers/${seed.a.owner.id}/employees`, { token: T.admin });
    assert.equal(details.status, 200);
    const emails = details.body.data.shops[0].employees.map((e) => e.email).sort();
    assert.deepEqual(emails, ['a1@shop.test', 'a2@shop.test']);
    assert.equal(details.body.data.counts.ACTIVE, 2);

    const staffAdd = await app.request('POST', '/addEmployee', {
      token: T.admin,
      body: { name: 'Ops', email: 'ops2@company.test', password: 'Secret123', permissions: ['catalog.read'] },
    });
    assert.equal(staffAdd.status, 201);
    const after = await app.request('GET', '/getallemploy', { token: T.admin });
    assert.ok(after.body.data.some((s) => s.email === 'ops2@company.test'));
  });
});
