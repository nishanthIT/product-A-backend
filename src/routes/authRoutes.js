import express from "express";
import multer from "multer";
import path from "path";
import fs from 'fs';
import { filterProducts, getProductFilters } from "../controller/filterProducts.js";
import {
  addProduct,
  editProduct,
  getProductByBarcode,
  getProductById,
  searchProducts,
  deleteProduct,
  quickAddProductFromScan,
  getPendingSubmittedProducts,
  approveSubmittedProduct,
} from "../controller/addProduct.js";
import { addShop, deleteShop, editShop, getAllShops, getShopById } from "../controller/addShop.js";
import {
  addProductAtShop,
  addProductAtShopifExistAtProduct,
  getAllProductIdsAtShop,
  getProductsAtShop,
  removeProductFromShop,
  transferProductsBetweenShops,
  searchProductsNotInShop,
  updateProductPriceAtShop,
  toggleOutOfStock,
  getShopFilters,
} from "../controller/addProductAtShop.js";
import {
  addEmployee,
  deleteEmployee,
  getAllEmployees,
  getEmployee,
  updateEmployee,
} from "../controller/employee.js";
import { COMPANY_PERMISSIONS as P, SHOP_FEATURES } from "../services/accessControl.js";
import {
  addCustomer,
  deleteCustomer,
  getCustomer,
  updateCustomer,
} from "../controller/customer.js";
import { getHourlyProductAdds } from "../controller/employeeAction.js";
import {
  addProductToList,
  getLowestPricesInList,
  makeList,
  removeProductFromList,
  getUserLists,
  getListById,
  deleteList,
  renameList,
  untrackList,
} from "../controller/makeList.js";
import { login, register, sendRegistrationOtp, logout, verify, extendTrialWithPoints, forgotPassword, resetPassword } from "../controller/auth.js";
import { emp_dash_handler, getEmployeeListItemUpdates } from "../controller/dashbord/employ.js";
import { getDashboardOverview } from "../controller/dashbord/admin.js";
import {
  isAdmin,
  isAuthenticated,
  requireCompanyPermission,
  requireCompanyStaff,
  requireShopFeature,
} from "../middleware/authware.js";
import { requireActiveSubscription, softSubscriptionCheck } from "../middleware/subscriptionCheck.js";
import { image } from "../controller/image.js";
import {
  createBundlePromotion,
  getBundlePromotions,
  getBundlePromotion,
  updateBundlePromotion,
  deleteBundlePromotion,
  checkProductBundleOffers,
  checkCartBundleOffers
} from "../controller/bundlePromotion.js";
import { getPackOptions } from "../controller/packComparison.js";
import {
  getShopProductPriceTiers,
  setShopProductPriceTiers,
  getProductPriceTiers,
} from "../controller/priceTiers.js";

const router = express.Router();

// Ensure upload directories exist
const uploadDirs = ['uploads', 'uploads/products', 'images'];
uploadDirs.forEach(dir => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
});

// Configure multer for product image uploads
const productStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = 'uploads/products';
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, 'product-' + uniqueSuffix + path.extname(file.originalname));
  }
});

const productUpload = multer({
  storage: productStorage,
  limits: { fileSize: 100 * 1024 * 1024 }, // 100MB max - allow larger images
  fileFilter: (req, file, cb) => {
    const allowedTypes = /jpeg|jpg|png|gif|webp|heic|heif|bmp|tiff/;
    const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
    const mimetype = file.mimetype.startsWith('image/');
    if (extname || mimetype) {
      cb(null, true);
    } else {
      cb(new Error('Only image files are allowed'));
    }
  }
});


router.post("/auth/login", login);
router.post("/auth/register/send-otp", sendRegistrationOtp);
router.post("/auth/register", register);
router.get("/auth/me", verify); // Make sure this route exists and is correctly defined
router.post("/auth/logout", logout);
router.post("/auth/extend-trial", isAuthenticated, extendTrialWithPoints);
router.post("/auth/forgot-password", forgotPassword);
router.post("/auth/reset-password", resetPassword);

router.get("/image/:barcode",image)

// Company catalog management: explicit company permissions only (never a shop role).
const catalogRead = [isAuthenticated, requireCompanyPermission(P.CATALOG_READ)];
const catalogWrite = [isAuthenticated, requireCompanyPermission(P.CATALOG_WRITE)];
const shopsManage = [isAuthenticated, requireCompanyPermission(P.SHOPS_MANAGE)];
const staffManage = [isAuthenticated, requireCompanyPermission(P.STAFF_MANAGE)];

router.get("/filterProducts", catalogRead, filterProducts); // given in query
router.get("/productFilters", catalogRead, getProductFilters); // Get available categories and aisles for filter dropdowns

/* <!-- Product Routes --> */
router.post("/addProduct", catalogWrite, addProduct);
router.put("/editProduct/:id", catalogWrite, editProduct);
router.get("/getProductByBarcode/:barcode", catalogRead, getProductByBarcode);
router.get("/getProductById/:id", catalogRead, getProductById);
router.delete("/deleteProduct/:id",isAuthenticated,isAdmin, deleteProduct); // Admin only - delete product

// Customer product search routes (for adding to lists)
router.get("/products/barcode/:barcode",isAuthenticated, getProductByBarcode); // Allow customers to search
router.get("/products/search",isAuthenticated, searchProducts); // Search products by name
router.post("/products/quick-add", isAuthenticated, quickAddProductFromScan);
router.get("/products/pending-submissions", catalogWrite, getPendingSubmittedProducts);
router.put("/products/pending-submissions/:id/approve", isAuthenticated, isAdmin, approveSubmittedProduct);
router.get("/products/:id/pack-options", isAuthenticated, getPackOptions); // Pack size comparison (smart purchase recommendation)
router.get("/products/:id/price-tiers", isAuthenticated, getProductPriceTiers); // Quantity-based price tiers (lowest-priced shop)
router.get("/products/:id",isAuthenticated, getProductById); // Allow customers to view products


/* <!-- Shop Routes --> */
router.post("/addShop", shopsManage, addShop);
router.put("/editShop/:id", shopsManage, editShop);
router.get("/getAllshop", shopsManage, getAllShops);
router.get("/getshop/:id", shopsManage, getShopById);
router.delete("/shops/:id",isAuthenticated,isAdmin, deleteShop); // Admin only - delete shop

/* <!-- ProductAtShop Routes --> */
// router.post("/addProductAtShop", addProductAtShop);
// router.post(
//   "/addProductAtShopifExistAtProduct",
//   addProductAtShopifExistAtProduct
// );
// router.put("/updateProductPriceAtShop/:shopId", updateProductPriceAtShop);
// router.get("/productAtShop/:shopId",getProductAtShop);

// Add a new product and associate it with a shop (with optional image upload)
router.post('/addProductAtShop', (req, res, next) => {
  console.log('=== addProductAtShop route hit ===');
  console.log('Headers:', JSON.stringify(req.headers, null, 2));
  next();
}, shopsManage, (req, res, next) => {
  console.log('=== Passed auth, starting multer ===');
  productUpload.single('image')(req, res, (err) => {
    if (err) {
      console.error('=== Multer error ===', err);
      if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          return res.status(400).json({ error: 'File is too large. Maximum size is 100MB.' });
        }
        return res.status(400).json({ error: `Upload error: ${err.message}` });
      } else {
        return res.status(400).json({ error: err.message });
      }
    }
    console.log('=== Multer complete, file:', req.file ? req.file.filename : 'no file');
    next();
  });
}, addProductAtShop);

// Add an existing product to a shop (with optional image upload)
router.post('/addProductAtShopifExistAtProduct', shopsManage, (req, res, next) => {
  productUpload.single('image')(req, res, (err) => {
    if (err instanceof multer.MulterError) {
      // A Multer error occurred when uploading
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({ error: 'File is too large. Maximum size is 100MB.' });
      }
      return res.status(400).json({ error: `Upload error: ${err.message}` });
    } else if (err) {
      // An unknown error occurred when uploading
      return res.status(400).json({ error: err.message });
    }
    // Everything went fine, continue to the next middleware
    next();
  });
}, addProductAtShopifExistAtProduct);

// Get products at a shop with pagination and search
router.get('/shop/:shopId/products', shopsManage, getProductsAtShop);

// Get all product IDs in a shop (for bulk transfer selection)
router.get('/shop/:shopId/product-ids', shopsManage, getAllProductIdsAtShop);

// Get categories and aisles available at a shop for filters
router.get('/shop/:shopId/filters', shopsManage, getShopFilters);

// Transfer products from one shop to another in bulk
router.post('/shop/transfer-products', shopsManage, transferProductsBetweenShops);

// Update product price at a shop
router.put('/shop/:shopId/updateProductPrice', shopsManage, updateProductPriceAtShop);

// Quantity-based price tiers for a product at a shop (company staff)
router.get('/shop/:shopId/product/:productId/price-tiers', shopsManage, getShopProductPriceTiers);
router.put('/shop/:shopId/product/:productId/price-tiers', shopsManage, setShopProductPriceTiers);

// Search for products not in a shop (company staff)
router.get('/shop/:shopId/searchProducts', shopsManage, searchProductsNotInShop);

// Remove a product from a shop
router.delete('/shop/:shopId/product', shopsManage, removeProductFromShop);

// Toggle out of stock status for a product at shop
router.put('/shop/:shopId/product/:productId/stock', shopsManage, toggleOutOfStock);

// Product-specific promotions endpoints
import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

// Helper function to find and apply the best promotion for today
const applyBestPromotion = async (productAtShopId) => {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  
  // Get all active promotions for this product
  const promotions = await prisma.productPromotion.findMany({
    where: {
      productAtShopId,
      isActive: true
    },
    orderBy: [
      { startDate: 'asc' }
    ]
  });
  
  // Find the best active promotion for today (lowest price among active ones)
  let bestPromo = null;
  for (const promo of promotions) {
    const startDate = new Date(promo.startDate);
    startDate.setHours(0, 0, 0, 0);
    
    // Check if promotion has started
    if (startDate > today) continue;
    
    // Check if promotion has expired
    if (promo.endDate) {
      const endDate = new Date(promo.endDate);
      endDate.setHours(23, 59, 59, 999);
      if (today > endDate) continue;
    }
    
    // This promotion is active - check if it's the best
    if (!bestPromo || parseFloat(promo.promotionPrice) < parseFloat(bestPromo.promotionPrice)) {
      bestPromo = promo;
    }
  }
  
  // Update ProductAtShop with the best promotion
  if (bestPromo) {
    await prisma.productAtShop.update({
      where: { id: productAtShopId },
      data: {
        offerPrice: bestPromo.promotionPrice,
        offerExpiryDate: bestPromo.endDate,
        updatedAt: new Date()
      }
    });
  } else {
    // No active promotion - clear offer
    await prisma.productAtShop.update({
      where: { id: productAtShopId },
      data: {
        offerPrice: null,
        offerExpiryDate: null,
        updatedAt: new Date()
      }
    });
  }
  
  return bestPromo;
};

// GET product promotions for a specific product at a shop
router.get('/product-promotions/:shopId/:productId', shopsManage, async (req, res) => {
  try {
    const { shopId, productId } = req.params;
    
    const productAtShop = await prisma.productAtShop.findUnique({
      where: {
        shopId_productId: { shopId, productId }
      },
      include: {
        product: { select: { title: true } },
        ProductPromotion: {
          orderBy: { startDate: 'asc' }
        }
      }
    });
    
    if (!productAtShop) {
      return res.status(404).json({ success: false, error: 'Product not found at shop' });
    }
    
    // Auto-apply the best promotion for today
    await applyBestPromotion(productAtShop.id);
    
    // Format promotions for frontend
    const promotions = productAtShop.ProductPromotion.map(p => ({
      id: p.id,
      startDate: p.startDate.toISOString(),
      endDate: p.endDate ? p.endDate.toISOString() : null,
      promotionPrice: parseFloat(p.promotionPrice),
      description: p.description,
      isActive: p.isActive
    }));
    
    res.json({ 
      success: true, 
      data: { 
        promotions,
        regularPrice: parseFloat(productAtShop.price),
        currentOfferPrice: productAtShop.offerPrice ? parseFloat(productAtShop.offerPrice) : null,
        currentOfferExpiry: productAtShop.offerExpiryDate
      } 
    });
  } catch (error) {
    console.error('Error fetching product promotions:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch promotions' });
  }
});

// POST add promotions for a product at shop
router.post('/product-promotions/:shopId/:productId', shopsManage, async (req, res) => {
  try {
    const { shopId, productId } = req.params;
    const { promotions } = req.body;
    
    if (!promotions || !Array.isArray(promotions) || promotions.length === 0) {
      return res.status(400).json({ success: false, error: 'Promotions array is required' });
    }
    
    // Get the ProductAtShop record
    const productAtShop = await prisma.productAtShop.findUnique({
      where: {
        shopId_productId: { shopId, productId }
      }
    });
    
    if (!productAtShop) {
      return res.status(404).json({ success: false, error: 'Product not found at shop' });
    }
    
    // Create all promotions in the ProductPromotion table
    const createdPromotions = await Promise.all(
      promotions.map(p => 
        prisma.productPromotion.create({
          data: {
            productAtShopId: productAtShop.id,
            startDate: new Date(p.startDate),
            endDate: p.endDate ? new Date(p.endDate) : null,
            promotionPrice: p.promotionPrice,
            description: p.description || null,
            isActive: true
          }
        })
      )
    );
    
    // Auto-apply the best promotion for today
    const bestPromo = await applyBestPromotion(productAtShop.id);
    
    res.json({ 
      success: true, 
      message: `${createdPromotions.length} promotion(s) added successfully`,
      data: { 
        promotions: createdPromotions,
        currentOfferPrice: bestPromo ? parseFloat(bestPromo.promotionPrice) : null,
        currentOfferExpiry: bestPromo ? bestPromo.endDate : null
      }
    });
  } catch (error) {
    console.error('Error adding product promotions:', error);
    res.status(500).json({ success: false, error: 'Failed to add promotions' });
  }
});

// DELETE a product promotion
router.delete('/product-promotions/:promotionId', shopsManage, async (req, res) => {
  try {
    const { promotionId } = req.params;
    
    // Get the promotion to find productAtShopId
    const promotion = await prisma.productPromotion.findUnique({
      where: { id: promotionId }
    });
    
    if (!promotion) {
      return res.status(404).json({ success: false, error: 'Promotion not found' });
    }
    
    const productAtShopId = promotion.productAtShopId;
    
    // Delete the promotion
    await prisma.productPromotion.delete({
      where: { id: promotionId }
    });
    
    // Re-apply best promotion after deletion
    await applyBestPromotion(productAtShopId);
    
    res.json({ success: true, message: 'Promotion deleted' });
  } catch (error) {
    console.error('Error deleting promotion:', error);
    res.status(500).json({ success: false, error: 'Failed to delete promotion' });
  }
});

// Apply a specific promotion as current offer (force override)
router.post('/product-promotions/:shopId/:productId/apply', shopsManage, async (req, res) => {
  try {
    const { shopId, productId } = req.params;
    const { promotionPrice, endDate } = req.body;
    
    const updated = await prisma.productAtShop.update({
      where: {
        shopId_productId: { shopId, productId }
      },
      data: {
        offerPrice: promotionPrice,
        offerExpiryDate: endDate ? new Date(endDate) : null,
        updatedAt: new Date()
      }
    });
    
    res.json({ 
      success: true, 
      message: 'Promotion applied as current offer',
      data: updated
    });
  } catch (error) {
    console.error('Error applying promotion:', error);
    res.status(500).json({ success: false, error: 'Failed to apply promotion' });
  }
});


// dashboard
router.get("/employee/dashboard-data", isAuthenticated, requireCompanyStaff, emp_dash_handler)
router.get("/employee/list-item-updates", isAuthenticated, requireCompanyStaff, getEmployeeListItemUpdates)
router.get("/admin/dashboard/overview",isAuthenticated,isAdmin,getDashboardOverview)



/* <!-- Company Staff Routes (never shop employees; see /api/employees for those) --> */
router.post("/addEmployee", staffManage, addEmployee);
router.put("/updateEmployee/:id", staffManage, updateEmployee);
router.delete("/deleteEmployee/:id", staffManage, deleteEmployee);
router.get("/getEmployee/:id", staffManage, getEmployee);

/* <!-- Customer Routes --> */
router.post("/addCustomer",isAuthenticated,isAdmin, addCustomer);
router.put("/updateCustomer",isAuthenticated,isAdmin, updateCustomer);
router.delete("/deleteCustomer/:id",isAuthenticated,isAdmin, deleteCustomer);
router.get("/getCustomer/:id",isAuthenticated,isAdmin, getCustomer);
router.get("/getallemploy", staffManage, getAllEmployees);

/* <!-- Action Log Routes --> */
router.get("/getHourlyProductAdds/:employeeId",isAuthenticated,isAdmin, getHourlyProductAdds);

// <!-- List Routes --> (Customer only) - With subscription checking
// Employees reach lists only through an ACTIVE shop membership.
const listAuth = [isAuthenticated, requireShopFeature(SHOP_FEATURES.LISTS)];
router.get("/lists", listAuth, softSubscriptionCheck, getUserLists); // Get all lists (soft check - allow viewing)
router.post("/lists", listAuth, requireActiveSubscription, makeList); // Create new list (requires active subscription)
router.post("/lists/addProduct", listAuth, requireActiveSubscription, addProductToList); // Add product to list (requires active subscription)
router.delete("/lists/removeProduct", listAuth, requireActiveSubscription, removeProductFromList); // Remove product from list (requires active subscription)
router.get("/lists/:listId/lowest-prices", listAuth, requireActiveSubscription, getLowestPricesInList); // Get lowest prices (premium feature)
// router.get("/lists/:listId", isAuthenticated, softSubscriptionCheck, getListById); // DISABLED - conflicts with listRoutes.js
router.put("/lists/:listId/rename", listAuth, renameList); // Rename list (owner or tracker) — syncs to shop
router.delete("/lists/:listId/untrack", listAuth, untrackList); // Stop tracking a shared list (remove from my lists)
router.delete("/lists/:listId", listAuth, requireActiveSubscription, deleteList); // Delete list (requires active subscription)

/* <!-- Bundle Promotion Routes --> */
// Company staff routes for managing bundle promotions
router.post("/shop/:shopId/bundle-promotions", shopsManage, createBundlePromotion);
router.get("/shop/:shopId/bundle-promotions", shopsManage, getBundlePromotions);
router.get("/bundle-promotions/:promotionId", shopsManage, getBundlePromotion);
router.put("/bundle-promotions/:promotionId", shopsManage, updateBundlePromotion);
router.delete("/bundle-promotions/:promotionId", shopsManage, deleteBundlePromotion);

// Customer routes for checking bundle offers
router.get("/shop/:shopId/product/:productId/bundle-offers", isAuthenticated, checkProductBundleOffers);
router.post("/shop/:shopId/check-cart-offers", isAuthenticated, checkCartBundleOffers);

export default router;
