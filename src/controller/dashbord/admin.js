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

/**
 * Get all customers with their subscription information
 */
const getAllCustomers = async (req, res) => {
  try {
    const customers = await prisma.customer.findMany({
      select: {
        id: true,
        name: true,
        email: true,
        mobile: true,
        subscriptionStatus: true,
        trialStartDate: true,
        trialEndDate: true,
        earnings: true,
        userType: true,
        lists: {
          select: {
            id: true,
            name: true
          }
        }
      },
      orderBy: {
        id: 'desc' // Show newest customers first
      }
    });

    // Calculate subscription details for each customer
    const customersWithDetails = customers.map(customer => {
      const now = new Date();
      let subscriptionDetails = {};

      if (customer.subscriptionStatus === 'free_trial') {
        const trialStartDate = customer.trialStartDate ? new Date(customer.trialStartDate) : null;
        let trialEndDate = customer.trialEndDate ? new Date(customer.trialEndDate) : null;
        
        // If trialEndDate is null but we have trialStartDate, calculate it
        if (!trialEndDate && trialStartDate) {
          trialEndDate = new Date(trialStartDate);
          trialEndDate.setDate(trialEndDate.getDate() + 30);
        }
        
        if (trialEndDate) {
          const daysRemaining = Math.ceil((trialEndDate - now) / (1000 * 60 * 60 * 24));
          const isExpired = daysRemaining <= 0;
          subscriptionDetails = {
            status: isExpired ? 'Trial Expired' : 'Free Trial Active',
            daysRemaining: Math.max(0, daysRemaining),
            isExpired: isExpired,
            trialStartDate: trialStartDate ? trialStartDate.toLocaleDateString() : null,
            trialEndDate: trialEndDate.toLocaleDateString(),
            statusColor: isExpired ? '#ff4444' : (daysRemaining <= 7 ? '#ff9900' : '#00aa44')
          };
        } else {
          subscriptionDetails = {
            status: 'Trial (No End Date)',
            daysRemaining: 'Unknown',
            isExpired: false,
            statusColor: '#888888'
          };
        }
      } else {
        subscriptionDetails = {
          status: customer.subscriptionStatus || 'Unknown',
          isExpired: false,
          statusColor: '#0066cc'
        };
      }

      return {
        ...customer,
        subscriptionDetails,
        totalLists: customer.lists.length,
        formattedEarnings: `£${parseFloat(customer.earnings || 0).toFixed(2)}`
      };
    });

    // Calculate subscription statistics
    const subscriptionStats = {
      totalCustomers: customers.length,
      activeTrials: customersWithDetails.filter(c => c.subscriptionDetails.status === 'Free Trial Active').length,
      expiredTrials: customersWithDetails.filter(c => c.subscriptionDetails.isExpired).length,
      expiringSoon: customersWithDetails.filter(c => 
        c.subscriptionDetails.daysRemaining !== 'Unknown' && 
        c.subscriptionDetails.daysRemaining <= 7 && 
        c.subscriptionDetails.daysRemaining > 0
      ).length,
      totalLists: customersWithDetails.reduce((sum, c) => sum + c.totalLists, 0),
      totalEarnings: customersWithDetails.reduce((sum, c) => sum + parseFloat(c.earnings || 0), 0).toFixed(2)
    };

    res.status(200).json({
      success: true,
      data: {
        customers: customersWithDetails,
        totalCount: customers.length,
        subscriptionStats
      }
    });
  } catch (error) {
    console.error('Error fetching customers:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
};

/**
 * Update customer subscription status
 */
const updateCustomerSubscription = async (req, res) => {
  try {
    const { customerId } = req.params;
    const { subscriptionStatus, subscriptionEndDate } = req.body;

    const updatedCustomer = await prisma.customer.update({
      where: { id: parseInt(customerId) },
      data: {
        subscriptionStatus,
        ...(subscriptionEndDate && { trialEndDate: new Date(subscriptionEndDate) })
      }
    });

    res.status(200).json({
      success: true,
      message: 'Subscription updated successfully',
      data: updatedCustomer
    });
  } catch (error) {
    console.error('Error updating subscription:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
};

/**
 * Process expired trials and update statuses
 */
const processExpiredTrials = async (req, res) => {
  try {
    const now = new Date();
    
    // Find customers with expired trials
    const expiredTrials = await prisma.customer.findMany({
      where: {
        subscriptionStatus: 'free_trial',
        trialEndDate: {
          lte: now
        }
      }
    });

    // Update expired trials to 'trial_expired' status
    const updatePromises = expiredTrials.map(customer =>
      prisma.customer.update({
        where: { id: customer.id },
        data: { subscriptionStatus: 'trial_expired' }
      })
    );

    await Promise.all(updatePromises);

    res.status(200).json({
      success: true,
      message: `Processed ${expiredTrials.length} expired trials`,
      data: {
        expiredCount: expiredTrials.length,
        expiredCustomers: expiredTrials.map(c => ({ id: c.id, name: c.name, email: c.email }))
      }
    });
  } catch (error) {
    console.error('Error processing expired trials:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
};

/**
 * Get subscription statistics only
 */
const getSubscriptionStats = async (req, res) => {
  try {
    const customers = await prisma.customer.findMany({
      select: {
        subscriptionStatus: true,
        trialStartDate: true,
        trialEndDate: true,
        earnings: true
      }
    });

    const now = new Date();
    let activeTrials = 0;
    let expiredTrials = 0;
    let expiringSoon = 0;

    customers.forEach(customer => {
      if (customer.subscriptionStatus === 'free_trial') {
        const trialStartDate = customer.trialStartDate ? new Date(customer.trialStartDate) : null;
        let trialEndDate = customer.trialEndDate ? new Date(customer.trialEndDate) : null;
        
        if (!trialEndDate && trialStartDate) {
          trialEndDate = new Date(trialStartDate);
          trialEndDate.setDate(trialEndDate.getDate() + 30);
        }
        
        if (trialEndDate) {
          const daysRemaining = Math.ceil((trialEndDate - now) / (1000 * 60 * 60 * 24));
          
          if (daysRemaining <= 0) {
            expiredTrials++;
          } else if (daysRemaining <= 7) {
            expiringSoon++;
          } else {
            activeTrials++;
          }
        }
      }
    });

    res.status(200).json({
      success: true,
      data: {
        totalCustomers: customers.length,
        activeTrials,
        expiredTrials,
        expiringSoon,
        conversionOpportunities: expiringSoon + expiredTrials,
        totalEarnings: customers.reduce((sum, c) => sum + parseFloat(c.earnings || 0), 0).toFixed(2)
      }
    });
  } catch (error) {
    console.error('Error fetching subscription stats:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
};

export { getDashboardOverview, getAllCustomers, getSubscriptionStats, updateCustomerSubscription, processExpiredTrials }