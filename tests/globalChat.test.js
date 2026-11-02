import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import fs from 'node:fs/promises';
import { getPrisma, resetDatabase, seedBase, startApp, createCompanyStaff } from './helpers/harness.js';

let db, app, seed, global, legacy, owner, otherOwner, staffA, staffB, company, supplier, wholesaleStaff, ensureGlobalChat;
const identity = p => `${p.userType}:${p.userId ?? p.id}`;
const waitFor = async predicate => {
  for (let n = 0; n < 150; n++) { if (predicate()) return; await delay(20); }
  assert.fail('Expected realtime event did not arrive');
};
const request = (method, url, user, body) => app.request(method, url, { token: user.token, shopId: user.shopId, body });
const send = (user, chatId, content) => request('POST', '/chat/message', user, { chatId, content });
const create = (user, peer) => request('POST', '/chat', user, { type: 'PERSONAL', participantIds: [{ userId: peer.id, userType: peer.userType }] });
before(async () => {
  await resetDatabase(); db = await getPrisma(); seed = await seedBase(db); app = await startApp();
  ({ ensureGlobalChat } = await import('../src/services/globalChat.js'));
  const account = async user => ({ ...user, token: (await app.login(user.email, seed.password)).token });
  owner = await account(seed.a.owner); otherOwner = await account(seed.b.owner);
  const employee = async (label, shop) => {
    const user = await createCompanyStaff(db, { email: `${label}@global.test`, passwordHash: seed.passwordHash, permissions: [] });
    if (shop) {
      await db.companyStaffMembership.delete({ where: { employeeId: user.id } });
      await db.shopEmployeeMembership.create({ data: { employeeId: user.id, shopId: shop.id, status: 'ACTIVE' } });
    }
    return { ...await account(user), shopId: shop?.id };
  };
  staffA = await employee('retail-alpha', seed.a.shop);
  staffB = await employee('retail-bravo', seed.b.shop);
  company = await employee('company-only');
  wholesaleStaff = await employee('wholesale-only', seed.wholesale);
  supplier = await account(await db.customer.create({ data: {
    name: 'Cash and Carry Owner', email: 'wholesale-owner@global.test', mobile: 'wholesale-owner', password: seed.passwordHash, shopId: seed.wholesale.id,
  } }));
  await db.communityAcceptance.createMany({ data: [staffA, staffB].map(u => ({ userId: u.id, userType: u.userType, version: '2026-10-12' })) });
  legacy = await db.chat.create({ data: { name: 'ALL Chat', type: 'GROUP', participants: { create: [owner, supplier, company, wholesaleStaff].map(u => ({ userId: u.id, userType: u.userType })) },
    messages: { create: { content: 'Original global history', senderId: owner.id, senderType: owner.userType } } } });
});
after(async () => { await app?.close(); await db?.$disconnect(); });

test('startup reuses and renames ALL Chat once without altering history or participants', async () => {
  const before = JSON.stringify(await Promise.all([db.message.findMany(), db.chatParticipant.findMany()]));
  const count = await db.chat.count();
  const rooms = await Promise.all([ensureGlobalChat(db), ensureGlobalChat(db), ensureGlobalChat(db)]);
  global = rooms[0];
  assert.ok(rooms.every(room => room.id === legacy.id && room.name === 'Global Chat'));
  assert.equal(await db.chat.count(), count);
  assert.equal(JSON.stringify(await Promise.all([db.message.findMany(), db.chatParticipant.findMany()])), before);
});

test('all retail owners and employees see the same global room, search its history, and keep shop teams private', async () => {
  const eligible = new Set([owner, otherOwner, staffA, staffB].map(identity));
  for (const user of [owner, otherOwner, staffA, staffB]) {
    const directory = await request('GET', '/chat', user);
    assert.equal(directory.status, 200);
    const room = directory.body.chats.find(c => c.isGlobalChat);
    assert.equal(room.id, global.id); assert.equal(room.name, 'Global Chat');
    assert.equal(room.shopId, null); assert.equal(room.isCommunityChat, true);
    assert.deepEqual(new Set(room.participants.map(identity)), eligible);
    assert.equal((await request('GET', `/chat/${global.id}`, user)).body.chat.messages[0].content, 'Original global history');
    assert.ok((await request('GET', '/chat?search=Original%20global', user)).body.chats.some(c => c.id === global.id));
    const contacts = (await request('GET', '/chat/users', user)).body.users;
    assert.equal(contacts.length, 3);
    assert.ok(contacts.every(p => eligible.has(identity(p)) && identity(p) !== identity(user)));
  }
  assert.equal((await request('GET', `/chat/${seed.a.shop.groupChatId}`, staffB)).status, 403);
  assert.equal((await request('GET', '/chat/users?search=retail-bravo', staffA)).body.users[0].id, String(staffB.id));
});

test('cash-and-carry owners, wholesale staff, company-only staff and anonymous clients cannot join global chat', async () => {
  for (const user of [supplier, wholesaleStaff, company]) {
    const denied = user.token ? 403 : 401; // Wholesale-only staff may be rejected at login itself.
    assert.deepEqual((await request('GET', '/chat', user)).body.chats ?? [], []);
    assert.equal((await request('GET', `/chat/${global.id}`, user)).status, denied);
    assert.equal((await request('GET', '/chat/users', user)).status, denied);
    assert.equal((await send(user, global.id, 'not permitted')).status, denied);
    assert.equal((await create(owner, user)).status, 403);
  }
  assert.equal((await app.request('GET', `/chat/${global.id}`)).status, 401);
  const socket = await app.connectSocket(company.token);
  assert.equal((await socket.timeout(3000).emitWithAck('join_chat', global.id)).success, false);
});

test('cross-shop members and multiple devices receive live global messages, and reconnect can fetch missed messages', async () => {
  const sockets = await Promise.all([staffB, staffB, otherOwner].map(u => app.connectSocket(u.token, u.shopId)));
  for (const socket of sockets) assert.deepEqual(await socket.timeout(3000).emitWithAck('join_chat', global.id), { success: true });
  const message = await send(staffA, global.id, 'Across retail shops');
  assert.equal(message.status, 201);
  await waitFor(() => sockets.every(s => s.received.some(e => e.event === 'message_received' && e.payload.id === message.body.message.id)));
  const offline = sockets[0]; offline.disconnect();
  const missed = await send(owner, global.id, 'While disconnected'); assert.equal(missed.status, 201);
  assert.ok((await request('GET', `/chat/${global.id}`, staffB)).body.chat.messages.some(m => m.id === missed.body.message.id));
  const reconnected = await app.connectSocket(staffB.token, staffB.shopId);
  assert.equal((await reconnected.timeout(3000).emitWithAck('join_chat', global.id)).success, true);
});

test('cross-shop private messages reuse one conversation, appear in Direct data, and exclude third parties', async () => {
  const results = await Promise.all([create(staffA, staffB), create(staffB, staffA), create(staffA, staffB)]);
  assert.deepEqual(results.map(r => r.status).sort(), [200, 200, 201]);
  const dm = results[0].body.chat;
  assert.ok(results.every(r => r.body.chat.id === dm.id)); assert.equal(dm.isCommunityChat, true);
  const socket = await app.connectSocket(staffB.token, staffB.shopId);
  assert.equal((await socket.timeout(3000).emitWithAck('join_chat', dm.id)).success, true);
  const message = await send(staffA, dm.id, 'Private across shops'); assert.equal(message.status, 201);
  await waitFor(() => socket.received.some(e => e.event === 'message_received' && e.payload.id === message.body.message.id));
  assert.equal((await send(staffB, dm.id, 'Private reply')).status, 201);
  for (const user of [staffA, staffB]) {
    assert.ok((await request('GET', '/chat', user)).body.chats.some(c => c.id === dm.id && c.type === 'PERSONAL'));
    assert.equal((await request('GET', `/chat/${dm.id}`, user)).body.chat.messages.length, 2);
  }
  for (const user of [owner, otherOwner, supplier]) {
    assert.equal((await request('GET', `/chat/${dm.id}`, user)).status, 403);
    assert.equal((await send(user, dm.id, 'Intrusion')).status, 403);
  }
  await db.userBlock.create({ data: { userId: staffA.id, userType: staffA.userType, blockedId: staffB.id, blockedType: staffB.userType } });
  assert.equal((await create(staffB, staffA)).status, 403);
  assert.equal((await request('GET', `/chat/${dm.id}`, staffB)).status, 403);
  await db.userBlock.deleteMany({});
});

test('joining global never grants access to shop lists, and membership removal revokes an already joined socket', async () => {
  const leaked = await request('POST', '/chat/message', owner, { chatId: global.id, content: 'Private list', messageType: 'LIST_SHARE', sharedListId: 'private-shop-list' });
  assert.equal(leaked.status, 403);
  const socket = await app.connectSocket(staffB.token, staffB.shopId);
  await socket.timeout(3000).emitWithAck('join_chat', global.id);
  await db.shopEmployeeMembership.updateMany({ where: { employeeId: staffB.id }, data: { status: 'INACTIVE' } });
  const message = await send(owner, global.id, 'After revocation'); assert.equal(message.status, 201);
  await waitFor(() => socket.received.some(e => e.event === 'chat_join_denied'));
  assert.ok(!socket.received.some(e => e.event === 'message_received' && e.payload.id === message.body.message.id));
  assert.equal((await request('GET', `/chat/${global.id}`, staffB)).status, 403);
  assert.equal((await send(staffB, global.id, 'Stale participant')).status, 403);
  await db.shopEmployeeMembership.updateMany({ where: { employeeId: staffB.id }, data: { status: 'ACTIVE' } });
});

test('existing valid personal history is reopened without replacing its thread or shop scope', async () => {
  const existing = await db.chat.create({ data: { type: 'PERSONAL', shopId: seed.a.shop.id,
    participants: { create: [owner, staffA].map(u => ({ userId: u.id, userType: u.userType })) },
    messages: { create: { content: 'Existing private history', senderId: owner.id, senderType: owner.userType } } } });
  const response = await create(owner, staffA);
  assert.equal(response.status, 200); assert.equal(response.body.chat.id, existing.id);
  assert.equal(response.body.chat.shopId, seed.a.shop.id);
  assert.equal((await request('GET', `/chat/${existing.id}`, staffA)).body.chat.messages[0].content, 'Existing private history');
});

test('global image attachments are available to retail members and denied to cash-and-carry accounts', async () => {
  const filename = 'global-chat-test-fixture.jpg';
  const path = `uploads/chat/${filename}`;
  await fs.mkdir('uploads/chat', { recursive: true }); await fs.writeFile(path, 'synthetic image fixture');
  try {
    await db.chatUpload.create({ data: { filename, uploaderId: owner.id, uploaderType: owner.userType } });
    const sent = await request('POST', '/chat/message', owner, { chatId: global.id, content: filename, messageType: 'IMAGE', attachmentUrl: `/uploads/chat/${filename}`, attachmentName: filename });
    assert.equal(sent.status, 201);
    const read = user => fetch(`${app.origin}/uploads/chat/${filename}`, { headers: { Authorization: `Bearer ${user.token}`, ...(user.shopId && { 'X-Supermarket-Id': user.shopId }) } });
    const allowed = await read(staffB); assert.equal(allowed.status, 200); await allowed.arrayBuffer();
    const denied = await read(supplier); assert.equal(denied.status, 403); await denied.arrayBuffer();
  } finally { await fs.unlink(path).catch(() => {}); }
});

test('a team named Global Chat stays private and extra legacy global rooms remain intact', async () => {
  await db.chat.update({ where: { id: seed.a.shop.groupChatId }, data: { name: 'Global Chat' } });
  const duplicate = await db.chat.create({ data: { name: 'ALL Chat', type: 'GROUP', messages: { create: { content: 'Duplicate legacy history', senderId: owner.id, senderType: owner.userType } } } });
  assert.equal((await ensureGlobalChat(db)).id, global.id);
  assert.equal((await request('GET', `/chat/${seed.a.shop.groupChatId}`, otherOwner)).status, 403);
  assert.equal((await request('GET', `/chat/${duplicate.id}`, owner)).status, 403);
  assert.equal(await db.message.count({ where: { chatId: duplicate.id } }), 1);
});

test('a fresh installation provisions exactly one shared room under concurrent startup', async () => {
  // Only this disposable test DB is modified; previous tests verified preservation.
  await db.chat.deleteMany({ where: { type: 'GROUP', shopId: null, id: { notIn: [seed.a.shop.groupChatId, seed.b.shop.groupChatId] } } });
  const rooms = await Promise.all([ensureGlobalChat(db), ensureGlobalChat(db), ensureGlobalChat(db)]);
  assert.equal(new Set(rooms.map(c => c.id)).size, 1);
  assert.equal(rooms[0].name, 'Global Chat');
  assert.equal((await request('GET', '/chat', owner)).body.chats.filter(c => c.isGlobalChat).length, 1);
});
