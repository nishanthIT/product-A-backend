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

// ===== FRIDGE MANAGEMENT (Admin) =====

// GET /api/fridges - Get all fridges for the shop
router.get('/', authenticateToken, async (req, res) => {
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

    const fridges = await prisma.fridge.findMany({
      where: whereClause,
      include: {
        temperatureLogs: {
          take: 1,
          orderBy: { recordedAt: 'desc' }
        }
      },
      orderBy: { name: 'asc' }
    });

    // Format response with latest reading
    const formattedFridges = fridges.map(fridge => ({
      id: fridge.id,
      name: fridge.name,
      location: fridge.location,
      minSafeTemp: fridge.minSafeTemp,
      maxSafeTemp: fridge.maxSafeTemp,
      isActive: fridge.isActive,
      createdAt: fridge.createdAt,
      latestReading: fridge.temperatureLogs[0] || null
    }));

    res.json({ success: true, fridges: formattedFridges });
  } catch (error) {
    console.error('Error fetching fridges:', error);
    res.status(500).json({ error: 'Failed to fetch fridges' });
  }
});

// POST /api/fridges - Create a new fridge (Admin only)
router.post('/', authenticateToken, requireCustomer, async (req, res) => {
  try {
    const customerId = req.user.id;
    const { name, location, minSafeTemp, maxSafeTemp } = req.body;

    if (!name) {
      return res.status(400).json({ error: 'Fridge name is required' });
    }

    const shopId = await getUserShopId(customerId, 'CUSTOMER');
    if (!shopId) {
      return res.status(400).json({ error: 'You are not assigned to a shop' });
    }

    const fridge = await prisma.fridge.create({
      data: {
        name,
        location: location || null,
        minSafeTemp: minSafeTemp !== undefined ? parseFloat(minSafeTemp) : -5,
        maxSafeTemp: maxSafeTemp !== undefined ? parseFloat(maxSafeTemp) : 8,
        shopId
      }
    });

    res.status(201).json({ 
      success: true, 
      message: 'Fridge created successfully',
      fridge 
    });
  } catch (error) {
    console.error('Error creating fridge:', error);
    res.status(500).json({ error: 'Failed to create fridge' });
  }
});

// PUT /api/fridges/:id - Update a fridge (Admin only)
router.put('/:id', authenticateToken, requireCustomer, async (req, res) => {
  try {
    const customerId = req.user.id;
    const fridgeId = req.params.id;
    const { name, location, minSafeTemp, maxSafeTemp, isActive } = req.body;

    const shopId = await getUserShopId(customerId, 'CUSTOMER');
    if (!shopId) {
      return res.status(400).json({ error: 'You are not assigned to a shop' });
    }

    // Verify fridge exists and belongs to this shop
    const existingFridge = await prisma.fridge.findFirst({
      where: { id: fridgeId, shopId }
    });

    if (!existingFridge) {
      return res.status(404).json({ error: 'Fridge not found' });
    }

    const updateData = {};
    if (name !== undefined) updateData.name = name;
    if (location !== undefined) updateData.location = location;
    if (minSafeTemp !== undefined) updateData.minSafeTemp = parseFloat(minSafeTemp);
    if (maxSafeTemp !== undefined) updateData.maxSafeTemp = parseFloat(maxSafeTemp);
    if (isActive !== undefined) updateData.isActive = isActive;

    const fridge = await prisma.fridge.update({
      where: { id: fridgeId },
      data: updateData
    });

    res.json({ 
      success: true, 
      message: 'Fridge updated successfully',
      fridge 
    });
  } catch (error) {
    console.error('Error updating fridge:', error);
    res.status(500).json({ error: 'Failed to update fridge' });
  }
});

// DELETE /api/fridges/:id - Delete a fridge (Admin only)
router.delete('/:id', authenticateToken, requireCustomer, async (req, res) => {
  try {
    const customerId = req.user.id;
    const fridgeId = req.params.id;

    const shopId = await getUserShopId(customerId, 'CUSTOMER');
    if (!shopId) {
      return res.status(400).json({ error: 'You are not assigned to a shop' });
    }

    // Verify fridge exists and belongs to this shop
    const existingFridge = await prisma.fridge.findFirst({
      where: { id: fridgeId, shopId }
    });

    if (!existingFridge) {
      return res.status(404).json({ error: 'Fridge not found' });
    }

    await prisma.fridge.delete({
      where: { id: fridgeId }
    });

    res.json({ success: true, message: 'Fridge deleted successfully' });
  } catch (error) {
    console.error('Error deleting fridge:', error);
    res.status(500).json({ error: 'Failed to delete fridge' });
  }
});

// ===== TEMPERATURE LOGGING =====

// GET /api/fridges/:id/logs - Get temperature logs for a fridge
router.get('/:id/logs', authenticateToken, async (req, res) => {
  try {
    const { id: userId, userType } = req.user;
    const fridgeId = req.params.id;
    const { startDate, endDate, entryType, limit } = req.query;

    const shopId = await getUserShopId(userId, userType);
    if (!shopId) {
      return res.status(400).json({ error: 'User not assigned to a shop' });
    }

    // Verify fridge belongs to this shop
    const fridge = await prisma.fridge.findFirst({
      where: { id: fridgeId, shopId }
    });

    if (!fridge) {
      return res.status(404).json({ error: 'Fridge not found' });
    }

    const whereClause = { fridgeId };
    
    if (entryType) {
      whereClause.entryType = entryType;
    }

    if (startDate || endDate) {
      whereClause.recordedAt = {};
      if (startDate) {
        whereClause.recordedAt.gte = new Date(startDate);
      }
      if (endDate) {
        // Set to end of day
        const endDateTime = new Date(endDate);
        endDateTime.setHours(23, 59, 59, 999);
        whereClause.recordedAt.lte = endDateTime;
      }
    }

    const logs = await prisma.fridgeTemperatureLog.findMany({
      where: whereClause,
      orderBy: { recordedAt: 'desc' },
      take: limit ? parseInt(limit) : 100
    });

    // Get user names for logs
    const logsWithUsers = await Promise.all(logs.map(async (log) => {
      let recordedByName = 'Unknown';
      if (log.recordedByType === 'CUSTOMER') {
        const customer = await prisma.customer.findUnique({
          where: { id: log.recordedById },
          select: { name: true }
        });
        recordedByName = customer?.name || 'Admin';
      } else if (log.recordedByType === 'EMPLOYEE') {
        const employee = await prisma.empolyee.findUnique({
          where: { id: log.recordedById },
          select: { name: true }
        });
        recordedByName = employee?.name || 'Employee';
      }

      // Check if temperature is within safe range
      const temp = parseFloat(log.temperature);
      const minSafe = parseFloat(fridge.minSafeTemp);
      const maxSafe = parseFloat(fridge.maxSafeTemp);
      const isAlert = temp < minSafe || temp > maxSafe;

      return {
        ...log,
        recordedByName,
        isAlert,
        alertMessage: isAlert 
          ? temp < minSafe 
            ? `Temperature too low (below ${minSafe}°C)` 
            : `Temperature too high (above ${maxSafe}°C)`
          : null
      };
    }));

    res.json({ 
      success: true, 
      fridge: {
        id: fridge.id,
        name: fridge.name,
        minSafeTemp: fridge.minSafeTemp,
        maxSafeTemp: fridge.maxSafeTemp
      },
      logs: logsWithUsers 
    });
  } catch (error) {
    console.error('Error fetching temperature logs:', error);
    res.status(500).json({ error: 'Failed to fetch temperature logs' });
  }
});

// POST /api/fridges/:id/logs - Add a temperature log (Admin or Employee)
router.post('/:id/logs', authenticateToken, async (req, res) => {
  try {
    const { id: userId, userType } = req.user;
    const fridgeId = req.params.id;
    const { temperature, entryType, notes } = req.body;

    if (temperature === undefined || temperature === null) {
      return res.status(400).json({ error: 'Temperature is required' });
    }

    if (!entryType || !['MORNING', 'EVENING'].includes(entryType)) {
      return res.status(400).json({ error: 'Entry type must be MORNING or EVENING' });
    }

    const shopId = await getUserShopId(userId, userType);
    if (!shopId) {
      return res.status(400).json({ error: 'User not assigned to a shop' });
    }

    // Verify fridge belongs to this shop
    const fridge = await prisma.fridge.findFirst({
      where: { id: fridgeId, shopId, isActive: true }
    });

    if (!fridge) {
      return res.status(404).json({ error: 'Fridge not found or inactive' });
    }

    // Check if already logged for this entry type today
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    const existingLog = await prisma.fridgeTemperatureLog.findFirst({
      where: {
        fridgeId,
        entryType,
        recordedAt: {
          gte: today,
          lt: tomorrow
        }
      }
    });

    if (existingLog) {
      return res.status(400).json({ 
        error: `${entryType.toLowerCase()} temperature already recorded for today` 
      });
    }

    const log = await prisma.fridgeTemperatureLog.create({
      data: {
        fridgeId,
        temperature: parseFloat(temperature),
        entryType,
        notes: notes || null,
        recordedById: userId,
        recordedByType: userType
      }
    });

    // Check if temperature is within safe range
    const temp = parseFloat(temperature);
    const minSafe = parseFloat(fridge.minSafeTemp);
    const maxSafe = parseFloat(fridge.maxSafeTemp);
    const isAlert = temp < minSafe || temp > maxSafe;

    res.status(201).json({ 
      success: true, 
      message: 'Temperature logged successfully',
      log: {
        ...log,
        isAlert,
        alertMessage: isAlert 
          ? temp < minSafe 
            ? `⚠️ Temperature too low (below ${minSafe}°C)` 
            : `⚠️ Temperature too high (above ${maxSafe}°C)`
          : null
      }
    });
  } catch (error) {
    console.error('Error logging temperature:', error);
    res.status(500).json({ error: 'Failed to log temperature' });
  }
});

// GET /api/fridges/all-logs - Get all temperature logs for the shop (Admin view)
router.get('/all-logs', authenticateToken, async (req, res) => {
  try {
    const { id: userId, userType } = req.user;
    const { fridgeId, startDate, endDate, limit } = req.query;

    const shopId = await getUserShopId(userId, userType);
    if (!shopId) {
      return res.status(400).json({ error: 'User not assigned to a shop' });
    }

    // Get all fridges for this shop
    const fridges = await prisma.fridge.findMany({
      where: { shopId },
      select: { id: true, name: true, minSafeTemp: true, maxSafeTemp: true }
    });

    const fridgeIds = fridgeId ? [fridgeId] : fridges.map(f => f.id);
    const fridgeMap = new Map(fridges.map(f => [f.id, f]));

    const whereClause = { fridgeId: { in: fridgeIds } };

    if (startDate || endDate) {
      whereClause.recordedAt = {};
      if (startDate) {
        whereClause.recordedAt.gte = new Date(startDate);
      }
      if (endDate) {
        const endDateTime = new Date(endDate);
        endDateTime.setHours(23, 59, 59, 999);
        whereClause.recordedAt.lte = endDateTime;
      }
    }

    const logs = await prisma.fridgeTemperatureLog.findMany({
      where: whereClause,
      orderBy: { recordedAt: 'desc' },
      take: limit ? parseInt(limit) : 200
    });

    // Add fridge name and user name to each log
    const logsWithDetails = await Promise.all(logs.map(async (log) => {
      const fridge = fridgeMap.get(log.fridgeId);
      let recordedByName = 'Unknown';
      
      if (log.recordedByType === 'CUSTOMER') {
        const customer = await prisma.customer.findUnique({
          where: { id: log.recordedById },
          select: { name: true }
        });
        recordedByName = customer?.name || 'Admin';
      } else if (log.recordedByType === 'EMPLOYEE') {
        const employee = await prisma.empolyee.findUnique({
          where: { id: log.recordedById },
          select: { name: true }
        });
        recordedByName = employee?.name || 'Employee';
      }

      const temp = parseFloat(log.temperature);
      const minSafe = parseFloat(fridge?.minSafeTemp || -5);
      const maxSafe = parseFloat(fridge?.maxSafeTemp || 8);
      const isAlert = temp < minSafe || temp > maxSafe;

      return {
        ...log,
        fridgeName: fridge?.name || 'Unknown Fridge',
        recordedByName,
        isAlert
      };
    }));

    res.json({ 
      success: true, 
      fridges,
      logs: logsWithDetails 
    });
  } catch (error) {
    console.error('Error fetching all temperature logs:', error);
    res.status(500).json({ error: 'Failed to fetch temperature logs' });
  }
});

// GET /api/fridges/today-status - Get today's logging status for all fridges
router.get('/today-status', authenticateToken, async (req, res) => {
  try {
    const { id: userId, userType } = req.user;

    const shopId = await getUserShopId(userId, userType);
    if (!shopId) {
      return res.status(400).json({ error: 'User not assigned to a shop' });
    }

    const fridges = await prisma.fridge.findMany({
      where: { shopId, isActive: true },
      orderBy: { name: 'asc' }
    });

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    const fridgesWithStatus = await Promise.all(fridges.map(async (fridge) => {
      const todayLogs = await prisma.fridgeTemperatureLog.findMany({
        where: {
          fridgeId: fridge.id,
          recordedAt: {
            gte: today,
            lt: tomorrow
          }
        }
      });

      const morningLog = todayLogs.find(l => l.entryType === 'MORNING');
      const eveningLog = todayLogs.find(l => l.entryType === 'EVENING');

      return {
        id: fridge.id,
        name: fridge.name,
        location: fridge.location,
        minSafeTemp: fridge.minSafeTemp,
        maxSafeTemp: fridge.maxSafeTemp,
        morningLogged: !!morningLog,
        morningTemp: morningLog?.temperature || null,
        eveningLogged: !!eveningLog,
        eveningTemp: eveningLog?.temperature || null
      };
    }));

    res.json({ success: true, fridges: fridgesWithStatus });
  } catch (error) {
    console.error('Error fetching today status:', error);
    res.status(500).json({ error: 'Failed to fetch today status' });
  }
});

export default router;
