import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout } from 'node:timers/promises';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import { getPrisma, resetDatabase, seedBase, startApp } from './helpers/harness.js';
let db, app, seed, a, b, admin, group, direct, message;
before(async () => {
  await resetDatabase(); db = await getPrisma(); seed = await seedBase(db); app = await startApp();
  a = await app.login(seed.a.owner.email, seed.password); b = await app.login(seed.b.owner.email, seed.password); admin = await app.login(seed.admin.email, seed.password);
  group = await db.chat.create({ data: { type: 'GROUP', name: 'ALL Chat' } });
  direct = await db.chat.create({ data: { type: 'PERSONAL', participants: { create: [{ userId: seed.a.owner.id, userType: 'CUSTOMER' }, { userId: seed.b.owner.id, userType: 'CUSTOMER' }] } } });
});
after(async () => { await app?.close(); await db?.$disconnect(); });
const send = (token, chatId, content, extra = {}) => app.request('POST', '/chat/message', { token, body: { chatId, content, ...extra } });

test('posting requires no rules acceptance and rejects content larger than the server limit', async () => {
  await db.communityAcceptance.delete({ where: { userId_userType: { userId: seed.a.owner.id, userType: 'CUSTOMER' } } });
  const immediate = await send(a.token, group.id, 'no acceptance needed');
  assert.equal(immediate.status, 201);
  await app.request('DELETE', `/chat/message/${immediate.body.message.id}`, { token:a.token });
  assert.equal((await app.request('POST', '/chat-safety/accept', { token: a.token, body: { version: 'old' } })).status, 204);
  assert.equal((await app.request('POST', '/chat-safety/accept', { token: a.token, body: { version: '2026-10-12' } })).status, 204);
  assert.equal((await send(a.token, group.id, 'a'.repeat(10001))).status, 400);
  message = (await send(b.token, group.id, 'Synthetic report fixture')).body.message;
  assert.ok(message.id);
});

test('reports are limited to accessible content, deduplicated and available only to moderators', async () => {
  const privateMessage = await db.message.create({ data: { chatId: seed.b.shop.groupChatId, senderId: seed.b.owner.id, senderType: 'CUSTOMER', content: 'private fixture' } });
  assert.equal((await app.request('POST', '/chat-safety/report', { token: a.token, body: { messageId: privateMessage.id, reason: 'ABUSE' } })).status, 404);
  const report = () => app.request('POST', '/chat-safety/report', { token: a.token, body: { messageId: message.id, reason: 'ABUSE' } });
  assert.equal((await report()).status, 202); await report();
  assert.equal(await db.contentReport.count(), 1);
  assert.equal((await app.request('GET', '/chat-safety/reports', { token: a.token })).status, 403);
  assert.equal((await app.request('GET', '/chat-safety/reports', { token: admin.token })).body.length, 1);
});

test('blocking hides group history and summary, rejects direct messages and forged new chats, and filters realtime bodies', async () => {
  assert.equal((await app.request('POST', '/chat-safety/block', { token: a.token, body: { messageId: message.id } })).status, 204);
  const history = await app.request('GET', `/chat/${group.id}`, { token: a.token });
  assert.equal(history.body.chat.messages.length, 0);
  const chats = await app.request('GET', '/chat', { token: a.token });
  assert.ok(!chats.body.chats.some(c => c.id === direct.id));
  assert.equal(chats.body.chats.find(c => c.id === group.id).lastMessage, undefined);
  assert.equal((await send(b.token, direct.id, 'blocked direct')).status, 403);
  assert.equal((await app.request('POST', '/chat', { token: b.token, body: { type: 'PERSONAL', participantIds: [{ userId: seed.a.owner.id, userType: 'CUSTOMER' }] } })).status, 403);
  const socket = await app.connectSocket(a.token);
  socket.emit('join_chat', group.id); await setTimeout(60);
  await send(b.token, group.id, 'blocked live fixture'); await setTimeout(60);
  assert.ok(!socket.received.some(e => e.event === 'message_received'));
  const own = await send(a.token, group.id, 'own visible fixture'); assert.equal(own.status, 201);
  const block = (await app.request('GET', '/chat-safety', { token: a.token })).body.blocks[0];
  assert.equal((await app.request('DELETE', `/chat-safety/block/${block.id}`, { token: b.token })).status, 204);
  assert.equal(await db.userBlock.count(), 1);
  await app.request('DELETE', `/chat-safety/block/${block.id}`, { token: a.token });
  assert.equal((await send(b.token, direct.id, 'allowed after unblock')).status, 201);
});

test('moderation removes reported content from histories and summaries and records a decision', async () => {
  const report = await db.contentReport.findFirst();
  assert.equal((await app.request('POST', `/chat-safety/reports/${report.id}/resolve`, { token: a.token, body: { action: 'REMOVE', note: 'Fixture removal' } })).status, 403);
  assert.equal((await app.request('POST', `/chat-safety/reports/${report.id}/resolve`, { token: admin.token, body: { action: 'REMOVE', note: 'Fixture removal' } })).status, 204);
  const messages = (await app.request('GET', `/chat/${group.id}`, { token: a.token })).body.chat.messages;
  assert.ok(!messages.some(m => m.id === message.id));
  assert.equal((await db.contentReport.findUnique({ where: { id: report.id } })).status, 'RESOLVED');
});

test('chat attachment sharing requires uploader ownership and private file requests require chat access', async () => {
  await db.chatUpload.create({ data: { filename: 'fixture.jpg', uploaderId: seed.b.owner.id, uploaderType: 'CUSTOMER' } });
  assert.equal((await send(a.token, group.id, 'stolen', { attachmentUrl: '/uploads/chat/fixture.jpg' })).status, 403);
  assert.equal((await send(a.token, group.id, 'remote', { attachmentUrl: 'https://unrelated.test/x.jpg' })).status, 403);
  assert.equal((await app.request('GET', '/uploads/chat/fixture.jpg')).status, 401);
  await send(b.token, seed.b.shop.groupChatId, 'private attachment', { attachmentUrl: '/uploads/chat/fixture.jpg' });
  assert.equal((await app.request('GET', '/uploads/chat/fixture.jpg', { token: a.token })).status, 404);
});

test('socket clients cannot relay a forged message or sender identity', async () => {
  const socketA = await app.connectSocket(a.token), socketB = await app.connectSocket(b.token);
  socketA.emit('join_chat', group.id); socketB.emit('join_chat', group.id); await setTimeout(60);
  socketB.emit('new_message', { chatId: group.id, content: 'spoofed', senderId: seed.admin.id, senderType: 'ADMIN' });
  await setTimeout(60);
  assert.ok(!socketA.received.some(e => e.event === 'message_received' && e.payload.content === 'spoofed'));
});

test('deleting a legacy message cannot unlink arbitrary files or another message attachment', async () => {
  const filename = `release-fixture-${crypto.randomUUID()}.txt`;
  const protectedFile = `tests/${filename}`;
  const attachment = `uploads/chat/${filename}`;
  await fs.mkdir('uploads/chat', { recursive: true });
  await fs.writeFile(protectedFile, 'keep');
  await fs.writeFile(attachment, 'shared');
  await db.chatUpload.create({ data: { filename, uploaderId: seed.a.owner.id, uploaderType: 'CUSTOMER' } });
  try {
    const data = { chatId: group.id, senderId: seed.a.owner.id, senderType: 'CUSTOMER', content: 'Synthetic cleanup fixture' };
    const malicious = await db.message.create({ data: { ...data, attachmentUrl: protectedFile } });
    assert.equal((await app.request('DELETE', `/chat/message/${malicious.id}`, { token: a.token })).status, 200);
    assert.equal(await fs.readFile(protectedFile, 'utf8'), 'keep');
    const first = await db.message.create({ data: { ...data, attachmentUrl: `/${attachment}` } });
    const second = await db.message.create({ data: { ...data, attachmentUrl: `/${attachment}` } });
    await app.request('DELETE', `/chat/message/${first.id}`, { token: a.token });
    assert.equal(await fs.readFile(attachment, 'utf8'), 'shared');
    await app.request('DELETE', `/chat/message/${second.id}`, { token: a.token });
    await assert.rejects(fs.stat(attachment), { code: 'ENOENT' });
  } finally {
    await fs.unlink(protectedFile).catch(() => {});
    await fs.unlink(attachment).catch(() => {});
  }
});
