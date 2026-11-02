import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import express from 'express';
import sharp from 'sharp';
import secureUpload from '../src/middleware/secureUpload.js';
import { validateUploadBuffer, safeImageBarcode, MAX_IMAGE_PIXELS } from '../src/services/uploadValidation.js';

const png = () => sharp({ create: { width: 3, height: 2, channels: 4, background: '#fe0040ff' } }).png().toBuffer();
test('uploaded raster bytes are decoded and re-encoded; names and MIME cannot authorize active content', async () => {
  for (const source of ['<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>', '<html><script>alert(1)</script></html>', '#!/bin/sh\necho unsafe']) {
    await assert.rejects(validateUploadBuffer(Buffer.from(source), { originalname: 'photo.jpg' }), { code: 'INVALID_UPLOAD' });
  }
  const image = await png();
  const valid = await validateUploadBuffer(Buffer.concat([image, Buffer.from('<script>attack</script>')]), { originalname: '../../attack.html' });
  assert.equal(valid.extension, '.png'); assert.equal(valid.contentType, 'image/png');
  assert.equal(valid.buffer.includes(Buffer.from('<script>')), false);
  assert.equal((await sharp(valid.buffer).metadata()).width, 3);
});
test('truncated images, decompression bombs, oversize files and documents in image fields are rejected', async () => {
  const image = await png();
  await assert.rejects(validateUploadBuffer(image.subarray(0, 16)), { code: 'INVALID_UPLOAD' });
  await assert.rejects(validateUploadBuffer(image, { maxBytes: 1 }), { code: 'INVALID_UPLOAD' });
  const bomb = await sharp({ create: { width: 7000, height: 7000, channels: 3, background: 'white' } }).png().toBuffer();
  assert.ok(7000 * 7000 > MAX_IMAGE_PIXELS);
  await assert.rejects(validateUploadBuffer(bomb), { code: 'INVALID_UPLOAD' });
  await assert.rejects(validateUploadBuffer(Buffer.from('%PDF-1.7\n%%EOF'), { originalname: 'fake.jpg' }), { code: 'INVALID_UPLOAD' });
  const pdf = await validateUploadBuffer(Buffer.from('%PDF-1.7\n%%EOF'), { allowed: ['pdf'] });
  assert.equal(pdf.extension, '.pdf');
});
test('text documents require valid text and generated image paths reject traversal', async () => {
  const text = await validateUploadBuffer(Buffer.from('safe document'), { originalname: 'notes.txt', allowed: ['document'] });
  assert.equal(text.contentType, 'text/plain');
  await assert.rejects(validateUploadBuffer(Buffer.from([0, 1, 2]), { originalname: 'notes.txt', allowed: ['document'] }));
  for (const value of ['../../secret', 'a/b', 'a\\b', '.', '..', '/etc/passwd', 'a\0b', 'a.html.png', '']) assert.equal(safeImageBarcode(value), false);
  assert.equal(safeImageBarcode('1234567890123'), true);
});
test('multipart validation occurs before disk write and accepted filenames are random safe extensions', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'paymi-security-upload-'));
  const app = express();
  const upload = secureUpload({ storage: secureUpload.diskStorage({ destination: dir, filename: (_req,file,done) => done(null,file.originalname) }), limits: { fileSize: 1024 * 1024 } });
  app.post('/upload', upload.single('image'), (req,res) => res.json({ filename: req.file.filename, mime: req.file.mimetype }));
  app.use((error,_req,res,_next) => res.status(error.status || 400).json({ error: error.code }));
  const server = http.createServer(app); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await fs.rm(dir, { recursive: true, force: true }); });
  const send = async (bytes, filename, type) => { const form = new FormData(); form.append('image', new Blob([bytes], { type }), filename); return fetch(`http://127.0.0.1:${server.address().port}/upload`, { method: 'POST', body: form }); };
  const malicious = await send(Buffer.from('<script>attack</script>'), 'attack.jpg', 'image/jpeg');
  assert.equal(malicious.status, 400); await malicious.arrayBuffer(); assert.deepEqual(await fs.readdir(dir), []);
  const valid = await send(await png(), '../../attack.html', 'image/png');
  assert.equal(valid.status, 200); const saved = await valid.json();
  assert.match(saved.filename, /^upload-[a-f0-9-]{36}\.png$/); assert.equal(saved.mime, 'image/png');
  assert.deepEqual(await fs.readdir(dir), [saved.filename]);
});
