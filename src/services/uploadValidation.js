import path from 'node:path';
import sharp from 'sharp';
import { fileTypeFromBuffer } from 'file-type';

export const MAX_IMAGE_PIXELS = 40_000_000;
const imageFormats = new Set(['jpg', 'png', 'gif', 'webp', 'heic', 'heif', 'avif', 'bmp', 'tif']);
const documentFormats = new Set(['pdf', 'doc', 'docx', 'xls', 'xlsx', 'cfb']);
const videoFormats = new Set(['mp4', 'mov', 'webm', 'm4v', 'avi']);
export const uploadError = () => Object.assign(new Error('Choose a valid supported file within the upload limits.'), { status: 400, code: 'INVALID_UPLOAD' });

// Metadata is untrusted. Identify bytes first, then fully decode/re-encode raster
// files to discard metadata and appended active content. SVG/HTML are never images.
export async function validateUploadBuffer(buffer, { allowed = ['image'], originalname = '', maxBytes = 20 * 1024 * 1024 } = {}) {
  if (!Buffer.isBuffer(buffer) || !buffer.length || buffer.length > maxBytes) throw uploadError();
  let detected;
  try { detected = await fileTypeFromBuffer(buffer); } catch { throw uploadError(); }
  if (detected && imageFormats.has(detected.ext) && allowed.includes('image')) {
    try {
      const input = sharp(buffer, { limitInputPixels: MAX_IMAGE_PIXELS, failOn: 'warning', animated: true });
      const metadata = await input.metadata();
      const pixels = metadata.width * metadata.height;
      if (!Number.isSafeInteger(pixels) || pixels < 1 || pixels > MAX_IMAGE_PIXELS || (metadata.pages || 1) > 100) throw uploadError();
      const format = ['jpeg', 'png', 'gif', 'webp'].includes(metadata.format) ? metadata.format : 'png';
      const cleaned = await input.rotate().toFormat(format).toBuffer();
      if (cleaned.length > maxBytes) throw uploadError();
      const ext = format === 'jpeg' ? 'jpg' : format;
      return { buffer: cleaned, extension: `.${ext}`, contentType: `image/${format}`, kind: 'image' };
    } catch { throw uploadError(); }
  }
  if (detected?.ext === 'pdf' && (allowed.includes('pdf') || allowed.includes('document'))) {
    // Format validation is not malware scanning. PDF is always delivered as an
    // attachment with a sandbox CSP; a scanner is an optional deployment layer.
    if (!buffer.subarray(-2048).includes(Buffer.from('%%EOF'))) throw uploadError();
    return { buffer, extension: '.pdf', contentType: 'application/pdf', kind: 'document' };
  }
  if (detected && documentFormats.has(detected.ext) && allowed.includes('document')) {
    let { ext, mime } = detected;
    if (ext === 'cfb') {
      const requested = path.extname(originalname).toLowerCase();
      if (!['.doc', '.xls'].includes(requested)) throw uploadError();
      ext = requested.slice(1); mime = ext === 'doc' ? 'application/msword' : 'application/vnd.ms-excel';
    }
    return { buffer, extension: `.${ext}`, contentType: mime, kind: 'document' };
  }
  if (detected && videoFormats.has(detected.ext) && allowed.includes('video')) {
    return { buffer, extension: `.${detected.ext}`, contentType: detected.mime, kind: 'video' };
  }
  if (!detected && allowed.includes('document') && path.extname(originalname).toLowerCase() === '.txt') {
    const text = new TextDecoder('utf-8', { fatal: true });
    try { if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text.decode(buffer))) throw uploadError(); } catch { throw uploadError(); }
    return { buffer, extension: '.txt', contentType: 'text/plain', kind: 'document' };
  }
  throw uploadError();
}

export function safeImageBarcode(value) {
  return typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(value);
}
