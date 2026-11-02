import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { attachmentFilename, attachmentReferenceFilter, attachmentStorageDescriptor, chatStorageConfig,
  chatAttachmentType, createChatStorage, readAttachmentBuffer } from '../src/services/chatStorage.js';

const image = { buffer: Buffer.from('private test attachment'), originalname: '../../camera.jpg', mimetype: 'image/jpeg' };
const cloudEnv = { CHAT_STORAGE_PROVIDER: 's3', CHAT_S3_BUCKET: 'paymi-private-test', CHAT_S3_REGION: 'auto',
  CHAT_S3_ENDPOINT: 'https://objects.example.test', CHAT_S3_PREFIX: 'private/chat' };
const cloudFile = { filename: 'chat-12345678-abcd-4abc-8def-123456789abc.jpg', storageProvider: 's3',
  storageBucket: 'original-private-bucket', storageEndpoint: 'https://objects.example.test',
  storageKey: 'private/chat/chat-12345678-abcd-4abc-8def-123456789abc.jpg', storageVersionId: null, contentType: 'image/jpeg' };
async function localFixture(t, extraEnv = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'paymi-storage-unit-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return { directory, storage: createChatStorage({ env: { ...extraEnv, CHAT_STORAGE_ROOT: path.join(directory, 'attachments') } }) };
}

test('storage configuration is independent of cwd and rejects unsafe or incomplete locations', () => {
  const before = process.cwd();
  const original = chatStorageConfig({}).root;
  try { process.chdir(os.tmpdir()); assert.equal(chatStorageConfig({}).root, original); }
  finally { process.chdir(before); }
  assert.ok(path.isAbsolute(original));
  for (const env of [
    { CHAT_STORAGE_ROOT: 'uploads/chat' }, { CHAT_STORAGE_ROOT: '/' },
    { CHAT_STORAGE_PROVIDER: 'ftp' }, { CHAT_STORAGE_PROVIDER: 's3' },
    { ...cloudEnv, CHAT_S3_PREFIX: '../private' }, { ...cloudEnv, CHAT_S3_PREFIX: '/private' },
    { ...cloudEnv, CHAT_S3_ENDPOINT: 'https://user:secret@objects.example.test' },
    { ...cloudEnv, CHAT_S3_ENDPOINT: 'https://objects.example.test/path' },
    { ...cloudEnv, CHAT_S3_ENDPOINT: 'file:///tmp' },
    { ...cloudEnv, CHAT_S3_CONDITIONAL_WRITES: 'guess' }, { ...cloudEnv, CHAT_S3_VERSIONING: 'guess' }, { CHAT_STORAGE_TIMEOUT_MS: '0' },
    { ...cloudEnv, CHAT_S3_FORCE_PATH_STYLE: 'yes' },
  ]) assert.throws(() => chatStorageConfig(env), { code: 'CHAT_STORAGE_CONFIGURATION' });
});

test('attachment identifiers normalize legacy URLs without accepting paths or URL-encoded traversal', () => {
  for (const url of ['/uploads/chat/a.jpg', '/api/uploads/chat/a.jpg', 'https://legacy.example.test/uploads/chat/a.jpg',
    'http://legacy.example.test/api/uploads/chat/a.jpg?download=1#preview']) assert.equal(attachmentFilename(url), 'a.jpg');
  for (const url of ['/uploads/chat/../secret', '/uploads/chat/..', '/uploads/chat/.', '/uploads/chat/%2e%2e',
    '/uploads/chat/a%2fsecret', '/uploads/chat/a\\secret', 'file:///uploads/chat/a.jpg', '//example.test/uploads/chat/a.jpg',
    '/uploads/chat/nested/a.jpg', '/uploads/chat/a.jpg\n', null, {}]) assert.equal(attachmentFilename(url), null);
  assert.throws(() => attachmentReferenceFilter('../private'), { code: 'CHAT_STORAGE_CONFIGURATION' });
  const filters = attachmentReferenceFilter('a.jpg').OR;
  assert.ok(filters.some(filter => filter.attachmentUrl.endsWith === '/uploads/chat/a.jpg'));
  assert.ok(filters.some(filter => filter.attachmentUrl.contains === '/uploads/chat/a.jpg?'));
  assert.ok(filters.some(filter => filter.attachmentUrl.contains === '/uploads/chat/a.jpg#'));
});

test('local writes record ownership before bytes and keep private permissions and legacy URL contract', async t => {
  const { directory, storage } = await localFixture(t);
  let prepared;
  const saved = await storage.put({ ...image, onPrepared: async descriptor => {
    prepared = { ...descriptor };
    await assert.rejects(fs.stat(path.join(directory, 'attachments', descriptor.filename)), { code: 'ENOENT' });
  } });
  assert.equal(saved.url, `/uploads/chat/${saved.filename}`);
  assert.match(saved.filename, /^chat-[0-9a-f-]+\.jpg$/);
  assert.equal(saved.storageKey, saved.filename);
  assert.equal(saved.contentType, 'image/jpeg');
  assert.equal(prepared.filename, saved.filename);
  const stat = await fs.stat(path.join(directory, 'attachments', saved.filename));
  assert.equal(stat.mode & 0o777, 0o600);
  assert.deepEqual(await readAttachmentBuffer(saved, { storage }), image.buffer);
  await storage.delete(saved);
  await storage.delete(saved); // A retry of a completed delete is harmless.
  assert.equal(await storage.open(saved), null);
});

test('failed ownership reservation writes no file or object', async t => {
  const { storage } = await localFixture(t);
  let descriptor;
  await assert.rejects(storage.put({ ...image, onPrepared: saved => { descriptor = saved; throw new Error('database unavailable'); } }), /database unavailable/);
  assert.equal(await storage.open(descriptor), null);
  const cloud = createChatStorage({ env: cloudEnv, client: { send() { assert.fail('Object written before ownership'); } } });
  await assert.rejects(cloud.put({ ...image, onPrepared: () => { throw new Error('database unavailable'); } }), /database unavailable/);
});

test('legacy null-provider descriptors still use local storage when new uploads switch to S3', async t => {
  const { directory, storage } = await localFixture(t, cloudEnv);
  await fs.mkdir(path.join(directory, 'attachments'));
  await fs.writeFile(path.join(directory, 'attachments', 'legacy.jpg'), 'legacy');
  const legacy = { filename: 'legacy.jpg', storageProvider: null, storageKey: null };
  assert.equal((await readAttachmentBuffer(legacy, { storage })).toString(), 'legacy');
  await storage.delete(legacy);
  assert.equal(await storage.open(legacy), null);
});

test('local storage refuses traversal and symlink reads without touching the target', async t => {
  const { directory, storage } = await localFixture(t);
  await fs.mkdir(path.join(directory, 'attachments'));
  const target = path.join(directory, 'do-not-touch');
  await fs.writeFile(target, 'private non-chat data');
  await fs.symlink(target, path.join(directory, 'attachments', 'link.jpg'));
  await assert.rejects(storage.open({ filename: 'link.jpg' }), { code: 'ELOOP' });
  await storage.delete({ filename: 'link.jpg' }); // unlink only the symlink itself
  assert.equal(await fs.readFile(target, 'utf8'), 'private non-chat data');
  for (const bad of [{ filename: '../do-not-touch' }, { filename: 'safe.jpg', storageKey: '../do-not-touch' }]) {
    await assert.rejects(storage.open(bad), { code: 'CHAT_STORAGE_CONFIGURATION' });
    await assert.rejects(storage.delete(bad), { code: 'CHAT_STORAGE_CONFIGURATION' });
  }
  await fs.mkdir(path.join(directory, 'attachments', 'directory.jpg'));
  await assert.rejects(storage.open({ filename: 'directory.jpg' }), /not a regular file/);
  await assert.rejects(storage.delete({ filename: 'directory.jpg' }));
});

test('supported MIME types produce safe server filenames without trusting client suffixes', () => {
  assert.equal(chatAttachmentType('camera', 'image/jpeg').extension, '.jpg');
  assert.equal(chatAttachmentType('document.docx', 'application/octet-stream').type, 'DOCUMENT');
  assert.equal(chatAttachmentType('malicious.html', 'text/html'), null);
  assert.equal(chatAttachmentType('image.svg', 'image/svg+xml'), null);
  assert.equal(chatAttachmentType('file.exe', 'application/x-msdownload'), null);
});

test('cloud uploads use official commands, conditional immutable keys and private descriptors', async () => {
  const calls = [];
  const storage = createChatStorage({ env: cloudEnv, client: { async send(command, options) {
    calls.push(command); assert.ok(options.abortSignal instanceof AbortSignal);
    return { VersionId: 'uploaded-version-1' };
  } } });
  const saved = await storage.put(image);
  assert.equal(calls[0].constructor.name, 'PutObjectCommand');
  assert.equal(calls[0].input.Bucket, cloudEnv.CHAT_S3_BUCKET);
  assert.equal(calls[0].input.IfNoneMatch, '*');
  assert.equal(calls[0].input.ACL, undefined);
  assert.deepEqual(calls[0].input.Body, image.buffer);
  assert.equal(saved.storageVersionId, 'uploaded-version-1');
  assert.equal(saved.storageEndpoint, cloudEnv.CHAT_S3_ENDPOINT);
  assert.ok(saved.storageKey.startsWith('private/chat/chat-'));
  assert.equal(saved.url, `/uploads/chat/${saved.filename}`);
  const descriptor = attachmentStorageDescriptor({ ...saved, uploaderId: 5, credential: 'do-not-store' });
  assert.equal(descriptor.uploaderId, undefined);
  assert.equal(descriptor.credential, undefined);
  assert.equal(descriptor.storageVersionId, saved.storageVersionId);
});

test('cloud reads and deletes target the recorded bucket and version after defaults change', async () => {
  const calls = [];
  const storage = createChatStorage({ env: { ...cloudEnv, CHAT_S3_BUCKET: 'new-default-bucket' }, client: { async send(command) {
    calls.push(command);
    return command.constructor.name === 'GetObjectCommand' ? { Body: Readable.from([image.buffer]), ContentLength: image.buffer.length } : {};
  } } });
  const descriptor = { ...cloudFile, storageVersionId: 'original-version' };
  assert.deepEqual(await readAttachmentBuffer(descriptor, { storage }), image.buffer);
  await storage.delete(descriptor);
  assert.deepEqual(calls.map(command => command.constructor.name), ['GetObjectCommand', 'DeleteObjectCommand']);
  for (const call of calls) {
    assert.equal(call.input.Bucket, cloudFile.storageBucket);
    assert.equal(call.input.Key, cloudFile.storageKey);
    assert.equal(call.input.VersionId, 'original-version');
  }
});

test('provider endpoint drift and forged storage keys fail before any network request', async () => {
  const storage = createChatStorage({ env: cloudEnv, client: { send() { assert.fail('Invalid descriptor reached provider'); } } });
  for (const descriptor of [
    { ...cloudFile, storageEndpoint: 'https://different-provider.example.test' },
    { ...cloudFile, storageBucket: '../private' }, { ...cloudFile, storageKey: '../secret' },
    { ...cloudFile, storageKey: 'private/chat/other.jpg' }, { ...cloudFile, storageProvider: 'unknown' },
    { ...cloudFile, storageEndpoint: null },
  ]) {
    await assert.rejects(storage.open(descriptor), { code: 'CHAT_STORAGE_CONFIGURATION' });
    await assert.rejects(storage.delete(descriptor), { code: 'CHAT_STORAGE_CONFIGURATION' });
  }
});

test('unknown response versions are removed only for the exact generated key, including paginated delete markers', async () => {
  const calls = [];
  let saved;
  const storage = createChatStorage({ env: cloudEnv, client: { async send(command) {
    calls.push(command);
    if (command.constructor.name === 'PutObjectCommand') throw Object.assign(new Error('Response lost after object write'), { name: 'TimeoutError' });
    if (command.constructor.name === 'ListObjectVersionsCommand') {
      assert.equal(command.input.Prefix, saved.storageKey);
      if (!command.input.KeyMarker) return { Versions: [{ Key: saved.storageKey, VersionId: 'lost-response-version' },
        { Key: `${saved.storageKey}-keep`, VersionId: 'neighbor-version' }], IsTruncated: true,
      NextKeyMarker: saved.storageKey, NextVersionIdMarker: 'lost-response-version' };
      assert.equal(command.input.VersionIdMarker, 'lost-response-version');
      return { DeleteMarkers: [{ Key: saved.storageKey, VersionId: 'old-marker' }], IsTruncated: false };
    }
    return {};
  } } });
  await assert.rejects(storage.put({ ...image, onPrepared: descriptor => { saved = descriptor; } }), /Response lost/);
  assert.equal(saved.storageVersionId, null);
  await storage.delete(saved);
  const deletions = calls.filter(command => command.constructor.name === 'DeleteObjectCommand');
  assert.deepEqual(deletions.map(command => command.input.VersionId), ['lost-response-version', 'old-marker']);
  assert.ok(deletions.every(command => command.input.Key === saved.storageKey));
});

test('unknown version cleanup fails safely on listing errors or non-server filenames and remains retryable', async () => {
  let failure = true, deleted = false;
  const storage = createChatStorage({ env: cloudEnv, client: { async send(command) {
    if (command.constructor.name === 'ListObjectVersionsCommand') {
      if (failure) throw Object.assign(new Error('Permission denied'), { name: 'AccessDenied', $metadata: { httpStatusCode: 403 } });
      return { Versions: [{ Key: cloudFile.storageKey, VersionId: 'version-after-retry' }] };
    }
    deleted = true; return {};
  } } });
  await assert.rejects(storage.delete(cloudFile), { name: 'AccessDenied' });
  assert.equal(deleted, false);
  failure = false;
  await storage.delete(cloudFile);
  assert.equal(deleted, true);
  await assert.rejects(storage.delete({ ...cloudFile, filename: 'user.jpg', storageKey: 'private/chat/user.jpg' }), /generated chat attachment key/);
});

test('explicit unversioned providers use idempotent deletion without unsupported version APIs', async () => {
  const calls = [];
  const storage = createChatStorage({ env: { ...cloudEnv, CHAT_S3_VERSIONING: 'disabled' }, client: { async send(command) {
    calls.push(command); return {};
  } } });
  await storage.delete(cloudFile);
  assert.deepEqual(calls.map(command => command.constructor.name), ['DeleteObjectCommand']);
  assert.equal(calls[0].input.Key, cloudFile.storageKey);
});

test('missing cloud files are harmless but provider failures are never silently treated as missing', async () => {
  let error = Object.assign(new Error('missing'), { name: 'NoSuchKey', $metadata: { httpStatusCode: 404 } });
  const storage = createChatStorage({ env: cloudEnv, client: { async send() { throw error; } } });
  assert.equal(await storage.open(cloudFile), null);
  await storage.delete({ ...cloudFile, storageVersionId: 'gone' });
  error = Object.assign(new Error('denied'), { name: 'AccessDenied', $metadata: { httpStatusCode: 403 } });
  await assert.rejects(storage.open(cloudFile), { name: 'AccessDenied' });
  await assert.rejects(storage.delete({ ...cloudFile, storageVersionId: 'gone' }), { name: 'AccessDenied' });
});

test('bounded evidence reads destroy provider streams when content exceeds the limit', async () => {
  const stream = Readable.from([Buffer.from('123'), Buffer.from('456')]);
  await assert.rejects(readAttachmentBuffer(cloudFile, { maxBytes: 4, storage: { open: async () => ({ stream }) } }), /exceeds allowed size/);
  assert.equal(stream.destroyed, true);
  const large = Readable.from([image.buffer]);
  await assert.rejects(readAttachmentBuffer(cloudFile, { maxBytes: 1, storage: { open: async () => ({ stream: large, size: 100 }) } }), /exceeds allowed size/);
  assert.equal(large.destroyed, true);
});


test('compatible providers can disable conditional PUT without changing generated private object keys', async () => {
  const commands = [];
  const storage = createChatStorage({ env: { ...cloudEnv, CHAT_S3_CONDITIONAL_WRITES: 'false' }, client: { send: async command => { commands.push(command); return {}; } } });
  const result = await storage.put(image);
  assert.equal(storage.config.conditionalWrites, false);
  assert.equal(commands[0].input.IfNoneMatch, undefined);
  assert.match(result.storageKey, /^private\/chat\/chat-[a-f0-9-]+\.jpg$/);
});
