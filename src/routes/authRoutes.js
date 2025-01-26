import express from "express";
import { filterProducts } from "../controller/filterProducts.js";
import { addProduct, editProduct } from "../controller/addProduct.js";
import { addShop, deleteShop, editShop, getAllShops, getShopById } from "../controller/addShop.js";
import {
  addProductAtShop,
  addProductAtShopifExistAtProduct,
  getProductAtShop,
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

const router = express.Router();

router.get("/filterProducts", filterProducts); // given in query

/* <!-- Product Routes --> */
router.post("/addProduct", addProduct);
router.put("/editProduct/:id", editProduct);


/* <!-- Shop Routes --> */
router.post("/addShop", addShop);
router.put("/editShop/:id", editShop);
router.get("/getAllshop", getAllShops);
router.get("/getshop/:id", getShopById);
router.delete("/shops/:id", deleteShop); // Add the delete route

/* <!-- ProductAtShop Routes --> */
router.post("/addProductAtShop/:employeeId", addProductAtShop);
router.post(
  "/addProductAtShopifExistAtProduct/:employeeId",
  addProductAtShopifExistAtProduct
);
router.put("/updateProductPriceAtShop/:shopId", updateProductPriceAtShop);
router.get("/productAtShop/:shopId",getProductAtShop);

/* <!-- Employee Routes --> */
router.post("/addEmployee", addEmployee);
router.put("/updateEmployee/:id", updateEmployee);
router.delete("/deleteEmployee/:id", deleteEmployee);
router.get("/getEmployee/:id", getEmployee);

/* <!-- Customer Routes --> */
router.post("/addCustomer", addCustomer);
router.put("/updateCustomer", updateCustomer);
router.delete("/deleteCustomer/:id", deleteCustomer);
router.get("/getCustomer/:id", getCustomer);
router.get("/getallemploy", getAllEmployees);

/* <!-- Action Log Routes --> */
router.get("/getHourlyProductAdds/:employeeId", getHourlyProductAdds);

// <!-- List Routes -->
router.post("/makeList/:customerId", makeList);
router.post("/addProductToList/", addProductToList);
router.get("/getLowestPricesInList", getLowestPricesInList);
router.delete("/removeProductFromList", removeProductFromList);

export default router;
