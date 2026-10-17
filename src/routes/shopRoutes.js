import supermarketRoutes from './supermarketRoutes.js';
import express from 'express';
import { PrismaClient } from '@prisma/client';
import { isAuthenticated, requireShopFeature } from '../middleware/authware.js';
import { SHOP_FEATURES, hasShopFeatureAccess } from '../services/accessControl.js';
import { resumeInitialSupermarket } from '../services/supermarketProvisioning.js';

const router = express.Router();
const prisma = new PrismaClient();

// Shared auth: verifies the token and reloads employee memberships each request
const authenticateToken = isAuthenticated;

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

    const shopId = req.user.shopId;

    if (!shopId) {
      return res.status(404).json({ error: 'User is not assigned to a shop' });
    }

    const shop = await prisma.shop.findUnique({
      where: { id: shopId },
      include: {
        supermarketOwnerships: { select: { customer: { select: { id: true, name: true } } } },
        ...(userType === 'CUSTOMER' && { employeeMemberships: { where: { status: 'ACTIVE' }, select: { employee: { select: { id: true, name: true, email: true } } } } }),
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
    // Registration has already created the first shop. Retrying setup must reuse it.
    const shop = await resumeInitialSupermarket(prisma, req.user, req.body.shopId);
    res.json({ success: true, message: 'Your shop is ready', shop });
  } catch (error) {
    res.status(error.status || 500).json({ error: error.status ? error.message : 'Failed to resume shop setup', code: error.code });
  }
});

router.use('/supermarkets', supermarketRoutes);

// GET /api/shop/group-chat - Get shop's group chat
router.get('/group-chat', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const userType = req.user.userType;

    const shopId = req.user.shopId;

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

    if (chat) chat.messages = chat.messages.map((message) => {
      const canRead = message.sharedList?.shopId === shopId && (userType !== 'EMPLOYEE' || hasShopFeatureAccess(req.user, SHOP_FEATURES.LISTS));
      return canRead ? message : { ...message, sharedList: null, sharedListId: null };
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

    const customer = { shopId: req.user.shopId };

    if (!customer?.shopId) {
      return res.status(400).json({ error: 'You are not assigned to a shop' });
    }

    const memberships = await prisma.shopEmployeeMembership.findMany({
      where: { shopId: customer.shopId, status: { not: 'REMOVED' } },
      select: {
        status: true,
        role: true,
        employee: {
          select: {
            id: true,
            name: true,
            email: true,
            phoneNo: true,
            createdAt: true,
            lists: {
              where: { shopId: customer.shopId },
              select: {
                id: true,
                name: true,
                createdAt: true
              }
            }
          }
        }
      },
      orderBy: { createdAt: 'desc' }
    });
    const employees = memberships.map((m) => ({ ...m.employee, status: m.status, role: m.role }));

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

    const customer = { shopId: req.user.shopId };

    if (!customer?.shopId) {
      return res.status(400).json({ error: 'You are not assigned to a shop' });
    }

    // Employee lists belong to the shop they were created in, even after the employee is deactivated.
    const lists = await prisma.list.findMany({
      where: {
        shopId: customer.shopId
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
    const customer = { shopId: req.user.shopId };

    // Check if source list is from the same shop (either employee or customer owned)
    const sourceShopId = sourceList.shopId;
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

    res.json({ 
      success: true, 
      message: existingTrack
        ? 'Already in your lists'
        : `Copied to your lists. It stays in sync with ${sourceList.employee?.name || sourceList.customer?.name || 'the creator'}.`,
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
router.post('/employee-copy-list/:listId', authenticateToken, requireEmployee, requireShopFeature(SHOP_FEATURES.LISTS), async (req, res) => {
  try {
    const employeeId = req.user.id;
    const listId = req.params.listId; // List ID is a cuid string

    if (!listId || listId === 'undefined' || listId === 'null') {
      return res.status(400).json({ error: 'Invalid list ID' });
    }

    // Get the employee's shop
    const employee = { shopId: req.user.shopId };

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
    const sourceShopId = sourceList.shopId;
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
      where: { shopType: 'WHOLESALE' },
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
