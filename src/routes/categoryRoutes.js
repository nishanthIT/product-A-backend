import express from "express";
import {
  getAllCategories,
  searchCategories,
  addCategory,
  updateCategory,
  deleteCategory,
  seedCategories,
  getProductCategories
} from "../controller/category.js";
import { isAuthenticated, isAdmin, isEmployee } from "../middleware/authware.js";

const router = express.Router();

// Public routes - anyone can view/search categories
router.get("/", getAllCategories);
router.get("/search", searchCategories);
router.get("/product-categories", getProductCategories);

// Protected routes - only authenticated users can add categories
router.post("/", isAuthenticated, addCategory);

// Admin only routes
router.put("/:id", isAuthenticated, isAdmin, updateCategory);
router.delete("/:id", isAuthenticated, isAdmin, deleteCategory);
router.post("/seed", isAuthenticated, isAdmin, seedCategories);

export default router;
