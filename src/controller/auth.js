


import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { PrismaClient } from '@prisma/client';
import redisService from '../services/redisService.js';
import { sendRegistrationOtpEmail, sendPasswordResetOtpEmail } from '../services/mailService.js';

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
    .createHmac('sha256', process.env.JWT_SECRET || 'your-secret-key')
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
async function verifyOtp(kind, email, code) {
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

  await redisService.del(otpKey(kind, email));
  return { ok: true };
}

const login = async (req, res) => {
  try {
    const { email, password } = req.body;
    console.log("Login attempt:", email);
    
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }
    
    let user;
    let userType;
    
    // Try to find user in all tables and detect user type automatically
    user = await prisma.admin.findFirst({ where: { email } });
    if (user) {
      userType = 'ADMIN';
    }
    
    if (!user) {
      user = await prisma.empolyee.findFirst({ where: { email } });
      if (user) {
        userType = 'EMPLOYEE';
      }
    }
    
    if (!user) {
      user = await prisma.customer.findFirst({ where: { email } });
      if (user) {
        userType = 'CUSTOMER';
      }
    }
    
    if (!user) {
      return res.status(401).json({ error: 'Invalid credentials - User not found' });
    }
    
    console.log("User found with type:", userType);
    
    const isPasswordValid = await bcrypt.compare(password, user.password);
    
    if (!isPasswordValid) {
      return res.status(401).json({ error: 'Invalid credentials - Password mismatch' });
    }
    
    // Generate JWT - Extended to 7 days for better mobile UX
    const token = jwt.sign(
      {
        id: user.id,
        email: user.email,
        
        userType
      },
      process.env.JWT_SECRET || 'your-secret-key',
      { expiresIn: '7d' }
    );
    
    // CRITICAL: Send token both as cookie AND in response body
    res.cookie('auth_token', token, {
      httpOnly: true,
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days to match JWT expiry
      secure: false, // Only for development
      sameSite: 'none', // Try 'none' instead of 'lax'
      path: '/'
    });
    
    console.log(token)
    const { password: _, ...userWithoutPassword } = user;
    return res.status(200).json({
      message: 'Login successful',
      user: { ...userWithoutPassword, userType },
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
    console.log('Registration OTP requested for:', email);

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
      prisma.admin.findFirst({ where: { email } }),
      prisma.empolyee.findFirst({ where: { email } }),
      prisma.customer.findFirst({ where: { email } }),
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
    console.log('Registration OTP sent to:', email);

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
    const { name, password, otp, shopName, shopAddress, shopMobile } = req.body;
    const email = normalizeEmail(req.body.email);
    console.log("Registration attempt:", email);
    
    if (!name || !email || !password) {
      return res.status(400).json({ error: 'Name, email and password are required' });
    }
    
    if (password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters long' });
    }

    if (!otp) {
      return res.status(400).json({ error: 'Verification code is required' });
    }

    // Verify the emailed code â€” accounts are only created after verification.
    const verification = await verifyOtp('register', email, otp);
    if (!verification.ok) {
      return res.status(400).json({ error: verification.error });
    }
    
    // Check if user already exists in any table
    const existingAdmin = await prisma.admin.findFirst({ where: { email } });
    const existingEmployee = await prisma.empolyee.findFirst({ where: { email } });
    const existingCustomer = await prisma.customer.findFirst({ where: { email } });
    
    if (existingAdmin || existingEmployee || existingCustomer) {
      return res.status(400).json({ error: 'User with this email already exists' });
    }
    
    // Hash password
    const hashedPassword = await bcrypt.hash(password, 12);
    
    // Create a personal shop for the user, using their name if no shop name is provided
    const shopNameToCreate = shopName || `${name}'s Shop`;
    const customerShop = await prisma.shop.create({
      data: {
        name: shopNameToCreate.trim(),
        address: shopAddress?.trim() || '',
        mobile: shopMobile?.trim() || '',
        shopType: 'CUSTOMER' // This is a customer retail shop
      }
    });
    console.log('Created CUSTOMER shop:', customerShop.id);
    
    // Create new customer with free trial
    const customer = await prisma.customer.create({
      data: {
        name: name.trim(),
        email,
        password: hashedPassword,
        mobile: `temp_${Date.now()}`, // Temporary unique mobile number
        subscriptionStatus: 'free_trial', // Set as free trial (lowercase to match schema default)
        trialStartDate: new Date(),
        trialEndDate: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000), // 90 days from now
        shopId: customerShop?.id // Link to the created shop
      }
    });
    
    // If shop was created, create a group chat for it
    if (customerShop) {
      const groupChat = await prisma.chat.create({
        data: {
          name: `${customerShop.name} - Team Chat`,
          type: 'GROUP',
          participants: {
            create: {
              userId: customer.id,
              userType: 'CUSTOMER',
              isAdmin: true
            }
          }
        }
      });
      
      // Update shop with group chat ID
      await prisma.shop.update({
        where: { id: customerShop.id },
        data: { groupChatId: groupChat.id }
      });
    }
    
    // Generate JWT - Extended to 7 days for better mobile UX
    const token = jwt.sign(
      {
        id: customer.id,
        email: customer.email,
        userType: 'CUSTOMER'
      },
      process.env.JWT_SECRET || 'your-secret-key',
      { expiresIn: '7d' }
    );
    
    // Set cookie and return response
    res.cookie('auth_token', token, {
      httpOnly: true,
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days to match JWT expiry
      secure: false,
      sameSite: 'none',
      path: '/'
    });
    
    const { password: _, ...customerWithoutPassword } = customer;
    return res.status(201).json({
      message: 'Registration successful - Welcome to your free trial!',
      user: { ...customerWithoutPassword, userType: 'CUSTOMER' },
      shop: customerShop ? { id: customerShop.id, name: customerShop.name, shopType: 'CUSTOMER' } : null,
      token: token
    });
  } catch (error) {
    console.error('Registration error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

const logout = (req, res) => {
  res.cookie('auth_token', '', {
    httpOnly: true,
    expires: new Date(0),
    secure: false, // Only for development
    sameSite: 'none', // Match login cookie settings
    path: '/'
  });
  res.status(200).json({ message: 'Logged out successfully' });
};

const verify = async (req, res) => {
  try {
    // console.log('Cookies received:', req.cookies);
    // console.log('Headers:', req.headers);
    
    // Try to get token from cookie OR authorization header
    let token = null;
    
    if (req.cookies && req.cookies.auth_token) {
      token = req.cookies.auth_token;
      console.log('Token found in cookie');
    } else if (req.headers.authorization && req.headers.authorization.startsWith('Bearer ')) {
      token = req.headers.authorization.split(' ')[1];
      console.log('Token found in Authorization header');
    }
    
    if (!token) {
      return res.status(401).json({ error: 'Authentication required - No token found' });
    }
    
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'your-secret-key');
    console.log('Token verified, user:', decoded);

    if( decoded.userType == "EMPLOYEE"){
      const user = await prisma.empolyee.findUnique({
        where: { id: decoded.id },
        select: { name: true },
      });

      console.log("hitted employ",user.name)
      return res.status(200).json({
        user: {
          id: decoded.id,
          email: decoded.email,
          userType: decoded.userType,
          name: user.name
        }
      });
    }
    
    if( decoded.userType == "CUSTOMER"){
      const user = await prisma.customer.findUnique({
        where: { id: decoded.id },
        select: {
          id: true,
          name: true,
          email: true,
          mobile: true,
          earnings: true,
          subscriptionStatus: true,
          trialStartDate: true,
          trialEndDate: true,
          points: true
        }
      });

      // Calculate subscription details
      let subscriptionInfo = null;
      if (user && user.subscriptionStatus === 'free_trial') {
        const now = new Date();
        let trialEndDate = user.trialEndDate ? new Date(user.trialEndDate) : null;
        
        if (!trialEndDate && user.trialStartDate) {
          trialEndDate = new Date(user.trialStartDate);
          trialEndDate.setDate(trialEndDate.getDate() + 90);
        }
        
        if (trialEndDate) {
          const daysRemaining = Math.ceil((trialEndDate - now) / (1000 * 60 * 60 * 24));
          subscriptionInfo = {
            daysRemaining: Math.max(0, daysRemaining),
            isExpired: daysRemaining <= 0,
            trialEndDate: trialEndDate.toISOString(),
            status: daysRemaining <= 0 ? 'expired' : 'active',
            points: parseFloat(user.points || 0)
          };
        }
      }

      return res.status(200).json({
        user: {
          ...user,
          userType: decoded.userType,
          subscriptionInfo
        }
      });
    }
    
    return res.status(200).json({
      user: {
        id: decoded.id,
        email: decoded.email,
        userType: decoded.userType,
        name: decoded.name
      }
    });
  } catch (error) {
    console.error('Auth error:', error);
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
};

const extendTrialWithPoints = async (req, res) => {
  try {
    const { days } = req.body;
    const userId = req.user.id;
    
    if (!days || days <= 0) {
      return res.status(400).json({ error: 'Invalid number of days' });
    }

    const customer = await prisma.customer.findUnique({
      where: { id: userId },
      select: {
        points: true,
        subscriptionStatus: true,
        trialEndDate: true,
        trialStartDate: true
      }
    });

    if (!customer) {
      return res.status(404).json({ error: 'Customer not found' });
    }

    const pointsNeeded = days;
    const currentPoints = parseFloat(customer.points || 0);

    if (currentPoints < pointsNeeded) {
      return res.status(400).json({ 
        error: 'Insufficient points',
        pointsNeeded,
        currentPoints,
        shortfall: pointsNeeded - currentPoints
      });
    }

    // Calculate new trial end date
    let currentEndDate = customer.trialEndDate ? new Date(customer.trialEndDate) : null;
    if (!currentEndDate && customer.trialStartDate) {
      currentEndDate = new Date(customer.trialStartDate);
      currentEndDate.setDate(currentEndDate.getDate() + 30);
    }
    
    if (!currentEndDate) {
      currentEndDate = new Date();
    }

    // If trial has already expired, start from today
    const now = new Date();
    if (currentEndDate < now) {
      currentEndDate = now;
    }

    const newEndDate = new Date(currentEndDate);
    newEndDate.setDate(newEndDate.getDate() + days);

    // Update customer
    const updatedCustomer = await prisma.customer.update({
      where: { id: userId },
      data: {
        points: currentPoints - pointsNeeded,
        trialEndDate: newEndDate,
        subscriptionStatus: 'free_trial'
      }
    });

    return res.status(200).json({
      success: true,
      message: `Trial extended by ${days} days`,
      data: {
        daysExtended: days,
        pointsUsed: pointsNeeded,
        remainingPoints: parseFloat(updatedCustomer.points),
        newTrialEndDate: newEndDate.toISOString(),
        daysRemaining: Math.ceil((newEndDate - now) / (1000 * 60 * 60 * 24))
      }
    });
  } catch (error) {
    console.error('Extend trial error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

// â”€â”€â”€ Password reset (OTP) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/** Finds a user by email across all three tables. Returns { user, userTable } or null. */
async function findUserByEmail(email) {
  let user = await prisma.admin.findFirst({ where: { email } });
  if (user) return { user, userTable: 'admin' };
  user = await prisma.empolyee.findFirst({ where: { email } });
  if (user) return { user, userTable: 'empolyee' };
  user = await prisma.customer.findFirst({ where: { email } });
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
    console.log('Password reset code sent to:', email);

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
      data: { password: hashedPassword },
    });

    console.log('Password reset successful for:', email);

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
