import express from 'express';
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';

const router = express.Router();
const prisma = new PrismaClient();

// Middleware to verify JWT token and require Customer (shop owner) role
const authenticateCustomer = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Access token required' });
  }

  jwt.verify(token, process.env.JWT_SECRET || 'your-secret-key', (err, user) => {
    if (err) {
      return res.status(403).json({ error: 'Invalid token' });
    }
    // Accept CUSTOMER userType (shop owners) - they are the administrators in the app
    if (user.userType !== 'CUSTOMER') {
      return res.status(403).json({ error: 'Shop owner access required' });
    }
    req.user = user;
    next();
  });
};

// GET /api/employees - Get all employees created by this customer (shop owner)
router.get('/', authenticateCustomer, async (req, res) => {
  try {
    const customerId = req.user.id;
    
    // Get customer's shop
    const customer = await prisma.customer.findUnique({
      where: { id: customerId },
      select: { shopId: true }
    });

    if (!customer?.shopId) {
      // Return empty list if no shop assigned yet
      return res.json({ success: true, employees: [] });
    }

    const employees = await prisma.empolyee.findMany({
      where: {
        shopId: customer.shopId,
        createdByCustomerId: customerId
      },
      select: {
        id: true,
        name: true,
        email: true,
        phoneNo: true,
        shopId: true,
        createdAt: true,
        lists: {
          select: {
            id: true,
            name: true,
            description: true,
            createdAt: true,
            products: {
              select: { id: true }
            }
          }
        }
      },
      orderBy: { createdAt: 'desc' }
    });

    // Format response with list count
    const formattedEmployees = employees.map(emp => ({
      ...emp,
      listCount: emp.lists.length,
      lists: emp.lists.map(list => ({
        ...list,
        productCount: list.products.length
      }))
    }));

    res.json({ success: true, employees: formattedEmployees });
  } catch (error) {
    console.error('Error fetching employees:', error);
    res.status(500).json({ error: 'Failed to fetch employees' });
  }
});

// POST /api/employees - Create a new employee
router.post('/', authenticateCustomer, async (req, res) => {
  try {
    const customerId = req.user.id;
    const { name, email, password, phoneNo } = req.body;

    // Validation
    if (!name || !email || !password) {
      return res.status(400).json({ error: 'Name, email, and password are required' });
    }

    if (password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }

    // Get customer's shop or create one
    let customer = await prisma.customer.findUnique({
      where: { id: customerId },
      select: { shopId: true, name: true }
    });

    let shopId = customer?.shopId;

    // If no shop, create one automatically
    if (!shopId) {
      const newShop = await prisma.shop.create({
        data: {
          name: `${customer?.name || 'My'}'s Shop`,
          address: 'Not specified',
          mobile: 'Not specified'
        }
      });
      shopId = newShop.id;
      
      // Update customer with shop ID
      await prisma.customer.update({
        where: { id: customerId },
        data: { shopId: newShop.id }
      });
    }

    // Check if email already exists
    const existingEmployee = await prisma.empolyee.findFirst({
      where: { email: email.toLowerCase() }
    });

    if (existingEmployee) {
      return res.status(400).json({ error: 'An employee with this email already exists' });
    }

    // Check if phone exists (if provided)
    if (phoneNo) {
      const existingPhone = await prisma.empolyee.findFirst({
        where: { phoneNo }
      });
      if (existingPhone) {
        return res.status(400).json({ error: 'An employee with this phone number already exists' });
      }
    }

    // Hash password
    const hashedPassword = await bcrypt.hash(password, 12);

    // Create employee
    const employee = await prisma.empolyee.create({
      data: {
        name: name.trim(),
        email: email.toLowerCase().trim(),
        password: hashedPassword,
        phoneNo: phoneNo || `temp_${Date.now()}`, // Generate temp if not provided
        shopId: shopId,
        createdByCustomerId: customerId,
        userType: 'EMPLOYEE'
      },
      select: {
        id: true,
        name: true,
        email: true,
        phoneNo: true,
        shopId: true,
        createdAt: true
      }
    });

    // Get or create shop's group chat
    const shop = await prisma.shop.findUnique({
      where: { id: shopId },
      select: { groupChatId: true, name: true }
    });

    let groupChatId = shop?.groupChatId;

    // Create group chat if doesn't exist
    if (!groupChatId) {
      const groupChat = await prisma.chat.create({
        data: {
          name: `${shop?.name || 'Shop'} Group`,
          type: 'GROUP'
        }
      });
      groupChatId = groupChat.id;

      // Update shop with group chat ID
      await prisma.shop.update({
        where: { id: shopId },
        data: { groupChatId: groupChat.id }
      });

      // Add customer (shop owner) to group chat
      await prisma.chatParticipant.create({
        data: {
          chatId: groupChatId,
          userId: customerId,
          userType: 'CUSTOMER',
          isAdmin: true
        }
      }).catch(err => {
        console.log('Could not add customer to group chat:', err.message);
      });
    }

    // Add employee to shop's group chat
    if (groupChatId) {
      await prisma.chatParticipant.create({
        data: {
          chatId: groupChatId,
          userId: employee.id,
          userType: 'EMPLOYEE',
          isAdmin: false
        }
      }).catch(err => {
        console.log('Could not add employee to group chat:', err.message);
      });
    }

    res.status(201).json({ 
      success: true, 
      message: 'Employee created successfully',
      employee 
    });
  } catch (error) {
    console.error('Error creating employee:', error);
    res.status(500).json({ error: 'Failed to create employee' });
  }
});

// PUT /api/employees/:id - Update an employee
router.put('/:id', authenticateCustomer, async (req, res) => {
  try {
    const customerId = req.user.id;
    const employeeId = parseInt(req.params.id);
    const { name, email, password, phoneNo } = req.body;

    // Verify employee belongs to this customer
    const employee = await prisma.empolyee.findFirst({
      where: {
        id: employeeId,
        createdByCustomerId: customerId
      }
    });

    if (!employee) {
      return res.status(404).json({ error: 'Employee not found or access denied' });
    }

    // Build update data
    const updateData = {};
    if (name) updateData.name = name.trim();
    if (email) {
      // Check email uniqueness
      const existing = await prisma.empolyee.findFirst({
        where: { email: email.toLowerCase(), id: { not: employeeId } }
      });
      if (existing) {
        return res.status(400).json({ error: 'Email already in use by another employee' });
      }
      updateData.email = email.toLowerCase().trim();
    }
    if (phoneNo) {
      // Check phone uniqueness
      const existing = await prisma.empolyee.findFirst({
        where: { phoneNo, id: { not: employeeId } }
      });
      if (existing) {
        return res.status(400).json({ error: 'Phone number already in use' });
      }
      updateData.phoneNo = phoneNo;
    }
    if (password) {
      if (password.length < 6) {
        return res.status(400).json({ error: 'Password must be at least 6 characters' });
      }
      updateData.password = await bcrypt.hash(password, 12);
    }

    const updatedEmployee = await prisma.empolyee.update({
      where: { id: employeeId },
      data: updateData,
      select: {
        id: true,
        name: true,
        email: true,
        phoneNo: true,
        shopId: true,
        createdAt: true
      }
    });

    res.json({ 
      success: true, 
      message: 'Employee updated successfully',
      employee: updatedEmployee 
    });
  } catch (error) {
    console.error('Error updating employee:', error);
    res.status(500).json({ error: 'Failed to update employee' });
  }
});

// DELETE /api/employees/:id - Delete an employee
router.delete('/:id', authenticateCustomer, async (req, res) => {
  try {
    const customerId = req.user.id;
    const employeeId = parseInt(req.params.id);

    // Verify employee belongs to this customer
    const employee = await prisma.empolyee.findFirst({
      where: {
        id: employeeId,
        createdByCustomerId: customerId
      }
    });

    if (!employee) {
      return res.status(404).json({ error: 'Employee not found or access denied' });
    }

    // Delete employee (cascades will handle related records)
    await prisma.empolyee.delete({
      where: { id: employeeId }
    });

    res.json({ 
      success: true, 
      message: 'Employee deleted successfully' 
    });
  } catch (error) {
    console.error('Error deleting employee:', error);
    res.status(500).json({ error: 'Failed to delete employee' });
  }
});

// GET /api/employees/:id/lists - Get all lists for a specific employee
router.get('/:id/lists', authenticateCustomer, async (req, res) => {
  try {
    const customerId = req.user.id;
    const employeeId = parseInt(req.params.id);

    // Verify employee belongs to this customer
    const employee = await prisma.empolyee.findFirst({
      where: {
        id: employeeId,
        createdByCustomerId: customerId
      },
      select: { id: true, name: true }
    });

    if (!employee) {
      return res.status(404).json({ error: 'Employee not found or access denied' });
    }

    const lists = await prisma.list.findMany({
      where: {
        employeeId: employeeId,
        creatorType: 'EMPLOYEE'
      },
      include: {
        products: {
          include: {
            productAtShop: {
              include: {
                product: true,
                shop: true
              }
            }
          }
        }
      },
      orderBy: { createdAt: 'desc' }
    });

    // Format lists with item count
    const formattedLists = lists.map(list => ({
      id: list.id,
      name: list.name,
      description: list.description,
      createdAt: list.createdAt,
      itemCount: list.products.length,
      products: list.products
    }));

    res.json({ 
      success: true, 
      employee: { id: employee.id, name: employee.name },
      lists: formattedLists 
    });
  } catch (error) {
    console.error('Error fetching employee lists:', error);
    res.status(500).json({ error: 'Failed to fetch employee lists' });
  }
});

export default router;
