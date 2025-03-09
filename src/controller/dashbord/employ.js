// src/pages/api/employee/dashboard-data.js
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

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
    const [todayCount, weekCount, monthCount] = await Promise.all([
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
    ]);

    return res.status(200).json({
      todayCount,
      weekCount,
      monthCount
    });
  } catch (error) {
    console.error("Error fetching employee stats:", error);
    return res.status(500).json({ error: "Failed to fetch employee stats" });
  }
}
export{
    emp_dash_handler
}