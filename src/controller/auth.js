import { serviceError } from '../services/serviceErrors.js';
import { verifySessionToken, revokeSessionToken, isInvalidSession } from '../services/sessionTokens.js';
import { jwtSecret, readSessionToken, sessionCookieOptions } from '../services/sessionSecurity.js';



import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { PrismaClient } from '@prisma/client';
import redisService from '../services/redisService.js';
import { sendRegistrationOtpEmail, sendPasswordResetOtpEmail } from '../services/mailService.js';
import { describeAccess, resolvePrincipal } from '../services/accessControl.js';
import { findRegistrationRetry, normalizeRegistration, provisionRegistration, registrationRequestHash } from '../services/supermarketProvisioning.js';

const prisma = new PrismaClient();

// â”€â”€â”€ OTP helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// 6-digit codes, stored hashed in Redis (memory fallback) with a 10 min TTL,
// max 5 verify attempts and a 60s resend cooldown.
const OTP_TTL_SECONDS = 10 * 60;
const OTP_MAX_ATTEMPTS = 5;
const OTP_RESEND_COOLDOWN = 60;

const normalizeEmail = (email) => String(email || '').trim().toLowerCase();

const hashOtp = (email, code) =>
  crypto
    .createHmac('sha256', jwtSecret())
    .update(`${email}:${code}`)
    .digest('hex');

const otpKey = (kind, email) => `otp:${kind}:${email}`;
const otpCooldownKey = (kind, email) => `otp_cd:${kind}:${email}`;

/** Returns remaining cooldown seconds, or 0 if a new code may be sent. */
async function getOtpCooldown(kind, email) {
  const raw = await redisService.get(otpCooldownKey(kind, email));
  if (!raw) return 0;
  const remaining = Math.ceil((Number(raw) - Date.now()) / 1000);
  return remaining > 0 ? remaining : 0;
}

/** Generates, stores and returns a fresh OTP code for `email`. */
async function issueOtp(kind, email) {
  const code = crypto.randomInt(100000, 1000000).toString();
  await redisService.set(
    otpKey(kind, email),
    { hash: hashOtp(email, code), attempts: 0, expiresAt: Date.now() + OTP_TTL_SECONDS * 1000 },
    OTP_TTL_SECONDS
  );
  await redisService.set(
    otpCooldownKey(kind, email),
    String(Date.now() + OTP_RESEND_COOLDOWN * 1000),
    OTP_RESEND_COOLDOWN
  );
  return code;
}

/** Verifies an OTP. On success the code is consumed. Returns { ok, error }. */
async function verifyOtp(kind, email, code, { consume = true } = {}) {
  const record = await redisService.get(otpKey(kind, email), true);
  if (!record || !record.hash || Date.now() > Number(record.expiresAt)) {
    return { ok: false, error: 'This code has expired. Please request a new one.' };
  }
  if (record.attempts >= OTP_MAX_ATTEMPTS) {
    await redisService.del(otpKey(kind, email));
    return { ok: false, error: 'Too many incorrect attempts. Please request a new code.' };
  }

  const expected = Buffer.from(record.hash, 'hex');
  const provided = Buffer.from(hashOtp(email, String(code).trim()), 'hex');
  const matches = expected.length === provided.length && crypto.timingSafeEqual(expected, provided);

  if (!matches) {
    const remainingTtl = Math.max(1, Math.ceil((Number(record.expiresAt) - Date.now()) / 1000));
    await redisService.set(
      otpKey(kind, email),
      { ...record, attempts: (record.attempts || 0) + 1 },
      remainingTtl
    );
    const attemptsLeft = OTP_MAX_ATTEMPTS - (record.attempts || 0) - 1;
    return {
      ok: false,
      error:
        attemptsLeft > 0
          ? `Incorrect code. ${attemptsLeft} attempt${attemptsLeft === 1 ? '' : 's'} remaining.`
          : 'Too many incorrect attempts. Please request a new code.',
    };
  }

  if (consume) await redisService.del(otpKey(kind, email));
  return { ok: true };
}

const login = async (req, res) => {
  try {
    const { password } = req.body;
    const email = normalizeEmail(req.body.email);
    
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }
    
    let user;
    let userType;
    
    // Try to find user in all tables and detect user type automatically
    user = await prisma.admin.findFirst({ where: { email: { equals: email, mode: 'insensitive' } } });
    if (user) {
      userType = 'ADMIN';
    }
    
    if (!user) {
      user = await prisma.empolyee.findFirst({ where: { email: { equals: email, mode: 'insensitive' } } });
      if (user) {
        userType = 'EMPLOYEE';
      }
    }
    
    if (!user) {
      user = await prisma.customer.findFirst({ where: { email: { equals: email, mode: 'insensitive' } } });
      if (user) {
        userType = 'CUSTOMER';
      }
    }
    
    if (!user) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }
    
    
    const isPasswordValid = await bcrypt.compare(password, user.password);
    
    if (!isPasswordValid) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    // Company and shop access come only from memberships, never from the EMPLOYEE type itself.
    const tokenPayload = { id: user.id, email: user.email, userType };
    tokenPayload.sv = user.sessionVersion ?? 0;
    const principal = await resolvePrincipal(tokenPayload);
    if (!principal.user) {
      return res.status(403).json({
        error: principal.error || 'This account has no active access. Please contact your shop owner or administrator.',
        code: principal.code,
      });
    }
    
    // Generate JWT - Extended to 7 days for better mobile UX
    const token = jwt.sign(
      tokenPayload,
      jwtSecret(),
      { expiresIn: '7d', jwtid: crypto.randomUUID() }
    );
    
    // CRITICAL: Send token both as cookie AND in response body
    res.cookie('auth_token', token, { ...sessionCookieOptions(), maxAge: 7 * 24 * 60 * 60 * 1000 });
    const { password: _, resetToken: _rt, resetTokenExpiry: _rte, sessionVersion: _sv, ...userWithoutPassword } = user;
    return res.status(200).json({
      message: 'Login successful',
      user: { ...userWithoutPassword, userType, shopId: principal.user.shopId, ...describeAccess(principal.user) },
      token: token // Send token in response body as backup
    });
  } catch (error) {
    console.error('Login error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

// Step 1 of registration: validate details and email a verification code.
// No account is created until the code is verified in /auth/register.
const sendRegistrationOtp = async (req, res) => {
  try {
    const { name, password } = req.body;
    const email = normalizeEmail(req.body.email);

    if (!name || !email || !password) {
      return res.status(400).json({ error: 'Name, email and password are required' });
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: 'Please enter a valid email address' });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters long' });
    }

    // Check if user already exists in any table
    const [existingAdmin, existingEmployee, existingCustomer] = await Promise.all([
      prisma.admin.findFirst({ where: { email: { equals: email, mode: 'insensitive' } } }),
      prisma.empolyee.findFirst({ where: { email: { equals: email, mode: 'insensitive' } } }),
      prisma.customer.findFirst({ where: { email: { equals: email, mode: 'insensitive' } } }),
    ]);
    if (existingAdmin || existingEmployee || existingCustomer) {
      return res.status(400).json({ error: 'User with this email already exists' });
    }

    const cooldown = await getOtpCooldown('register', email);
    if (cooldown > 0) {
      return res.status(429).json({
        error: `Please wait ${cooldown}s before requesting another code.`,
        retryAfter: cooldown,
      });
    }

    const code = await issueOtp('register', email);
    await sendRegistrationOtpEmail(email, code);

    return res.status(200).json({
      success: true,
      message: 'Verification code sent to your email.',
      resendIn: OTP_RESEND_COOLDOWN,
      expiresIn: OTP_TTL_SECONDS,
    });
  } catch (error) {
    console.error('Send registration OTP error:', error);
    return res.status(500).json({ error: 'Failed to send verification code. Please try again.' });
  }
};

const register = async (req, res) => {
  try {
    const input = normalizeRegistration(req.body);
    const requestHash = registrationRequestHash(input, jwtSecret());
    let result = await findRegistrationRetry(prisma, requestHash, input.password);
    if (!result) {
      // Keep the proof usable after a transaction failure. Consume only after commit.
      const verification = await verifyOtp('register', input.email, input.otp, { consume: false });
      if (!verification.ok) {
        // Another request may have committed and consumed the OTP between our reads.
        result = await findRegistrationRetry(prisma, requestHash, input.password);
        if (!result) return res.status(400).json({ error: verification.error });
      } else {
        const passwordHash = await bcrypt.hash(input.password, 12);
        result = await provisionRegistration(prisma, input, passwordHash, requestHash);
        await redisService.del(otpKey('register', input.email)).catch(() => {});
      }
    }
    const { customer, shop, replayed } = result;
    const token = jwt.sign(
      { id: customer.id, email: customer.email, userType: 'CUSTOMER', sv: customer.sessionVersion ?? 0 },
      jwtSecret(),
      { expiresIn: '7d', jwtid: crypto.randomUUID() }
    );
    res.cookie('auth_token', token, { ...sessionCookieOptions(), maxAge: 7 * 24 * 60 * 60 * 1000 });
    const { password: _, resetToken: _rt, resetTokenExpiry: _rte, shop: _shop, sessionVersion: _sv, ...safeCustomer } = customer;
    return res.status(replayed ? 200 : 201).json({
      message: replayed ? 'Your account and shop are ready.' : 'Your free account and shop are ready.',
      user: { ...safeCustomer, userType: 'CUSTOMER' },
      shop: { id: shop.id, name: shop.name, shopType: shop.shopType },
      token,
    });
  } catch (error) {
    if (error.status) return res.status(error.status).json({ error: error.message, code: error.code });
    console.error('Registration failed:', error.code || error.name);
    return res.status(500).json({ error: 'Unable to complete registration. Please retry.' });
  }
};

const logout = async (req, res) => {
  try {
    const token = readSessionToken(req);
    if (token) await revokeSessionToken(token);
    for (const socket of req.io?.sockets?.sockets?.values() ?? []) {
      if (socket.sessionToken === token) socket.disconnect(true);
    }
  } catch {
    return res.status(503).json({ error: 'Unable to revoke this session. Please retry.' });
  }
  res.clearCookie('auth_token', sessionCookieOptions());
  res.status(200).json({ message: 'Logged out successfully' });
};

const verify = async (req, res) => {
  try {
    // console.log('Cookies received:', req.cookies);
    // console.log('Headers:', req.headers);
    
    // Try to get token from cookie OR authorization header
    const token = readSessionToken(req);

    if (!token) {
      return res.status(401).json({ error: 'Authentication required - No token found' });
    }
    
    const decoded = await verifySessionToken(token);

    if (decoded.userType === 'EMPLOYEE' || decoded.userType === 'ADMIN') {
      const principal = await resolvePrincipal(decoded);
      if (!principal.user) {
        return res.status(principal.status).json({ error: principal.error, code: principal.code });
      }
      const { user } = principal;
      return res.status(200).json({
        user: {
          id: user.id,
          email: user.email,
          userType: user.userType,
          name: user.name,
          shopId: user.shopId,
          ...describeAccess(user)
        }
      });
    }
    
    if( decoded.userType == "CUSTOMER"){
      const [user, principal] = await Promise.all([prisma.customer.findUnique({
        where: { id: decoded.id },
        select: {
          id: true,
          name: true,
          email: true,
          mobile: true,
          shopId: true,
          defaultSupermarketId: true,
          earnings: true,
          subscriptionStatus: true,
          trialStartDate: true,
          trialEndDate: true,
          points: true
        }
      }), resolvePrincipal(decoded, undefined, req.get('X-Supermarket-Id'))]);

      if (!user) return res.status(401).json({ error: 'Account no longer exists', code: 'SESSION_REVOKED' });
      if (!principal.user) return res.status(principal.status).json({ error: principal.error, code: principal.code });
      const subscriptionInfo = { status: 'free', isActive: true, isExpired: false };

      return res.status(200).json({
        user: {
          ...user,
          shopId: principal.user.shopId,
          userType: decoded.userType,
          subscriptionInfo,
          companyAccess: null,
          shopAccess: null
        }
      });
    }
    
    return res.status(401).json({ error: 'Invalid or expired token' });
  } catch (error) {
    if (isInvalidSession(error)) return res.status(401).json({ error: 'Invalid or expired token' });
    console.error('Session validation service unavailable', serviceError(error));
    return res.status(503).json({ error: 'Session verification is temporarily unavailable. Try again.' });
  }
};

const extendTrialWithPoints = (_req, res) => res.status(409).json({ error: 'Paymi is free in this release. Trial extensions are not needed.' });

// â”€â”€â”€ Password reset (OTP) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/** Finds a user by email across all three tables. Returns { user, userTable } or null. */
async function findUserByEmail(email) {
  let user = await prisma.admin.findFirst({ where: { email: { equals: email, mode: 'insensitive' } } });
  if (user) return { user, userTable: 'admin' };
  user = await prisma.empolyee.findFirst({ where: { email: { equals: email, mode: 'insensitive' } } });
  if (user) return { user, userTable: 'empolyee' };
  user = await prisma.customer.findFirst({ where: { email: { equals: email, mode: 'insensitive' } } });
  if (user) return { user, userTable: 'customer' };
  return null;
}

// Step 1: email a 6-digit reset code. Response is identical whether or not
// the account exists, to avoid leaking which emails are registered.
const forgotPassword = async (req, res) => {
  try {
    const email = normalizeEmail(req.body.email);

    if (!email) {
      return res.status(400).json({ error: 'Email is required' });
    }

    const genericResponse = {
      success: true,
      message: 'If this email is registered, a reset code has been sent.',
      resendIn: OTP_RESEND_COOLDOWN,
      expiresIn: OTP_TTL_SECONDS,
    };

    const cooldown = await getOtpCooldown('reset', email);
    if (cooldown > 0) {
      return res.status(429).json({
        error: `Please wait ${cooldown}s before requesting another code.`,
        retryAfter: cooldown,
      });
    }

    const found = await findUserByEmail(email);
    if (!found) {
      // Don't reveal that the user doesn't exist.
      return res.status(200).json(genericResponse);
    }

    const code = await issueOtp('reset', email);
    await sendPasswordResetOtpEmail(email, code);

    return res.status(200).json(genericResponse);
  } catch (error) {
    console.error('Forgot password error:', error);
    return res.status(500).json({ error: 'Failed to send reset code. Please try again.' });
  }
};

// Step 2: verify the code and set the new password.
const resetPassword = async (req, res) => {
  try {
    const { otp, newPassword } = req.body;
    const email = normalizeEmail(req.body.email);

    if (!email || !otp || !newPassword) {
      return res.status(400).json({ error: 'Email, code and new password are required' });
    }

    if (newPassword.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters long' });
    }

    const verification = await verifyOtp('reset', email, otp);
    if (!verification.ok) {
      return res.status(400).json({ error: verification.error });
    }

    const found = await findUserByEmail(email);
    if (!found) {
      return res.status(400).json({ error: 'Account not found' });
    }

    const hashedPassword = await bcrypt.hash(newPassword, 12);
    await prisma[found.userTable].update({
      where: { id: found.user.id },
      data: { password: hashedPassword, sessionVersion: { increment: 1 } },
    });


    for (const socket of req.io?.sockets?.sockets?.values() ?? []) {
      const type = { admin: 'ADMIN', customer: 'CUSTOMER', empolyee: 'EMPLOYEE' }[found.userTable];
      if (socket.claims?.id === found.user.id && socket.claims?.userType === type) socket.disconnect(true);
    }
    return res.status(200).json({
      success: true,
      message: 'Password has been reset successfully. You can now sign in with your new password.',
    });
  } catch (error) {
    console.error('Reset password error:', error);
    return res.status(500).json({ error: 'Failed to reset password' });
  }
};

export { login, register, sendRegistrationOtp, logout, verify, extendTrialWithPoints, forgotPassword, resetPassword };
