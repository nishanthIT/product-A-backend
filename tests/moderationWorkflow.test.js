import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { getPrisma, resetDatabase, seedBase, startApp } from './helpers/harness.js';
import { activeSuspension } from '../src/services/chatSafety.js';
let db, app, seed, owner, peer, admin, chat, report, evidenceDirectory;
before(async () => {
  await resetDatabase(); db = await getPrisma(); seed = await seedBase(db); app = await startApp();
  owner = await app.login(seed.a.owner.email, seed.password); peer = await app.login(seed.b.owner.email, seed.password); admin = await app.login(seed.admin.email, seed.password);
  chat = await db.chat.create({ data: { type: 'GROUP', name: 'ALL Chat' } });
  evidenceDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'paymi-report-evidence-')); process.env.MODERATION_EVIDENCE_DIR = evidenceDirectory;
});
after(async () => { await app?.close(); await db?.$disconnect(); if (evidenceDirectory) await fs.rm(evidenceDirectory, { recursive: true, force: true }); delete process.env.MODERATION_EVIDENCE_DIR; });
const post = (token, route, body) => app.request('POST', route, { token, body });

test('report snapshots preserve reported content and protected attachments after author deletion', async () => {
  const filename = `safety-${Date.now()}.txt`; const attachmentUrl = `/uploads/chat/${filename}`;
  await fs.mkdir('uploads/chat', { recursive: true }); await fs.writeFile(`uploads/chat/${filename}`, 'synthetic reported file');
  await db.chatUpload.create({ data: { filename, uploaderId: seed.a.owner.id, uploaderType: 'CUSTOMER' } });
  const message = (await post(owner.token, '/chat/message', { chatId: chat.id, content: 'synthetic reported content', attachmentUrl, attachmentName: 'fixture.txt' })).body.message;
  const body = { messageId: message.id, reason: 'CHILD_SAFETY' };
  const responses = await Promise.all([post(peer.token, '/chat-safety/report', body), post(peer.token, '/chat-safety/report', body)]);
  assert.equal(responses[0].status, 202); assert.equal(responses[1].body.id, responses[0].body.id);
  report = responses[0].body;
  await app.request('DELETE', `/chat/message/${message.id}`, { token: owner.token });
  const queued = (await app.request('GET', '/chat-safety/reports', { token: admin.token })).body[0];
  assert.equal(queued.message, null); assert.equal(queued.evidence.content, 'synthetic reported content');
  assert.equal(queued.evidence.attachmentStatus, 'CAPTURED'); assert.equal(queued.reporterId, seed.b.owner.id); assert.equal(queued.reporter.id, seed.b.owner.id); assert.equal(queued.reportedUser.id, seed.a.owner.id); assert.equal(queued.evidence.chatId, chat.id);
  assert.equal((await app.request('GET', `/chat-safety/reports/${report.id}/attachment`, { token: owner.token })).status, 403);
  const download = await fetch(`${app.origin}/api/chat-safety/reports/${report.id}/attachment`, { headers: { Authorization: `Bearer ${admin.token}` } });
  assert.equal(download.status, 200); assert.equal(await download.text(), 'synthetic reported file');
  assert.match(download.headers.get('cache-control'), /no-store/);
});

test('suspension applies to all sessions and uploads/typing while private workspace operations stay accessible', async () => {
  const another = await app.login(seed.a.owner.email, seed.password);
  const socket = await app.connectSocket(another.token), receiver = await app.connectSocket(peer.token);
  socket.emit('join_chat', chat.id); receiver.emit('join_chat', chat.id); await setTimeout(50);
  const body = { minutes: 60, reason: 'Synthetic moderation test' };
  assert.equal((await post(owner.token, `/chat-safety/reports/${report.id}/suspension`, body)).status, 403);
  const result = await post(admin.token, `/chat-safety/reports/${report.id}/suspension`, body); assert.equal(result.status, 200);
  for (const token of [owner.token, another.token]) {
    assert.equal((await post(token, '/chat/message', { chatId: chat.id, content: 'must reject' })).status, 403);
    assert.equal((await post(token, '/chat/upload', {})).status, 403);
    assert.equal((await app.request('GET', '/lists', { token })).status, 200);
  }
  socket.emit('typing_start', { chatId: chat.id }); await setTimeout(70);
  assert.ok(!receiver.received.some(e => e.event === 'user_typing'));
  const saved = await db.chatSuspension.findUnique({ where: { id: result.body.id } });
  assert.ok(await activeSuspension({ id: seed.a.owner.id, userType: 'CUSTOMER' }, db, new Date(+saved.until - 1)));
  assert.equal(await activeSuspension({ id: seed.a.owner.id, userType: 'CUSTOMER' }, db, saved.until), null);
  const extended = await post(admin.token, `/chat-safety/suspensions/${saved.id}/extend`, { minutes: 60, reason: 'Extended fixture review' });
  assert.ok(Date.parse(extended.body.until) > +saved.until);
  assert.equal((await post(admin.token, `/chat-safety/suspensions/${saved.id}/lift`, { reason: 'Fixture appeal granted' })).status, 204);
  assert.equal((await post(owner.token, '/chat/message', { chatId: chat.id, content: 'allowed after lift' })).status, 201);
  // Expiry is read from the database by a new app instance; no in-memory timer is required.
  await db.chatSuspension.update({ where: { id: saved.id }, data: { until: new Date(Date.now() - 1000) } });
  await app.close(); app = await startApp();
  assert.equal((await post(another.token, '/chat/message', { chatId: chat.id, content: 'allowed after restart' })).status, 201);
  assert.equal(await db.chatModerationAction.count({ where: { action: { contains: 'SUSPENSION' } } }), 3);
});

test('removal revokes reused attachment access and notifies active clients, while evidence remains admin-only', async () => {
  const filename = `remove-${Date.now()}.txt`; const attachmentUrl = `/uploads/chat/${filename}`;
  await fs.writeFile(`uploads/chat/${filename}`, 'synthetic file');
  await db.chatUpload.create({ data: { filename, uploaderId: seed.a.owner.id, uploaderType: 'CUSTOMER' } });
  try {
    const first = (await post(owner.token, '/chat/message', { chatId: chat.id, content: 'first', attachmentUrl })).body.message;
    const second = (await post(owner.token, '/chat/message', { chatId: chat.id, content: 'reused', attachmentUrl })).body.message;
    const row = await post(peer.token, '/chat-safety/report', { messageId: first.id, reason: 'ABUSE' });
    const socket = await app.connectSocket(peer.token); socket.emit('join_chat', chat.id); await setTimeout(50);
    assert.equal((await post(admin.token, `/chat-safety/reports/${row.body.id}/resolve`, { action: 'REMOVE', note: 'Synthetic removal test' })).status, 204);
    await setTimeout(50);
    assert.ok(socket.received.some(e => e.event === 'message_deleted' && e.payload.messageId === first.id));
    assert.ok(socket.received.some(e => e.event === 'message_deleted' && e.payload.messageId === second.id));
    assert.equal((await app.request('GET', attachmentUrl, { token: peer.token })).status, 404);
    const history = await app.request('GET', `/chat/${chat.id}`, { token: peer.token });
    assert.ok(!history.body.chat.messages.some(m => [first.id, second.id].includes(m.id)));
  } finally { await fs.unlink(`uploads/chat/${filename}`).catch(() => {}); }
});
