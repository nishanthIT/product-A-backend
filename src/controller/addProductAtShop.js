import { PrismaClient } from "@prisma/client";
import fs from 'fs';
import path from 'path';
import { Jimp } from 'jimp';
import { removeBackground } from "@imgly/background-removal-node";
import multiLayerCache from '../services/multiLayerCache.js';
import {
  MAX_SEARCH_RESULTS,
  indexProduct,
  orderByRank,
  refreshIndexedProduct,
  searchProductIds,
} from '../services/productSearchService.js';

const prisma = new PrismaClient();

const getOrCreateUnknownProductAtShop = async (productId) => {
  const UNKNOWN_SHOP_NAME = 'Unknown Shop';

  let unknownShop = await prisma.shop.findFirst({
    where: {
      name: UNKNOWN_SHOP_NAME,
      shopType: 'WHOLESALE',
    },
  });

  if (!unknownShop) {
    unknownShop = await prisma.shop.create({
      data: {
        name: UNKNOWN_SHOP_NAME,
        address: 'Unknown',
        mobile: 'N/A',
        shopType: 'WHOLESALE',
      },
    });
  }

  let unknownProductAtShop = await prisma.productAtShop.findFirst({
    where: {
      productId,
      shopId: unknownShop.id,
    },
  });

  if (!unknownProductAtShop) {
    const product = await prisma.product.findUnique({
      where: { id: productId },
      select: { rrp: true },
    });

    const fallbackPrice = product?.rrp ? parseFloat(product.rrp) : 0;

    unknownProductAtShop = await prisma.productAtShop.create({
      data: {
        productId,
        shopId: unknownShop.id,
        price: fallbackPrice,
        outOfStock: false,
      },
    });
  }

  return unknownProductAtShop;
};

const PRODUCT_CACHE_TTL_SECONDS = 180;

const getProductsCacheKey = ({ shopId, page, search, category, aisle, stockStatus, limit }) => {
  return [
    'products-at-shop',
    shopId,
    `page=${page}`,
    `limit=${limit}`,
    `search=${encodeURIComponent(search || '')}`,
    `category=${encodeURIComponent(category || '')}`,
    `aisle=${encodeURIComponent(aisle || '')}`,
    `stock=${encodeURIComponent(stockStatus || '')}`,
  ].join(':');
};

const getProductsCacheGroupKey = (shopId) => `products-at-shop:${shopId}`;

const getShopFiltersCacheKey = (shopId) => `shop-filters:${shopId}`;

const getShopFiltersCacheGroupKey = (shopId) => `shop-filters:${shopId}`;

const invalidateShopInventoryCache = async (shopId) => {
  if (!shopId) {
    return;
  }

  try {
    await Promise.all([
      multiLayerCache.invalidateGroup(getProductsCacheGroupKey(shopId)),
      multiLayerCache.invalidateGroup(getShopFiltersCacheGroupKey(shopId)),
    ]);
  } catch (error) {
    console.warn(`Cache invalidation failed for shop ${shopId}:`, error.message);
  }
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
    locationCode,
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

    // Handle image upload with background removal
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

        // Try background removal first
        try {
          console.log("Attempting background removal...");
          const blob = await removeBackground(req.file.path, {
            publicPath: `file://${path.resolve('node_modules/@imgly/background-removal-node/dist')}/`,
            debug: false,
            output: {
              format: 'image/png',
              quality: 0.8,
              type: 'foreground'
            }
          });

          // Save processed image
          fs.writeFileSync(outputPath, Buffer.from(await blob.arrayBuffer()));
          console.log("Background removal successful for:", barcode);
        } catch (bgError) {
          console.error("Background removal failed, saving original:", bgError.message);
          // Fallback: just copy the file as-is
          fs.copyFileSync(req.file.path, outputPath);
          console.log("Saved original image for:", barcode);
        }

        imgPath = `/api/image/${barcode}`;
        
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
    indexProduct(newProduct);

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

    if (locationCode !== undefined) {
      await prisma.$executeRaw`UPDATE "ProductAtShop" SET "locationCode" = ${locationCode || null} WHERE "id" = ${addedProductAtShop.id}`;
    }

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
  const { productId, price, employeeId, offerPrice, offerExpiryDate, aisle, locationCode } = req.body;

  console.log('updateProductPriceAtShop received:', {
    shopId,
    productId,
    price,
    employeeId,
    offerPrice,
    offerExpiryDate,
    aisle,
    locationCode,
    offerPriceType: typeof offerPrice,
    offerExpiryDateType: typeof offerExpiryDate,
    locationCodeType: typeof locationCode
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
      parsedOfferExpiryDate,
      aisle,
      locationCode
    });

    // Prepare update data
    const updateData = {
      price: parseFloat(price),
      updatedAt: new Date()
    };

    // Always update offer fields to handle clearing offers
    updateData.offerPrice = parsedOfferPrice;
    updateData.offerExpiryDate = parsedOfferExpiryDate;
    
    // Update aisle if provided (can be empty string to clear)
    if (aisle !== undefined) {
      updateData.card_aiel_number = aisle || null;
    }

    console.log('Update data:', updateData);

    // Update product price and offer details
    const updatedProductAtShop = await prisma.productAtShop.update({
      where: {
        shopId_productId: { shopId, productId },
      },
      data: updateData,
    });

    if (locationCode !== undefined) {
      await prisma.$executeRaw`UPDATE "ProductAtShop" SET "locationCode" = ${locationCode || null} WHERE "shopId" = ${shopId} AND "productId" = ${productId}`;
    }

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

    await invalidateShopInventoryCache(shopId);

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
  
  const { shopId, id, price, employeeId, casebarcode, aiel, locationCode, rrp, packetSize, caseSize, offerPrice, offerExpiryDate, category } = req.body;
 
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
      if (casebarcode) refreshIndexedProduct(id);
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

      if (locationCode !== undefined) {
        await prisma.$executeRaw`UPDATE "ProductAtShop" SET "locationCode" = ${locationCode || null} WHERE "shopId" = ${shopId} AND "productId" = ${id}`;
      }
      
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

      await invalidateShopInventoryCache(shopId);
      
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

      if (locationCode !== undefined) {
        await prisma.$executeRaw`UPDATE "ProductAtShop" SET "locationCode" = ${locationCode || null} WHERE "shopId" = ${shopId} AND "productId" = ${id}`;
      }
      
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

      await invalidateShopInventoryCache(shopId);
      
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
  const { page = 1, search = "", category = "", aisle = "", stockStatus = "" } = req.query;
  const limit = 100
  
  if (!shopId) {
    return res.status(400).json({ error: "Shop ID is required" });
  }

  const pageNumber = parseInt(page);
  const limitNumber = parseInt(limit);
  const offset = (pageNumber - 1) * limitNumber;
  const cacheKey = getProductsCacheKey({
    shopId,
    page: pageNumber,
    search,
    category,
    aisle,
    stockStatus,
    limit: limitNumber,
  });
  const cacheGroupKey = getProductsCacheGroupKey(shopId);

  try {
    const responseData = await multiLayerCache.readThrough({
      key: cacheKey,
      groupKey: cacheGroupKey,
      ttlSeconds: PRODUCT_CACHE_TTL_SECONDS,
      loader: async () => {
        // Check if shop exists
        const shopExists = await prisma.shop.findUnique({
          where: { id: shopId },
        });

        if (!shopExists) {
          const shopError = new Error("Shop not found");
          shopError.statusCode = 404;
          throw shopError;
        }

        // Build search conditions for fuzzy matching
        let whereClause = { shopId };

        // Add stock status filter
        if (stockStatus === "in-stock") {
          whereClause.outOfStock = false;
        } else if (stockStatus === "out-of-stock") {
          whereClause.outOfStock = true;
        }

        // Add category filter
        if (category && category.trim()) {
          whereClause.product = {
            ...whereClause.product,
            category: category.trim()
          };
        }

        // Add aisle filter
        if (aisle && aisle.trim()) {
          whereClause.card_aiel_number = aisle.trim();
        }

        const productInclude = {
          product: {
            select: {
              title: true,
              caseSize: true,
              packetSize: true,
              retailSize: true,
              barcode: true,
              caseBarcode: true,
              img: true,
              rrp: true,
              category: true
            }
          }
        };

        let totalCount;
        let productsAtShop;

        if (search && search.trim()) {
          // Rank the whole catalogue, keep this shop's (filtered) rows, then paginate by rank.
          const rankedIds = (await searchProductIds(search, { limit: MAX_SEARCH_RESULTS })).map((r) => r.id);
          const matchingRows = rankedIds.length
            ? await prisma.productAtShop.findMany({
                where: { ...whereClause, productId: { in: rankedIds } },
                select: { productId: true },
              })
            : [];
          const orderedIds = orderByRank(matchingRows, rankedIds, (row) => row.productId)
            .map((row) => row.productId);
          totalCount = orderedIds.length;

          const pageIds = orderedIds.slice(offset, offset + limitNumber);
          const pageRows = pageIds.length
            ? await prisma.productAtShop.findMany({
                where: { shopId, productId: { in: pageIds } },
                include: productInclude,
              })
            : [];
          productsAtShop = orderByRank(pageRows, pageIds, (row) => row.productId);
        } else {
          totalCount = await prisma.productAtShop.count({ where: whereClause });

          productsAtShop = await prisma.productAtShop.findMany({
            where: whereClause,
            include: productInclude,
            skip: offset,
            take: limitNumber,
            orderBy: {
              updatedAt: 'desc'
            }
          });
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
          category: item.product.category,
          aiel: item.card_aiel_number,
          locationCode: item.locationCode,
          outOfStock: item.outOfStock || false,
          updatedAt: item.updatedAt
        }));

        return {
          products: formattedProducts,
          total: Math.max(totalCount, formattedProducts.length),
          page: pageNumber,
          limit: limitNumber,
          totalPages: Math.ceil(Math.max(totalCount, formattedProducts.length) / limitNumber)
        };
      }
    });

    res.status(200).json(responseData);
  } catch (error) {
    if (error.statusCode === 404) {
      return res.status(404).json({ error: error.message });
    }

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
    // Rank matches, then keep the best 20 that are not in the shop yet
    const rankedIds = (await searchProductIds(String(query), { limit: 1000 })).map((r) => r.id);
    const rows = rankedIds.length
      ? await prisma.product.findMany({
          where: {
            id: { in: rankedIds },
            NOT: {
              shops: {
                some: {
                  shopId: shopId
                }
              }
            }
          },
        })
      : [];
    const products = orderByRank(rows, rankedIds).slice(0, 20);

    res.status(200).json(products);
  } catch (error) {
    console.error("Error searching products:", error);
    res.status(500).json({ error: "Internal server error" });
  }
};

// Toggle out of stock status for a product at shop
const toggleOutOfStock = async (req, res) => {
  const { shopId, productId } = req.params;
  const { outOfStock } = req.body;

  if (!shopId || !productId) {
    return res.status(400).json({ error: "Shop ID and Product ID are required" });
  }

  try {
    const productAtShop = await prisma.productAtShop.findUnique({
      where: {
        shopId_productId: { shopId, productId }
      }
    });

    if (!productAtShop) {
      return res.status(404).json({ error: "Product not found at the specified shop" });
    }

    const newOutOfStock = outOfStock !== undefined ? outOfStock : !productAtShop.outOfStock;
    
    // Use raw query to update outOfStock field (works even if Prisma client not regenerated)
    await prisma.$executeRaw`UPDATE "ProductAtShop" SET "outOfStock" = ${newOutOfStock} WHERE "shopId" = ${shopId} AND "productId" = ${productId}`;

    await invalidateShopInventoryCache(shopId);

    res.status(200).json({
      success: true,
      outOfStock: newOutOfStock,
      message: newOutOfStock ? "Product marked as out of stock" : "Product marked as in stock"
    });
  } catch (error) {
    console.error("Error toggling out of stock:", error);
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

    // Preserve list references by moving them to Unknown Shop before deletion
    const unknownProductAtShop = await getOrCreateUnknownProductAtShop(productId);

    await prisma.listProduct.updateMany({
      where: {
        productAtShopId: productAtShop.id,
      },
      data: {
        productAtShopId: unknownProductAtShop.id,
      },
    });

    // Now remove the product from this specific shop inventory
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

    await invalidateShopInventoryCache(shopId);

    res.status(200).json({
      success: true,
      message: "Product removed from shop successfully."
    });
  } catch (error) {
    console.error("Error removing product from shop:", error);
    res.status(500).json({ error: "Internal server error." });
  }
};

// Get shop filters (categories and aisles available at a shop)
const getShopFilters = async (req, res) => {
  try {
    const { shopId } = req.params;

    const responseData = await multiLayerCache.readThrough({
      key: getShopFiltersCacheKey(shopId),
      groupKey: getShopFiltersCacheGroupKey(shopId),
      ttlSeconds: PRODUCT_CACHE_TTL_SECONDS,
      loader: async () => {
        // Get all unique categories and aisles from products at this shop
        const productsAtShop = await prisma.productAtShop.findMany({
          where: { shopId: shopId },
          include: {
            product: {
              select: {
                category: true,
              },
            },
          },
        });

        // Extract unique categories from shop products
        const shopCategories = [...new Set(productsAtShop.map(p => p.product.category).filter(Boolean))].sort();
        const aisles = [...new Set(productsAtShop.map(p => p.card_aiel_number).filter(Boolean))].sort();

        // Also get all categories from the Category table for complete list
        let allCategories = shopCategories;
        try {
          const categoryRecords = await prisma.category.findMany({
            orderBy: { name: 'asc' }
          });
          allCategories = categoryRecords.map(c => c.name);
        } catch (e) {
          // If Category table doesn't exist, fall back to shop categories
          console.log("Category table not available, using shop categories only");
        }

        return {
          categories: allCategories.length > 0 ? allCategories : shopCategories,
          aisles,
          totalProducts: productsAtShop.length,
        };
      }
    });

    res.json(responseData);
  } catch (error) {
    console.error('Error getting shop filters:', error);
    res.status(500).json({ error: 'Failed to get shop filters' });
  }
};

const getAllProductIdsAtShop = async (req, res) => {
  const { shopId } = req.params;

  if (!shopId) {
    return res.status(400).json({ error: "Shop ID is required" });
  }

  try {
    const shop = await prisma.shop.findUnique({
      where: { id: shopId },
      select: { id: true }
    });

    if (!shop) {
      return res.status(404).json({ error: "Shop not found" });
    }

    const records = await prisma.productAtShop.findMany({
      where: { shopId },
      select: { productId: true }
    });

    const productIds = records.map((record) => record.productId);

    res.status(200).json({
      shopId,
      total: productIds.length,
      productIds,
    });
  } catch (error) {
    console.error("Error getting all product IDs at shop:", error);
    res.status(500).json({ error: "Internal server error" });
  }
};

const transferProductsBetweenShops = async (req, res) => {
  const { sourceShopId, destinationShopId, productIds, copyPrice, copyAisleNumber, copyLocationCode, duplicateStrategy } = req.body;

  if (!sourceShopId || !destinationShopId) {
    return res.status(400).json({ error: "sourceShopId and destinationShopId are required" });
  }

  if (sourceShopId === destinationShopId) {
    return res.status(400).json({ error: "Source and destination shops must be different" });
  }

  if (!Array.isArray(productIds) || productIds.length === 0) {
    return res.status(400).json({ error: "productIds must be a non-empty array" });
  }

  const strategy = duplicateStrategy === "replace" ? "replace" : "skip";
  const normalizedProductIds = Array.from(new Set(productIds.filter((id) => typeof id === "string" && id.trim())));

  if (normalizedProductIds.length === 0) {
    return res.status(400).json({ error: "No valid productIds were provided" });
  }

  const shouldCopyPrice = Boolean(copyPrice);
  const shouldCopyAisle = Boolean(copyAisleNumber);
  const shouldCopyLocationCode = Boolean(copyLocationCode);
  const actorEmployeeId = req.user?.userType === "EMPLOYEE" ? parseInt(req.user.id, 10) : null;

  try {
    const result = await prisma.$transaction(async (tx) => {
      const [sourceShop, destinationShop] = await Promise.all([
        tx.shop.findUnique({ where: { id: sourceShopId }, select: { id: true } }),
        tx.shop.findUnique({ where: { id: destinationShopId }, select: { id: true } }),
      ]);

      if (!sourceShop) {
        const sourceError = new Error("Source shop not found");
        sourceError.statusCode = 404;
        throw sourceError;
      }

      if (!destinationShop) {
        const destinationError = new Error("Destination shop not found");
        destinationError.statusCode = 404;
        throw destinationError;
      }

      const sourceRecords = await tx.productAtShop.findMany({
        where: {
          shopId: sourceShopId,
          productId: {
            in: normalizedProductIds,
          },
        },
        select: {
          productId: true,
          price: true,
          card_aiel_number: true,
          locationCode: true,
        },
      });

      const sourceByProductId = new Map(sourceRecords.map((record) => [record.productId, record]));
      const existingDestinationRecords = await tx.productAtShop.findMany({
        where: {
          shopId: destinationShopId,
          productId: {
            in: normalizedProductIds,
          },
        },
        select: {
          productId: true,
        },
      });
      const existingDestinationSet = new Set(existingDestinationRecords.map((record) => record.productId));

      const toCreate = [];
      const toReplace = [];
      let skipped = 0;
      let failed = 0;

      for (const productId of normalizedProductIds) {
        const sourceRecord = sourceByProductId.get(productId);

        if (!sourceRecord) {
          skipped += 1;
          continue;
        }

        const existsAtDestination = existingDestinationSet.has(productId);

        if (!existsAtDestination) {
          toCreate.push({
            shopId: destinationShopId,
            productId,
            employeeId: Number.isNaN(actorEmployeeId) ? undefined : actorEmployeeId,
            price: shouldCopyPrice ? sourceRecord.price : 0,
            card_aiel_number: shouldCopyAisle ? sourceRecord.card_aiel_number : null,
            locationCode: shouldCopyLocationCode ? sourceRecord.locationCode : null,
            outOfStock: false,
          });
          continue;
        }

        if (strategy === "skip") {
          skipped += 1;
          continue;
        }

        if (!shouldCopyPrice && !shouldCopyAisle && !shouldCopyLocationCode) {
          skipped += 1;
          continue;
        }

        const updateData = {};

        if (shouldCopyPrice) {
          updateData.price = sourceRecord.price;
        }

        if (shouldCopyAisle) {
          updateData.card_aiel_number = sourceRecord.card_aiel_number;
        }

        if (shouldCopyLocationCode) {
          updateData.locationCode = sourceRecord.locationCode;
        }

        if (!Number.isNaN(actorEmployeeId) && actorEmployeeId !== null) {
          updateData.employeeId = actorEmployeeId;
        }

        updateData.updatedAt = new Date();

        toReplace.push({
          productId,
          updateData,
        });
      }

      let createdCount = 0;
      if (toCreate.length > 0) {
        const createResult = await tx.productAtShop.createMany({
          data: toCreate,
          skipDuplicates: true,
        });
        createdCount = createResult.count;
      }

      if (toReplace.length > 0) {
        const replaceChunkSize = 250;
        for (let i = 0; i < toReplace.length; i += replaceChunkSize) {
          const chunk = toReplace.slice(i, i + replaceChunkSize);
          const updateResults = await Promise.allSettled(
            chunk.map((item) =>
              tx.productAtShop.update({
                where: {
                  shopId_productId: {
                    shopId: destinationShopId,
                    productId: item.productId,
                  },
                },
                data: item.updateData,
              })
            )
          );

          updateResults.forEach((updateResult) => {
            if (updateResult.status === "rejected") {
              failed += 1;
            }
          });
        }
      }

      const replacedCount = Math.max(0, toReplace.length - failed);
      const transferred = createdCount + replacedCount;
      const failedWithResiduals = Math.max(0, normalizedProductIds.length - transferred - skipped);

      return {
        transferred,
        skipped,
        failed: failedWithResiduals,
        requested: normalizedProductIds.length,
      };
    });

    await Promise.all([
      invalidateShopInventoryCache(sourceShopId),
      invalidateShopInventoryCache(destinationShopId),
    ]);

    res.status(200).json({
      success: true,
      message: "Transfer complete",
      ...result,
    });
  } catch (error) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({ error: error.message });
    }

    console.error("Error transferring products between shops:", error);
    res.status(500).json({ error: "Failed to transfer products" });
  }
};

// Export all the handlers
export {
  addProductAtShop,
  updateProductPriceAtShop,
  addProductAtShopifExistAtProduct,
  getProductsAtShop,
  searchProductsNotInShop,
  removeProductFromShop,
  toggleOutOfStock,
  getShopFilters,
  getAllProductIdsAtShop,
  transferProductsBetweenShops
};