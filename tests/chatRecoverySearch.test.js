import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { getPrisma, resetDatabase, seedBase, startApp, createCompanyStaff } from './helpers/harness.js';
import { chatUnavailableResponse } from '../src/services/chatQuery.js';
import { verifyServiceSchema } from '../src/services/serviceReadiness.js';
import { setTimeout as delay } from 'node:timers/promises';

let db, app, seed, owner, employee, staff, thread, otherThread;
before(async () => {
  await resetDatabase(); db = await getPrisma(); seed = await seedBase(db); app = await startApp();
  owner = await app.login(seed.a.owner.email, seed.password);
  employee = await createCompanyStaff(db, { email: 'search-teammate@fixture.test', passwordHash: seed.passwordHash, permissions: [] });
  await db.shopEmployeeMembership.create({ data: { employeeId: employee.id, shopId: seed.a.shop.id, status: 'ACTIVE', permissions: [] } });
  staff = await app.login(employee.email, seed.password);
  thread = await db.chat.create({ data: { name: 'Delivery notes', type: 'GROUP', shopId: seed.a.shop.id, participants: { create: [
    { userId: seed.a.owner.id, userType: 'CUSTOMER' }, { userId: employee.id, userType: 'EMPLOYEE' },
  ] } } });
  otherThread = seed.b.shop.groupChatId;
  await db.message.createMany({ data: [
    ...Array.from({ length: 65 }, (_, i) => ({ id: `search-${String(i).padStart(3, '0')}`, chatId: thread.id, senderId: employee.id, senderType: 'EMPLOYEE', content: i < 3 ? `Historic Needle ${i}` : `Delivery ${i}`, createdAt: new Date('2026-10-20T12:00:00Z') })),
    { id: 'attachment-match', chatId: thread.id, senderId: employee.id, senderType: 'EMPLOYEE', content: 'Document', attachmentName: 'Receipt-special.pdf', createdAt: new Date('2026-10-19') },
    { id: 'literal-wildcard', chatId: thread.id, senderId: employee.id, senderType: 'EMPLOYEE', content: 'Offer 25%_off', createdAt: new Date('2026-10-19') },
    { id: 'removed-match', chatId: thread.id, senderId: employee.id, senderType: 'EMPLOYEE', content: 'Removed-only-keyword', deletedAt: new Date() },
    { id: 'private-other-shop', chatId: otherThread, senderId: seed.b.owner.id, senderType: 'CUSTOMER', content: 'Other-shop-secret' },
  ] });
});
after(async () => { await app?.close(); await db?.$disconnect(); });
const get = (path, token = owner.token) => app.request('GET', path, { token, shopId: seed.a.shop.id });
const send = body => app.request('POST', '/chat/message', { token: owner.token, body: { chatId: thread.id, ...body } });

test('conversation search matches complete authorized history, attachment names, participant names and names', async () => {
  for (const term of ['needle', 'receipt-SPECIAL', employee.name, 'Delivery notes', '25%_off']) {
    const result = await get(`/chat?search=${encodeURIComponent(term)}`);
    assert.equal(result.status, 200);
    assert.ok(result.body.chats.some(chat => chat.id === thread.id), term);
  }
  for (const term of ['Other-shop-secret', 'Removed-only-keyword', 'does not exist']) {
    const result = await get(`/chat?search=${encodeURIComponent(term)}`);
    assert.equal(result.status, 200); assert.deepEqual(result.body.chats, []);
  }
  const literal = await get('/chat?search=%25_%25');
  assert.deepEqual(literal.body.chats, []);
});

test('message search includes older pages and filenames and keeps the existing chronological response', async () => {
  const result = await get(`/chat/${thread.id}?search=needle&limit=2`);
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.chat.messages.map(m => m.id), ['search-001', 'search-002']);
  assert.equal(result.body.chat.pagination.hasMore, true);
  const next = await get(`/chat/${thread.id}?search=needle&limit=2&before=${result.body.chat.pagination.nextCursor}`);
  assert.deepEqual(next.body.chat.messages.map(m => m.id), ['search-000']);
  assert.equal(next.body.chat.pagination.hasMore, false);
  assert.equal(next.body.chat.pagination.nextCursor, null);
  const attachment = await get(`/chat/${thread.id}?search=receipt-special`);
  assert.deepEqual(attachment.body.chat.messages.map(m => m.id), ['attachment-match']);
  assert.deepEqual((await get(`/chat/${thread.id}?search=%25`)).body.chat.messages.map(m => m.id), ['literal-wildcard']);
});

test('cursor pagination has no gaps or duplicate messages when new messages arrive or the boundary is deleted', async () => {
  const first = (await get(`/chat/${thread.id}?limit=10`)).body.chat;
  assert.equal(first.messages.length, 10);
  const boundary = first.messages[0].id;
  await db.message.create({ data: { id: 'new-arrival', chatId: thread.id, senderId: employee.id, senderType: 'EMPLOYEE', content: 'Arrived between pages' } });
  await db.message.delete({ where: { id: boundary } });
  let cursor = first.pagination.nextCursor;
  const ids = first.messages.map(m => m.id);
  while (cursor) {
    const response = await get(`/chat/${thread.id}?limit=10&before=${cursor}`);
    assert.equal(response.status, 200);
    ids.push(...response.body.chat.messages.map(m => m.id));
    cursor = response.body.chat.pagination.nextCursor;
  }
  assert.equal(ids.length, 67); assert.equal(new Set(ids).size, 67);
  assert.ok(!ids.includes('new-arrival'));
  const legacy = await get(`/chat/${thread.id}?page=2&limit=10`);
  assert.equal(legacy.status, 200); assert.equal(legacy.body.chat.messages.length, 10);
});

test('search and cursors never bypass shop access, blocked authors or removed-message filtering', async () => {
  const outsider = await app.login(seed.b.owner.email, seed.password);
  assert.equal((await get(`/chat/${thread.id}?search=needle`, outsider.token)).status, 403);
  assert.equal((await get(`/chat/${otherThread}?search=secret`)).status, 403);
  await db.userBlock.create({ data: { userId: seed.a.owner.id, userType: 'CUSTOMER', blockedId: employee.id, blockedType: 'EMPLOYEE' } });
  assert.deepEqual((await get('/chat?search=needle')).body.chats, []);
  assert.deepEqual((await get(`/chat/${thread.id}?search=needle`)).body.chat.messages, []);
  await db.userBlock.deleteMany({ where: { userId: seed.a.owner.id, userType: 'CUSTOMER' } });
  await db.shopEmployeeMembership.updateMany({ where: { employeeId: employee.id }, data: { status: 'INACTIVE' } });
  assert.equal((await get(`/chat/${thread.id}?search=needle`, staff.token)).status, 403);
  await db.shopEmployeeMembership.updateMany({ where: { employeeId: employee.id }, data: { status: 'ACTIVE' } });
});

test('invalid query parameters return a client error, not a misleading unavailable error', async () => {
  for (const query of ['limit=0', 'limit=101', 'page=-1', 'page=no', 'before=', 'before=v1.bad', 'before=x&page=2', 'search[]=x', `search=${'x'.repeat(201)}`]) {
    assert.equal((await get(`/chat/${thread.id}?${query}`)).status, 400, query);
  }
  assert.equal((await get('/chat?search[]=x')).status, 400);
});

test('schema failures are identified without exposing SQL, credentials or message content', async () => {
  assert.equal(chatUnavailableResponse({ code: 'P2022' }).code, 'CHAT_SCHEMA_NOT_READY');
  assert.equal(chatUnavailableResponse({ code: 'P1001' }).code, 'CHAT_UNAVAILABLE');
  // This harness refuses all databases except disposable local test databases.
  await db.$executeRawUnsafe('ALTER TABLE "Chat" RENAME COLUMN "shopId" TO "test_missing_shopId"');
  try {
    await assert.rejects(verifyServiceSchema(db), error => error.service === 'chat');
    const result = await get('/chat');
    assert.equal(result.status, 503); assert.equal(result.body.code, 'CHAT_SCHEMA_NOT_READY');
    assert.ok(!JSON.stringify(result.body).includes('SELECT'));
  } finally { await db.$executeRawUnsafe('ALTER TABLE "Chat" RENAME COLUMN "test_missing_shopId" TO "shopId"'); }
});

test('text retries persist once, reject conflicting payloads and do not resurrect deleted messages', async () => {
  const body = { content: 'Reliable delivery', messageType: 'TEXT', clientMessageId: 'stable-text-attempt' };
  const [one, two] = await Promise.all([send(body), send(body)]);
  assert.deepEqual([one.status, two.status].sort(), [200, 201]);
  assert.equal(one.body.message.id, two.body.message.id);
  assert.equal(one.body.message.clientMessageId, body.clientMessageId);
  assert.equal(await db.message.count({ where: { id: one.body.message.id } }), 1);
  assert.equal((await send({ ...body, content: 'Changed body' })).status, 409);
  assert.equal((await app.request('DELETE', `/chat/message/${one.body.message.id}`, { token: owner.token })).status, 200);
  assert.equal((await send(body)).status, 409);
  assert.ok(!(await get(`/chat/${thread.id}`)).body.chat.messages.some(m => m.id === one.body.message.id));
});

test('a post-commit cache outage still acknowledges and broadcasts a saved message and safe retry', async () => {
  const cache = (await import('../src/services/cacheService.js')).default;
  const original = cache.invalidateMessages;
  cache.invalidateMessages = async () => { throw Object.assign(new Error('synthetic cache outage'), { service: 'cache' }); };
  try {
    const receiver = await app.connectSocket(staff.token, seed.a.shop.id);
    assert.deepEqual(await receiver.timeout(3000).emitWithAck('join_chat', thread.id), { success: true });
    const body = { content: 'Saved despite cache outage', messageType: 'TEXT', clientMessageId: 'cache-outage-attempt' };
    const first = await send(body), retry = await send(body);
    assert.equal(first.status, 201); assert.equal(retry.status, 200);
    assert.equal(first.body.message.id, retry.body.message.id);
    assert.equal(await db.message.count({ where: { id: first.body.message.id } }), 1);
    for (let i = 0; i < 100 && !receiver.received.some(event => event.event === 'message_received' && event.payload.id === first.body.message.id); i++) await delay(10);
    assert.equal(receiver.received.filter(event => event.event === 'message_received' && event.payload.id === first.body.message.id).length, 1);
  } finally { cache.invalidateMessages = original; }
});

test('document retries reuse the original upload and require current conversation access', async () => {
  const filename = 'synthetic-retry-receipt.pdf';
  await db.chatUpload.create({ data: { filename, uploaderId: seed.a.owner.id, uploaderType: 'CUSTOMER' } });
  const body = { content: 'Receipt', messageType: 'DOCUMENT', attachmentUrl: `/uploads/chat/${filename}`, attachmentName: filename, attachmentSize: 8, clientMessageId: 'stable-document-attempt' };
  const first = await send(body), retry = await send(body);
  assert.equal(first.status, 201); assert.equal(retry.status, 200);
  assert.equal(first.body.message.id, retry.body.message.id);
  const outsider = await app.login(seed.b.owner.email, seed.password);
  assert.equal((await app.request('POST', '/chat/message', { token: outsider.token, body: { chatId: thread.id, ...body } })).status, 403);
  assert.equal(await db.message.count({ where: { id: first.body.message.id } }), 1);
});
