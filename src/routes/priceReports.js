import { getEffectivePrice } from '../services/supplierPricing.js';
import express from 'express';
import { PrismaClient } from '@prisma/client';
import { orderByRank, searchProductIds } from '../services/productSearchService.js';
import { isAuthenticated, requireCompanyPermission } from '../middleware/authware.js';
import { COMPANY_PERMISSIONS } from '../services/accessControl.js';

const router = express.Router();
const prisma = new PrismaClient();
const requireReviewer = requireCompanyPermission(COMPANY_PERMISSIONS.PRICE_REPORTS_REVIEW);

// Levenshtein distance function for fuzzy matching
function levenshteinDistance(str1, str2) {
  const m = str1.length;
  const n = str2.length;
  
  const dp = Array(m + 1).fill(null).map(() => Array(n + 1).fill(0));
  
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (str1[i - 1].toLowerCase() === str2[j - 1].toLowerCase()) {
        dp[i][j] = dp[i - 1][j - 1];
      } else {
        dp[i][j] = 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
      }
    }
  }
  
  return dp[m][n];
}

// Fuzzy match a word against a text
function fuzzyMatchWord(searchWord, text, maxDistance = 2) {
  if (!searchWord || !text) return false;
  
  const lowerWord = searchWord.toLowerCase();
  const lowerText = text.toLowerCase();
  
  if (lowerText.includes(lowerWord)) return true;
  
  const textWords = lowerText.split(/\s+/);
  
  for (const textWord of textWords) {
    if (textWord === lowerWord) return true;
    if (textWord.startsWith(lowerWord) || lowerWord.startsWith(textWord)) return true;
    
    const lengthDiff = Math.abs(textWord.length - lowerWord.length);
    if (lengthDiff <= maxDistance) {
      const distance = levenshteinDistance(textWord, lowerWord);
      const threshold = lowerWord.length <= 4 ? 1 : maxDistance;
      if (distance <= threshold) return true;
    }
  }
  
  return false;
}

const authenticateToken = isAuthenticated;
const identitySelect = { id: true, name: true, email: true };
const reportInclude = {
  reporter: { select: identitySelect },
  reporterEmployee: { select: identitySelect },
  reporterAdmin: { select: identitySelect },
  product: true,
  shop: true,
};
const reporterField = { CUSTOMER: 'reporterId', EMPLOYEE: 'reporterEmployeeId', ADMIN: 'reporterAdminId' };
const reporterWhere = user => ({ reporterType: user.userType, [reporterField[user.userType]]: user.id });
function presentReport(row) {
  const { reporterEmployee, reporterAdmin, ...report } = row;
  const identity = row.reporterType === 'EMPLOYEE' ? reporterEmployee : row.reporterType === 'ADMIN' ? reporterAdmin : row.reporter;
  // Keep the admin dashboard's reporter.name/email contract without exposing credentials.
  return { ...report, reporter: identity ? { ...identity, userType: row.reporterType } : null };
}
function validPrice(value) {
  if (!['string', 'number'].includes(typeof value)) return false;
  const text = String(value).trim();
  return /^\d+(?:\.\d{1,2})?$/.test(text) && Number.isFinite(Number(text)) && Number(text) <= 1_000_000_000;
}
function validNotes(value) { return value == null || (typeof value === 'string' && value.length <= 2000); }


// GET /api/price-reports - Get user's price reports
router.get('/', authenticateToken, async (req, res) => {
  try {
    const reports = await prisma.priceReport.findMany({
      where: reporterWhere(req.user),
      include: {
        product: true,
        shop: true
      },
      orderBy: { createdAt: 'desc' }
    });

    // Get user's earnings/points
    const user = req.user.userType === 'CUSTOMER' ? await prisma.customer.findUnique({
      where: { id: req.user.id },
      select: { earnings: true }
    }) : null;

    res.json({
      reports,
      earnings: user?.earnings || 0
    });
  } catch (error) {
    console.error('Error fetching price reports:', error);
    res.status(500).json({ error: 'Failed to fetch reports' });
  }
});

// POST /api/price-reports - Submit a new price report
router.post('/', authenticateToken, async (req, res) => {
  try {
    const userId = parseInt(req.user.id);
    const { productId, shopId, reportedPrice, currentPrice, notes, productAtShopId } = req.body;

    if (!validPrice(reportedPrice) || (currentPrice != null && !validPrice(currentPrice))) {
      return res.status(400).json({ error: 'Prices must be non-negative amounts with at most two decimal places' });
    }
    if (!validNotes(notes)) return res.status(400).json({ error: 'Notes must be text of at most 2000 characters' });

    if (!productId && !productAtShopId) {
      return res.status(400).json({ error: 'Either productId with shopId, or productAtShopId is required' });
    }

    let finalProductId = productId;
    let finalShopId = shopId;
    let productAtShop;

    // If productAtShopId is provided, look up the product and shop
    if (productAtShopId) {
      productAtShop = await prisma.productAtShop.findUnique({
        where: { id: productAtShopId },
        include: {
          product: true,
          shop: true
        }
      });

      if (!productAtShop) {
        return res.status(404).json({ error: 'Product not found' });
      }

      finalProductId = productAtShop.productId;
      finalShopId = productAtShop.shopId;
    } else if (productId && shopId) {
      // Check if product exists at this shop
      productAtShop = await prisma.productAtShop.findUnique({
        where: { shopId_productId: { shopId, productId } },
        include: {
          product: true,
          shop: true
        }
      });

      if (!productAtShop) {
        return res.status(404).json({ error: 'Product not found at this shop' });
      }
    } else {
      return res.status(400).json({ error: 'Product and Shop information required' });
    }

    // Create price report
    const report = await prisma.priceReport.create({
      data: {
        ...reporterWhere(req.user),
        productId: finalProductId,
        shopId: finalShopId,
        currentPrice: currentPrice == null ? productAtShop.price : Number(currentPrice),
        reportedPrice: Number(reportedPrice),
        status: 'PENDING',
        adminNotes: notes || null
      },
      include: {
        product: true,
        shop: true
      }
    });

    console.log(`📋 New price report created by ${req.user.userType} ${userId} for product ${finalProductId} at shop ${finalShopId}`);

    res.status(201).json({
      message: 'Price report submitted successfully',
      report
    });
  } catch (error) {
    console.error('Error creating price report:', error);
    res.status(500).json({ error: 'Failed to submit price report' });
  }
});

// Company reviewers retain the existing review permission; submissions stay authenticated.
router.get('/admin/pending', authenticateToken, requireReviewer, async (req, res) => {
  try {
    const reports = await prisma.priceReport.findMany({ where: { status: 'PENDING' }, include: reportInclude, orderBy: { createdAt: 'asc' } });
    res.json(reports.map(presentReport));
  } catch (error) {
    console.error('Error fetching pending reports:', error);
    res.status(500).json({ error: 'Failed to fetch pending reports' });
  }
});

function reviewReport(status) {
  return async (req, res) => {
    try {
      const { reportId } = req.params;
      const { adminNotes } = req.body;
      if (!validNotes(adminNotes)) return res.status(400).json({ error: 'Notes must be text of at most 2000 characters' });
      const report = await prisma.$transaction(async tx => {
        // Serialize all review aliases so concurrent approvals cannot award twice.
        await tx.$queryRaw`SELECT "id" FROM "PriceReport" WHERE "id" = ${reportId} FOR UPDATE`;
        const current = await tx.priceReport.findUnique({ where: { id: reportId } });
        if (!current) throw Object.assign(new Error('Report not found'), { status: 404 });
        if (current.status !== 'PENDING') throw Object.assign(new Error('Report already processed'), { status: 400 });
        const award = status === 'APPROVED' && current.reporterType === 'CUSTOMER';
        if (status === 'APPROVED') {
          await tx.productAtShop.update({
            where: { shopId_productId: { shopId: current.shopId, productId: current.productId } },
            data: { price: current.reportedPrice, offerPriceSource: null, priceObservedAt: new Date(), updatedAt: new Date() },
          });
          // Customer earnings are an existing customer-only benefit; integer IDs
          // from the employee/admin tables must never address a Customer row.
          if (award) await tx.customer.update({ where: { id: current.reporterId }, data: { earnings: { increment: 1 } } });
        }
        return tx.priceReport.update({
          where: { id: reportId },
          data: {
            status, adminNotes: adminNotes || null, reviewedAt: new Date(), pointsAwarded: award,
            reviewedBy: req.user.userType === 'ADMIN' ? req.user.id : null,
            reviewedByEmployeeId: req.user.userType === 'EMPLOYEE' ? req.user.id : null,
          },
          include: reportInclude,
        });
      }, { maxWait: 15000, timeout: 60000 });
      res.json({
        message: status === 'APPROVED' ? 'Report approved and price updated successfully' : 'Report rejected',
        report: presentReport(report), pointsAwarded: report.pointsAwarded ? 1 : 0, priceUpdated: status === 'APPROVED',
      });
    } catch (error) {
      if (error.status) return res.status(error.status).json({ error: error.message });
      console.error('Error reviewing price report:', error);
      res.status(500).json({ error: 'Failed to review report' });
    }
  };
}
router.put('/admin/:reportId/approve', authenticateToken, requireReviewer, reviewReport('APPROVED'));
router.post('/admin/approve/:reportId', authenticateToken, requireReviewer, reviewReport('APPROVED'));
router.put('/admin/:reportId/reject', authenticateToken, requireReviewer, reviewReport('REJECTED'));
router.post('/admin/reject/:reportId', authenticateToken, requireReviewer, reviewReport('REJECTED'));

// GET /api/price-reports/product/:productId/shop/:shopId/price - Get current price for a product at a shop
router.get('/product/:productId/shop/:shopId/price', authenticateToken, async (req, res) => {
  try {
    const { productId, shopId } = req.params;

    const productAtShop = await prisma.productAtShop.findUnique({
      where: {
        shopId_productId: {
          shopId,
          productId
        }
      },
      select: {
        price: true,
        offerPrice: true,
        offerExpiryDate: true,
        offerPriceSource: true,
        sourcePricing: true,
        unitsPerPack: true,
        packagingId: true,
        pricedUnitSize: true,
        priceObservedAt: true,
        updatedAt: true
      }
    });

    if (!productAtShop) {
      return res.status(404).json({ error: 'Product not found at this shop' });
    }

    res.json({
      ...getEffectivePrice(productAtShop),
      offerExpiryDate: productAtShop.offerExpiryDate,
      lastUpdated: productAtShop.updatedAt
    });
  } catch (error) {
    console.error('Error fetching product price:', error);
    res.status(500).json({ error: 'Failed to fetch product price' });
  }
});

// GET /api/price-reports/products/search - Ranked product search for price reporting
router.get('/products/search', authenticateToken, async (req, res) => {
  try {
    const { q, limit = 10 } = req.query;

    if (!q || typeof q !== 'string' || q.trim().length < 2) {
      return res.json({ products: [] });
    }

    const take = Math.min(Math.max(parseInt(limit) || 10, 1), 100);
    const rankedIds = (await searchProductIds(q, { limit: take })).map((r) => r.id);
    const rows = rankedIds.length
      ? await prisma.product.findMany({
          where: { id: { in: rankedIds } },
          select: {
            id: true,
            title: true,
            barcode: true,
            img: true
          },
        })
      : [];

    res.json({ products: orderByRank(rows, rankedIds) });
  } catch (error) {
    console.error('Error searching products:', error);
    res.status(500).json({ error: 'Failed to search products' });
  }
});

// GET /api/price-reports/products/:productId/shops/search - Search shops that have a specific product with fuzzy matching
router.get('/products/:productId/shops/search', authenticateToken, async (req, res) => {
  try {
    const { productId } = req.params;
    const { q, limit = 10 } = req.query;

    // Build the where condition
    const whereCondition = {
      productId: productId,
    };

    let searchWords = [];
    
    // Only add search filters if query is provided and has enough characters
    if (q && q.trim().length >= 2) {
      searchWords = q.trim().split(/\s+/).filter(word => word.length > 0);
      
      const searchConditions = searchWords.map(word => ({
        OR: [
          { name: { contains: word, mode: 'insensitive' } },
          { address: { contains: word, mode: 'insensitive' } }
        ]
      }));
      
      whereCondition.shop = { AND: searchConditions };
    }

    // Find shops that have this product (with optional search filter)
    let shopsWithProduct = await prisma.productAtShop.findMany({
      where: whereCondition,
      include: {
        shop: {
          select: {
            id: true,
            name: true,
            address: true,
            mobile: true
          }
        }
      },
      take: parseInt(limit) * 2,
      orderBy: { shop: { name: 'asc' } }
    });

    // If few results and search was provided, try fuzzy matching
    if (searchWords.length > 0 && shopsWithProduct.length < parseInt(limit) / 2) {
      const allShopsWithProduct = await prisma.productAtShop.findMany({
        where: { productId: productId },
        include: {
          shop: {
            select: {
              id: true,
              name: true,
              address: true,
              mobile: true
            }
          }
        },
        take: 100
      });
      
      const fuzzyMatched = allShopsWithProduct.filter(item => {
        const searchableText = `${item.shop.name || ''} ${item.shop.address || ''}`;
        return searchWords.every(word => fuzzyMatchWord(word, searchableText, 2));
      });
      
      const existingIds = new Set(shopsWithProduct.map(s => s.shop.id));
      const additionalShops = fuzzyMatched.filter(s => !existingIds.has(s.shop.id));
      shopsWithProduct = [...shopsWithProduct, ...additionalShops];
    }

    const shops = shopsWithProduct.slice(0, parseInt(limit)).map(item => item.shop);
    res.json({ shops });
  } catch (error) {
    console.error('Error searching shops:', error);
    res.status(500).json({ error: 'Failed to search shops' });
  }
});

// GET /api/price-reports/products/:productId/shops - Get all shops that have a specific product
router.get('/products/:productId/shops', authenticateToken, async (req, res) => {
  try {
    const { productId } = req.params;
    const { limit = 50 } = req.query; // Higher default limit for showing all shops

    // Find all shops that have this product
    const shopsWithProduct = await prisma.productAtShop.findMany({
      where: {
        productId: productId,
      },
      include: {
        shop: {
          select: {
            id: true,
            name: true,
            address: true,
            mobile: true
          }
        }
      },
      take: parseInt(limit),
      orderBy: { shop: { name: 'asc' } }
    });

    const shops = shopsWithProduct.map(item => item.shop);
    res.json({ shops });
  } catch (error) {
    console.error('Error fetching shops for product:', error);
    res.status(500).json({ error: 'Failed to fetch shops' });
  }
});

// GET /api/price-reports/admin/all - Get all price reports with filters
router.get('/admin/all', authenticateToken, requireReviewer, async (req, res) => {
  try {
    const { status, limit = 50 } = req.query;

    if (status && !['PENDING', 'APPROVED', 'REJECTED'].includes(status)) return res.status(400).json({ error: 'Invalid report status' });
    const whereCondition = status ? { status } : {};

    const reports = await prisma.priceReport.findMany({
      where: whereCondition,
      include: reportInclude,
      orderBy: { createdAt: 'desc' },
      take: Math.min(Math.max(parseInt(limit) || 50, 1), 500)
    });

    res.json({ reports: reports.map(presentReport) });
  } catch (error) {
    console.error('Error fetching all reports:', error);
    res.status(500).json({ error: 'Failed to fetch reports' });
  }
});

export default router;