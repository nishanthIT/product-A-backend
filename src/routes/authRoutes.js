import express from "express";
import multer from "multer";
import path from "path";
import { filterProducts } from "../controller/filterProducts.js";
import { addProduct, editProduct, getProductByBarcode, getProductById, searchProducts, deleteProduct } from "../controller/addProduct.js";
import { addShop, deleteShop, editShop, getAllShops, getShopById } from "../controller/addShop.js";
import {
  addProductAtShop,
  addProductAtShopifExistAtProduct,
 
  getProductsAtShop,
  removeProductFromShop,
  searchProductsNotInShop,
  updateProductPriceAtShop,
} from "../controller/addProductAtShop.js";
import {
  addEmployee,
  deleteEmployee,
  getAllEmployees,
  getEmployee,
  updateEmployee,
} from "../controller/employee.js";
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
} from "../controller/makeList.js";
import { login, register, logout, verify, extendTrialWithPoints, forgotPassword, resetPassword } from "../controller/auth.js";
import { emp_dash_handler } from "../controller/dashbord/employ.js";
import { getDashboardOverview } from "../controller/dashbord/admin.js";
import { isAdmin, isAuthenticated, isEmployee } from "../middleware/authware.js";
import { requireActiveSubscription, softSubscriptionCheck } from "../middleware/subscriptionCheck.js";
import { image } from "../controller/image.js";

const router = express.Router();

// Configure multer for product image uploads
const productStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, 'uploads/products');
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, 'product-' + uniqueSuffix + path.extname(file.originalname));
  }
});

const productUpload = multer({
  storage: productStorage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB max
  fileFilter: (req, file, cb) => {
    const allowedTypes = /jpeg|jpg|png|gif|webp/;
    const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
    const mimetype = allowedTypes.test(file.mimetype);
    if (extname && mimetype) {
      cb(null, true);
    } else {
      cb(new Error('Only image files are allowed'));
    }
  }
});


router.post("/auth/login", login);
router.post("/auth/register", register);
router.get("/auth/me", verify); // Make sure this route exists and is correctly defined
router.post("/auth/logout", logout);
router.post("/auth/extend-trial", isAuthenticated, extendTrialWithPoints);
router.post("/auth/forgot-password", forgotPassword);
router.get("/auth/reset-password", resetPassword);
router.post("/auth/reset-password", resetPassword);

router.get("/image/:barcode",image)

router.get("/filterProducts",isAuthenticated,isEmployee, filterProducts); // given in query

/* <!-- Product Routes --> */
router.post("/addProduct",isAuthenticated,isEmployee, addProduct);
router.put("/editProduct/:id",isAuthenticated,isEmployee, editProduct);
router.get("/getProductByBarcode/:barcode",isAuthenticated,isEmployee, getProductByBarcode);
router.get("/getProductById/:id",isAuthenticated,isEmployee, getProductById);
router.delete("/deleteProduct/:id",isAuthenticated,isAdmin, deleteProduct); // Admin only - delete product

// Customer product search routes (for adding to lists)
router.get("/products/barcode/:barcode",isAuthenticated, getProductByBarcode); // Allow customers to search
router.get("/products/search",isAuthenticated, searchProducts); // Search products by name
router.get("/products/:id",isAuthenticated, getProductById); // Allow customers to view products


/* <!-- Shop Routes --> */
router.post("/addShop",isAuthenticated,isEmployee, addShop);
router.put("/editShop/:id",isAuthenticated,isEmployee, editShop);
router.get("/getAllshop", isAuthenticated,isEmployee,getAllShops);
router.get("/getshop/:id",isAuthenticated,isEmployee, getShopById);
router.delete("/shops/:id",isAuthenticated,isAdmin, deleteShop); // Admin only - delete shop

/* <!-- ProductAtShop Routes --> */
// router.post("/addProductAtShop", addProductAtShop);
// router.post(
//   "/addProductAtShopifExistAtProduct",
//   addProductAtShopifExistAtProduct
// );
// router.put("/updateProductPriceAtShop/:shopId", updateProductPriceAtShop);
// router.get("/productAtShop/:shopId",getProductAtShop);

// Add a new product and associate it with a shop
router.post('/addProductAtShop',isAuthenticated,isEmployee, addProductAtShop);

// Add an existing product to a shop (with optional image upload)
router.post('/addProductAtShopifExistAtProduct',isAuthenticated,isEmployee, productUpload.single('image'), addProductAtShopifExistAtProduct);

// Get products at a shop with pagination and search
router.get('/shop/:shopId/products',isAuthenticated,isEmployee, getProductsAtShop);

// Update product price at a shop
router.put('/shop/:shopId/updateProductPrice',isAuthenticated,isEmployee, updateProductPriceAtShop);

// Search for products not in a shop (for employees)
router.get('/shop/:shopId/searchProducts',isAuthenticated,isEmployee, searchProductsNotInShop);

// Remove a product from a shop
router.delete('/shop/:shopId/product',isAuthenticated,isEmployee, removeProductFromShop);



// dashboard
router.get("/employee/dashboard-data",isAuthenticated,isEmployee,emp_dash_handler)
router.get("/admin/dashboard/overview",isAuthenticated,isAdmin,getDashboardOverview)



/* <!-- Employee Routes --> */
router.post("/addEmployee",isAuthenticated,isAdmin, addEmployee);
router.put("/updateEmployee/:id",isAuthenticated,isAdmin, updateEmployee);
router.delete("/deleteEmployee/:id",isAuthenticated,isAdmin, deleteEmployee);
router.get("/getEmployee/:id",isAuthenticated,isAdmin, getEmployee);

/* <!-- Customer Routes --> */
router.post("/addCustomer",isAuthenticated,isAdmin, addCustomer);
router.put("/updateCustomer",isAuthenticated,isAdmin, updateCustomer);
router.delete("/deleteCustomer/:id",isAuthenticated,isAdmin, deleteCustomer);
router.get("/getCustomer/:id",isAuthenticated,isAdmin, getCustomer);
router.get("/getallemploy",isAuthenticated,isAdmin, getAllEmployees);

/* <!-- Action Log Routes --> */
router.get("/getHourlyProductAdds/:employeeId",isAuthenticated,isAdmin, getHourlyProductAdds);

// <!-- List Routes --> (Customer only) - With subscription checking
router.get("/lists", isAuthenticated, softSubscriptionCheck, getUserLists); // Get all lists (soft check - allow viewing)
router.post("/lists", isAuthenticated, requireActiveSubscription, makeList); // Create new list (requires active subscription)
router.post("/lists/addProduct", isAuthenticated, requireActiveSubscription, addProductToList); // Add product to list (requires active subscription)
router.delete("/lists/removeProduct", isAuthenticated, requireActiveSubscription, removeProductFromList); // Remove product from list (requires active subscription)
router.get("/lists/:listId/lowest-prices", isAuthenticated, requireActiveSubscription, getLowestPricesInList); // Get lowest prices (premium feature)
// router.get("/lists/:listId", isAuthenticated, softSubscriptionCheck, getListById); // DISABLED - conflicts with listRoutes.js
router.delete("/lists/:listId", isAuthenticated, requireActiveSubscription, deleteList); // Delete list (requires active subscription)

export default router;
