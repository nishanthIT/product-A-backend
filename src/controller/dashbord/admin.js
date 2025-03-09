import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
/**
 * Get dashboard overview data
 * Returns counts and earnings data for the dashboard
 */
const getDashboardOverview = async (req, res) => {
  try {
    // Get counts for dashboard stats cards
    const [customerCount, productCount, shopCount] = await Promise.all([
      prisma.customer.count(),
      prisma.product.count(),
      prisma.shop.count()
    ]);

    // Calculate monthly earnings data based on ProductAtShop entries
    // This assumes earnings are calculated from product prices
    const today = new Date();
    const currentYear = today.getFullYear();
    
    // Get all months data for the current year
    const monthlyEarnings = await Promise.all(
      Array.from({ length: 12 }, async (_, monthIndex) => {
        const startDate = new Date(currentYear, monthIndex, 1);
        const endDate = new Date(currentYear, monthIndex + 1, 0); // Last day of month
        
        // Get products added in this month
        const monthProducts = await prisma.productAtShop.findMany({
          where: {
            createdAt: {
              gte: startDate,
              lte: endDate
            }
          },
          select: {
            price: true
          }
        });
        
        // Calculate total earnings from products
        const totalEarnings = monthProducts.reduce(
          (sum, product) => sum + parseFloat(product.price), 
          0
        );
        
        return {
          month: startDate.toLocaleString('default', { month: 'short' }),
          earnings: totalEarnings
        };
      })
    );
    
    // Format response with all dashboard data
    res.status(200).json({
      success: true,
      data: {
        stats: [
          { label: 'Total Customers', value: customerCount.toString() },
          { label: 'Total Products', value: productCount.toString() },
          { label: 'Total Shops', value: shopCount.toString() }
        ],
        earningsData: monthlyEarnings
      }
    });
  } catch (error) {
    console.error('Error fetching dashboard data:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
};

export{getDashboardOverview}