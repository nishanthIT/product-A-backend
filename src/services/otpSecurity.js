import crypto from 'node:crypto';
import redisService from './redisService.js';
import { jwtSecret } from './sessionSecurity.js';

export const OTP_TTL_SECONDS = 600;
export const OTP_MAX_ATTEMPTS = 5;
export const OTP_RESEND_COOLDOWN = 60;
export const otpKey = (kind, email) => `otp:${kind}:${email}`;
const hashOtp = (email, code) => crypto.createHmac('sha256', jwtSecret()).update(`${email}:${code}`).digest('hex');
const parse = entry => { try { return entry?.type === 'string' ? JSON.parse(entry.value) : null; } catch { return null; } };
const deliveryRecord = entry => {
  const record = parse(entry);
  // Existing cooldowns from before delivery tracking expire within a minute.
  if (typeof record === 'number') return { until: record, state: 'sent' };
  return record && Number.isFinite(record.until) ? record : null;
};

// The durable PostgreSQL-backed cache holds a per-key transaction lock. Redis
// outages and multiple workers cannot reset attempt counts or consume a proof twice.
export async function reserveOtpDelivery(kind, email, cache = redisService, now = Date.now()) {
  return cache.change(`otp_cd:${kind}:${email}`, entry => {
    const until = deliveryRecord(entry)?.until || 0;
    if (until > now) return { entry, result: Math.ceil((until - now) / 1000) };
    const expiresAt = new Date(now + OTP_RESEND_COOLDOWN * 1000);
    return { entry: { type: 'string', value: JSON.stringify({ until: +expiresAt, state: 'pending' }), expiresAt }, result: 0 };
  });
}

export async function completeOtpDelivery(kind, email, { reservedAt, cache = redisService }) {
  return cache.change(`otp_cd:${kind}:${email}`, entry => {
    const record = deliveryRecord(entry);
    if (record?.until !== reservedAt + OTP_RESEND_COOLDOWN * 1000) return { entry, result: false };
    return { entry: { ...entry, value: JSON.stringify({ ...record, state: 'sent' }) }, result: true };
  });
}

export async function otpDeliveryWasSent(kind, email, cache = redisService, now = Date.now()) {
  return cache.change(`otp_cd:${kind}:${email}`, entry => {
    const record = deliveryRecord(entry);
    return { entry, result: record?.state === 'sent' && record.until > now };
  });
}

export async function issueOtp(kind, email, cache = redisService, now = Date.now()) {
  const code = crypto.randomInt(100000, 1000000).toString();
  await cache.set(otpKey(kind, email), { hash: hashOtp(email, code), attempts: 0, expiresAt: now + OTP_TTL_SECONDS * 1000 }, OTP_TTL_SECONDS);
  return code;
}

// Remove only the failed send's proof and reservation. A slow SMTP failure must
// never delete a later resend's code or cooldown on another worker.
export async function cancelOtpDelivery(kind, email, { code, reservedAt, cache = redisService }) {
  if (code) {
    await cache.change(otpKey(kind, email), entry => {
      const record = parse(entry);
      const ours = record?.hash === hashOtp(email, code)
        && record.expiresAt === reservedAt + OTP_TTL_SECONDS * 1000;
      return { entry: ours ? null : entry };
    });
  }
  await cache.change(`otp_cd:${kind}:${email}`, entry => ({
    entry: deliveryRecord(entry)?.until === reservedAt + OTP_RESEND_COOLDOWN * 1000 ? null : entry,
  }));
}

export async function verifyOtp(kind, email, code, { consume = true, cache = redisService, now = Date.now() } = {}) {
  return cache.change(otpKey(kind, email), entry => {
    const record = parse(entry);
    const invalid = { ok: false, error: 'Invalid or expired verification code. Please request a new one.' };
    if (!record || !/^[a-f0-9]{64}$/.test(record.hash || '') || now >= Number(record.expiresAt) || record.attempts >= OTP_MAX_ATTEMPTS) {
      return { entry: null, result: invalid };
    }
    const expected = Buffer.from(record.hash, 'hex');
    const provided = Buffer.from(hashOtp(email, typeof code === 'string' ? code.trim() : ''), 'hex');
    if (!crypto.timingSafeEqual(expected, provided)) {
      const attempts = (Number(record.attempts) || 0) + 1;
      return { entry: attempts >= OTP_MAX_ATTEMPTS ? null : { ...entry, value: JSON.stringify({ ...record, attempts }) }, result: invalid };
    }
    return { entry: consume ? null : entry, result: { ok: true } };
  });
}
