import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, ListObjectVersionsCommand } from '@aws-sdk/client-s3';

export const MAX_CHAT_ATTACHMENT_BYTES = 20 * 1024 * 1024;
const defaultRoot = fileURLToPath(new URL('../../uploads/chat/', import.meta.url));
const safeFilename = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,254}$/.test(value) && value !== '.' && value !== '..';
const fail = message => Object.assign(new Error(message), { code: 'CHAT_STORAGE_CONFIGURATION' });
const missing = error => error?.code === 'ENOENT' || error?.name === 'NoSuchKey' || error?.name === 'NotFound' || error?.$metadata?.httpStatusCode === 404;

const mimeExtensions = {
  'image/jpeg': '.jpg', 'image/jpg': '.jpg', 'image/png': '.png', 'image/gif': '.gif', 'image/webp': '.webp',
  'application/pdf': '.pdf', 'application/msword': '.doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
  'application/vnd.ms-excel': '.xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx', 'text/plain': '.txt',
};
const extensionMime = Object.fromEntries(Object.entries(mimeExtensions).map(([mime, extension]) => [extension, mime]));
extensionMime['.jpg'] = 'image/jpeg';
extensionMime['.jpeg'] = 'image/jpeg';

export function chatAttachmentType(originalname, mimetype) {
  const extension = path.extname(originalname || '').toLowerCase();
  const safeExtension = mimeExtensions[mimetype] || (extensionMime[extension] && extension);
  if (!safeExtension) return null;
  return { extension: safeExtension, contentType: extensionMime[safeExtension], type: safeExtension.match(/^\.(jpe?g|png|gif|webp)$/) ? 'IMAGE' : 'DOCUMENT' };
}

// URLs are identifiers, never filesystem paths or remote URLs to fetch. Legacy
// absolute API URLs map to the same private, server-owned filename.
export function attachmentFilename(value) {
  if (typeof value !== 'string' || /[\\\u0000-\u001f]/.test(value)) return null;
  const match = /^(?:https?:\/\/[^/?#]+)?\/(?:api\/)?uploads\/chat\/([a-zA-Z0-9][a-zA-Z0-9._-]{0,254})(?:[?#].*)?$/.exec(value);
  return match && safeFilename(match[1]) ? match[1] : null;
}

export function attachmentReferenceFilter(filename) {
  if (!safeFilename(filename)) throw fail('Invalid chat attachment filename');
  const suffix = `/uploads/chat/${filename}`;
  // Conservative matching also preserves historical URLs with query/hash
  // parameters; a false-positive holds a file rather than deleting shared data.
  return { OR: [
    { attachmentUrl: { endsWith: suffix } },
    { attachmentUrl: { contains: `${suffix}?` } },
    { attachmentUrl: { contains: `${suffix}#` } },
  ] };
}

function endpointIdentity(value) {
  if (!value) return 'aws';
  let url;
  try { url = new URL(value); } catch { throw fail('CHAT_S3_ENDPOINT must be an HTTP(S) origin'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw fail('CHAT_S3_ENDPOINT must be an HTTP(S) origin without credentials or paths');
  }
  return url.origin;
}

export function chatStorageConfig(env = process.env) {
  const provider = env.CHAT_STORAGE_PROVIDER || 'local';
  if (!['local', 's3'].includes(provider)) throw fail('CHAT_STORAGE_PROVIDER must be local or s3');
  const root = env.CHAT_STORAGE_ROOT || defaultRoot;
  if (!path.isAbsolute(root) || path.resolve(root) === path.parse(root).root) throw fail('CHAT_STORAGE_ROOT must be an absolute attachment directory');
  const prefix = env.CHAT_S3_PREFIX || 'chat';
  if (!/^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*$/.test(prefix)) throw fail('CHAT_S3_PREFIX must contain safe path segments');
  const endpoint = endpointIdentity(env.CHAT_S3_ENDPOINT);
  const bucket = env.CHAT_S3_BUCKET;
  if (bucket && !/^[a-zA-Z0-9][a-zA-Z0-9.-]{1,253}$/.test(bucket)) throw fail('CHAT_S3_BUCKET is invalid');
  if (provider === 's3' && !bucket) throw fail('CHAT_S3_BUCKET is required for S3 storage');
  const timeoutMs = Number(env.CHAT_STORAGE_TIMEOUT_MS || 15000);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 120000) throw fail('CHAT_STORAGE_TIMEOUT_MS must be 1000–120000');
  if (env.CHAT_S3_FORCE_PATH_STYLE && !['true', 'false'].includes(env.CHAT_S3_FORCE_PATH_STYLE)) throw fail('CHAT_S3_FORCE_PATH_STYLE must be true or false');
  if (env.CHAT_S3_CONDITIONAL_WRITES && !['true', 'false'].includes(env.CHAT_S3_CONDITIONAL_WRITES)) throw fail('CHAT_S3_CONDITIONAL_WRITES must be true or false');
  const conditionalWrites = env.CHAT_S3_CONDITIONAL_WRITES !== 'false';
  const versioning = env.CHAT_S3_VERSIONING || 'auto';
  if (!['auto', 'disabled'].includes(versioning)) throw fail('CHAT_S3_VERSIONING must be auto or disabled');
  return { provider, root: path.resolve(root), prefix, bucket, endpoint, timeoutMs, versioning, conditionalWrites,
    region: env.CHAT_S3_REGION || env.AWS_REGION || 'us-east-1', forcePathStyle: env.CHAT_S3_FORCE_PATH_STYLE === 'true' };
}

// Keep descriptors independent of ChatUpload's owner fields for durable jobs.
export function attachmentStorageDescriptor(upload) {
  const { filename, storageProvider = null, storageKey = null, storageBucket = null,
    storageEndpoint = null, storageVersionId = null, contentType = null } = upload;
  return { filename, storageProvider, storageKey, storageBucket, storageEndpoint, storageVersionId, contentType };
}

export function createChatStorage({ env = process.env, client } = {}) {
  const config = chatStorageConfig(env);
  let s3 = client;
  const s3Client = () => s3 ||= new S3Client({
    region: config.region, ...(config.endpoint !== 'aws' && { endpoint: config.endpoint }),
    forcePathStyle: config.forcePathStyle, maxAttempts: config.conditionalWrites ? 3 : 1,
    // The default credential chain supports IAM roles, workload identities and
    // standard AWS_* environment variables without saving credentials in rows.
    requestChecksumCalculation: 'WHEN_REQUIRED', responseChecksumValidation: 'WHEN_REQUIRED',
  });
  const send = (command, abortSignal = AbortSignal.timeout(config.timeoutMs)) => s3Client().send(command, { abortSignal });
  const location = upload => {
    if (!safeFilename(upload?.filename)) throw fail('Invalid chat attachment filename');
    const provider = upload.storageProvider || 'local';
    if (provider === 'local') {
      if (upload.storageKey && upload.storageKey !== upload.filename) throw fail('Unsafe local chat attachment key');
      return { provider, file: path.join(config.root, upload.filename) };
    }
    if (provider !== 's3' || !upload.storageBucket || !upload.storageKey || !upload.storageEndpoint) throw fail('Incomplete chat object storage descriptor');
    if (upload.storageEndpoint !== config.endpoint) throw fail('Chat object endpoint differs from configured storage; restore the original provider configuration');
    if (!/^[a-zA-Z0-9][a-zA-Z0-9.-]{1,253}$/.test(upload.storageBucket)
      || !/^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*\/[a-zA-Z0-9][a-zA-Z0-9._-]{0,254}$/.test(upload.storageKey)
      || path.posix.basename(upload.storageKey) !== upload.filename) throw fail('Unsafe chat object storage descriptor');
    return { provider, Bucket: upload.storageBucket, Key: upload.storageKey, ...(upload.storageVersionId && { VersionId: upload.storageVersionId }) };
  };
  return {
    config,
    async put({ buffer, originalname, mimetype, onPrepared }) {
      if (!Buffer.isBuffer(buffer) || buffer.length > MAX_CHAT_ATTACHMENT_BYTES) throw new Error('Invalid chat attachment size');
      const type = chatAttachmentType(originalname, mimetype);
      if (!type) throw new Error('Unsupported chat attachment type');
      const filename = `chat-${randomUUID()}${type.extension}`;
      const descriptor = { filename, storageProvider: config.provider, storageKey: config.provider === 's3' ? `${config.prefix}/${filename}` : filename,
        storageBucket: config.provider === 's3' ? config.bucket : null, storageEndpoint: config.provider === 's3' ? config.endpoint : null,
        storageVersionId: null, contentType: type.contentType };
      // Record ownership before writing bytes, so a failed request still leaves
      // an auditable, retryable orphan for retention rather than an unknown file.
      await onPrepared?.(descriptor);
      if (config.provider === 'local') {
        await fs.mkdir(config.root, { recursive: true, mode: 0o700 });
        await fs.writeFile(location(descriptor).file, buffer, { flag: 'wx', mode: 0o600 });
      } else {
        const result = await send(new PutObjectCommand({ Bucket: config.bucket, Key: descriptor.storageKey,
          Body: buffer, ContentType: type.contentType, ContentLength: buffer.length, ...(config.conditionalWrites && { IfNoneMatch: '*' }) }));
        descriptor.storageVersionId = result.VersionId || null;
      }
      return { ...descriptor, url: `/uploads/chat/${filename}`, type: type.type };
    },
    async open(upload) {
      const target = location(upload);
      try {
        if (target.provider === 'local') {
          // O_NOFOLLOW disallows a symlink upload from exposing another file.
          const handle = await fs.open(target.file, constants.O_RDONLY | constants.O_NOFOLLOW);
          try {
            const stat = await handle.stat();
            if (!stat.isFile()) throw fail('Chat attachment is not a regular file');
            return { stream: handle.createReadStream({ autoClose: true }), size: stat.size,
              contentType: upload.contentType || extensionMime[path.extname(upload.filename).toLowerCase()] || 'application/octet-stream' };
          } catch (error) { await handle.close(); throw error; }
        }
        const { provider: _provider, ...input } = target;
        const result = await send(new GetObjectCommand(input));
        if (!result.Body) throw fail('Chat object storage returned an empty response');
        return { stream: result.Body, size: result.ContentLength, contentType: upload.contentType || result.ContentType || 'application/octet-stream' };
      } catch (error) { if (missing(error)) return null; throw error; }
    },
    async delete(upload) {
      const target = location(upload);
      // One deadline for the whole operation, including version pagination, so
      // the caller's DB lock transaction can safely budget a bounded duration.
      const abortSignal = AbortSignal.timeout(config.timeoutMs);
      try {
        if (target.provider === 'local') await fs.unlink(target.file);
        else {
          const { provider: _provider, ...input } = target;
          if (input.VersionId) {
            // Delete the recorded version itself, not a marker concealing bytes.
            await send(new DeleteObjectCommand(input), abortSignal);
          } else if (config.versioning === 'disabled') {
            // Explicitly configured for providers without object versioning,
            // e.g. R2. Never silently assume this after an S3 API failure.
            await send(new DeleteObjectCommand(input), abortSignal);
          } else {
            // A successful PUT can lose its response, leaving the version ID
            // unknown. Only our immutable random UUID keys may be recovered this
            // way. No prefix-wide deletes, user keys, or neighboring objects.
            if (!/^chat-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.[a-z0-9]+$/.test(upload.filename)) {
              throw fail('Unknown object version requires a generated chat attachment key');
            }
            const versions = new Set();
            let marker, versionMarker, truncated;
            for (let page = 0; page < 10; page++) {
              const result = await send(new ListObjectVersionsCommand({ Bucket: input.Bucket, Prefix: input.Key,
                ...(marker && { KeyMarker: marker }), ...(versionMarker && { VersionIdMarker: versionMarker }) }), abortSignal);
              for (const version of [...(result.Versions || []), ...(result.DeleteMarkers || [])]) {
                if (version.Key === input.Key && typeof version.VersionId === 'string' && version.VersionId) versions.add(version.VersionId);
              }
              truncated = result.IsTruncated;
              if (!truncated) break;
              if (!result.NextKeyMarker || (result.NextKeyMarker === marker && result.NextVersionIdMarker === versionMarker)) {
                throw fail('Chat object version listing did not advance');
              }
              marker = result.NextKeyMarker; versionMarker = result.NextVersionIdMarker;
            }
            if (truncated) throw fail('Chat object version listing exceeded its safe limit');
            for (const VersionId of versions) await send(new DeleteObjectCommand({ ...input, VersionId }), abortSignal);
          }
        }
      } catch (error) { if (!missing(error)) throw error; }
    },
    close() { s3?.destroy?.(); },
  };
}

let activeStorage, activeConfig;
export function getChatStorage() {
  const signature = JSON.stringify(chatStorageConfig());
  if (!activeStorage || signature !== activeConfig) {
    activeStorage?.close();
    activeStorage = createChatStorage();
    activeConfig = signature;
  }
  return activeStorage;
}
export const deleteAttachment = upload => getChatStorage().delete(upload);

export async function readAttachmentBuffer(upload, { storage = getChatStorage(), maxBytes = MAX_CHAT_ATTACHMENT_BYTES } = {}) {
  const file = await storage.open(upload);
  if (!file) return null;
  try {
    if (file.size > maxBytes) throw new Error('Chat attachment exceeds allowed size');
    const chunks = [];
    let length = 0;
    for await (const chunk of file.stream) {
      length += chunk.length;
      if (length > maxBytes) throw new Error('Chat attachment exceeds allowed size');
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  } finally { file.stream.destroy?.(); }
}
