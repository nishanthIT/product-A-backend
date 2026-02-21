import { PrismaClient } from "@prisma/client";
import fs from 'fs';
import path from 'path';
import { Jimp } from 'jimp';
import { removeBackground } from "@imgly/background-removal-node";

const prisma = new PrismaClient();

// Levenshtein distance function for fuzzy matching (typo tolerance)
const levenshteinDistance = (str1, str2) => {
  const m = str1.length;
  const n = str2.length;
  const dp = Array(m + 1).fill(null).map(() => Array(n + 1).fill(0));

  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (str1[i - 1] === str2[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1];
      } else {
        dp[i][j] = 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
      }
    }
  }
  return dp[m][n];
};

// Check if a word fuzzy matches any word in text
const fuzzyMatchWord = (searchWord, text, maxDistance = 2) => {
  const textLower = text.toLowerCase();
  const searchLower = searchWord.toLowerCase();
  
  if (textLower.includes(searchLower)) return true;
  
  const textWords = textLower.split(/\s+/);
  for (const textWord of textWords) {
    const allowedDistance = searchLower.length <= 3 ? 1 : maxDistance;
    
    if (textWord.startsWith(searchLower.substring(0, Math.min(3, searchLower.length)))) {
      const distance = levenshteinDistance(searchLower, textWord.substring(0, searchLower.length + 2));
      if (distance <= allowedDistance) return true;
    }
    
    if (textWord.length >= searchLower.length - 2 && textWord.length <= searchLower.length + 2) {
      const distance = levenshteinDistance(searchLower, textWord);
      if (distance <= allowedDistance) return true;
    }
  }
  return false;
};

// Add a product at a shop
const addProductAtShop = async (req, res) => {
  console.log("addProductAtShop called with body:", req.body);
  console.log("addProductAtShop file:", req.file);
  
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
    rrp,
    category
  } = req.body;

  // Check for required fields
  if (!shopId || !title || !employeeId) {
    // Clean up uploaded file if validation fails
    if (req.file) {
      try { fs.unlinkSync(req.file.path); } catch (e) { console.error("Failed to cleanup file:", e); }
    }
    return res.status(400).json({ 
      error: "Missing required fields: shopId, title, and employeeId are required." 
    });
  }

  // Parse and validate price
  const parsedPrice = price ? parseFloat(price) : 0;
  const parsedEmployeeId = parseInt(employeeId, 10);
  
  if (isNaN(parsedEmployeeId)) {
    if (req.file) {
      try { fs.unlinkSync(req.file.path); } catch (e) { console.error("Failed to cleanup file:", e); }
    }
    return res.status(400).json({ error: "Invalid employeeId" });
  }

  try {
    // Check if shop exists
    const shopExists = await prisma.shop.findUnique({ where: { id: shopId } });
    if (!shopExists) {
      if (req.file) try { fs.unlinkSync(req.file.path); } catch (e) {}
      return res.status(404).json({ error: "Shop not found." });
    }

    // Check if product with case barcode already exists
    if (casebarcode) {
      const existingProduct = await prisma.product.findFirst({
        where: { caseBarcode: casebarcode },
      });

      if (existingProduct) {
        if (req.file) try { fs.unlinkSync(req.file.path); } catch (e) {}
        return res.status(409).json({ error: "Product with this case barcode already exists." });
      }
    }

    // Check if product with barcode already exists
    if (barcode) {
      const existingProductWithBarcode = await prisma.product.findUnique({
        where: { barcode },
      });

      if (existingProductWithBarcode) {
        if (req.file) try { fs.unlinkSync(req.file.path); } catch (e) {}
        return res.status(409).json({ error: "Product with this barcode already exists." });
      }
    }

    // Set default values
    const finalCaseSize = caseSize || "1";
    const finalPacketSize = packetSize || "1";
    const finalRrp = rrp || price;

    // Handle image upload - save directly without background removal for reliability
    let imgPath = null;
    if (req.file && barcode) {
      const outputFilename = `${barcode}.png`;
      const outputPath = path.join('./images', outputFilename);

      // Ensure images directory exists
      if (!fs.existsSync('./images')) {
        fs.mkdirSync('./images', { recursive: true });
      }

      try {
        console.log("Processing image for barcode:", barcode);
        console.log("Source file:", req.file.path);
        console.log("Destination:", outputPath);
        
        // Check if source file exists
        if (!fs.existsSync(req.file.path)) {
          console.error("Source file not found:", req.file.path);
          throw new Error("Uploaded file not found");
        }

        // Simply copy the file for reliability
        fs.copyFileSync(req.file.path, outputPath);
        imgPath = `/api/image/${barcode}`;
        console.log("Image saved successfully for:", barcode);
        
        // Clean up temp file
        try { fs.unlinkSync(req.file.path); } catch (e) { 
          console.log("Could not delete temp file:", e.message); 
        }
      } catch (imgError) {
        console.error("Image processing failed:", imgError.message);
        // Clean up on error
        if (req.file && fs.existsSync(req.file.path)) {
          try { fs.unlinkSync(req.file.path); } catch (e) {}
        }
        // Continue without image instead of failing
        imgPath = null;
      }
    } else if (req.file) {
      // No barcode provided but image uploaded - clean up
      console.log("No barcode provided, cleaning up image");
      try { fs.unlinkSync(req.file.path); } catch (e) {}
    }

    // Create the product in the database
    const newProduct = await prisma.product.create({
      data: {
        title,
        productUrl: null,
        caseSize: String(finalCaseSize),
        packetSize: String(finalPacketSize),
        retailSize: retailSize ? String(retailSize) : null,
        img: imgPath,
        barcode: barcode || null,
        caseBarcode: casebarcode || null,
        rrp: finalRrp ? parseFloat(finalRrp) : null,
        category: category || null,
      },
    });

    // Add product to the shop
    const addedProductAtShop = await prisma.productAtShop.create({
      data: {
        shopId,
        productId: newProduct.id,
        price: parsedPrice,
        employeeId: parsedEmployeeId,
        card_aiel_number: aiel || null,
      },
    });

    // Log the action
    const actionLog = await prisma.actionLog.create({
      data: {
        employeeId: parsedEmployeeId,
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
    // Clean up uploaded file on error
    if (req.file && fs.existsSync(req.file.path)) {
      try { fs.unlinkSync(req.file.path); } catch (e) {}
    }
    
    // Return more specific error message
    const errorMessage = error.message || "An error occurred while adding the product.";
    res
      .status(500)
      .json({ error: errorMessage.includes('category') 
        ? "Database schema out of sync. Please run 'npx prisma generate' on server." 
        : errorMessage 
      });
  }
};

// Update product price at a shop
const updateProductPriceAtShop = async (req, res) => {
  const { shopId } = req.params;
  const { productId, price, employeeId, offerPrice, offerExpiryDate } = req.body;

  console.log('updateProductPriceAtShop received:', {
    shopId,
    productId,
    price,
    employeeId,
    offerPrice,
    offerExpiryDate,
    offerPriceType: typeof offerPrice,
    offerExpiryDateType: typeof offerExpiryDate
  });

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

    // Parse offer data
    const parsedOfferPrice = offerPrice && offerPrice !== '' && offerPrice !== 'null' ? parseFloat(offerPrice) : null;
    const parsedOfferExpiryDate = offerExpiryDate && offerExpiryDate !== '' && offerExpiryDate !== 'null' ? new Date(offerExpiryDate) : null;

    console.log('Parsed values:', {
      originalPrice: price,
      parsedPrice: parseFloat(price),
      originalOfferPrice: offerPrice,
      parsedOfferPrice,
      originalOfferExpiryDate: offerExpiryDate,
      parsedOfferExpiryDate
    });

    // Prepare update data
    const updateData = {
      price: parseFloat(price),
      updatedAt: new Date()
    };

    // Always update offer fields to handle clearing offers
    updateData.offerPrice = parsedOfferPrice;
    updateData.offerExpiryDate = parsedOfferExpiryDate;

    console.log('Update data:', updateData);

    // Update product price and offer details
    const updatedProductAtShop = await prisma.productAtShop.update({
      where: {
        shopId_productId: { shopId, productId },
      },
      data: updateData,
    });

    console.log('Database update result:', {
      id: updatedProductAtShop.id,
      price: updatedProductAtShop.price,
      offerPrice: updatedProductAtShop.offerPrice,
      offerExpiryDate: updatedProductAtShop.offerExpiryDate,
      updatedAt: updatedProductAtShop.updatedAt
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
      message: "Product price and offer updated successfully.",
      data: updatedProductAtShop,
    });
  } catch (error) {
    console.error("Error updating product price at shop:", error);
    res.status(500).json({ error: "Internal server error." });
  }
};

// Add an existing product to a shop
const addProductAtShopifExistAtProduct = async (req, res) => {
  console.log("Request body:", req.body);
  console.log("Request file:", req.file);
  
  const { shopId, id, price, employeeId, casebarcode, aiel, rrp, packetSize, caseSize, offerPrice, offerExpiryDate, category } = req.body;
 
  console.log("Extracted values - shopId:", shopId, "id:", id);
  
  // Validate required fields - only shopId and id are truly required
  if (!shopId || !id) {
    console.log("Validation failed - shopId:", shopId, "id:", id);
    return res.status(400).json({
      error: "Missing required fields: shopId and id are required.",
      received: { shopId, id }
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
    
    // Handle image upload with background removal
    let imgPath = null;
    if (req.file) {
      const outputFilename = `${product.barcode}.png`;
      const outputPath = path.join('./images', outputFilename);

      // Ensure images directory exists
      if (!fs.existsSync('./images')) {
        fs.mkdirSync('./images', { recursive: true });
      }

      try {
        // Use @imgly/background-removal-node
        const blob = await removeBackground(req.file.path, {
          publicPath: `file://${path.resolve('node_modules/@imgly/background-removal-node/dist')}/`,
          debug: true,
          output: {
            format: 'image/png',
            quality: 0.8,
            type: 'foreground'
          }
        });

        // Save processed image
        fs.writeFileSync(outputPath, Buffer.from(await blob.arrayBuffer()));
        fs.unlinkSync(req.file.path);
        imgPath = `/api/image/${product.barcode}`;
        console.log("Background removal successful for:", product.barcode);

      } catch (bgError) {
        console.error("Background removal failed:", bgError);
        
        // Jimp fallback
        try {
          const image = await Jimp.read(req.file.path);
          await image.writeAsync(outputPath);
          fs.unlinkSync(req.file.path);
          imgPath = `/api/image/${product.barcode}`;
        } catch (jimpError) {
          console.error("Fallback failed:", jimpError);
          // Continue without image if both fail
        }
      }
    }
    
    // Parse numeric values - handle optional fields
    const parsedPrice = price ? parseFloat(price) : 0;
    const parsedRrp = rrp ? parseFloat(rrp) : null;
    const parsedEmployeeId = employeeId ? parseInt(employeeId, 10) : null;
    const parsedOfferPrice = offerPrice ? parseFloat(offerPrice) : null;
    const parsedOfferExpiryDate = offerExpiryDate ? new Date(offerExpiryDate) : null;
    
    // First, update the product record with caseBarcode, rrp, caseSize, packetSize, category, and image if provided
    const productUpdateData = {
      ...(casebarcode ? { caseBarcode: casebarcode } : {}),
      ...(parsedRrp !== null ? { rrp: parsedRrp } : {}),
      ...(caseSize ? { caseSize: caseSize } : {}),
      ...(packetSize ? { packetSize: packetSize } : {}),
      ...(category ? { category: category } : {}),
      ...(imgPath ? { img: imgPath } : {})
    };
    
    if (Object.keys(productUpdateData).length > 0) {
      await prisma.product.update({
        where: { id },
        data: productUpdateData,
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
          ...(price ? { price: parsedPrice } : {}),
          ...(aiel ? { card_aiel_number: aiel } : {}),
          ...(parsedOfferPrice !== null ? { offerPrice: parsedOfferPrice } : {}),
          ...(parsedOfferExpiryDate ? { offerExpiryDate: parsedOfferExpiryDate } : {}),
          updatedAt: new Date(),
          ...(parsedEmployeeId ? { employeeId: parsedEmployeeId } : {})
        },
      });
      
      // Log the update action if we have an employee
      if (parsedEmployeeId) {
        await prisma.actionLog.create({
          data: {
            employeeId: parsedEmployeeId,
            shopId,
            productId: id,
            actionType: "UPDATE",
          },
        });
      }
      
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
          ...(parsedEmployeeId ? { employeeId: parsedEmployeeId } : {}),
          ...(aiel ? { card_aiel_number: aiel } : {}),
          ...(parsedOfferPrice !== null ? { offerPrice: parsedOfferPrice } : {}),
          ...(parsedOfferExpiryDate ? { offerExpiryDate: parsedOfferExpiryDate } : {})
        },
      });
      
      // Log the add action if we have an employee
      if (parsedEmployeeId) {
        await prisma.actionLog.create({
          data: {
            employeeId: parsedEmployeeId,
            shopId,
            productId: id,
            actionType: "ADD",
          },
        });
      }
      
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

// Get products at a shop with pagination and search (with fuzzy matching)
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

    // Build search conditions for fuzzy matching
    let whereClause = { shopId };
    
    if (search && search.trim()) {
      const searchWords = search.trim().split(/\s+/).filter(word => word.length > 0);
      
      if (searchWords.length > 0) {
        // Build OR conditions for each word to match title OR barcode
        const searchConditions = searchWords.map(word => {
          const conditions = [
            { product: { title: { contains: word, mode: "insensitive" } } },
            { product: { barcode: { contains: word, mode: "insensitive" } } },
            { product: { caseBarcode: { contains: word, mode: "insensitive" } } }
          ];
          
          // For words longer than 3 characters, also try matching with first part
          if (word.length > 3) {
            const partialWord = word.substring(0, Math.ceil(word.length * 0.7));
            if (partialWord.length >= 3) {
              conditions.push({ product: { title: { contains: partialWord, mode: "insensitive" } } });
            }
          }
          
          return { OR: conditions };
        });
        
        whereClause.AND = searchConditions;
      }
    }

    // Get total count
    const totalCount = await prisma.productAtShop.count({ where: whereClause });

    // Get products with pagination and search
    let productsAtShop = await prisma.productAtShop.findMany({
      where: whereClause,
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
        updatedAt: 'desc'
      }
    });

    // If search provided and few results, apply fuzzy matching
    if (search && search.trim() && productsAtShop.length < 10) {
      const searchWords = search.trim().split(/\s+/).filter(word => word.length > 0);
      
      // Get more products for fuzzy matching
      const allProductsAtShop = await prisma.productAtShop.findMany({
        where: { shopId },
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
        take: 500
      });
      
      // Apply fuzzy matching
      const fuzzyMatched = allProductsAtShop.filter(item => {
        const searchableText = `${item.product.title || ''} ${item.product.barcode || ''} ${item.product.caseBarcode || ''}`;
        return searchWords.every(word => fuzzyMatchWord(word, searchableText, 2));
      });
      
      // Merge results
      const existingIds = new Set(productsAtShop.map(p => p.productId));
      const additionalProducts = fuzzyMatched.filter(p => !existingIds.has(p.productId));
      productsAtShop = [...productsAtShop, ...additionalProducts].slice(0, limitNumber);
    }

    // Map the data to a more frontend-friendly format
    const formattedProducts = productsAtShop.map(item => ({
      productId: item.productId,
      shopId: item.shopId,
      price: item.price,
      offerPrice: item.offerPrice,
      offerExpiryDate: item.offerExpiryDate,
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
      total: Math.max(totalCount, formattedProducts.length),
      page: pageNumber,
      limit: limitNumber,
      totalPages: Math.ceil(Math.max(totalCount, formattedProducts.length) / limitNumber)
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