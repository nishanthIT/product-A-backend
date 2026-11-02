import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { getPrisma, resetDatabase, seedBase, startApp, createCompanyStaff } from './helpers/harness.js';

let db, app, seed, owner, staff, peer, outsider, company, supplier, admin, dm;
const waitFor = async predicate => {
  for (let n = 0; n < 100; n++) { if (predicate()) return; await delay(20); }
  assert.fail('Expected socket event did not arrive');
};
before(async () => {
  await resetDatabase(); db = await getPrisma(); seed = await seedBase(db); app = await startApp();
  const employee = async (label, shops, companyRole = false) => {
    const user = await createCompanyStaff(db, { email: `${label}@isolation.test`, passwordHash: seed.passwordHash, permissions: ['content.manage'] });
    if (!companyRole) await db.companyStaffMembership.delete({ where: { employeeId: user.id } });
    for (const shop of shops) await db.shopEmployeeMembership.create({ data: { employeeId: user.id, shopId: shop.id, status: 'ACTIVE', permissions: [] } });
    return { ...user, token: (await app.login(user.email, seed.password)).token };
  };
  staff = await employee('employee', [seed.a.shop, seed.b.shop]);
  peer = await employee('peer', [seed.a.shop], true); // Explicit shop grant permits a company employee.
  outsider = await employee('other-shop', [seed.b.shop]);
  company = await employee('company-only', [], true);
  const supplierUser = await db.customer.create({ data: { name: 'Supplier', email: 'supplier@isolation.test', mobile: 'supplier', password: seed.passwordHash, shopId: seed.wholesale.id } });
  supplier = { ...supplierUser, token: (await app.login(supplierUser.email, seed.password)).token };
  owner = (await app.login(seed.a.owner.email, seed.password)).token;
  admin = (await app.login(seed.admin.email, seed.password)).token;
});
after(async () => { await app?.close(); await db?.$disconnect(); });
const request = (method, route, token, body, shopId = seed.a.shop.id) => app.request(method, route, { token, body, shopId });
const create = (token, target, shopId) => request('POST', '/chat', token, { type: 'PERSONAL', participantIds: [{ userId: target.id, userType: target.userType }] }, shopId);
const send = (token, chatId, content, shopId) => request('POST', '/chat/message', token, { chatId, content }, shopId);

test('retail directory spans shops while private team participants stay within the selected shop', async () => {
  for (const token of [owner, staff.token, peer.token]) {
    const users = await request('GET', '/chat/users', token);
    assert.equal(users.status, 200);
    const eligible = new Set([`CUSTOMER:${seed.a.owner.id}`, `EMPLOYEE:${staff.id}`, `EMPLOYEE:${peer.id}`]);
    const retail = new Set([...eligible, `CUSTOMER:${seed.b.owner.id}`, `EMPLOYEE:${outsider.id}`]);
    assert.equal(users.body.users.length, 4);
    assert.ok(users.body.users.every(u => retail.has(`${u.userType}:${u.id}`)));
    const chats = await request('GET', '/chat', token);
    assert.deepEqual(chats.body.chats.map(c => c.id), [seed.a.shop.groupChatId]);
    assert.equal(chats.body.chats[0].isTeamChat, true);
    const thread = await request('GET', `/chat/${seed.a.shop.groupChatId}`, token);
    assert.equal(thread.body.chat.participantCount, 3);
    assert.ok(thread.body.chat.participants.every(p => eligible.has(`${p.userType}:${p.id}`)));
  }
  for (const term of ['supplier', 'company-only']) assert.deepEqual((await request('GET', `/chat/users?search=${term}`, owner)).body.users, []);
  assert.deepEqual((await request('GET', '/chat/users?search=PEER', staff.token)).body.users.map(u => Number(u.id)), [peer.id]);
  for (const token of [supplier.token, company.token, admin, outsider.token]) {
    assert.equal((await request('GET', '/chat/users', token)).status, 403);
    assert.deepEqual((await request('GET', '/chat', token)).body.chats ?? [], []);
    assert.equal((await request('GET', `/chat/${seed.a.shop.groupChatId}`, token)).status, 403);
  }
});

test('simultaneous and reverse employee DMs reuse one conversation; messages and socket replies survive reopening', async () => {
  const responses = await Promise.all([create(staff.token, peer), create(peer.token, staff), create(staff.token, peer)]);
  assert.deepEqual(responses.map(r => r.status).sort(), [200, 200, 201]);
  assert.equal(new Set(responses.map(r => r.body.chat.id)).size, 1);
  dm = responses[0].body.chat;
  assert.equal(dm.shopId, null); assert.equal(dm.isCommunityChat, true);
  const left = await app.connectSocket(staff.token, seed.a.shop.id), right = await app.connectSocket(peer.token, seed.a.shop.id);
  left.emit('join_chat', dm.id); right.emit('join_chat', dm.id); await delay(100);
  const first = await send(staff.token, dm.id, 'Employee says hello'); assert.equal(first.status, 201);
  await waitFor(() => right.received.some(e => e.event === 'message_received' && e.payload.id === first.body.message.id));
  const reply = await send(peer.token, dm.id, 'Peer replies'); assert.equal(reply.status, 201);
  await waitFor(() => left.received.some(e => e.event === 'message_received' && e.payload.id === reply.body.message.id));
  const reopened = await create(peer.token, staff); assert.equal(reopened.body.chat.id, dm.id);
  const history = await request('GET', `/chat/${dm.id}`, staff.token);
  assert.deepEqual(history.body.chat.messages.map(m => m.content).sort(), ['Employee says hello', 'Peer replies']);
  assert.equal((await request('POST', '/chat/read', staff.token, { messageIds: [reply.body.message.id] })).status, 200);
  assert.equal((await request('GET', '/chat', staff.token)).body.chats.find(c => c.id === dm.id).unreadCount, 0);
});

test('forged identities, supplier/company targets, other shops and malformed DMs cannot bypass eligibility', async () => {
  for (const target of [company, supplier, { id: seed.admin.id, userType: 'ADMIN' }, { id: staff.id, userType: 'SUPPLIER' }, { id: 99999, userType: 'EMPLOYEE' }]) {
    assert.ok([400, 403].includes((await create(staff.token, target)).status));
  }
  for (const token of [outsider.token, company.token, supplier.token, admin]) assert.equal((await create(token, staff)).status, 403);
  for (const participantIds of [[], [{ userId: staff.id, userType: 'EMPLOYEE' }], [{ userId: peer.id, userType: 'EMPLOYEE' }, { userId: seed.a.owner.id, userType: 'CUSTOMER' }]]) {
    assert.equal((await request('POST', '/chat', staff.token, { type: 'PERSONAL', participantIds })).status, 400);
  }
  assert.equal((await request('POST', '/chat', staff.token, { type: 'GROUP', participantIds: [] })).status, 400);
  // Retail direct participants retain their own DM when selecting another authorized shop.
  assert.equal((await request('GET', `/chat/${dm.id}`, staff.token, undefined, seed.b.shop.id)).status, 200);
  const message = await db.message.findFirst({ where: { chatId: dm.id } });
  for (const token of [outsider.token, company.token, supplier.token, admin]) {
    assert.equal((await request('GET', `/chat/${dm.id}`, token)).status, 403);
    assert.equal((await send(token, dm.id, 'forged access')).status, 403);
    assert.equal((await request('POST', '/chat/read', token, { messageIds: [message.id] })).status, 403);
    assert.equal((await request('DELETE', `/chat/message/${message.id}`, token)).status, 403);
    assert.equal((await request('DELETE', `/chat/${dm.id}`, token)).status, 403);
  }
  assert.equal(await db.message.count({ where: { chatId: dm.id } }), 2);
});

test('stale participants and joined sockets lose read, typing and send access after membership revocation', async () => {
  const stale = await app.connectSocket(peer.token, seed.a.shop.id);
  const otherShopDevice = await app.connectSocket(staff.token, seed.b.shop.id);
  stale.emit('join_chat', seed.a.shop.groupChatId);
  otherShopDevice.emit('join_chat', seed.a.shop.groupChatId);
  await waitFor(() => otherShopDevice.received.some(e => e.event === 'chat_join_denied'));
  await db.chatParticipant.create({ data: { chatId: seed.a.shop.groupChatId, userId: peer.id, userType: 'EMPLOYEE' } });
  await db.shopEmployeeMembership.updateMany({ where: { employeeId: peer.id, shopId: seed.a.shop.id }, data: { status: 'INACTIVE' } });
  const result = await send(owner, seed.a.shop.groupChatId, 'Private after removal'); assert.equal(result.status, 201);
  await waitFor(() => stale.received.some(e => e.event === 'chat_join_denied'));
  assert.ok([stale, otherShopDevice].every(s => !s.received.some(e => e.event === 'message_received')));
  for (const token of [staff.token, peer.token]) assert.equal((await request('GET', `/chat/${dm.id}`, token)).status, 403);
  stale.emit('typing_start', { chatId: seed.a.shop.groupChatId }); await delay(60);
  assert.equal((await send(peer.token, seed.a.shop.groupChatId, 'stale participant')).status, 403);
  assert.equal(await db.message.count({ where: { chatId: dm.id } }), 2);
  await db.shopEmployeeMembership.updateMany({ where: { employeeId: peer.id, shopId: seed.a.shop.id }, data: { status: 'ACTIVE' } });
  assert.equal((await create(peer.token, staff)).body.chat.id, dm.id);
});

test('additive migration scopes only unambiguous histories and preserves every message and participant', async () => {
  const make = (name, people, type = 'PERSONAL') => db.chat.create({ data: { name, type, participants: { create: people.map(p => ({ userId: p.id, userType: p.userType })) }, messages: { create: { senderId: staff.id, senderType: 'EMPLOYEE', content: name } } } });
  const unique = await make('Existing direct history', [staff, peer]);
  const global = await make('ALL Chat', [staff, peer], 'GROUP');
  const foreign = await make('Other shops history', [peer, outsider]);
  const companyHistory = await make('Company history', [staff, company]);
  const ambiguous = await make('Ambiguous', [seed.a.owner, staff]);
  await db.supermarketOwnership.create({ data: { customerId: seed.a.owner.id, shopId: seed.b.shop.id, source: 'TEST' } });
  const dangling = await db.shop.create({ data: { name: 'Dangling team', address: 'test', mobile: 'test', shopType: 'CUSTOMER', groupChatId: 'missing-canonical-chat' } });
  await db.supermarketOwnership.create({ data: { shopId: dangling.id, customerId: seed.a.owner.id, source: 'TEST' } });
  await db.shop.create({ data: { name: 'Ownerless', address: 'test', mobile: 'test', shopType: 'CUSTOMER', groupChatId: 'ownerless-missing-chat' } });
  const snapshot = async () => JSON.stringify(await Promise.all([db.message.findMany({ orderBy: { id: 'asc' } }), db.chatParticipant.findMany({ orderBy: { id: 'asc' } })]));
  const before = await snapshot(), chatsBefore = await db.chat.count();
  // Simulate the pre-migration schema in the harness's guarded disposable DB only.
  await db.$executeRawUnsafe('ALTER TABLE "Chat" DROP COLUMN "shopId" CASCADE');
  const sql = await fs.readFile(new URL('../prisma/migrations/20261024100000_shop_chat_scope/migration.sql', import.meta.url), 'utf8');
  const statements = sql.replace(/--[^\n]*/g, '').split(';').map(s => s.trim()).filter(Boolean);
  await db.$transaction(async tx => { for (const statement of statements) await tx.$executeRawUnsafe(statement); });
  assert.equal((await db.chat.findUnique({ where: { id: unique.id } })).shopId, seed.a.shop.id);
  for (const chat of [global, foreign, companyHistory, ambiguous]) assert.equal((await db.chat.findUnique({ where: { id: chat.id } })).shopId, null);
  assert.equal((await db.chat.findUnique({ where: { id: seed.a.shop.groupChatId } })).shopId, seed.a.shop.id);
  assert.equal(await db.chat.count(), chatsBefore + 1); assert.equal(await snapshot(), before);
  const repaired = await db.chat.findUnique({ where: { id: dangling.groupChatId } });
  assert.equal(repaired.shopId, dangling.id); assert.equal(repaired.type, 'GROUP');
  assert.equal((await db.shop.findUnique({ where: { id: dangling.id } })).groupChatId, dangling.groupChatId);
  assert.equal(await db.chat.findUnique({ where: { id: 'ownerless-missing-chat' } }), null);
  assert.equal((await request('GET', `/chat/${repaired.id}`, owner, undefined, dangling.id)).status, 200);
  assert.equal((await request('GET', `/chat/${unique.id}`, staff.token)).status, 200);
  assert.equal((await request('GET', `/chat/${global.id}`, staff.token)).status, 200);
});
