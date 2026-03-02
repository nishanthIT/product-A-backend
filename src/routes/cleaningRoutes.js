import express from 'express';
import { PrismaClient } from '@prisma/client';
import jwt from 'jsonwebtoken';

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

// Helper to get user's shop ID
const getUserShopId = async (userId, userType) => {
  if (userType === 'CUSTOMER') {
    const customer = await prisma.customer.findUnique({
      where: { id: userId },
      select: { shopId: true }
    });
    return customer?.shopId;
  } else if (userType === 'EMPLOYEE') {
    const employee = await prisma.empolyee.findUnique({
      where: { id: userId },
      select: { shopId: true }
    });
    return employee?.shopId;
  }
  return null;
};

// ===== CLEANING AREA MANAGEMENT (Admin) =====

// GET /api/cleaning/areas - Get all cleaning areas for the shop
router.get('/areas', authenticateToken, async (req, res) => {
  try {
    const { id: userId, userType } = req.user;
    const shopId = await getUserShopId(userId, userType);

    if (!shopId) {
      return res.status(400).json({ error: 'User not assigned to a shop' });
    }

    const { includeInactive } = req.query;

    const whereClause = { shopId };
    if (!includeInactive) {
      whereClause.isActive = true;
    }

    const areas = await prisma.cleaningArea.findMany({
      where: whereClause,
      orderBy: { name: 'asc' }
    });

    res.json({ success: true, areas });
  } catch (error) {
    console.error('Error fetching cleaning areas:', error);
    res.status(500).json({ error: 'Failed to fetch cleaning areas' });
  }
});

// POST /api/cleaning/areas - Create a new cleaning area (Admin only)
router.post('/areas', authenticateToken, requireCustomer, async (req, res) => {
  try {
    const customerId = req.user.id;
    const { name, description } = req.body;

    if (!name) {
      return res.status(400).json({ error: 'Cleaning area name is required' });
    }

    const shopId = await getUserShopId(customerId, 'CUSTOMER');
    if (!shopId) {
      return res.status(400).json({ error: 'You are not assigned to a shop' });
    }

    const area = await prisma.cleaningArea.create({
      data: {
        name,
        description: description || null,
        shopId
      }
    });

    res.status(201).json({ 
      success: true, 
      message: 'Cleaning area created successfully',
      area 
    });
  } catch (error) {
    console.error('Error creating cleaning area:', error);
    res.status(500).json({ error: 'Failed to create cleaning area' });
  }
});

// POST /api/cleaning/areas/bulk - Create multiple cleaning areas at once (Admin only)
router.post('/areas/bulk', authenticateToken, requireCustomer, async (req, res) => {
  try {
    const customerId = req.user.id;
    const { areas } = req.body; // Array of { name, description }

    if (!areas || !Array.isArray(areas) || areas.length === 0) {
      return res.status(400).json({ error: 'Areas array is required' });
    }

    const shopId = await getUserShopId(customerId, 'CUSTOMER');
    if (!shopId) {
      return res.status(400).json({ error: 'You are not assigned to a shop' });
    }

    const createdAreas = await prisma.cleaningArea.createMany({
      data: areas.map(area => ({
        name: area.name,
        description: area.description || null,
        shopId
      }))
    });

    // Fetch created areas
    const allAreas = await prisma.cleaningArea.findMany({
      where: { shopId },
      orderBy: { name: 'asc' }
    });

    res.status(201).json({ 
      success: true, 
      message: `${createdAreas.count} cleaning areas created successfully`,
      areas: allAreas 
    });
  } catch (error) {
    console.error('Error creating cleaning areas:', error);
    res.status(500).json({ error: 'Failed to create cleaning areas' });
  }
});

// PUT /api/cleaning/areas/:id - Update a cleaning area (Admin only)
router.put('/areas/:id', authenticateToken, requireCustomer, async (req, res) => {
  try {
    const customerId = req.user.id;
    const areaId = req.params.id;
    const { name, description, isActive } = req.body;

    const shopId = await getUserShopId(customerId, 'CUSTOMER');
    if (!shopId) {
      return res.status(400).json({ error: 'You are not assigned to a shop' });
    }

    // Verify area exists and belongs to this shop
    const existingArea = await prisma.cleaningArea.findFirst({
      where: { id: areaId, shopId }
    });

    if (!existingArea) {
      return res.status(404).json({ error: 'Cleaning area not found' });
    }

    const updateData = {};
    if (name !== undefined) updateData.name = name;
    if (description !== undefined) updateData.description = description;
    if (isActive !== undefined) updateData.isActive = isActive;

    const area = await prisma.cleaningArea.update({
      where: { id: areaId },
      data: updateData
    });

    res.json({ 
      success: true, 
      message: 'Cleaning area updated successfully',
      area 
    });
  } catch (error) {
    console.error('Error updating cleaning area:', error);
    res.status(500).json({ error: 'Failed to update cleaning area' });
  }
});

// DELETE /api/cleaning/areas/:id - Delete a cleaning area (Admin only)
router.delete('/areas/:id', authenticateToken, requireCustomer, async (req, res) => {
  try {
    const customerId = req.user.id;
    const areaId = req.params.id;

    const shopId = await getUserShopId(customerId, 'CUSTOMER');
    if (!shopId) {
      return res.status(400).json({ error: 'You are not assigned to a shop' });
    }

    // Verify area exists and belongs to this shop
    const existingArea = await prisma.cleaningArea.findFirst({
      where: { id: areaId, shopId }
    });

    if (!existingArea) {
      return res.status(404).json({ error: 'Cleaning area not found' });
    }

    await prisma.cleaningArea.delete({
      where: { id: areaId }
    });

    res.json({ success: true, message: 'Cleaning area deleted successfully' });
  } catch (error) {
    console.error('Error deleting cleaning area:', error);
    res.status(500).json({ error: 'Failed to delete cleaning area' });
  }
});

// ===== CLEANING LOGS =====

// GET /api/cleaning/today - Get today's cleaning status for all areas
router.get('/today', authenticateToken, async (req, res) => {
  try {
    const { id: userId, userType } = req.user;

    const shopId = await getUserShopId(userId, userType);
    if (!shopId) {
      return res.status(400).json({ error: 'User not assigned to a shop' });
    }

    const areas = await prisma.cleaningArea.findMany({
      where: { shopId, isActive: true },
      orderBy: { name: 'asc' }
    });

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    const areasWithStatus = await Promise.all(areas.map(async (area) => {
      const todayLog = await prisma.cleaningLog.findFirst({
        where: {
          cleaningAreaId: area.id,
          completedAt: {
            gte: today,
            lt: tomorrow
          }
        },
        orderBy: { completedAt: 'desc' }
      });

      let completedByName = null;
      if (todayLog) {
        if (todayLog.completedByType === 'CUSTOMER') {
          const customer = await prisma.customer.findUnique({
            where: { id: todayLog.completedById },
            select: { name: true }
          });
          completedByName = customer?.name || 'Admin';
        } else if (todayLog.completedByType === 'EMPLOYEE') {
          const employee = await prisma.empolyee.findUnique({
            where: { id: todayLog.completedById },
            select: { name: true }
          });
          completedByName = employee?.name || 'Employee';
        }
      }

      return {
        id: area.id,
        name: area.name,
        description: area.description,
        isCompleted: !!todayLog,
        completedAt: todayLog?.completedAt || null,
        completedBy: completedByName,
        notes: todayLog?.notes || null
      };
    }));

    const completedCount = areasWithStatus.filter(a => a.isCompleted).length;
    const totalCount = areasWithStatus.length;

    res.json({ 
      success: true, 
      summary: {
        completedCount,
        totalCount,
        percentage: totalCount > 0 ? Math.round((completedCount / totalCount) * 100) : 0
      },
      areas: areasWithStatus 
    });
  } catch (error) {
    console.error('Error fetching today cleaning status:', error);
    res.status(500).json({ error: 'Failed to fetch cleaning status' });
  }
});

// POST /api/cleaning/complete/:areaId - Mark an area as cleaned
router.post('/complete/:areaId', authenticateToken, async (req, res) => {
  try {
    const { id: userId, userType } = req.user;
    const areaId = req.params.areaId;
    const { notes } = req.body;

    const shopId = await getUserShopId(userId, userType);
    if (!shopId) {
      return res.status(400).json({ error: 'User not assigned to a shop' });
    }

    // Verify area exists and belongs to this shop
    const area = await prisma.cleaningArea.findFirst({
      where: { id: areaId, shopId, isActive: true }
    });

    if (!area) {
      return res.status(404).json({ error: 'Cleaning area not found' });
    }

    // Check if already cleaned today
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    const existingLog = await prisma.cleaningLog.findFirst({
      where: {
        cleaningAreaId: areaId,
        completedAt: {
          gte: today,
          lt: tomorrow
        }
      }
    });

    if (existingLog) {
      return res.status(400).json({ error: 'This area has already been marked as cleaned today' });
    }

    const log = await prisma.cleaningLog.create({
      data: {
        cleaningAreaId: areaId,
        notes: notes || null,
        completedById: userId,
        completedByType: userType
      }
    });

    // Get user name
    let completedByName = 'Unknown';
    if (userType === 'CUSTOMER') {
      const customer = await prisma.customer.findUnique({
        where: { id: userId },
        select: { name: true }
      });
      completedByName = customer?.name || 'Admin';
    } else if (userType === 'EMPLOYEE') {
      const employee = await prisma.empolyee.findUnique({
        where: { id: userId },
        select: { name: true }
      });
      completedByName = employee?.name || 'Employee';
    }

    res.status(201).json({ 
      success: true, 
      message: `${area.name} marked as cleaned`,
      log: {
        ...log,
        areaName: area.name,
        completedByName
      }
    });
  } catch (error) {
    console.error('Error marking area as cleaned:', error);
    res.status(500).json({ error: 'Failed to update cleaning status' });
  }
});

// GET /api/cleaning/history - Get cleaning history
router.get('/history', authenticateToken, async (req, res) => {
  try {
    const { id: userId, userType } = req.user;
    const { areaId, startDate, endDate, employeeId, limit } = req.query;

    const shopId = await getUserShopId(userId, userType);
    if (!shopId) {
      return res.status(400).json({ error: 'User not assigned to a shop' });
    }

    // Get all areas for this shop
    const areas = await prisma.cleaningArea.findMany({
      where: { shopId },
      select: { id: true, name: true }
    });

    const areaIds = areaId ? [areaId] : areas.map(a => a.id);
    const areaMap = new Map(areas.map(a => [a.id, a.name]));

    const whereClause = { cleaningAreaId: { in: areaIds } };

    if (employeeId) {
      whereClause.completedById = parseInt(employeeId);
      whereClause.completedByType = 'EMPLOYEE';
    }

    if (startDate || endDate) {
      whereClause.completedAt = {};
      if (startDate) {
        whereClause.completedAt.gte = new Date(startDate);
      }
      if (endDate) {
        const endDateTime = new Date(endDate);
        endDateTime.setHours(23, 59, 59, 999);
        whereClause.completedAt.lte = endDateTime;
      }
    }

    const logs = await prisma.cleaningLog.findMany({
      where: whereClause,
      orderBy: { completedAt: 'desc' },
      take: limit ? parseInt(limit) : 100
    });

    // Add area name and user name to each log
    const logsWithDetails = await Promise.all(logs.map(async (log) => {
      let completedByName = 'Unknown';
      
      if (log.completedByType === 'CUSTOMER') {
        const customer = await prisma.customer.findUnique({
          where: { id: log.completedById },
          select: { name: true }
        });
        completedByName = customer?.name || 'Admin';
      } else if (log.completedByType === 'EMPLOYEE') {
        const employee = await prisma.empolyee.findUnique({
          where: { id: log.completedById },
          select: { name: true }
        });
        completedByName = employee?.name || 'Employee';
      }

      return {
        ...log,
        areaName: areaMap.get(log.cleaningAreaId) || 'Unknown Area',
        completedByName
      };
    }));

    res.json({ 
      success: true, 
      areas,
      logs: logsWithDetails 
    });
  } catch (error) {
    console.error('Error fetching cleaning history:', error);
    res.status(500).json({ error: 'Failed to fetch cleaning history' });
  }
});

// DELETE /api/cleaning/undo/:areaId - Undo today's cleaning (for corrections)
router.delete('/undo/:areaId', authenticateToken, async (req, res) => {
  try {
    const { id: userId, userType } = req.user;
    const areaId = req.params.areaId;

    const shopId = await getUserShopId(userId, userType);
    if (!shopId) {
      return res.status(400).json({ error: 'User not assigned to a shop' });
    }

    // Verify area exists and belongs to this shop
    const area = await prisma.cleaningArea.findFirst({
      where: { id: areaId, shopId }
    });

    if (!area) {
      return res.status(404).json({ error: 'Cleaning area not found' });
    }

    // Find today's log
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    const todayLog = await prisma.cleaningLog.findFirst({
      where: {
        cleaningAreaId: areaId,
        completedAt: {
          gte: today,
          lt: tomorrow
        }
      }
    });

    if (!todayLog) {
      return res.status(404).json({ error: 'No cleaning record found for today' });
    }

    await prisma.cleaningLog.delete({
      where: { id: todayLog.id }
    });

    res.json({ 
      success: true, 
      message: `Cleaning record for ${area.name} has been removed` 
    });
  } catch (error) {
    console.error('Error undoing cleaning:', error);
    res.status(500).json({ error: 'Failed to undo cleaning status' });
  }
});

export default router;
