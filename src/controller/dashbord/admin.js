import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
/**
 * Get dashboard overview data
 * Returns counts and earnings data for the dashboard
 */
const getDashboardOverview = async (req, res) => {
  try {
    const adminId = parseInt(req.user?.id, 10);
    let scopedShopId = null;

    if (!Number.isNaN(adminId)) {
      const admin = await prisma.admin.findUnique({
        where: { id: adminId },
        select: { shopId: true }
      });
      scopedShopId = admin?.shopId || null;
    }

    const listUpdateWhere = {
      actionType: 'LIST_ITEM_UPDATE',
      ...(scopedShopId ? { shopId: scopedShopId } : {})
    };

    // Get counts for dashboard stats cards
    const [customerCount, productCount, shopCount, listItemUpdateCount] = await Promise.all([
      prisma.customer.count(),
      prisma.product.count(),
      prisma.shop.count(),
      prisma.actionLog.count({ where: listUpdateWhere })
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
          { label: 'Total Shops', value: shopCount.toString() },
          { label: 'List Item Updates', value: listItemUpdateCount.toString() }
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

const toJsonSafe = (value) => {
  if (!value) return null;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return null;
  }
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

const UNKNOWN_SHOP_VALUE = '__UNKNOWN_SHOP__';
const UNKNOWN_SHOP_LABEL = 'Unknown Shop';
const NO_AISLE_VALUE = '__NO_AISLE__';
const NO_AISLE_LABEL = 'No Aisle';

const getListItemsSummary = async (req, res) => {
  try {
    const userType = req.user?.userType;
    let scopedShopId = null;

    if (userType === 'ADMIN') {
      const adminId = parseInt(req.user.id, 10);
      if (!Number.isNaN(adminId)) {
        const admin = await prisma.admin.findUnique({
          where: { id: adminId },
          select: { shopId: true }
        });
        scopedShopId = admin?.shopId || null;
      }
    } else if (userType === 'EMPLOYEE') {
      const employeeId = parseInt(req.user.id, 10);
      if (!Number.isNaN(employeeId)) {
        const employee = await prisma.empolyee.findUnique({
          where: { id: employeeId },
          select: { shopId: true }
        });
        scopedShopId = employee?.shopId || null;
      }
    }

    const search = String(req.query.search || '').trim().toLowerCase();
    const missingCaseBarcodeOnly = parseBoolean(String(req.query.missingCaseBarcode || 'false'));
    const sortBy = String(req.query.sortBy || 'lastUpdated');
    const sortOrder = String(req.query.sortOrder || 'desc').toLowerCase() === 'asc' ? 'asc' : 'desc';
    const shopId = String(req.query.shopId || '').trim();
    const aisle = String(req.query.aisle || '').trim();
    const page = Math.max(parseInt(req.query.page || '1', 10), 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit || '25', 10), 1), 100);

    const whereClause = scopedShopId
      ? {
          list: {
            shopId: scopedShopId
          }
        }
      : {};

    const listProducts = await prisma.listProduct.findMany({
      where: whereClause,
      select: {
        listId: true,
        list: {
          select: {
            shopId: true,
            updatedAt: true,
            createdAt: true
          }
        },
        productAtShop: {
          select: {
            shopId: true,
            card_aiel_number: true,
            price: true,
            updatedAt: true,
            createdAt: true,
            shop: {
              select: {
                id: true,
                name: true
              }
            },
            product: {
              select: {
                id: true,
                title: true,
                caseBarcode: true,
                barcode: true,
                img: true,
                caseSize: true,
                packetSize: true,
                retailSize: true,
                rrp: true,
                category: true
              }
            }
          }
        }
      }
    });

    const dedupedItems = new Map();

    for (const row of listProducts) {
      const productAtShop = row.productAtShop;
      const product = productAtShop?.product;
      if (!product) continue;

      const resolvedShopId = String(productAtShop?.shopId || row.list?.shopId || '').trim();
      const resolvedShopName = String(productAtShop?.shop?.name || '').trim();
      const shopBucketValue = resolvedShopId || UNKNOWN_SHOP_VALUE;
      const shopBucketLabel = resolvedShopName || UNKNOWN_SHOP_LABEL;

      const aisleValue = String(productAtShop?.card_aiel_number || '').trim();
      const aisleBucketValue = aisleValue || NO_AISLE_VALUE;
      const aisleBucketLabel = aisleValue || NO_AISLE_LABEL;

      const fallbackKey = [
        product.title || '',
        product.retailSize || '',
        product.caseSize || '',
        product.packetSize || ''
      ]
        .map((part) => String(part).toLowerCase().trim())
        .join('|');

      const productKey = product.id || fallbackKey;
      if (!productKey) continue;

      const dedupeKey = `${shopBucketValue}::${productKey}`;

      const listUpdatedAt = row.list?.updatedAt || row.list?.createdAt || null;
      const productAtShopUpdatedAt = productAtShop?.updatedAt || productAtShop?.createdAt || null;
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
          price: productAtShop?.price ?? null,
          caseSize: product.caseSize || null,
          packetSize: product.packetSize || null,
          retailSize: product.retailSize || null,
          rrp: product.rrp || null,
          category: product.category || null,
          shopId: shopBucketValue,
          shopName: shopBucketLabel,
          aisle: aisleBucketLabel,
          aisleValue: aisleBucketValue,
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
      if (entry.price === null && productAtShop?.price != null) entry.price = productAtShop.price;
      if (!entry.caseSize && product.caseSize) entry.caseSize = product.caseSize;
      if (!entry.packetSize && product.packetSize) entry.packetSize = product.packetSize;
      if (!entry.retailSize && product.retailSize) entry.retailSize = product.retailSize;
      if (!entry.rrp && product.rrp) entry.rrp = product.rrp;
      if (!entry.category && product.category) entry.category = product.category;
      if (!entry.shopName && shopBucketLabel) entry.shopName = shopBucketLabel;
      if (!entry.aisle && aisleBucketLabel) entry.aisle = aisleBucketLabel;
      if (!entry.aisleValue && aisleBucketValue) entry.aisleValue = aisleBucketValue;
    }

    let items = Array.from(dedupedItems.values()).map((entry) => ({
      itemId: entry.itemId,
      dedupeKey: entry.dedupeKey,
      itemName: entry.itemName,
      barcode: entry.barcode,
      caseBarcode: entry.caseBarcode,
      img: entry.img,
      price: entry.price,
      caseSize: entry.caseSize,
      packetSize: entry.packetSize,
      retailSize: entry.retailSize,
      rrp: entry.rrp,
      category: entry.category,
      shopId: entry.shopId,
      shopName: entry.shopName,
      aisle: entry.aisle,
      aisleValue: entry.aisleValue,
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

    const shopOptionMap = new Map();
    for (const item of items) {
      const key = item.shopId || UNKNOWN_SHOP_VALUE;
      const existing = shopOptionMap.get(key);
      if (existing) {
        existing.count += 1;
      } else {
        shopOptionMap.set(key, {
          value: key,
          label: item.shopName || UNKNOWN_SHOP_LABEL,
          count: 1
        });
      }
    }

    const shopOptions = Array.from(shopOptionMap.values()).sort((a, b) => {
      if (a.value === UNKNOWN_SHOP_VALUE) return 1;
      if (b.value === UNKNOWN_SHOP_VALUE) return -1;
      return a.label.localeCompare(b.label);
    });

    if (shopId) {
      if (shopId === UNKNOWN_SHOP_VALUE) {
        items = items.filter((item) => (item.shopId || UNKNOWN_SHOP_VALUE) === UNKNOWN_SHOP_VALUE);
      } else {
        items = items.filter((item) => item.shopId === shopId);
      }
    }

    const aisleOptionMap = new Map();
    for (const item of items) {
      const key = item.aisleValue || NO_AISLE_VALUE;
      const existing = aisleOptionMap.get(key);
      if (existing) {
        existing.count += 1;
      } else {
        aisleOptionMap.set(key, {
          value: key,
          label: item.aisle || NO_AISLE_LABEL,
          count: 1
        });
      }
    }

    const aisleOptions = Array.from(aisleOptionMap.values()).sort((a, b) => {
      if (a.value === NO_AISLE_VALUE) return 1;
      if (b.value === NO_AISLE_VALUE) return -1;
      return a.label.localeCompare(b.label, undefined, { numeric: true, sensitivity: 'base' });
    });

    if (aisle) {
      if (aisle === NO_AISLE_VALUE) {
        items = items.filter((item) => (item.aisleValue || NO_AISLE_VALUE) === NO_AISLE_VALUE);
      } else {
        items = items.filter((item) => item.aisleValue === aisle);
      }
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
        filters: {
          shops: shopOptions,
          aisles: aisleOptions,
          selectedShop: shopId || null,
          selectedAisle: aisle || null
        },
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

    const existingProduct = await prisma.product.findUnique({
      where: { id: itemId },
      select: {
        id: true,
        title: true,
        caseBarcode: true
      }
    });

    if (!existingProduct) {
      return res.status(404).json({ success: false, error: 'Item not found' });
    }

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

    const updateUserType = String(req.user?.userType || '').toUpperCase();
    if (updateUserType === 'EMPLOYEE') {
      try {
        const employeeId = parseInt(req.user.id, 10);
        if (!Number.isNaN(employeeId)) {
          const employee = await prisma.empolyee.findUnique({
            where: { id: employeeId },
            select: { shopId: true }
          });

          if (employee?.shopId) {
            await prisma.actionLog.create({
              data: {
                employeeId,
                shopId: employee.shopId,
                productId: itemId,
                actionType: 'LIST_ITEM_UPDATE',
                beforeData: {
                  caseBarcode: existingProduct.caseBarcode || null
                },
                afterData: {
                  caseBarcode: updatedProduct.caseBarcode || null
                }
              }
            });
          }
        }
      } catch (logError) {
        console.error('Failed to log list item update:', logError);
      }
    }

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

const updateListItemDetails = async (req, res) => {
  try {
    const {
      itemId,
      shopId,
      title,
      barcode,
      caseBarcode,
      caseSize,
      packetSize,
      retailSize,
      rrp,
      category,
      price
    } = req.body;

    if (!itemId || typeof itemId !== 'string') {
      return res.status(400).json({ success: false, error: 'Valid itemId is required' });
    }

    const normalizedTitle = typeof title === 'string' ? title.trim() : undefined;
    const normalizedBarcode = typeof barcode === 'string' ? barcode.trim() : undefined;
    const normalizedCaseBarcode = typeof caseBarcode === 'string' ? caseBarcode.trim() : undefined;
    const normalizedCaseSize = typeof caseSize === 'string' ? caseSize.trim() : undefined;
    const normalizedPacketSize = typeof packetSize === 'string' ? packetSize.trim() : undefined;
    const normalizedRetailSize = typeof retailSize === 'string' ? retailSize.trim() : undefined;
    const normalizedCategory = typeof category === 'string' ? category.trim() : undefined;
    const normalizedShopId = typeof shopId === 'string' ? shopId.trim() : undefined;

    const hasRrp = Object.prototype.hasOwnProperty.call(req.body, 'rrp');
    const hasPrice = Object.prototype.hasOwnProperty.call(req.body, 'price');
    const parsedRrp = hasRrp ? (rrp === '' || rrp === null ? null : Number(rrp)) : undefined;
    const parsedPrice = hasPrice ? (price === '' || price === null ? null : Number(price)) : undefined;

    if (parsedRrp !== undefined && Number.isNaN(parsedRrp)) {
      return res.status(400).json({ success: false, error: 'RRP must be a valid number' });
    }

    if (parsedPrice !== undefined && Number.isNaN(parsedPrice)) {
      return res.status(400).json({ success: false, error: 'Price must be a valid number' });
    }

    const existingProduct = await prisma.product.findUnique({
      where: { id: itemId },
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
    });

    if (!existingProduct) {
      return res.status(404).json({ success: false, error: 'Item not found' });
    }

    let existingProductAtShop = null;
    if (normalizedShopId) {
      existingProductAtShop = await prisma.productAtShop.findUnique({
        where: {
          shopId_productId: {
            shopId: normalizedShopId,
            productId: itemId
          }
        },
        select: {
          id: true,
          price: true,
          shopId: true
        }
      });
    }

    const productUpdateData = {};
    if (normalizedTitle !== undefined) productUpdateData.title = normalizedTitle || 'Unnamed Item';
    if (normalizedBarcode !== undefined) productUpdateData.barcode = normalizedBarcode || null;
    if (normalizedCaseBarcode !== undefined) productUpdateData.caseBarcode = normalizedCaseBarcode || null;
    if (normalizedCaseSize !== undefined) productUpdateData.caseSize = normalizedCaseSize || null;
    if (normalizedPacketSize !== undefined) productUpdateData.packetSize = normalizedPacketSize || null;
    if (normalizedRetailSize !== undefined) productUpdateData.retailSize = normalizedRetailSize || null;
    if (parsedRrp !== undefined) productUpdateData.rrp = parsedRrp;
    if (normalizedCategory !== undefined) productUpdateData.category = normalizedCategory || null;

    let updatedProduct = existingProduct;
    let updatedProductAtShop = existingProductAtShop;

    await prisma.$transaction(async (tx) => {
      if (Object.keys(productUpdateData).length > 0) {
        updatedProduct = await tx.product.update({
          where: { id: itemId },
          data: productUpdateData,
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
        });
      }

      if (normalizedShopId && parsedPrice !== undefined) {
        if (!existingProductAtShop) {
          throw new Error('Product is not assigned to this shop');
        }

        updatedProductAtShop = await tx.productAtShop.update({
          where: {
            shopId_productId: {
              shopId: normalizedShopId,
              productId: itemId
            }
          },
          data: {
            price: parsedPrice,
            updatedAt: new Date()
          },
          select: {
            id: true,
            price: true,
            shopId: true
          }
        });
      }
    });

    const detailUserType = String(req.user?.userType || '').toUpperCase();
    if (detailUserType === 'EMPLOYEE') {
      try {
        const employeeId = parseInt(req.user.id, 10);
        if (!Number.isNaN(employeeId)) {
          const employee = await prisma.empolyee.findUnique({
            where: { id: employeeId },
            select: { shopId: true }
          });
          let logShopId = employee?.shopId || null;
          if (!logShopId && normalizedShopId && !normalizedShopId.startsWith('__')) {
            logShopId = normalizedShopId;
          }

          if (!logShopId && updatedProductAtShop?.shopId) {
            logShopId = updatedProductAtShop.shopId;
          }

          if (!logShopId && existingProductAtShop?.shopId) {
            logShopId = existingProductAtShop.shopId;
          }

          if (!logShopId) {
            const fallback = await prisma.productAtShop.findFirst({
              where: { productId: itemId },
              select: { shopId: true }
            });
            logShopId = fallback?.shopId || null;
          }

          if (logShopId) {
            await prisma.actionLog.create({
              data: {
                employeeId,
                shopId: logShopId,
                productId: itemId,
                actionType: 'LIST_ITEM_UPDATE',
                beforeData: toJsonSafe({
                  product: existingProduct,
                  productAtShop: existingProductAtShop
                }),
                afterData: toJsonSafe({
                  product: updatedProduct,
                  productAtShop: updatedProductAtShop
                })
              }
            });
          } else {
            console.warn('Skipping list item update log: no shopId found', {
              employeeId,
              itemId,
              normalizedShopId
            });
          }
        }
      } catch (logError) {
        console.error('Failed to log list item update:', logError);
      }
    }

    res.status(200).json({
      success: true,
      message: 'List item updated',
      data: {
        product: updatedProduct,
        productAtShop: updatedProductAtShop
      }
    });
  } catch (error) {
    if (error.code === 'P2002') {
      return res.status(409).json({ success: false, error: 'Barcode already exists for another product' });
    }

    if (error.message === 'Product is not assigned to this shop') {
      return res.status(400).json({ success: false, error: error.message });
    }

    console.error('Error updating list item:', error);
    res.status(500).json({ success: false, error: 'Failed to update list item' });
  }
};

const getEmployeeListItemUpdates = async (req, res) => {
  try {
    const employeeId = parseInt(req.params.employeeId, 10);
    if (Number.isNaN(employeeId)) {
      return res.status(400).json({ success: false, error: 'Valid employeeId is required' });
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

    res.status(200).json({
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
    console.error('Error fetching list item updates for employee:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch list item updates' });
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
  updateGlobalCaseBarcode,
  updateListItemDetails,
  getEmployeeListItemUpdates
}