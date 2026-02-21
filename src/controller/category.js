import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();

// Default categories to seed
const DEFAULT_CATEGORIES = [
  "Confectionery",
  "Crisps",
  "Soft Drinks",
  "Alcohol",
  "Grocery",
  "Pet Food",
  "Health & Beauty",
  "House Hold",
  "Hardware",
  "Medicines",
  "Cigarettes",
  "Single Spirits",
  "Cakes & Bread",
  "Chill Foods",
  "Frozen & Ice Cream"
];

// Get all categories
const getAllCategories = async (req, res) => {
  try {
    const categories = await prisma.category.findMany({
      orderBy: { name: 'asc' }
    });
    
    res.status(200).json({
      success: true,
      data: categories
    });
  } catch (error) {
    console.error("Error fetching categories:", error);
    res.status(500).json({ error: "Failed to fetch categories" });
  }
};

// Search categories with autocomplete
const searchCategories = async (req, res) => {
  try {
    const { query } = req.query;
    
    const categories = await prisma.category.findMany({
      where: query ? {
        name: {
          contains: query,
          mode: 'insensitive'
        }
      } : {},
      orderBy: { name: 'asc' },
      take: 20
    });
    
    res.status(200).json({
      success: true,
      data: categories
    });
  } catch (error) {
    console.error("Error searching categories:", error);
    res.status(500).json({ error: "Failed to search categories" });
  }
};

// Add a new category
const addCategory = async (req, res) => {
  try {
    const { name } = req.body;
    
    if (!name || !name.trim()) {
      return res.status(400).json({ error: "Category name is required" });
    }
    
    const trimmedName = name.trim();
    
    // Check if category already exists
    const existingCategory = await prisma.category.findFirst({
      where: {
        name: {
          equals: trimmedName,
          mode: 'insensitive'
        }
      }
    });
    
    if (existingCategory) {
      return res.status(409).json({ 
        error: "Category already exists",
        data: existingCategory
      });
    }
    
    const category = await prisma.category.create({
      data: { name: trimmedName }
    });
    
    res.status(201).json({
      success: true,
      message: "Category created successfully",
      data: category
    });
  } catch (error) {
    console.error("Error adding category:", error);
    res.status(500).json({ error: "Failed to add category" });
  }
};

// Update a category
const updateCategory = async (req, res) => {
  try {
    const { id } = req.params;
    const { name } = req.body;
    
    if (!name || !name.trim()) {
      return res.status(400).json({ error: "Category name is required" });
    }
    
    const trimmedName = name.trim();
    
    // Check if another category with this name exists
    const existingCategory = await prisma.category.findFirst({
      where: {
        name: {
          equals: trimmedName,
          mode: 'insensitive'
        },
        id: { not: id }
      }
    });
    
    if (existingCategory) {
      return res.status(409).json({ error: "Category with this name already exists" });
    }
    
    const category = await prisma.category.update({
      where: { id },
      data: { name: trimmedName }
    });
    
    res.status(200).json({
      success: true,
      message: "Category updated successfully",
      data: category
    });
  } catch (error) {
    console.error("Error updating category:", error);
    if (error.code === 'P2025') {
      return res.status(404).json({ error: "Category not found" });
    }
    res.status(500).json({ error: "Failed to update category" });
  }
};

// Delete a category
const deleteCategory = async (req, res) => {
  try {
    const { id } = req.params;
    
    await prisma.category.delete({
      where: { id }
    });
    
    res.status(200).json({
      success: true,
      message: "Category deleted successfully"
    });
  } catch (error) {
    console.error("Error deleting category:", error);
    if (error.code === 'P2025') {
      return res.status(404).json({ error: "Category not found" });
    }
    res.status(500).json({ error: "Failed to delete category" });
  }
};

// Seed default categories
const seedCategories = async (req, res) => {
  try {
    let created = 0;
    let existing = 0;
    
    for (const categoryName of DEFAULT_CATEGORIES) {
      const existingCategory = await prisma.category.findFirst({
        where: {
          name: {
            equals: categoryName,
            mode: 'insensitive'
          }
        }
      });
      
      if (!existingCategory) {
        await prisma.category.create({
          data: { name: categoryName }
        });
        created++;
      } else {
        existing++;
      }
    }
    
    res.status(200).json({
      success: true,
      message: `Categories seeded. Created: ${created}, Already existing: ${existing}`
    });
  } catch (error) {
    console.error("Error seeding categories:", error);
    res.status(500).json({ error: "Failed to seed categories" });
  }
};

// Get unique categories from products (for data migration)
const getProductCategories = async (req, res) => {
  try {
    const products = await prisma.product.findMany({
      where: {
        category: { not: null }
      },
      select: { category: true },
      distinct: ['category']
    });
    
    const categories = products.map(p => p.category).filter(Boolean);
    
    res.status(200).json({
      success: true,
      data: categories
    });
  } catch (error) {
    console.error("Error fetching product categories:", error);
    res.status(500).json({ error: "Failed to fetch product categories" });
  }
};

export {
  getAllCategories,
  searchCategories,
  addCategory,
  updateCategory,
  deleteCategory,
  seedCategories,
  getProductCategories,
  DEFAULT_CATEGORIES
};
