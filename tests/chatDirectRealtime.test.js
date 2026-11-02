import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { getPrisma, resetDatabase, seedBase, startApp, createCompanyStaff } from './helpers/harness.js';

let db, app, seed, owner, peer, employee, dm, global, drainChatWork;
const request = (method, path, user, body) => app.request(method, path, { token: user.token, shopId: user.shopId, body });
const create = (user, other) => request('POST', '/chat', user, { type: 'PERSONAL', participantIds: [{ userId: other.id, userType: other.userType }] });
const send = (user, chatId, content) => request('POST', '/chat/message', user, { chatId, content, clientMessageId: `retry-${content}` });
const waitFor = async predicate => {
  for (let i = 0; i < 200; i++) { if (await predicate()) return; await delay(15); }
  assert.fail('Expected realtime state did not arrive');
};
const received = (socket, event, id) => socket.received.filter(item => item.event === event && (item.payload.id === id || item.payload.messageIds?.includes(id)));

before(async () => {
  await resetDatabase(); db = await getPrisma(); seed = await seedBase(db); app = await startApp();
  ({ drainChatWork } = await import('../src/services/chatBroadcast.js'));
  global = await (await import('../src/services/globalChat.js')).ensureGlobalChat(db);
  const account = async (user, shop) => ({ ...user, shopId: shop.id, token: (await app.login(user.email, seed.password)).token });
  owner = await account(seed.a.owner, seed.a.shop);
  peer = await account(seed.b.owner, seed.b.shop);
  const staff = await createCompanyStaff(db, { email: 'direct-retail@fixture.test', passwordHash: seed.passwordHash, permissions: [] });
  await db.companyStaffMembership.delete({ where: { employeeId: staff.id } });
  await db.shopEmployeeMembership.create({ data: { employeeId: staff.id, shopId: seed.b.shop.id, status: 'ACTIVE' } });
  await db.communityAcceptance.create({ data: { userId: staff.id, userType: 'EMPLOYEE', version: '2026-10-12' } });
  employee = await account(staff, seed.b.shop);
});
after(async () => { await app?.close(); await db?.$disconnect(); });

test('simultaneous opens from both participants reuse one direct room and return an initial page only when new', async () => {
  const results = await Promise.all(Array.from({ length: 8 }, (_, i) => i % 2 ? create(owner, peer) : create(peer, owner)));
  assert.equal(results.filter(r => r.status === 201).length, 1);
  assert.equal(results.filter(r => r.status === 200).length, 7);
  assert.equal(new Set(results.map(r => r.body.chat.id)).size, 1);
  dm = results[0].body.chat;
  const initial = results.find(r => r.status === 201).body.chat.initialPage;
  assert.equal(initial.id, dm.id); assert.deepEqual(initial.messages, []);
  assert.deepEqual(initial.pagination, { hasMore: false, nextCursor: null, limit: 30 });
  assert.ok(results.filter(r => r.status === 200).every(r => !r.body.chat.initialPage));
  assert.equal(await db.chat.count({ where: { type: 'PERSONAL' } }), 1);
});

test('unopened direct inbox receives one copy on every device, including correct ownership on sender devices', async () => {
  const receiver = await app.connectSocket(peer.token, peer.shopId);
  const secondReceiver = await app.connectSocket(peer.token, peer.shopId);
  const senderDevice = await app.connectSocket(owner.token, owner.shopId);
  // Only one receiver joins the thread; the other stays in its inbox.
  assert.equal((await receiver.timeout(3000).emitWithAck('join_chat', dm.id)).success, true);
  const result = await send(owner, dm.id, 'background-direct-delivery');
  assert.equal(result.status, 201); const id = result.body.message.id;
  await waitFor(() => [receiver, secondReceiver, senderDevice].every(socket => received(socket, 'message_received', id).length));
  await drainChatWork();
  assert.equal(received(receiver, 'message_received', id).length, 1);
  assert.equal(received(secondReceiver, 'message_received', id).length, 1);
  assert.equal(received(senderDevice, 'message_received', id)[0].payload.isOwnMessage, true);
  assert.equal(received(secondReceiver, 'message_received', id)[0].payload.isOwnMessage, false);
  assert.ok(secondReceiver.received.some(item => item.event === 'chats_changed' && item.payload.chatId === dm.id && item.payload.reason === 'message'));
  // Merely sending to an online socket is not proof of receipt.
  assert.equal(await db.messageDelivery.count({ where: { messageId: id } }), 0);
  const reopened = await create(peer, owner);
  assert.equal(reopened.status, 200); assert.equal(reopened.body.chat.id, dm.id);
  assert.equal(reopened.body.chat.unreadCount, 1);
  assert.equal(reopened.body.chat.lastMessage, 'background-direct-delivery');
});

test('delivery acknowledgements and read receipts persist once, notify unopened sender devices, and survive reload', async () => {
  const sender = await app.connectSocket(owner.token, owner.shopId);
  const receiver = await app.connectSocket(peer.token, peer.shopId);
  const otherDevice = await app.connectSocket(peer.token, peer.shopId);
  const sent = await send(owner, dm.id, 'acknowledged-direct-message');
  const id = sent.body.message.id;
  await waitFor(() => received(receiver, 'message_received', id).length);
  const ack = { chatId: dm.id, messageIds: [id, id] };
  const delivered = await Promise.all([receiver, otherDevice].map(socket => socket.timeout(3000).emitWithAck('message_delivered', ack)));
  assert.ok(delivered.every(result => result.success));
  await waitFor(() => received(sender, 'message_delivered', id).length);
  assert.equal(await db.messageDelivery.count({ where: { messageId: id } }), 1);
  assert.equal(await db.messageRead.count({ where: { messageId: id } }), 0);
  const reads = await Promise.all([request('POST', '/chat/read', peer, { messageIds: [id, id] }), request('POST', '/chat/read', peer, { messageIds: [id] })]);
  assert.ok(reads.every(r => r.status === 200));
  await waitFor(() => received(sender, 'message_read', id).length);
  assert.equal(await db.messageRead.count({ where: { messageId: id } }), 1);
  assert.equal(await db.messageDelivery.count({ where: { messageId: id } }), 1);
  const history = await request('GET', `/chat/${dm.id}`, owner);
  const message = history.body.chat.messages.find(m => m.id === id);
  assert.equal(message.deliveredTo.length, 1); assert.equal(message.readBy.length, 1);
  assert.equal(message.deliveredTo[0].userId, peer.id); assert.equal(message.readBy[0].userType, peer.userType);
  // Read all incoming messages and verify the sender's other device is refreshed.
  const incoming = history.body.chat.messages.map(m => m.id);
  assert.equal((await request('POST', '/chat/read', peer, { messageIds: incoming })).status, 200);
  assert.equal((await create(peer, owner)).body.chat.unreadCount, 0);
});

test('receipt APIs reject forged recipients, wrong room IDs, blocked messages and self delivery', async () => {
  const result = await send(owner, dm.id, 'private-receipt-auth'); const id = result.body.message.id;
  const outsider = await app.connectSocket(employee.token, employee.shopId);
  assert.equal((await outsider.timeout(3000).emitWithAck('message_delivered', { chatId: dm.id, messageIds: [id] })).success, false);
  assert.equal((await request('POST', '/chat/read', employee, { messageIds: [id] })).status, 403);
  const receiver = await app.connectSocket(peer.token, peer.shopId);
  for (const malformed of [null, 'invalid', 1, {}, { chatId: dm.id, messageIds: null }]) {
    assert.equal((await receiver.timeout(3000).emitWithAck('message_delivered', malformed)).success, false);
    assert.equal(receiver.connected, true);
  }
  assert.equal((await receiver.timeout(3000).emitWithAck('message_delivered', { chatId: seed.b.shop.groupChatId, messageIds: [id] })).success, false);
  const sender = await app.connectSocket(owner.token, owner.shopId);
  assert.equal((await sender.timeout(3000).emitWithAck('message_delivered', { chatId: dm.id, messageIds: [id] })).success, true);
  assert.equal(await db.messageDelivery.count({ where: { messageId: id } }), 0);
  await db.userBlock.create({ data: { userId: peer.id, userType: peer.userType, blockedId: owner.id, blockedType: owner.userType } });
  try {
    assert.equal((await receiver.timeout(3000).emitWithAck('message_delivered', { chatId: dm.id, messageIds: [id] })).success, false);
    assert.equal((await request('POST', '/chat/read', peer, { messageIds: [id] })).status, 404);
    assert.equal(await db.messageRead.count({ where: { messageId: id } }), 0);
  } finally { await db.userBlock.deleteMany({}); }
});

test('revoked retail memberships cannot reopen, send, acknowledge or receive an existing private room', async () => {
  const opened = await create(owner, employee); assert.equal(opened.status, 201);
  const room = opened.body.chat.id;
  const staleSocket = await app.connectSocket(employee.token, employee.shopId);
  assert.equal((await staleSocket.timeout(3000).emitWithAck('join_chat', room)).success, true);
  assert.equal((await staleSocket.timeout(3000).emitWithAck('join_chat', global.id)).success, true);
  const before = await send(owner, room, 'before-revocation');
  await drainChatWork();
  await db.shopEmployeeMembership.updateMany({ where: { employeeId: employee.id }, data: { status: 'INACTIVE' } });
  try {
    assert.equal((await create(owner, employee)).status, 403);
    assert.equal((await request('GET', `/chat/${room}`, employee)).status, 403);
    assert.equal((await send(employee, room, 'after-revocation')).status, 403);
    assert.equal((await request('POST', '/chat/read', employee, { messageIds: [before.body.message.id] })).status, 403);
    // Existing socket rooms cannot retain access when the membership is revoked.
    const publicSend = await send(owner, global.id, 'global-after-revocation');
    assert.equal(publicSend.status, 201); await drainChatWork();
    await waitFor(() => staleSocket.received.some(item => item.event === 'chat_join_denied' && item.payload.chatId === global.id));
    assert.equal(received(staleSocket, 'message_received', publicSend.body.message.id).length, 0);
    // Direct access helper is denied for BOTH sides, so stale ownership cannot
    // leak private message bodies after the other participant is removed.
    assert.equal((await send(owner, room, 'no-longer-eligible-peer')).status, 403);
  } finally { await db.shopEmployeeMembership.updateMany({ where: { employeeId: employee.id }, data: { status: 'ACTIVE' } }); }
});

test('a committed send returns while cache work is still pending and retries preserve one message', async () => {
  await drainChatWork();
  const cache = (await import('../src/services/cacheService.js')).default;
  const original = cache.invalidateMessages;
  let release, entered = false;
  const hold = new Promise(resolve => { release = resolve; });
  cache.invalidateMessages = async () => { entered = true; await hold; };
  try {
    const pending = send(owner, dm.id, 'nonblocking-cache-send');
    const result = await Promise.race([pending, delay(3000).then(() => null)]);
    assert.ok(result, 'Committed send should not wait for cache completion'); assert.equal(result.status, 201);
    await waitFor(() => entered);
    const retry = await send(owner, dm.id, 'nonblocking-cache-send');
    assert.equal(retry.status, 200); assert.equal(retry.body.message.id, result.body.message.id);
    assert.equal(await db.message.count({ where: { id: result.body.message.id } }), 1);
  } finally { release(); await drainChatWork(); cache.invalidateMessages = original; }
});
