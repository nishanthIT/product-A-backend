// src/pages/api/employee/dashboard-data.js
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const countDistinctListUpdates = async (employeeId, startDate) => {
  const where = {
    employeeId,
    actionType: 'LIST_ITEM_UPDATE',
    ...(startDate ? { timestamp: { gte: startDate } } : {})
  };

  const logs = await prisma.actionLog.findMany({
    where,
    distinct: ['productId'],
    select: { productId: true }
  });

  return logs.length;
};

const buildUpdateSummary = (logs) => {
  const summaryMap = new Map();
  const totalUnique = new Set();

  logs.forEach((log) => {
    const dateKey = new Date(log.timestamp).toISOString().split('T')[0];
    if (!summaryMap.has(dateKey)) {
      summaryMap.set(dateKey, { productIds: new Set(), totalEdits: 0 });
    }

    const entry = summaryMap.get(dateKey);
    entry.totalEdits += 1;
    entry.productIds.add(log.productId);
    totalUnique.add(log.productId);
  });

  const byDate = Array.from(summaryMap.entries()).map(([date, data]) => ({
    date,
    uniqueProducts: data.productIds.size,
    totalEdits: data.totalEdits
  })).sort((a, b) => b.date.localeCompare(a.date));

  return {
    totalUnique: totalUnique.size,
    byDate
  };
};

const emp_dash_handler = async (req, res)=> {
  try {
    // Get the employee ID from the query parameter
    const { employeeId } = req.query;
    
    if (!employeeId) {
      return res.status(400).json({ error: 'Employee ID is required' });
    }

    // Convert to number for Prisma
    const empId = parseInt(employeeId);
    
    // Get current date
    const now = new Date();
    
    // Calculate date ranges
    const todayStart = new Date(now);
    todayStart.setHours(0, 0, 0, 0);
    
    const weekStart = new Date(now);
    weekStart.setDate(now.getDate() - 7);
    
    const monthStart = new Date(now);
    monthStart.setMonth(now.getMonth() - 1);

    // Get counts for today, week, and month
    const [todayCount, weekCount, monthCount, listUpdatesToday, listUpdatesWeek, listUpdatesMonth, listUpdatesTotal] = await Promise.all([
      // Today's count
      prisma.productAtShop.count({
        where: {
          employeeId: empId,
          updatedAt: {
            gte: todayStart
          }
        }
      }),
      
      // This week's count
      prisma.productAtShop.count({
        where: {
          employeeId: empId,
          updatedAt: {
            gte: weekStart
          }
        }
      }),
      
      // This month's count
      prisma.productAtShop.count({
        where: {
          employeeId: empId,
          updatedAt: {
            gte: monthStart
          }
        }
      }),
      countDistinctListUpdates(empId, todayStart),
      countDistinctListUpdates(empId, weekStart),
      countDistinctListUpdates(empId, monthStart),
      countDistinctListUpdates(empId, null)
    ]);

    return res.status(200).json({
      todayCount,
      weekCount,
      monthCount,
      listItemUpdates: {
        today: listUpdatesToday,
        week: listUpdatesWeek,
        month: listUpdatesMonth,
        total: listUpdatesTotal
      }
    });
  } catch (error) {
    console.error("Error fetching employee stats:", error);
    return res.status(500).json({ error: "Failed to fetch employee stats" });
  }
}

const getEmployeeListItemUpdates = async (req, res) => {
  try {
    const employeeId = parseInt(req.user?.id, 10);
    if (Number.isNaN(employeeId)) {
      return res.status(400).json({ error: 'Employee ID is required' });
    }

    const limit = Math.min(Math.max(parseInt(req.query.limit || '25', 10), 1), 100);

    const logs = await prisma.actionLog.findMany({
      where: {
        employeeId,
        actionType: 'LIST_ITEM_UPDATE'
      },
      orderBy: {
        timestamp: 'desc'
      },
      take: limit,
      include: {
        product: {
          select: {
            id: true,
            title: true,
            barcode: true,
            caseBarcode: true,
            caseSize: true,
            packetSize: true,
            retailSize: true,
            rrp: true,
            category: true
          }
        },
        shop: {
          select: {
            id: true,
            name: true
          }
        }
      }
    });

    const summaryDays = Math.min(Math.max(parseInt(req.query.summaryDays || '30', 10), 1), 365);
    const summaryStart = new Date();
    summaryStart.setDate(summaryStart.getDate() - summaryDays);

    const summaryLogs = await prisma.actionLog.findMany({
      where: {
        employeeId,
        actionType: 'LIST_ITEM_UPDATE',
        timestamp: {
          gte: summaryStart
        }
      },
      select: {
        productId: true,
        timestamp: true
      }
    });

    const summary = buildUpdateSummary(summaryLogs);

    return res.status(200).json({
      success: true,
      data: logs.map((log) => ({
        id: log.id,
        timestamp: log.timestamp,
        product: log.product,
        shop: log.shop,
        beforeData: log.beforeData,
        afterData: log.afterData
      })),
      summary: {
        rangeDays: summaryDays,
        ...summary
      }
    });
  } catch (error) {
    console.error('Error fetching employee list item updates:', error);
    return res.status(500).json({ error: 'Failed to fetch list item updates' });
  }
};
export{
    emp_dash_handler,
    getEmployeeListItemUpdates
}