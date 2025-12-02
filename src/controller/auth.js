


import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import nodemailer from 'nodemailer';
import crypto from 'crypto';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

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
    
    // Generate JWT
    const token = jwt.sign(
      {
        id: user.id,
        email: user.email,
        
        userType
      },
      process.env.JWT_SECRET || 'your-secret-key',
      { expiresIn: '24h' }
    );
    
    // CRITICAL: Send token both as cookie AND in response body
    res.cookie('auth_token', token, {
      httpOnly: true,
      maxAge: 24 * 60 * 60 * 1000,
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

const register = async (req, res) => {
  try {
    const { name, email, password } = req.body;
    console.log("Registration attempt:", email);
    
    if (!name || !email || !password) {
      return res.status(400).json({ error: 'Name, email and password are required' });
    }
    
    if (password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters long' });
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
    
    // Create new customer with free trial
    const customer = await prisma.customer.create({
      data: {
        name: name.trim(),
        email: email.trim().toLowerCase(),
        password: hashedPassword,
        mobile: `temp_${Date.now()}`, // Temporary unique mobile number
        subscriptionStatus: 'free_trial', // Set as free trial (lowercase to match schema default)
        trialStartDate: new Date(),
        trialEndDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), // 30 days from now
      }
    });
    
    // Generate JWT
    const token = jwt.sign(
      {
        id: customer.id,
        email: customer.email,
        userType: 'CUSTOMER'
      },
      process.env.JWT_SECRET || 'your-secret-key',
      { expiresIn: '24h' }
    );
    
    // Set cookie and return response
    res.cookie('auth_token', token, {
      httpOnly: true,
      maxAge: 24 * 60 * 60 * 1000,
      secure: false,
      sameSite: 'none',
      path: '/'
    });
    
    const { password: _, ...customerWithoutPassword } = customer;
    return res.status(201).json({
      message: 'Registration successful - Welcome to your free trial!',
      user: { ...customerWithoutPassword, userType: 'CUSTOMER' },
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
          trialEndDate.setDate(trialEndDate.getDate() + 30);
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

// Email transporter configuration
const transporter = nodemailer.createTransport({
  service: 'gmail', // You can use other services like 'outlook', 'yahoo', etc.
  auth: {
    user: process.env.EMAIL_USER || 'your-email@gmail.com', // Add to .env file
    pass: process.env.EMAIL_PASS || 'your-app-password'     // Add to .env file
  }
});

const forgotPassword = async (req, res) => {
  try {
    const { email } = req.body;
    
    if (!email) {
      return res.status(400).json({ error: 'Email is required' });
    }

    // Find user in all tables
    let user = null;
    let userType = null;
    let userTable = null;
    
    user = await prisma.admin.findFirst({ where: { email } });
    if (user) {
      userType = 'ADMIN';
      userTable = 'admin';
    }
    
    if (!user) {
      user = await prisma.empolyee.findFirst({ where: { email } });
      if (user) {
        userType = 'EMPLOYEE';
        userTable = 'empolyee';
      }
    }
    
    if (!user) {
      user = await prisma.customer.findFirst({ where: { email } });
      if (user) {
        userType = 'CUSTOMER';
        userTable = 'customer';
      }
    }

    if (!user) {
      // Don't reveal that user doesn't exist for security
      return res.status(200).json({ 
        success: true, 
        message: 'If this email exists, a password reset link has been sent.' 
      });
    }

    // Generate reset token
    const resetToken = crypto.randomBytes(32).toString('hex');
    const resetTokenExpiry = new Date(Date.now() + 3600000); // 1 hour from now

    // Save reset token to user record
    const updateData = {
      resetToken,
      resetTokenExpiry
    };

    if (userTable === 'admin') {
      await prisma.admin.update({
        where: { id: user.id },
        data: updateData
      });
    } else if (userTable === 'empolyee') {
      await prisma.empolyee.update({
        where: { id: user.id },
        data: updateData
      });
    } else if (userTable === 'customer') {
      await prisma.customer.update({
        where: { id: user.id },
        data: updateData
      });
    }

    // Create reset URL - you can change this to your frontend URL
    const resetURL = `http://192.168.1.13:3000/api/auth/reset-password?token=${resetToken}&email=${encodeURIComponent(email)}`;
    
    // Email content
    const mailOptions = {
      from: process.env.EMAIL_USER || 'noreply@yourapp.com',
      to: email,
      subject: 'Password Reset Request',
      html: `
        <!DOCTYPE html>
        <html>
        <head>
          <style>
            body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
            .container { max-width: 600px; margin: 0 auto; padding: 20px; }
            .header { background-color: #4CAF50; color: white; padding: 20px; text-align: center; }
            .content { padding: 20px; background-color: #f9f9f9; }
            .button { display: inline-block; padding: 10px 20px; background-color: #4CAF50; color: white; text-decoration: none; border-radius: 5px; }
            .footer { margin-top: 20px; font-size: 12px; color: #666; }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="header">
              <h1>Password Reset Request</h1>
            </div>
            <div class="content">
              <p>Hi ${user.name},</p>
              <p>You requested to reset your password. Click the button below to reset it:</p>
              <p style="text-align: center;">
                <a href="${resetURL}" class="button">Reset Password</a>
              </p>
              <p>Or copy and paste this link into your browser:</p>
              <p style="word-break: break-all;">${resetURL}</p>
              <p><strong>This link will expire in 1 hour.</strong></p>
              <p>If you didn't request this password reset, please ignore this email.</p>
            </div>
            <div class="footer">
              <p>This is an automated email. Please do not reply.</p>
            </div>
          </div>
        </body>
        </html>
      `
    };

    // Send email
    await transporter.sendMail(mailOptions);
    
    console.log('Password reset email sent to:', email);
    
    res.status(200).json({
      success: true,
      message: 'Password reset link has been sent to your email.'
    });
    
  } catch (error) {
    console.error('Forgot password error:', error);
    res.status(500).json({ error: 'Failed to send password reset email' });
  }
};

const resetPassword = async (req, res) => {
  try {
    const { token, email, newPassword } = req.query.token ? req.query : req.body;
    
    if (!token || !email) {
      return res.status(400).json({ error: 'Reset token and email are required' });
    }

    // If this is a GET request, show the reset password form
    if (req.method === 'GET') {
      const resetForm = `
        <!DOCTYPE html>
        <html>
        <head>
          <title>Reset Password</title>
          <style>
            body { font-family: Arial, sans-serif; max-width: 500px; margin: 50px auto; padding: 20px; }
            .form-group { margin-bottom: 15px; }
            label { display: block; margin-bottom: 5px; font-weight: bold; }
            input { width: 100%; padding: 10px; border: 1px solid #ddd; border-radius: 4px; box-sizing: border-box; }
            button { background-color: #4CAF50; color: white; padding: 12px 20px; border: none; border-radius: 4px; cursor: pointer; width: 100%; }
            button:hover { background-color: #45a049; }
            .container { background-color: #f9f9f9; padding: 30px; border-radius: 8px; }
            h2 { text-align: center; color: #333; }
            .error { color: red; margin-top: 10px; }
            .success { color: green; margin-top: 10px; }
          </style>
        </head>
        <body>
          <div class="container">
            <h2>Reset Your Password</h2>
            <form id="resetForm">
              <input type="hidden" name="token" value="${token}">
              <input type="hidden" name="email" value="${email}">
              
              <div class="form-group">
                <label for="newPassword">New Password:</label>
                <input type="password" id="newPassword" name="newPassword" required minlength="6">
              </div>
              
              <div class="form-group">
                <label for="confirmPassword">Confirm Password:</label>
                <input type="password" id="confirmPassword" name="confirmPassword" required minlength="6">
              </div>
              
              <button type="submit">Reset Password</button>
              <div id="message"></div>
            </form>
          </div>
          
          <script>
            document.getElementById('resetForm').addEventListener('submit', async (e) => {
              e.preventDefault();
              
              const formData = new FormData(e.target);
              const newPassword = formData.get('newPassword');
              const confirmPassword = formData.get('confirmPassword');
              const messageDiv = document.getElementById('message');
              
              if (newPassword !== confirmPassword) {
                messageDiv.innerHTML = '<p class="error">Passwords do not match!</p>';
                return;
              }
              
              if (newPassword.length < 6) {
                messageDiv.innerHTML = '<p class="error">Password must be at least 6 characters long!</p>';
                return;
              }
              
              try {
                const response = await fetch('/api/auth/reset-password', {
                  method: 'POST',
                  headers: {
                    'Content-Type': 'application/json'
                  },
                  body: JSON.stringify({
                    token: formData.get('token'),
                    email: formData.get('email'),
                    newPassword: newPassword
                  })
                });
                
                const result = await response.json();
                
                if (response.ok) {
                  messageDiv.innerHTML = '<p class="success">' + result.message + '</p>';
                  setTimeout(() => {
                    window.close();
                  }, 3000);
                } else {
                  messageDiv.innerHTML = '<p class="error">' + result.error + '</p>';
                }
              } catch (error) {
                messageDiv.innerHTML = '<p class="error">An error occurred. Please try again.</p>';
              }
            });
          </script>
        </body>
        </html>
      `;
      
      return res.send(resetForm);
    }

    // Handle POST request - actually reset the password
    if (!newPassword) {
      return res.status(400).json({ error: 'New password is required' });
    }

    if (newPassword.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters long' });
    }

    // Find user with valid reset token
    let user = null;
    let userTable = null;
    
    user = await prisma.admin.findFirst({ 
      where: { 
        email,
        resetToken: token,
        resetTokenExpiry: { gte: new Date() }
      } 
    });
    if (user) userTable = 'admin';
    
    if (!user) {
      user = await prisma.empolyee.findFirst({ 
        where: { 
          email,
          resetToken: token,
          resetTokenExpiry: { gte: new Date() }
        } 
      });
      if (user) userTable = 'empolyee';
    }
    
    if (!user) {
      user = await prisma.customer.findFirst({ 
        where: { 
          email,
          resetToken: token,
          resetTokenExpiry: { gte: new Date() }
        } 
      });
      if (user) userTable = 'customer';
    }

    if (!user) {
      return res.status(400).json({ error: 'Invalid or expired reset token' });
    }

    // Hash new password
    const hashedPassword = await bcrypt.hash(newPassword, 12);
    
    // Update password and clear reset token
    const updateData = {
      password: hashedPassword,
      resetToken: null,
      resetTokenExpiry: null
    };

    if (userTable === 'admin') {
      await prisma.admin.update({
        where: { id: user.id },
        data: updateData
      });
    } else if (userTable === 'empolyee') {
      await prisma.empolyee.update({
        where: { id: user.id },
        data: updateData
      });
    } else if (userTable === 'customer') {
      await prisma.customer.update({
        where: { id: user.id },
        data: updateData
      });
    }

    console.log('Password reset successful for:', email);
    
    res.status(200).json({
      success: true,
      message: 'Password has been reset successfully. You can now login with your new password.'
    });
    
  } catch (error) {
    console.error('Reset password error:', error);
    res.status(500).json({ error: 'Failed to reset password' });
  }
};

export { login, register, logout, verify, extendTrialWithPoints, forgotPassword, resetPassword };