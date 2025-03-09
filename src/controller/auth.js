


import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const login = async (req, res) => {
  try {
    const { email, password, userType } = req.body;
    console.log("Login attempt:", email, userType);
    
    if (!email || !password || !userType) {
      return res.status(400).json({ error: 'Email, password, and user type are required' });
    }
    
    let user;
    
    // switch (userType) {
    //   case 'ADMIN':
    //     user = await prisma.admin.findFirst({ where: { email } });
    //     break;
    //   case 'EMPLOYEE':
    //     user = await prisma.employee.findFirst({ where: { email } });
    //     break;
    //   case 'CUSTOMER':
    //     user = await prisma.customer.findFirst({ where: { email } });
    //     break;
    //   default:
    //     return res.status(400).json({ error: 'Invalid user type' });
    // }
    switch (userType) {
        case 'ADMIN':
          user = await prisma.admin.findFirst({ where: { email } });
          break;
        case 'EMPLOYEE':
          // Debug this line
          
          user = await prisma.empolyee.findFirst({ where: { email } });
          break;
        case 'CUSTOMER':
          user = await prisma.customer.findFirst({ where: { email } });
          break;
        default:
          return res.status(400).json({ error: 'Invalid user type' });
      }
    
    if (!user) {
      return res.status(401).json({ error: 'Invalid credentials - User not found' });
    }
    
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

export { login, logout, verify };