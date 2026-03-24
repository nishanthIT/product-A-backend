import express from 'express';
import { PrismaClient } from '@prisma/client';
import jwt from 'jsonwebtoken';
import cacheService from '../services/cacheService.js';

const router = express.Router();
const prisma = new PrismaClient();

// Middleware to verify JWT token
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Access token required' });
  }

  jwt.verify(token, process.env.JWT_SECRET || 'your-secret-key', (err, user) => {
    if (err) {
      return res.status(403).json({ error: 'Invalid token' });
    }
    req.user = user;
    next();
  });
};

// Customer-only middleware (Customers are shop owners/admins)
const requireCustomer = (req, res, next) => {
  if (req.user.userType !== 'CUSTOMER') {
    return res.status(403).json({ error: 'Shop owner access required' });
  }
  next();
};

// Employee-only middleware
const requireEmployee = (req, res, next) => {
  if (req.user.userType !== 'EMPLOYEE') {
    return res.status(403).json({ error: 'Employee access required' });
  }
  next();
};

// GET /api/shop/my-shop - Get current user's shop info
router.get('/my-shop', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const userType = req.user.userType;

    let shopId = null;

    if (userType === 'CUSTOMER') {
      const customer = await prisma.customer.findUnique({
        where: { id: userId },
        select: { shopId: true }
      });
      shopId = customer?.shopId;
    } else if (userType === 'EMPLOYEE') {
      const employee = await prisma.empolyee.findUnique({
        where: { id: userId },
        select: { shopId: true }
      });
      shopId = employee?.shopId;
    }

    if (!shopId) {
      return res.status(404).json({ error: 'User is not assigned to a shop' });
    }

    const shop = await prisma.shop.findUnique({
      where: { id: shopId },
      include: {
        customers: {
          select: { id: true, name: true, email: true }
        },
        employees: {
          select: { id: true, name: true, email: true }
        }
      }
    });

    res.json({ success: true, shop });
  } catch (error) {
    console.error('Error fetching shop:', error);
    res.status(500).json({ error: 'Failed to fetch shop info' });
  }
});

// POST /api/shop/assign - Assign customer to a shop (or create new shop)
router.post('/assign', authenticateToken, requireCustomer, async (req, res) => {
  try {
    const customerId = req.user.id;
    const { shopId, shopName, shopAddress, shopMobile } = req.body;

    let shop;

    if (shopId) {
      // Assign to existing shop
      shop = await prisma.shop.findUnique({ where: { id: shopId } });
      if (!shop) {
        return res.status(404).json({ error: 'Shop not found' });
      }
    } else if (shopName) {
      // Create new CUSTOMER shop (not a wholesale shop)
      shop = await prisma.shop.create({
        data: {
          name: shopName,
          address: shopAddress || '',
          mobile: shopMobile || '',
          shopType: 'CUSTOMER' // This is a customer retail shop
        }
      });
    } else {
      return res.status(400).json({ error: 'Either shopId or shopName is required' });
    }

    // Update customer with shop assignment
    await prisma.customer.update({
      where: { id: customerId },
      data: { shopId: shop.id }
    });

    // Create shop group chat if it doesn't exist
    if (!shop.groupChatId) {
      const groupChat = await prisma.chat.create({
        data: {
          name: `${shop.name} - Team Chat`,
          type: 'GROUP',
          participants: {
            create: {
              userId: customerId,
              userType: 'CUSTOMER',
              isAdmin: true
            }
          }
        }
      });

      // Update shop with group chat ID
      shop = await prisma.shop.update({
        where: { id: shop.id },
        data: { groupChatId: groupChat.id }
      });
    }

    res.json({ 
      success: true, 
      message: 'Shop assigned successfully',
      shop 
    });
  } catch (error) {
    console.error('Error assigning shop:', error);
    res.status(500).json({ error: 'Failed to assign shop' });
  }
});

// GET /api/shop/group-chat - Get shop's group chat
router.get('/group-chat', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const userType = req.user.userType;

    let shopId = null;

    if (userType === 'CUSTOMER') {
      const customer = await prisma.customer.findUnique({
        where: { id: userId },
        select: { shopId: true }
      });
      shopId = customer?.shopId;
    } else if (userType === 'EMPLOYEE') {
      const employee = await prisma.empolyee.findUnique({
        where: { id: userId },
        select: { shopId: true }
      });
      shopId = employee?.shopId;
    }

    if (!shopId) {
      return res.status(404).json({ error: 'User is not assigned to a shop' });
    }

    const shop = await prisma.shop.findUnique({
      where: { id: shopId },
      select: { groupChatId: true, name: true }
    });

    if (!shop?.groupChatId) {
      return res.status(404).json({ error: 'Shop group chat not found' });
    }

    // Get chat with messages
    const chat = await prisma.chat.findUnique({
      where: { id: shop.groupChatId },
      include: {
        participants: true,
        messages: {
          orderBy: { createdAt: 'desc' },
          take: 50,
          include: {
            sharedList: {
              include: {
                products: {
                  include: {
                    productAtShop: {
                      include: {
                        product: true
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    });

    res.json({ success: true, chat, shopName: shop.name });
  } catch (error) {
    console.error('Error fetching group chat:', error);
    res.status(500).json({ error: 'Failed to fetch group chat' });
  }
});

// GET /api/shop/employees - Get all employees in the shop (Customer/Shop owner only)
router.get('/employees', authenticateToken, requireCustomer, async (req, res) => {
  try {
    const customerId = req.user.id;

    const customer = await prisma.customer.findUnique({
      where: { id: customerId },
      select: { shopId: true }
    });

    if (!customer?.shopId) {
      return res.status(400).json({ error: 'You are not assigned to a shop' });
    }

    const employees = await prisma.empolyee.findMany({
      where: { shopId: customer.shopId },
      select: {
        id: true,
        name: true,
        email: true,
        phoneNo: true,
        createdAt: true,
        lists: {
          select: {
            id: true,
            name: true,
            createdAt: true
          }
        }
      },
      orderBy: { createdAt: 'desc' }
    });

    res.json({ success: true, employees });
  } catch (error) {
    console.error('Error fetching shop employees:', error);
    res.status(500).json({ error: 'Failed to fetch employees' });
  }
});

// GET /api/shop/all-lists - Get all lists in the shop (Customer/Shop owner only)
router.get('/all-lists', authenticateToken, requireCustomer, async (req, res) => {
  try {
    const customerId = req.user.id;

    const customer = await prisma.customer.findUnique({
      where: { id: customerId },
      select: { shopId: true }
    });

    if (!customer?.shopId) {
      return res.status(400).json({ error: 'You are not assigned to a shop' });
    }

    // Get all employee lists in this shop
    const lists = await prisma.list.findMany({
      where: {
        OR: [
          { employee: { shopId: customer.shopId } },
          { customerId: customerId }
        ]
      },
      include: {
        employee: {
          select: { id: true, name: true, email: true }
        },
        customer: {
          select: { id: true, name: true }
        },
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

    // Separate customer lists and employee lists
    const customerLists = lists.filter(l => l.customerId);
    const employeeLists = lists.filter(l => l.employeeId);

    res.json({ 
      success: true, 
      lists: {
        customerLists,
        employeeLists,
        all: lists
      }
    });
  } catch (error) {
    console.error('Error fetching shop lists:', error);
    res.status(500).json({ error: 'Failed to fetch lists' });
  }
});

// POST /api/shop/copy-list/:listId - Customer tracks a shop list (no duplicate copy)
router.post('/copy-list/:listId', authenticateToken, requireCustomer, async (req, res) => {
  try {
    const customerId = req.user.id;
    const listId = req.params.listId; // List ID is a cuid string

    if (!listId || listId === 'undefined' || listId === 'null') {
      return res.status(400).json({ error: 'Invalid list ID' });
    }

    // Get the source list
    const sourceList = await prisma.list.findUnique({
      where: { id: listId },
      include: {
        products: {
          include: {
            productAtShop: true
          }
        },
        employee: {
          select: { name: true, shopId: true }
        },
        customer: {
          select: { name: true, shopId: true }
        }
      }
    });

    if (!sourceList) {
      return res.status(404).json({ error: 'List not found' });
    }

    // Verify the customer has access (same shop)
    const customer = await prisma.customer.findUnique({
      where: { id: customerId },
      select: { shopId: true }
    });

    // Check if source list is from the same shop (either employee or customer owned)
    const sourceShopId = sourceList.employee?.shopId || sourceList.customer?.shopId || sourceList.shopId;
    if (sourceShopId !== customer?.shopId) {
      return res.status(403).json({ error: 'Access denied - list belongs to a different shop' });
    }

    if (!prisma.trackedList?.findFirst || !prisma.trackedList?.create) {
      return res.status(500).json({
        error: 'Tracking model is not available. Please run Prisma migration and generate client.'
      });
    }

    // Prevent duplicate tracking for the same user/list
    const existingTrack = await prisma.trackedList.findFirst({
      where: {
        listId: sourceList.id,
        userId: customerId,
        userType: req.user.userType,
      }
    });

    const tracking = existingTrack || await prisma.trackedList.create({
      data: {
        listId: sourceList.id,
        userId: customerId,
        userType: req.user.userType,
      }
    });

    // Invalidate cache so new list shows up
    await cacheService.invalidateUserLists(customerId);

    res.json({ 
      success: true, 
      message: existingTrack ? 'Already tracking this list' : 'Live tracking enabled',
      list: sourceList,
      tracking,
      alreadyTracked: !!existingTrack,
    });
  } catch (error) {
    console.error('Error copying list:', error);
    res.status(500).json({ error: 'Failed to copy list' });
  }
});

// POST /api/shop/employee-copy-list/:listId - Employee tracks a list (no duplicate copy)
router.post('/employee-copy-list/:listId', authenticateToken, requireEmployee, async (req, res) => {
  try {
    const employeeId = req.user.id;
    const listId = req.params.listId; // List ID is a cuid string

    if (!listId || listId === 'undefined' || listId === 'null') {
      return res.status(400).json({ error: 'Invalid list ID' });
    }

    // Get the employee's shop
    const employee = await prisma.empolyee.findUnique({
      where: { id: employeeId },
      select: { id: true, name: true, shopId: true }
    });

    if (!employee?.shopId) {
      return res.status(403).json({ error: 'Employee not assigned to a shop' });
    }

    // Get the source list
    const sourceList = await prisma.list.findUnique({
      where: { id: listId },
      include: {
        products: {
          include: {
            productAtShop: true
          }
        },
        customer: {
          select: { name: true, shopId: true }
        },
        employee: {
          select: { name: true, shopId: true }
        }
      }
    });

    if (!sourceList) {
      return res.status(404).json({ error: 'List not found' });
    }

    // Verify the list belongs to the same shop
    const sourceShopId = sourceList.customer?.shopId || sourceList.employee?.shopId;
    if (sourceShopId !== employee.shopId) {
      return res.status(403).json({ error: 'Access denied - list belongs to a different shop' });
    }

    if (!prisma.trackedList?.findFirst || !prisma.trackedList?.create) {
      return res.status(500).json({
        error: 'Tracking model is not available. Please run Prisma migration and generate client.'
      });
    }

    // Prevent duplicate tracking for the same user/list
    const existingTrack = await prisma.trackedList.findFirst({
      where: {
        listId: sourceList.id,
        userId: employeeId,
        userType: req.user.userType,
      }
    });

    const tracking = existingTrack || await prisma.trackedList.create({
      data: {
        listId: sourceList.id,
        userId: employeeId,
        userType: req.user.userType,
      }
    });

    res.json({ 
      success: true, 
      message: existingTrack ? 'Already tracking this list' : 'Live tracking enabled',
      list: sourceList,
      tracking,
      alreadyTracked: !!existingTrack,
    });
  } catch (error) {
    console.error('Error copying list for employee:', error);
    res.status(500).json({ error: 'Failed to copy list' });
  }
});

// GET /api/shop/available - Get list of available shops for assignment
router.get('/available', authenticateToken, requireCustomer, async (req, res) => {
  try {
    const shops = await prisma.shop.findMany({
      select: {
        id: true,
        name: true,
        address: true,
        mobile: true
      },
      orderBy: { name: 'asc' }
    });

    res.json({ success: true, shops });
  } catch (error) {
    console.error('Error fetching shops:', error);
    res.status(500).json({ error: 'Failed to fetch shops' });
  }
});

export default router;
