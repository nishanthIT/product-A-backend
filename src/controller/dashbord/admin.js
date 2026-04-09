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
          trialEndDate.setDate(trialEndDate.getDate() + 90);
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
      } else if (customer.subscriptionStatus === 'premium') {
        // Handle premium users - use trialEndDate as subscription end date
        const endDate = customer.trialEndDate ? new Date(customer.trialEndDate) : null;
        
        if (endDate) {
          const daysRemaining = Math.ceil((endDate - now) / (1000 * 60 * 60 * 24));
          const isExpired = daysRemaining <= 0;
          subscriptionDetails = {
            status: isExpired ? 'Premium Expired' : 'Premium Active',
            daysRemaining: Math.max(0, daysRemaining),
            isExpired: isExpired,
            trialEndDate: endDate.toLocaleDateString(),
            statusColor: isExpired ? '#ff4444' : (daysRemaining <= 7 ? '#ff9900' : '#9b59b6')
          };
        } else {
          subscriptionDetails = {
            status: 'Premium (Unlimited)',
            daysRemaining: '∞',
            isExpired: false,
            statusColor: '#9b59b6'
          };
        }
      } else {
        subscriptionDetails = {
          status: customer.subscriptionStatus || 'Unknown',
          daysRemaining: '--',
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
 * Delete customer and all related linked data
 */
const deleteCustomerWithRelatedData = async (req, res) => {
  try {
    const { customerId } = req.params;
    const id = parseInt(customerId, 10);

    if (Number.isNaN(id)) {
      return res.status(400).json({ success: false, error: 'Invalid customer ID' });
    }

    const existingCustomer = await prisma.customer.findUnique({
      where: { id },
      select: { id: true, name: true, email: true }
    });

    if (!existingCustomer) {
      return res.status(404).json({ success: false, error: 'Customer not found' });
    }

    const participations = await prisma.chatParticipant.findMany({
      where: {
        userId: id,
        userType: 'CUSTOMER'
      },
      select: {
        chatId: true
      }
    });

    const participantChatIds = [...new Set(participations.map((p) => p.chatId))];

    await prisma.$transaction([
      prisma.messageRead.deleteMany({
        where: {
          userId: id,
          userType: 'CUSTOMER'
        }
      }),
      prisma.message.deleteMany({
        where: {
          senderId: id,
          senderType: 'CUSTOMER'
        }
      }),
      prisma.chatParticipant.deleteMany({
        where: {
          userId: id,
          userType: 'CUSTOMER'
        }
      }),
      prisma.productAtShop.updateMany({
        where: { userId: id },
        data: { userId: null }
      }),
      prisma.trackedList.deleteMany({
        where: {
          userId: id,
          userType: 'CUSTOMER'
        }
      }),
      prisma.customer.delete({
        where: { id }
      })
    ]);

    if (participantChatIds.length > 0) {
      await prisma.chat.deleteMany({
        where: {
          id: { in: participantChatIds },
          participants: { none: {} }
        }
      });
    }

    res.status(200).json({
      success: true,
      message: 'Customer and related data deleted successfully',
      data: {
        customer: existingCustomer
      }
    });
  } catch (error) {
    console.error('Error deleting customer:', error);
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

const parseBoolean = (value) => {
  if (typeof value !== 'string') return false;
  return ['1', 'true', 'yes'].includes(value.toLowerCase());
};

const normalizeSearchValue = (value) => String(value || '')
  .toLowerCase()
  .replace(/[^a-z0-9]/g, '');

const getListItemsSummary = async (req, res) => {
  try {
    const adminId = parseInt(req.user.id);
    const admin = await prisma.admin.findUnique({
      where: { id: adminId },
      select: { shopId: true }
    });

    const search = String(req.query.search || '').trim().toLowerCase();
    const missingCaseBarcodeOnly = parseBoolean(String(req.query.missingCaseBarcode || 'false'));
    const sortBy = String(req.query.sortBy || 'lastUpdated');
    const sortOrder = String(req.query.sortOrder || 'desc').toLowerCase() === 'asc' ? 'asc' : 'desc';
    const page = Math.max(parseInt(req.query.page || '1', 10), 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit || '25', 10), 1), 100);

    const whereClause = admin?.shopId
      ? {
          list: {
            shopId: admin.shopId
          }
        }
      : {};

    const listProducts = await prisma.listProduct.findMany({
      where: whereClause,
      select: {
        listId: true,
        list: {
          select: {
            updatedAt: true,
            createdAt: true
          }
        },
        productAtShop: {
          select: {
            updatedAt: true,
            createdAt: true,
            product: {
              select: {
                id: true,
                title: true,
                caseBarcode: true,
                barcode: true,
                img: true,
                caseSize: true,
                packetSize: true,
                retailSize: true
              }
            }
          }
        }
      }
    });

    const dedupedItems = new Map();

    for (const row of listProducts) {
      const product = row.productAtShop?.product;
      if (!product) continue;

      const fallbackKey = [
        product.title || '',
        product.retailSize || '',
        product.caseSize || '',
        product.packetSize || ''
      ]
        .map((part) => String(part).toLowerCase().trim())
        .join('|');

      const dedupeKey = product.id || fallbackKey;
      if (!dedupeKey) continue;

      const listUpdatedAt = row.list?.updatedAt || row.list?.createdAt || null;
      const productAtShopUpdatedAt = row.productAtShop?.updatedAt || row.productAtShop?.createdAt || null;
      const rowUpdatedAt = [listUpdatedAt, productAtShopUpdatedAt]
        .filter(Boolean)
        .map((date) => new Date(date).getTime())
        .sort((a, b) => b - a)[0];

      if (!dedupedItems.has(dedupeKey)) {
        dedupedItems.set(dedupeKey, {
          itemId: product.id || null,
          dedupeKey,
          itemName: product.title || 'Unnamed Item',
          barcode: product.barcode || null,
          caseBarcode: product.caseBarcode || null,
          img: product.img || null,
          listIds: new Set(),
          lastUpdatedTs: rowUpdatedAt || 0
        });
      }

      const entry = dedupedItems.get(dedupeKey);
      entry.listIds.add(row.listId);
      if ((rowUpdatedAt || 0) > entry.lastUpdatedTs) {
        entry.lastUpdatedTs = rowUpdatedAt || entry.lastUpdatedTs;
      }

      if (!entry.itemId && product.id) entry.itemId = product.id;
      if (!entry.caseBarcode && product.caseBarcode) entry.caseBarcode = product.caseBarcode;
      if (!entry.barcode && product.barcode) entry.barcode = product.barcode;
      if (!entry.img && product.img) entry.img = product.img;
    }

    let items = Array.from(dedupedItems.values()).map((entry) => ({
      itemId: entry.itemId,
      dedupeKey: entry.dedupeKey,
      itemName: entry.itemName,
      barcode: entry.barcode,
      caseBarcode: entry.caseBarcode,
      img: entry.img,
      listCount: entry.listIds.size,
      lastUpdated: entry.lastUpdatedTs ? new Date(entry.lastUpdatedTs).toISOString() : null
    }));

    if (search) {
      const normalizedSearch = normalizeSearchValue(search);
      items = items.filter((item) => {
        const name = String(item.itemName || '').toLowerCase();
        const id = String(item.itemId || '').toLowerCase();
        const barcode = String(item.barcode || '').toLowerCase();
        const caseBarcode = String(item.caseBarcode || '').toLowerCase();
        const normalizedId = normalizeSearchValue(id);
        const normalizedBarcode = normalizeSearchValue(barcode);
        const normalizedCaseBarcode = normalizeSearchValue(caseBarcode);

        return (
          name.includes(search) ||
          id.includes(search) ||
          barcode.includes(search) ||
          caseBarcode.includes(search) ||
          (normalizedSearch && normalizedId.includes(normalizedSearch)) ||
          (normalizedSearch && normalizedBarcode.includes(normalizedSearch)) ||
          (normalizedSearch && normalizedCaseBarcode.includes(normalizedSearch))
        );
      });
    }

    if (missingCaseBarcodeOnly) {
      items = items.filter((item) => !item.caseBarcode || !String(item.caseBarcode).trim());
    }

    const sorters = {
      itemName: (a, b) => a.itemName.localeCompare(b.itemName),
      itemId: (a, b) => String(a.itemId || '').localeCompare(String(b.itemId || '')),
      caseBarcode: (a, b) => String(a.caseBarcode || '').localeCompare(String(b.caseBarcode || '')),
      listCount: (a, b) => a.listCount - b.listCount,
      lastUpdated: (a, b) => {
        const aTs = a.lastUpdated ? new Date(a.lastUpdated).getTime() : 0;
        const bTs = b.lastUpdated ? new Date(b.lastUpdated).getTime() : 0;
        return aTs - bTs;
      }
    };

    const selectedSorter = sorters[sortBy] || sorters.lastUpdated;
    items.sort((a, b) => {
      const result = selectedSorter(a, b);
      return sortOrder === 'asc' ? result : -result;
    });

    const total = items.length;
    const totalPages = Math.max(Math.ceil(total / limit), 1);
    const start = (page - 1) * limit;
    const paginatedItems = items.slice(start, start + limit);

    res.status(200).json({
      success: true,
      data: {
        items: paginatedItems,
        pagination: {
          page,
          limit,
          total,
          totalPages
        }
      }
    });
  } catch (error) {
    console.error('Error fetching deduplicated user-list items:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch list items summary' });
  }
};

const updateGlobalCaseBarcode = async (req, res) => {
  try {
    const { itemId, caseBarcode } = req.body;

    if (!itemId || typeof itemId !== 'string') {
      return res.status(400).json({ success: false, error: 'Valid itemId is required' });
    }

    const normalizedCaseBarcode = String(caseBarcode || '').trim();

    const updatedProduct = await prisma.product.update({
      where: { id: itemId },
      data: {
        caseBarcode: normalizedCaseBarcode || null
      },
      select: {
        id: true,
        title: true,
        caseBarcode: true
      }
    });

    res.status(200).json({
      success: true,
      message: 'Case barcode updated globally for this item',
      data: updatedProduct
    });
  } catch (error) {
    console.error('Error updating global case barcode:', error);
    if (error.code === 'P2025') {
      return res.status(404).json({ success: false, error: 'Item not found' });
    }
    res.status(500).json({ success: false, error: 'Failed to update case barcode' });
  }
};

export {
  getDashboardOverview,
  getAllCustomers,
  getSubscriptionStats,
  updateCustomerSubscription,
  deleteCustomerWithRelatedData,
  processExpiredTrials,
  getListItemsSummary,
  updateGlobalCaseBarcode
}