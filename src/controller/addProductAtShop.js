



import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();

// Add a product at a shop
const addProductAtShop = async (req, res) => {
  const {
    shopId,
    title,
    caseSize,
    packetSize,
    retailSize,
    barcode,
    casebarcode,
    price,
    employeeId,
    aiel,
    rrp
  } = req.body;

  // Check for required fields
  if (!shopId || !title || !employeeId) {
    return res.status(400).json({ 
      error: "Missing required fields: shopId, title, and employeeId are required." 
    });
  }

  try {
    // Check if shop exists
    const shopExists = await prisma.shop.findUnique({ where: { id: shopId } });
    if (!shopExists) {
      return res.status(404).json({ error: "Shop not found." });
    }

    // Check if product with case barcode already exists
    if (casebarcode) {
      const existingProduct = await prisma.product.findFirst({
        where: { caseBarcode:casebarcode },
      });

      if (existingProduct) {
        return res.status(409).json({ error: "Product with this case barcode already exists." });
      }
    }

    // Check if product with barcode already exists
    if (barcode) {
      const existingProductWithBarcode = await prisma.product.findUnique({
        where: { barcode },
      });

      if (existingProductWithBarcode) {
        return res.status(409).json({ error: "Product with this barcode already exists." });
      }
    }

    // Set default values
    const finalCaseSize = caseSize || "1";
    const finalPacketSize = packetSize || "1";
    const finalRrp = rrp || price;

    // Create the product in the database
    const newProduct = await prisma.product.create({
      data: {
        title,
        productUrl: null,
        caseSize: String(finalCaseSize),
        packetSize: String(finalPacketSize),
        retailSize: retailSize ? String(retailSize) : null,
        img: null,
        barcode: barcode || null,
        caseBarcode: casebarcode || null,
        rrp: finalRrp ? parseFloat(finalRrp) : null,
      },
    });

    // Add product to the shop
    const addedProductAtShop = await prisma.productAtShop.create({
      data: {
        shopId,
        productId: newProduct.id,
        price: parseFloat(price),
        employeeId: parseInt(employeeId, 10),
        card_aiel_number: aiel || null,
      },
    });

    // Log the action
    const actionLog = await prisma.actionLog.create({
      data: {
        employeeId: parseInt(employeeId, 10),
        shopId,
        productId: newProduct.id,
        actionType: "ADD",
      },
    });

    res.status(201).json({ 
      message: "Product added to shop successfully.",
      productId: newProduct.id
    });
  } catch (error) {
    console.error("Error adding product at shop:", error);
    res
      .status(500)
      .json({ error: "An error occurred while adding the product." });
  }
};

// Update product price at a shop
const updateProductPriceAtShop = async (req, res) => {
  const { shopId } = req.params;
  const { productId, price, employeeId } = req.body;

  if (!shopId || !productId || price === undefined || !employeeId) {
    return res.status(400).json({ 
      error: "Missing required fields: shopId, productId, price, and employeeId are required." 
    });
  }

  try {
    // Check if the product exists in ProductAtShop
    const productAtShop = await prisma.productAtShop.findUnique({
      where: {
        shopId_productId: { shopId, productId },
      },
    });

    if (!productAtShop) {
      return res
        .status(404)
        .json({ error: "Product not found at the specified shop." });
    }

    // Update product price
    const updatedProductAtShop = await prisma.productAtShop.update({
      where: {
        shopId_productId: { shopId, productId },
      },
      data: { 
        price: parseFloat(price), 
        updatedAt: new Date() 
      },
    });

    // Log the action
    await prisma.actionLog.create({
      data: {
        employeeId: parseInt(employeeId, 10),
        shopId,
        productId,
        actionType: "UPDATE",
      },
    });

    res.status(200).json({
      success: true,
      message: "Product price updated successfully.",
      data: updatedProductAtShop,
    });
  } catch (error) {
    console.error("Error updating product price at shop:", error);
    res.status(500).json({ error: "Internal server error." });
  }
};

// Add an existing product to a shop
const addProductAtShopifExistAtProduct = async (req, res) => {
  const { shopId, id, price, employeeId, casebarcode, aiel, rrp, packetSize, caseSize } = req.body;
 
  
  // Validate required fields
  if (!shopId || !id || price === undefined ||price == ''|| aiel === undefined ||aiel == ''|| casebarcode === undefined ||casebarcode == ''|| packetSize === undefined ||packetSize == ''  || !employeeId) {
    return res.status(400).json({
      error: "Missing required fields: shopId, id, price, and employeeId are required."
    });
  }
  
  try {
    // Check if shop exists
    const shopExists = await prisma.shop.findUnique({
      where: { id: shopId }
    });
    
    if (!shopExists) {
      return res.status(404).json({ error: "Shop not found." });
    }
    
    // Check if product exists
    const product = await prisma.product.findUnique({
      where: { id },
    });
    
    if (!product) {
      return res.status(404).json({
        error: "Product not found in Products database."
      });
    }
    
    // Parse numeric values
    const parsedPrice = parseFloat(price);
    const parsedRrp = rrp ? parseFloat(rrp) : null;
    const parsedEmployeeId = parseInt(employeeId, 10);
    
    // First, update the product record with caseBarcode, rrp, caseSize, and packetSize if provided
    if (casebarcode || parsedRrp !== null || caseSize || packetSize) {
      await prisma.product.update({
        where: { id },
        data: {
          ...(casebarcode ? { caseBarcode: casebarcode } : {}),
          ...(parsedRrp !== null ? { rrp: parsedRrp } : {}),
          ...(caseSize ? { caseSize: caseSize } : {}),
          ...(packetSize ? { packetSize: packetSize } : {})
        },
      });
    }
    
    // Check if the product already exists in productAtShop
    const productAtShopExists = await prisma.productAtShop.findUnique({
      where: {
        shopId_productId: { shopId, productId: id },
      },
    });
    
    let result;
    
    if (productAtShopExists) {
      // Update existing productAtShop entry
      result = await prisma.productAtShop.update({
        where: {
          shopId_productId: { shopId, productId: id },
        },
        data: {
          price: parsedPrice,
          ...(aiel ? { card_aiel_number: aiel } : {}),
          updatedAt: new Date(),
          employeeId: parsedEmployeeId
        },
      });
      
      // Log the update action
      await prisma.actionLog.create({
        data: {
          employeeId: parsedEmployeeId,
          shopId,
          productId: id,
          actionType: "UPDATE",
        },
      });
      
      res.status(200).json({
        success: true,
        message: "Product updated successfully.",
        data: result,
      });
    } else {
      // Create new productAtShop entry
      result = await prisma.productAtShop.create({
        data: {
          shopId,
          productId: id,
          price: parsedPrice,
          employeeId: parsedEmployeeId,
          ...(aiel ? { card_aiel_number: aiel } : {})
        },
      });
      
      // Log the add action
      await prisma.actionLog.create({
        data: {
          employeeId: parsedEmployeeId,
          shopId,
          productId: id,
          actionType: "ADD",
        },
      });
      
      res.status(201).json({
        success: true,
        message: "Product added to shop successfully.",
        data: result
      });
    }
  } catch (error) {
    console.error("Error:", error);
    res.status(500).json({
      error: "An error occurred while processing the product.",
      details: error.message
    });
  }
};

// Get products at a shop with pagination and search
const getProductsAtShop = async (req, res) => {
  const { shopId } = req.params;
  const { page = 1,  search = "" } = req.query;
  const limit = 100
  
  if (!shopId) {
    return res.status(400).json({ error: "Shop ID is required" });
  }

  const pageNumber = parseInt(page);
  const limitNumber = parseInt(limit);
  const offset = (pageNumber - 1) * limitNumber;

  try {
    // Check if shop exists
    const shopExists = await prisma.shop.findUnique({
      where: { id: shopId },
    });

    if (!shopExists) {
      return res.status(404).json({ error: "Shop not found" });
    }

    // Get total count of products that match the search
    const totalCount = await prisma.productAtShop.count({
      where: {
        shopId,
        product: {
          title: {
            contains: search,
            mode: "insensitive"
          }
        }
      }
    });

    // Get products with pagination and search
    const productsAtShop = await prisma.productAtShop.findMany({
      where: {
        shopId,
        product: {
          title: {
            contains: search,
            mode: "insensitive"
          }
        }
      },
      include: {
        product: {
          select: {
            title: true,
            caseSize: true,
            packetSize: true,
            retailSize: true,
            barcode: true,
            caseBarcode: true,
            img: true,
            rrp: true
          }
        }
      },
      skip: offset,
      take: limitNumber,
      orderBy: {
        updatedAt: 'desc' // Most recently updated first
      }
    });

    // Map the data to a more frontend-friendly format
    const formattedProducts = productsAtShop.map(item => ({
      productId: item.productId,
      shopId: item.shopId,
      price: item.price,
      title: item.product.title,
      caseSize: item.product.caseSize,
      packetSize: item.product.packetSize,
      retailSize: item.product.retailSize,
      barcode: item.product.barcode,
      caseBarcode: item.product.caseBarcode,
      img: item.product.img,
      rrp: item.product.rrp,
      aiel: item.card_aiel_number,
      updatedAt: item.updatedAt
    }));

    res.status(200).json({
      products: formattedProducts,
      total: totalCount,
      page: pageNumber,
      limit: limitNumber,
      totalPages: Math.ceil(totalCount / limitNumber)
    });
  } catch (error) {
    console.error("Error fetching products at shop:", error);
    res.status(500).json({ error: "Internal server error" });
  }
};

// Search for products not in a shop
const searchProductsNotInShop = async (req, res) => {
  const { query, shopId } = req.query;
  
  if (!query || !shopId) {
    return res.status(400).json({ error: "Query and shopId parameters are required" });
  }

  try {
    // Get products that match the search but are not in the shop
    const products = await prisma.product.findMany({
      where: {
        title: {
          contains: query,
          mode: "insensitive"
        },
        NOT: {
          shops: {  // Changed from productAtShop to shops
            some: {
              shopId: shopId
            }
          }
        }
      },
      take: 20, // Limit results
      orderBy: {
        title: 'asc'
      }
    });

    res.status(200).json(products);
  } catch (error) {
    console.error("Error searching products:", error);
    res.status(500).json({ error: "Internal server error" });
  }
};

// Remove a product from a shop
const removeProductFromShop = async (req, res) => {
  const { shopId } = req.params;
  const { productId, employeeId } = req.body;

  if (!shopId || !productId || !employeeId) {
    return res.status(400).json({ 
      error: "Missing required fields: shopId, productId, and employeeId are required." 
    });
  }

  try {
    // Check if the product exists in the shop
    const productAtShop = await prisma.productAtShop.findUnique({
      where: {
        shopId_productId: { shopId, productId }
      }
    });

    if (!productAtShop) {
      return res.status(404).json({ 
        error: "Product not found at the specified shop." 
      });
    }

    // Delete the product from the shop
    await prisma.productAtShop.delete({
      where: {
        shopId_productId: { shopId, productId }
      }
    });

    // Log the removal action
    await prisma.actionLog.create({
      data: {
        employeeId: parseInt(employeeId, 10),
        shopId,
        productId,
        actionType: "REMOVE",
      },
    });

    res.status(200).json({
      success: true,
      message: "Product removed from shop successfully."
    });
  } catch (error) {
    console.error("Error removing product from shop:", error);
    res.status(500).json({ error: "Internal server error." });
  }
};

// Export all the handlers
export {
  addProductAtShop,
  updateProductPriceAtShop,
  addProductAtShopifExistAtProduct,
  getProductsAtShop,
  searchProductsNotInShop,
  removeProductFromShop
};