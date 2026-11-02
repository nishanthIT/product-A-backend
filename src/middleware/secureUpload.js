import { safeLogger } from '../services/safeLogger.js';
const securityLog = safeLogger('middleware/secureUpload.js');
import multer from 'multer';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import fs from 'node:fs/promises';
import { recordSecurityEvent } from '../services/securityProtection.js';
import { validateUploadBuffer, uploadError } from '../services/uploadValidation.js';

// Compatible with existing Multer call sites. No bytes reach a public directory
// until content validation succeeds; names are generated from validated formats.
export default function secureUpload(options = {}) {
  const maxBytes = Math.min(options.limits?.fileSize || 20 * 1024 * 1024, 25 * 1024 * 1024);
  const original = options.storage || multer.memoryStorage();
  const storage = {
    _handleFile(req, file, done) {
      (async () => {
        const chunks = []; let size = 0;
        for await (const chunk of file.stream) {
          size += chunk.length;
          if (size > maxBytes) throw new multer.MulterError('LIMIT_FILE_SIZE');
          chunks.push(chunk);
        }
        if (file.stream.truncated) throw new multer.MulterError('LIMIT_FILE_SIZE');
        const allowed = typeof options.allowedTypes === 'function' ? options.allowedTypes(file) : options.allowedTypes || ['image'];
        const valid = await validateUploadBuffer(Buffer.concat(chunks), { allowed, originalname: file.originalname, maxBytes });
        file.mimetype = valid.contentType;
        file.validatedExtension = valid.extension;
        const validatedFile = { ...file, stream: Readable.from(valid.buffer) };
        original._handleFile(req, validatedFile, (error, info) => {
          if (info?.path) {
            // Validation/business-rule errors must not leave abandoned files.
            resCleanup(req, info.path);
          }
          done(error, info);
        });
      })().catch(async error => {
        if (req.user) await recordSecurityEvent(req, { category: 'upload', severity: 'medium', rule: 'UPLOAD_CONTENT_REJECTED', reason: 'Upload content failed validation', action: 'rejected' }).catch(() => securityLog.warn('Upload rejection audit unavailable'));
        done(error.code === 'LIMIT_FILE_SIZE' ? error : uploadError());
      });
    },
    _removeFile(req, file, done) { original._removeFile(req, file, done); },
  };
  return multer({ ...options, storage,
    limits: { fields: 50, fieldSize: 128 * 1024, files: 12, parts: 62, ...options.limits, fileSize: maxBytes },
  });
}

function resCleanup(req, filename) {
  const response = req.res;
  if (!response) return;
  response.once('finish', () => { if (response.statusCode >= 400) fs.unlink(filename).catch(() => {}); });
  response.once('close', () => { if (!response.writableFinished) fs.unlink(filename).catch(() => {}); });
}
secureUpload.diskStorage = options => multer.diskStorage({ ...options, filename: (_req, file, done) => {
  if (!/^\.[a-z0-9]+$/.test(file.validatedExtension || '')) return done(uploadError());
  done(null, `upload-${crypto.randomUUID()}${file.validatedExtension}`);
} });
secureUpload.memoryStorage = multer.memoryStorage;
secureUpload.MulterError = multer.MulterError;
