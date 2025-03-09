import express from "express";
import { filterProducts } from "../controller/filterProducts.js";
import { addProduct, editProduct, getProductByBarcode, getProductById } from "../controller/addProduct.js";
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
} from "../controller/makeList.js";
import { login, logout,  verify } from "../controller/auth.js";
import { emp_dash_handler } from "../controller/dashbord/employ.js";
import { getDashboardOverview } from "../controller/dashbord/admin.js";
import { isAdmin, isAuthenticated, isEmployee } from "../middleware/authware.js";
import { image } from "../controller/image.js";

const router = express.Router();


router.post("/auth/login", login);
router.get("/auth/me", verify); // Make sure this route exists and is correctly defined
router.post("/auth/logout", logout);

router.get("/image/:barcode",image)

router.get("/filterProducts",isAuthenticated,isEmployee, filterProducts); // given in query

/* <!-- Product Routes --> */
router.post("/addProduct",isAuthenticated,isEmployee, addProduct);
router.put("/editProduct/:id",isAuthenticated,isEmployee, editProduct);
router.get("/getProductByBarcode/:barcode",isAuthenticated,isEmployee, getProductByBarcode);
router.get("/getProductById/:id",isAuthenticated,isEmployee, getProductById);


/* <!-- Shop Routes --> */
router.post("/addShop",isAuthenticated,isEmployee, addShop);
router.put("/editShop/:id",isAuthenticated,isEmployee, editShop);
router.get("/getAllshop", isAuthenticated,isEmployee,getAllShops);
router.get("/getshop/:id",isAuthenticated,isEmployee, getShopById);
router.delete("/shops/:id",isAuthenticated,isEmployee, deleteShop); // Add the delete route

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

// Add an existing product to a shop
router.post('/addProductAtShopifExistAtProduct',isAuthenticated,isEmployee, addProductAtShopifExistAtProduct);

// Get products at a shop with pagination and search
router.get('/shop/:shopId/products',isAuthenticated,isEmployee, getProductsAtShop);

// Update product price at a shop
router.put('/shop/:shopId/updateProductPrice',isAuthenticated,isEmployee, updateProductPriceAtShop);

// Search for products not in a shop
router.get('/products/search',isAuthenticated,isEmployee, searchProductsNotInShop);

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

// <!-- List Routes -->
router.post("/makeList/:customerId", makeList);
router.post("/addProductToList/", addProductToList);
router.get("/getLowestPricesInList", getLowestPricesInList);
router.delete("/removeProductFromList", removeProductFromList);

export default router;
