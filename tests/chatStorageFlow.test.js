import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import sharp from 'sharp';
import { validateUploadBuffer } from '../src/services/uploadValidation.js';
const jpegFixture = () => sharp({ create: { width: 2, height: 2, channels: 3, background: '#ef4030' } }).jpeg().toBuffer();
import { getPrisma, resetDatabase, seedBase, startApp } from './helpers/harness.js';
import { runChatRetention, deleteQueuedAttachment } from '../src/services/chatRetention.js';
import { getChatStorage } from '../src/services/chatStorage.js';
import { drainChatWork } from '../src/services/chatBroadcast.js';

// A local S3 protocol fixture exercises the real SDK transport and application
// upload/download/cleanup routes, without credentials or a production bucket.
let db, app, seed, objectServer, token, other, failDelete = false, uncertainPut = false, latePut;
const objects = new Map(), requests = [];
before(async () => {
  await resetDatabase(); db = await getPrisma(); seed = await seedBase(db);
  objectServer = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://fixture.test');
    requests.push({ method: req.method, path: url.pathname, version: url.searchParams.get('versionId') });
    if (req.method === 'PUT') {
      if (objects.has(url.pathname)) { res.writeHead(412); res.end(); return; }
      const parts = []; for await (const part of req) parts.push(part);
      if (uncertainPut) {
        latePut = new Promise(resolve => setTimeout(() => { objects.set(url.pathname, Buffer.concat(parts)); resolve(); }, 100));
        res.writeHead(503, { 'content-type': 'application/xml' }); res.end('<Error><Code>ServiceUnavailable</Code></Error>'); return;
      }
      objects.set(url.pathname, Buffer.concat(parts)); res.setHeader('x-amz-version-id', 'fixture-version-1'); res.writeHead(200); res.end();
    } else if (req.method === 'GET') {
      if (url.searchParams.has('versions')) {
        const prefix = url.searchParams.get('prefix');
        const exists = objects.has(`${url.pathname.replace(/\/$/, '')}/${prefix}`);
        res.setHeader('content-type', 'application/xml');
        res.end(`<ListVersionsResult><IsTruncated>false</IsTruncated>${exists ? `<Version><Key>${prefix}</Key><VersionId>fixture-version-1</VersionId></Version>` : ''}</ListVersionsResult>`); return;
      }
      const content = objects.get(url.pathname);
      if (!content) { res.writeHead(404); res.end(); return; }
      res.setHeader('content-length', content.length); res.setHeader('content-type', 'image/jpeg'); res.end(content);
    } else if (req.method === 'DELETE') {
      if (failDelete) { res.writeHead(403, { 'content-type': 'application/xml' }); res.end('<Error><Code>AccessDenied</Code></Error>'); return; }
      objects.delete(url.pathname); res.writeHead(204); res.end();
    } else { res.writeHead(400); res.end(); }
  });
  await new Promise(resolve => objectServer.listen(0, '127.0.0.1', resolve));
  Object.assign(process.env, { CHAT_STORAGE_PROVIDER: 's3', CHAT_S3_BUCKET: 'private-fixture',
    CHAT_S3_ENDPOINT: `http://127.0.0.1:${objectServer.address().port}`, CHAT_S3_REGION: 'us-east-1', CHAT_S3_FORCE_PATH_STYLE: 'true',
    AWS_ACCESS_KEY_ID: 'fixture-only-key', AWS_SECRET_ACCESS_KEY: 'fixture-only-secret' });
  app = await startApp(); token = (await app.login(seed.a.owner.email, seed.password)).token; other = (await app.login(seed.b.owner.email, seed.password)).token;
});

test('uncertain upload keeps its descriptor until delayed cleanup can remove a late object', async t => {
  t.after(() => { uncertainPut = false; delete process.env.CHAT_S3_CONDITIONAL_WRITES; });
  uncertainPut = true; process.env.CHAT_S3_CONDITIONAL_WRITES = 'false';
  const requestsBefore = requests.length;
  const form = new FormData(); form.append('file', new Blob([await jpegFixture()], { type: 'image/jpeg' }), 'late.jpg');
  const uploaded = await fetch(`${app.origin}/api/chat/upload`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form });
  assert.equal(uploaded.status, 500); await uploaded.arrayBuffer();
  const [upload] = await db.chatUpload.findMany(), [job] = await db.chatAttachmentDeletionJob.findMany();
  assert.ok(upload?.pendingDeletion); assert.equal(job.filename, upload.filename);
  assert.equal(job.storageProvider, 's3'); assert.equal(job.storageVersionId, null);
  assert.ok(+job.nextAttemptAt > Date.now() + 240000);
  assert.equal(requests.slice(requestsBefore).filter(r => r.method === 'DELETE').length, 0);
  assert.equal((await deleteQueuedAttachment(job.filename, { db })).busy, true);
  await latePut; assert.equal(objects.size, 1);
  assert.equal((await deleteQueuedAttachment(job.filename, { db, now: new Date(+job.nextAttemptAt + 1) })).deleted, true);
  assert.equal(objects.size, 0); assert.equal(await db.chatUpload.count(), 0);
  assert.equal(await db.chatAttachmentDeletionJob.count(), 0);
});
after(async () => {
  await app?.close(); getChatStorage().close(); await db?.$disconnect();
  objectServer?.closeAllConnections(); await new Promise(resolve => objectServer?.close(resolve));
});

test('real S3 transport preserves private upload/send/download and shared-file retention, then retries provider deletion', async () => {
  const bytes = await jpegFixture();
  const cleanedBytes = (await validateUploadBuffer(bytes)).buffer;
  const form = new FormData(); form.append('file', new Blob([bytes], { type: 'image/jpeg' }), 'camera.jpg');
  const uploaded = await fetch(`${app.origin}/api/chat/upload`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form });
  assert.equal(uploaded.status, 200); const { file } = await uploaded.json();
  assert.match(file.url, /^\/uploads\/chat\/chat-[a-f0-9-]+\.jpg$/);
  assert.equal(file.url.includes('127.0.0.1'), false);
  const filename = file.url.split('/').at(-1), upload = await db.chatUpload.findUnique({ where: { filename } });
  assert.equal(upload.storageProvider, 's3'); assert.equal(upload.storageVersionId, 'fixture-version-1');
  assert.equal(upload.storageBucket, 'private-fixture'); assert.equal(objects.size, 1);
  const send = () => app.request('POST', '/chat/message', { token, shopId: seed.a.shop.id, body: {
    chatId: seed.a.shop.groupChatId, content: 'camera fixture', messageType: 'IMAGE', attachmentUrl: file.url,
  } });
  const first = await send(), second = await send(); assert.equal(first.status, 201); assert.equal(second.status, 201);
  const download = await fetch(`${app.origin}${file.url}`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(download.status, 200); assert.equal(download.headers.get('cache-control'), 'private, no-store');
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), cleanedBytes);
  const requestsBefore = requests.length;
  const denied = await fetch(`${app.origin}${file.url}`, { headers: { Authorization: `Bearer ${other}` } });
  assert.equal(denied.status, 404); await denied.arrayBuffer(); assert.equal(requests.length, requestsBefore);
  await db.message.update({ where: { id: first.body.message.id }, data: { createdAt: new Date(Date.now() - 40 * 86400000) } });
  const cleaned = await runChatRetention({ db, now: new Date(Date.now() + 10000) });
  assert.equal(cleaned.removed, 1); assert.equal(objects.size, 1, 'newer shared message protects cloud bytes');
  assert.ok(await db.message.findUnique({ where: { id: second.body.message.id } }));
  failDelete = true;
  const deleted = await app.request('DELETE', `/chat/message/${second.body.message.id}`, { token });
  assert.equal(deleted.status, 200); await drainChatWork();
  assert.equal(objects.size, 1); const job = await db.chatAttachmentDeletionJob.findUnique({ where: { filename } });
  assert.equal(job.storageVersionId, 'fixture-version-1'); assert.equal(job.attempts, 1);
  failDelete = false;
  assert.equal((await deleteQueuedAttachment(filename, { db, now: new Date(+job.nextAttemptAt + 1) })).deleted, true);
  assert.equal(objects.size, 0); assert.equal(await db.chatAttachmentDeletionJob.count(), 0);
  assert.equal(await db.chatUpload.count(), 0);
  assert.ok(requests.filter(r => r.method === 'DELETE').every(r => r.version === 'fixture-version-1'));
});
