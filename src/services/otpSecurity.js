import crypto from 'node:crypto';
import redisService from './redisService.js';
import { jwtSecret } from './sessionSecurity.js';

export const OTP_TTL_SECONDS = 600;
export const OTP_MAX_ATTEMPTS = 5;
export const OTP_RESEND_COOLDOWN = 60;
export const otpKey = (kind, email) => `otp:${kind}:${email}`;
const hashOtp = (email, code) => crypto.createHmac('sha256', jwtSecret()).update(`${email}:${code}`).digest('hex');
const parse = entry => { try { return entry?.type === 'string' ? JSON.parse(entry.value) : null; } catch { return null; } };

// The durable PostgreSQL-backed cache holds a per-key transaction lock. Redis
// outages and multiple workers cannot reset attempt counts or consume a proof twice.
export async function reserveOtpDelivery(kind, email, cache = redisService, now = Date.now()) {
  return cache.change(`otp_cd:${kind}:${email}`, entry => {
    const until = Number(entry?.value || 0);
    if (until > now) return { entry, result: Math.ceil((until - now) / 1000) };
    const expiresAt = new Date(now + OTP_RESEND_COOLDOWN * 1000);
    return { entry: { type: 'string', value: String(+expiresAt), expiresAt }, result: 0 };
  });
}

export async function issueOtp(kind, email, cache = redisService, now = Date.now()) {
  const code = crypto.randomInt(100000, 1000000).toString();
  await cache.set(otpKey(kind, email), { hash: hashOtp(email, code), attempts: 0, expiresAt: now + OTP_TTL_SECONDS * 1000 }, OTP_TTL_SECONDS);
  return code;
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
