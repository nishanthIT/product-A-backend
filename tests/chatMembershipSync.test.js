import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout } from 'node:timers/promises';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import { createCompanyStaff, getPrisma, resetDatabase, seedBase, startApp } from './helpers/harness.js';

let db, app, seed, owner, stranger, admin, employee, employeeToken, companyToken, second, inactive, legacy;
const send = (token, chatId, content) => app.request('POST', '/chat/message', { token, shopId: chatId === second.groupChatId ? second.id : seed.a.shop.id, body: { chatId, content } });
const waitFor = async (predicate, message) => {
  for (let i = 0; i < 100; i++) { if (predicate()) return; await setTimeout(20); }
  assert.fail(message);
};
const rosterIds = chat => chat.participants.filter(p => p.userType === 'EMPLOYEE').map(p => p.id);
before(async () => {
  await resetDatabase(); db = await getPrisma(); seed = await seedBase(db); app = await startApp();
  owner = (await app.login(seed.a.owner.email, seed.password)).token;
  stranger = (await app.login(seed.b.owner.email, seed.password)).token;
  admin = (await app.login(seed.admin.email, seed.password)).token;
  const group = await db.chat.create({ data: { name: 'Second team', type: 'GROUP' } });
  second = await db.shop.create({ data: { name: 'Second', address: 'test', mobile: 'test', shopType: 'CUSTOMER', groupChatId: group.id } });
  await db.supermarketOwnership.create({ data: { shopId: second.id, customerId: seed.a.owner.id, source: 'TEST' } });
  employee = await db.empolyee.create({ data: { name: 'Restricted employee', email: 'restricted@sync.test', phoneNo: 'restricted', password: seed.passwordHash, shopId: seed.a.shop.id, createdByCustomerId: seed.a.owner.id } });
  await db.shopEmployeeMembership.createMany({ data: [seed.a.shop.id, second.id].map(shopId => ({ employeeId: employee.id, shopId, status: 'ACTIVE', permissions: [] })) });
  employeeToken = (await app.login(employee.email, seed.password)).token;
  const company = await createCompanyStaff(db, { email: 'company@sync.test', passwordHash: seed.passwordHash, permissions: ['catalog.read'] });
  companyToken = (await app.login(company.email, seed.password)).token;
  inactive = await createCompanyStaff(db, { email: 'inactive@sync.test', passwordHash: seed.passwordHash, permissions: [] });
  await db.shopEmployeeMembership.create({ data: { employeeId: inactive.id, shopId: second.id, status: 'INACTIVE', permissions: [] } });
  await db.chatParticipant.create({ data: { chatId: group.id, userId: inactive.id, userType: 'EMPLOYEE' } });
  legacy = await db.empolyee.create({ data: { name: 'Legacy', email: 'legacy@sync.test', phoneNo: 'legacy', password: seed.passwordHash, shopId: second.id } });
  await db.employeeAccessReview.create({ data: { employeeId: legacy.id, reason: 'LEGACY_AMBIGUOUS', evidence: {} } });
});
after(async () => { await app?.close(); await db?.$disconnect(); });

test('owners and active employees see only the selected shop roster; company roles confer no chat access', async () => {
  for (const token of [owner, employeeToken]) {
    for (const shop of [seed.a.shop, second]) {
    const directory = await app.request('GET', '/chat', { token, shopId: shop.id });
    assert.equal(directory.status, 200);
      const summary = directory.body.chats.find(chat => chat.id === shop.groupChatId);
      assert.deepEqual(rosterIds(summary), [employee.id]);
      const thread = await app.request('GET', `/chat/${shop.groupChatId}`, { token, shopId: shop.id });
      assert.equal(thread.status, 200);
      assert.deepEqual(rosterIds(thread.body.chat), [employee.id]);
    }
  }
  for (const token of [stranger, companyToken, admin]) {
    assert.equal((await app.request('GET', `/chat/${second.groupChatId}`, { token })).status, 403);
    assert.equal((await send(token, second.groupChatId, 'forbidden')).status, 403);
  }
  const inactiveToken = (await app.login(inactive.email, seed.password)).token;
  assert.equal((await app.request('GET', `/chat/${second.groupChatId}`, { token: inactiveToken })).status, 403);
  const contacts = await app.request('GET', '/chat/users', { token: owner, shopId: second.id });
  assert.ok(contacts.body.users.some(p => Number(p.id) === employee.id && p.userType === 'EMPLOYEE'));
  assert.ok(!contacts.body.users.some(p => [inactive.id, legacy.id].includes(Number(p.id)) && p.userType === 'EMPLOYEE'));
});

test('both employee devices receive background refresh without participant rows; unauthorized accounts receive nothing', async () => {
  const first = await app.connectSocket(employeeToken, second.id), otherDevice = await app.connectSocket(employeeToken, second.id);
  const unrelated = await app.connectSocket(stranger), company = await app.connectSocket(companyToken);
  assert.equal(await db.chatParticipant.count({ where: { chatId: second.groupChatId, userId: employee.id, userType: 'EMPLOYEE' } }), 0);
  assert.equal((await send(owner, second.groupChatId, 'owner update')).status, 201);
  await waitFor(() => [first, otherDevice].every(s => s.received.some(e => e.event === 'chats_changed')), 'Both devices should refresh their team directory');
  assert.ok([first, otherDevice].every(s => s.received.some(e => e.event === 'message_received' && e.payload.content === 'owner update')));
  assert.ok([unrelated, company].every(s => !s.received.some(e => e.event === 'message_received')));
  assert.ok([unrelated, company].every(s => !s.received.some(e => e.event === 'chats_changed')));
  const live = await app.connectSocket(employeeToken, second.id);
  live.emit('join_chat', second.groupChatId);
  await setTimeout(60);
  const message = await send(owner, second.groupChatId, 'live team update');
  await waitFor(() => live.received.some(e => e.event === 'message_received' && e.payload.id === message.body.message.id), 'Joined employee should receive live messages');
  unrelated.emit('join_chat', second.groupChatId);
  await waitFor(() => unrelated.received.some(e => e.event === 'chat_join_denied'), 'Another shop cannot join');
});

test('concurrent first posts from two devices join once and preserve both messages', async () => {
  const responses = await Promise.all(['first device', 'second device'].map(content => send(employeeToken, second.groupChatId, content)));
  assert.deepEqual(responses.map(r => r.status), [201, 201]);
  assert.equal(await db.chatParticipant.count({ where: { chatId: second.groupChatId, userId: employee.id, userType: 'EMPLOYEE' } }), 1);
  assert.equal(await db.message.count({ where: { chatId: second.groupChatId, senderId: employee.id, senderType: 'EMPLOYEE' } }), 2);
  const response = await send(admin, seed.a.shop.groupChatId, 'admin reply');
  assert.equal(response.status, 403);
});

test('create, assign, deactivate, reactivate and remove refresh owners and active members without leaking to another shop', async () => {
  const ownerSocket = await app.connectSocket(owner), peerSocket = await app.connectSocket(employeeToken, second.id), unrelated = await app.connectSocket(stranger);
  const expectRefresh = async (action, shop) => {
    ownerSocket.received.length = peerSocket.received.length = unrelated.received.length = 0;
    const result = await action();
    assert.ok([200, 201].includes(result.status), JSON.stringify(result.body));
    await waitFor(() => [ownerSocket, peerSocket].every(s => s.received.some(e => e.event === 'chat_participants_changed' && e.payload.chatId === shop.groupChatId && e.payload.shopId === shop.id)), 'Owner and active teammate should refresh their roster');
    assert.ok(!unrelated.received.some(e => ['chats_changed', 'chat_participants_changed'].includes(e.event)));
    return result;
  };
  const created = await expectRefresh(() => app.request('POST', '/employees', { token: owner, body: { name: 'New teammate', email: 'new@sync.test', password: seed.password, permissions: [] } }), seed.a.shop);
  const id = created.body.employee.id;
  const memberToken = (await app.login('new@sync.test', seed.password)).token;
  await expectRefresh(() => app.request('POST', '/employees/assign', { token: owner, shopId: second.id, body: { employeeId: id, permissions: [] } }), second);
  const memberSocket = await app.connectSocket(memberToken, second.id);
  memberSocket.emit('join_chat', second.groupChatId); await setTimeout(60);
  await expectRefresh(() => app.request('PATCH', `/employees/${id}/status`, { token: owner, shopId: second.id, body: { status: 'INACTIVE' } }), second);
  await waitFor(() => !memberSocket.connected, 'Revoked membership must disconnect joined sockets');
  assert.equal((await app.request('GET', `/chat/${second.groupChatId}`, { token: memberToken, shopId: second.id })).status, 403);
  assert.equal((await app.request('GET', `/chat/${seed.a.shop.groupChatId}`, { token: memberToken })).status, 200);
  await expectRefresh(() => app.request('PATCH', `/employees/${id}/status`, { token: owner, shopId: second.id, body: { status: 'ACTIVE' } }), second);
  assert.equal((await app.request('GET', `/chat/${second.groupChatId}`, { token: memberToken, shopId: second.id })).status, 200);
  await expectRefresh(() => app.request('DELETE', `/employees/${id}`, { token: owner, shopId: second.id }), second);
  const thread = await app.request('GET', `/chat/${second.groupChatId}`, { token: owner, shopId: second.id });
  assert.ok(!rosterIds(thread.body.chat).includes(id));
  assert.ok(thread.body.chat.messages.some(m => m.content === 'live team update'));
});

test('shop diagnostics report legacy and inactive relationships without modifying data or exposing personal fields', async () => {
  const snapshot = async () => JSON.stringify(await Promise.all([db.shop.findMany(), db.chat.findMany(), db.chatParticipant.findMany(), db.shopEmployeeMembership.findMany(), db.employeeAccessReview.findMany()]));
  const before = await snapshot();
  const output = execFileSync(process.execPath, ['scripts/inspectShopTeamChats.js', `--shop-id=${second.id}`], { env: { ...process.env, DATABASE_URL: process.env.TEST_DATABASE_URL }, encoding: 'utf8' });
  const report = JSON.parse(output);
  assert.equal(report.readOnly, true); assert.equal(report.shopCount, 1);
  const shop = report.shops[0];
  assert.ok(shop.findings.includes('LEGACY_MEMBERSHIP_REVIEW_REQUIRED'));
  assert.ok(shop.findings.includes('STALE_PARTICIPANTS_DO_NOT_GRANT_ACCESS'));
  assert.equal(shop.memberships.find(m => m.employeeId === inactive.id).status, 'INACTIVE');
  assert.equal(shop.legacyEmployeesWithoutMembership.find(e => e.employeeId === legacy.id).reviews[0].status, 'OPEN');
  assert.ok(!output.includes('@')); assert.ok(!output.includes(employee.name));
  assert.equal(await snapshot(), before);
});

test('camera JPEG multipart uploads send and download for owners and employees; outsiders and removed members cannot fetch them', async () => {
  const { default: sharp } = await import('sharp');
  const jpeg = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#ff0000' } }).jpeg().toBuffer();
  const { validateUploadBuffer } = await import('../src/services/uploadValidation.js');
  const cleanedJpeg = (await validateUploadBuffer(jpeg)).buffer;
  const uploads = [], messages = [];
  try {
    for (const [token, filename] of [[owner, 'camera.jpg'], [employeeToken, 'capture']]) {
      const form = new FormData();
      form.append('file', new Blob([jpeg], { type: 'image/jpeg' }), filename);
      const uploaded = await fetch(`${app.origin}/api/chat/upload`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form });
      assert.equal(uploaded.status, 200);
      const { file } = await uploaded.json(); uploads.push(file.url);
      assert.equal(file.type, 'IMAGE'); assert.equal(file.size, cleanedJpeg.length);
      const sent = await app.request('POST', '/chat/message', { token, shopId: second.id, body: { chatId: second.groupChatId, content: 'Camera photo', messageType: file.type, attachmentUrl: file.url, attachmentName: file.name, attachmentSize: file.size } });
      assert.equal(sent.status, 201); messages.push({ id: sent.body.message.id, token });
      for (const viewer of [owner, employeeToken]) {
        const image = await fetch(`${app.origin}${file.url}`, { headers: { Authorization: `Bearer ${viewer}`, 'X-Supermarket-Id': second.id } });
        assert.equal(image.status, 200); assert.match(image.headers.get('content-type'), /image\/jpeg/);
        assert.equal(image.headers.get('cache-control'), 'private, no-store');
        assert.deepEqual(Buffer.from(await image.arrayBuffer()), cleanedJpeg);
        const history = await app.request('GET', `/chat/${second.groupChatId}`, { token: viewer, shopId: second.id });
        assert.ok(history.body.chat.messages.some(m => m.id === sent.body.message.id && m.messageType === 'IMAGE' && m.attachmentUrl === file.url));
      }
      for (const viewer of [stranger, companyToken, admin]) {
        assert.ok([403, 404].includes((await fetch(`${app.origin}${file.url}`, { headers: { Authorization: `Bearer ${viewer}`, 'X-Supermarket-Id': second.id } })).status));
      }
      assert.equal((await fetch(`${app.origin}${file.url}`)).status, 401);
    }
    assert.equal((await app.request('PATCH', `/employees/${employee.id}/status`, { token: owner, shopId: second.id, body: { status: 'INACTIVE' } })).status, 200);
    for (const url of uploads) assert.equal((await fetch(`${app.origin}${url}`, { headers: { Authorization: `Bearer ${employeeToken}`, 'X-Supermarket-Id': second.id } })).status, 403);
    const invalid = new FormData(); invalid.append('file', new Blob(['bad'], { type: 'application/x-executable' }), 'bad.exe');
    const rejected = await fetch(`${app.origin}/api/chat/upload`, { method: 'POST', headers: { Authorization: `Bearer ${owner}` }, body: invalid });
    assert.equal(rejected.status, 400); assert.equal((await rejected.json()).success, false);
  } finally {
    await app.request('PATCH', `/employees/${employee.id}/status`, { token: owner, shopId: second.id, body: { status: 'ACTIVE' } });
    for (const message of messages) await app.request('DELETE', `/chat/message/${message.id}`, { token: message.token, shopId: second.id });
    for (const url of uploads) await fs.unlink(url.slice(1)).catch(() => {});
  }
});

test('photo retries after a lost response create one message and one event without changing newer chat activity', async () => {
  const filename = 'retry-camera-fixture.jpg';
  await db.chatUpload.create({ data: { filename, uploaderId: seed.a.owner.id, uploaderType: 'CUSTOMER' } });
  const body = { chatId: second.groupChatId, content: 'Retry photo', messageType: 'IMAGE', attachmentUrl: `/uploads/chat/${filename}`, attachmentName: filename, attachmentSize: 123, clientMessageId: `/uploads/chat/${filename}` };
  const socket = await app.connectSocket(employeeToken, second.id);
  socket.emit('join_chat', second.groupChatId); await setTimeout(60);
  const results = await Promise.all([1, 2].map(() => app.request('POST', '/chat/message', { token: owner, shopId: second.id, body })));
  assert.deepEqual(results.map(r => r.status).sort(), [200, 201], JSON.stringify(results));
  const id = results[0].body.message.id;
  assert.equal(results[1].body.message.id, id);
  assert.equal(await db.message.count({ where: { attachmentUrl: body.attachmentUrl } }), 1);
  await waitFor(() => socket.received.some(e => e.event === 'message_received' && e.payload.id === id), 'The original photo should arrive once');
  assert.equal(socket.received.filter(e => e.event === 'message_received' && e.payload.id === id).length, 1);

  const later = await send(owner, second.groupChatId, 'Newer conversation activity');
  assert.equal(later.status, 201);
  const before = (await db.chat.findUnique({ where: { id: second.groupChatId } })).lastMessageAt;
  socket.received.length = 0;
  const retry = await app.request('POST', '/chat/message', { token: owner, shopId: second.id, body });
  assert.equal(retry.status, 200); assert.equal(retry.body.replayed, true);
  assert.equal(retry.body.message.id, id);
  assert.equal(retry.body.message.timestamp, results[0].body.message.timestamp);
  assert.deepEqual((await db.chat.findUnique({ where: { id: second.groupChatId } })).lastMessageAt, before);
  await setTimeout(60);
  assert.ok(!socket.received.some(e => e.event === 'message_received' && e.payload.id === id));
  assert.equal((await app.request('POST', '/chat/message', { token: owner, shopId: second.id, body: { ...body, content: 'Changed photo payload' } })).status, 409);
  assert.equal((await app.request('POST', '/chat/message', { token: stranger, shopId: second.id, body })).status, 403);
  assert.equal((await app.request('POST', '/chat/message', { token: employeeToken, shopId: second.id, body })).status, 403, 'another role cannot replay an owner photo');
  for (const invalid of [{ clientMessageId: '' }, { clientMessageId: 'a'.repeat(513) }, { messageType: 'INVALID' }]) {
    assert.equal((await app.request('POST', '/chat/message', { token: owner, shopId: second.id, body: { ...body, ...invalid } })).status, 400);
  }

  // Same key belongs to the typed sender as well as the conversation.
  const employeeFile = 'employee-retry-camera-fixture.jpg';
  await db.chatUpload.create({ data: { filename: employeeFile, uploaderId: employee.id, uploaderType: 'EMPLOYEE' } });
  const employeeSend = await app.request('POST', '/chat/message', { token: employeeToken, shopId: second.id, body: { ...body, attachmentUrl: `/uploads/chat/${employeeFile}` } });
  assert.equal(employeeSend.status, 201); assert.notEqual(employeeSend.body.message.id, id);
  const anotherChat = await app.request('POST', '/chat/message', { token: owner, shopId: seed.a.shop.id, body: { ...body, chatId: seed.a.shop.groupChatId } });
  assert.equal(anotherChat.status, 201); assert.notEqual(anotherChat.body.message.id, id);

  // A shared upload must not allow a delayed request to resurrect an author-deleted photo.
  assert.equal((await app.request('DELETE', `/chat/message/${id}`, { token: owner, shopId: second.id })).status, 200);
  const tombstone = await db.message.findUnique({ where: { id } });
  assert.ok(tombstone.deletedAt); assert.equal(tombstone.content, ''); assert.equal(tombstone.attachmentUrl, null);
  assert.equal(tombstone.attachmentName, null); assert.equal(tombstone.attachmentSize, null);
  assert.ok(await db.chatUpload.findUnique({ where: { filename } }), 'another conversation still owns a reference to the upload');
  assert.equal((await app.request('POST', '/chat/message', { token: owner, shopId: second.id, body })).status, 409);
  assert.ok(!(await app.request('GET', `/chat/${second.groupChatId}`, { token: owner, shopId: second.id })).body.chat.messages.some(m => m.id === id));
  await db.message.update({ where: { id: anotherChat.body.message.id }, data: { deletedAt: new Date() } });
  assert.equal((await app.request('POST', '/chat/message', { token: owner, shopId: seed.a.shop.id, body: { ...body, chatId: seed.a.shop.groupChatId } })).status, 409, 'moderation removals cannot be replayed');
  await app.request('DELETE', `/chat/message/${anotherChat.body.message.id}`, { token: owner });
  await app.request('DELETE', `/chat/message/${employeeSend.body.message.id}`, { token: employeeToken, shopId: second.id });
});
