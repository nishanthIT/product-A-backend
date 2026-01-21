import jwt from 'jsonwebtoken';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// Middleware to verify if the user is authenticated
const isAuthenticated = async (req, res, next) => {
  try {
    // Try to get token from: 1) cookie, 2) authorization header (for localStorage)
    let token = null;
    
    // First check if token exists in cookies
    if (req.cookies && req.cookies.auth_token) {
      token = req.cookies.auth_token;
    } 
    // If not in cookies, check authorization header
    else if (req.headers.authorization && req.headers.authorization.startsWith('Bearer ')) {
      token = req.headers.authorization.split(' ')[1];
    }
    
    if (!token) {
      return res.status(401).json({ error: 'Authentication required - No token found' });
    }
    
    // Verify the token
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'your-secret-key');
    
    // Attach the user info to the request object
    req.user = {
      id: decoded.id,
      email: decoded.email,
      userType: decoded.userType
    };
    
    // For EMPLOYEE userType, fetch additional info from database
    if (decoded.userType === 'EMPLOYEE') {
      const user = await prisma.empolyee.findUnique({
        where: { id: decoded.id },
        select: { name: true }
      });
      
      if (user) {
        req.user.name = user.name;
      }
    }
    
    next();
  } catch (error) {
    console.error('Auth middleware error:', error);
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
};

// Middleware to check if the user is an admin
const isAdmin = async (req, res, next) => {
  try {
    // First make sure the user is authenticated
    if (!req.user) {
      // If isAuthenticated middleware wasn't run first
      return res.status(401).json({ error: 'Authentication required' });
    }
    
    // Check if the user is an admin
    if (req.user.userType === 'ADMIN') {
      return next(); // Allow access if admin
    }
    
    // If not admin, deny access
    return res.status(403).json({ error: 'Access denied. Requires admin privileges' });
  } catch (error) {
    console.error('Admin check error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

// Middleware to check if the user is an employee
const isEmployee = async (req, res, next) => {
  try {
    // First make sure the user is authenticated
    if (!req.user) {
      // If isAuthenticated middleware wasn't run first
      return res.status(401).json({ error: 'Authentication required' });
    }
    
    // Check if the user is an employee or admin (admin has all privileges)
    if (req.user.userType === 'EMPLOYEE' || req.user.userType === 'ADMIN') {
      return next(); // Allow access
    }
    
    // If not employee or admin, deny access
    return res.status(403).json({ error: 'Access denied. Requires employee or admin privileges' });
  } catch (error) {
    console.error('Employee check error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

export { isAuthenticated, isAdmin, isEmployee };