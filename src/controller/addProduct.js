import { getEffectivePrice, presentSupplierPrice } from '../services/supplierPricing.js';
import { assertProductMasterWrite, resolveProductBarcode } from '../services/productBarcodes.js';
import { PrismaClient } from "@prisma/client";
import {
  indexProduct,
  orderByRank,
  removeIndexedProduct,
  searchProductIds,
} from "../services/productSearchService.js";
const prisma = new PrismaClient();
const USER_SUBMITTED_PENDING_CATEGORY = 'USER_SUBMITTED_PENDING';

const getOrCreateUnknownShop = async () => {
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

  return unknownShop;
};

// Helper function to get effective price (considering active offers)

import multer from 'multer';
import fs from 'fs';
import path from 'path';
import {Jimp} from 'jimp';
import { removeBackground } from "@imgly/background-removal-node";

// Configure multer
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = './images';
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => cb(null, file.originalname)
});

const upload = multer({
  storage,
  limits: { fileSize: 100 * 1024 * 1024 }, // 100MB max - allow large images
  fileFilter: (req, file, cb) => {
    file.mimetype.startsWith('image/') ? cb(null, true) : cb(new Error('Only images allowed'));
  }
});

const addProduct = async (req, res) => {
  upload.single('image')(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message });

    try {
      const { title, rrp, caseSize, packetSize, retailSize, barcode, caseBarcode, category } = req.body;
      
      if (!title || !barcode) {
        if (req.file) fs.unlinkSync(req.file.path);
        return res.status(400).json({ error: "Title and barcode required" });
      }

      // Check existing product
      await assertProductMasterWrite(prisma, null, { barcode: String(barcode), caseBarcode });
      const existingProduct = await prisma.product.findUnique({
        where: { barcode: String(barcode) },
      });
      if (existingProduct) {
        if (req.file) fs.unlinkSync(req.file.path);
        return res.status(409).json({ error: "Product exists" });
      }

      let imgPath = null;
      if (req.file) {
        const outputFilename = `${barcode}.png`;
        const outputPath = path.join('./images', outputFilename);

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
          imgPath = `/api/image/${barcode}`;

        } catch (bgError) {
          console.error("Background removal failed:", bgError);
          
          // Jimp fallback
          try {
            const image = await Jimp.read(req.file.path);
            await image.writeAsync(outputPath);
            fs.unlinkSync(req.file.path);
            imgPath = `/api/image/${barcode}`;
          } catch (jimpError) {
            console.error("Fallback failed:", jimpError);
            return res.status(500).json({ error: "Image processing failed" });
          }
        }
      }

      // Create product with category
      const newProduct = await prisma.product.create({
        data: {
          title,
          rrp: rrp ? parseFloat(rrp) : null,
          caseSize: caseSize || null,
          packetSize: packetSize || null,
          retailSize: retailSize || null,
          img: imgPath,
          barcode: String(barcode),
          caseBarcode: caseBarcode ? String(caseBarcode) : null,
          category: category || null,
        },
      });
      indexProduct(newProduct);

      res.status(201).json({
        success: true,
        data: {
          ...newProduct,
          rrp: newProduct.rrp?.toString() || null,
        }
      });

    } catch (error) {
      if (error.statusCode) {
        if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
        return res.status(error.statusCode).json({ error: error.message, code: error.code });
      }
      console.error("Error:", error);
      if (req.file) fs.unlinkSync(req.file.path);
      res.status(500).json({ error: "Server error" });
    }
  });
};




// Add a new product
// const addProduct = async (req, res) => {
//   try {
//     const {
//       title,
//       productUrl,
//       caseSize,
//       packetSize,
//       retailSize,
//       img,
//       barcode,
//     } = req.body;

//     // Validate required fields
//     if (
//       !title ||
//       !productUrl ||
//       !caseSize ||
//       !packetSize ||
//       !retailSize ||
//       !barcode
//     ) {
//       return res.status(400).json({ error: "All fields are required." });
//     }

//     // Check if the product already exists
//     const existingProduct = await prisma.product.findUnique({
//       where: { barcode: BigInt(barcode) }, // Ensure barcode is treated as BigInt
//     });

//     if (existingProduct) {
//       return res.status(409).json({ error: "Product already exists." });
//     }

//     // Create a new product
//     const newProduct = await prisma.product.create({
//       data: {
//         title,
//         productUrl,
//         caseSize,
//         packetSize,
//         retailSize,
//         img,
//         barcode: BigInt(barcode), // Convert barcode to BigInt
//       },
//     });

//     // Format response with BigInt converted to string
//     res.status(201).json({
//       success: true,
//       data: {
//         ...newProduct,
//         barcode: newProduct.barcode.toString(), // Convert barcode to string
//       },
//     });
//   } catch (error) {
//     console.error("Error adding product:", error);
//     res.status(500).json({ error: "Internal server error." });
//   }
// };

// Edit an existing product
// const editProduct = async (req, res) => {
//   const { id } = req.params;

//   try {
//     const {
//       title,
//       productUrl,
//       caseSize,
//       packetSize,
//       retailSize,
//       img,
//       barcode,
//     } = req.body;

//     // Validate required fields
//     if (!id) {
//       return res.status(400).json({ error: "Product ID is required." });
//     }

//     // Check if the product exists
//     const existingProduct = await prisma.product.findUnique({
//       where: { id },
//     });
//     if (!existingProduct) {
//       return res.status(404).json({ error: "Product not found." });
//     }

//     // Prepare the data for update
//     const dataToUpdate = {};
//     if (title !== undefined) dataToUpdate.title = title;
//     if (productUrl !== undefined) dataToUpdate.productUrl = productUrl;
//     if (caseSize !== undefined) dataToUpdate.caseSize = caseSize;
//     if (packetSize !== undefined) dataToUpdate.packetSize = packetSize;
//     if (retailSize !== undefined) dataToUpdate.retailSize = retailSize;
//     if (img !== undefined) dataToUpdate.img = img;
//     if (barcode !== undefined) dataToUpdate.barcode = BigInt(barcode);

//     // Update the product
//     const updatedProduct = await prisma.product.update({
//       where: { id },
//       data: dataToUpdate,
//     });

//     // Format response with BigInt converted to string
//     res.status(200).json({
//       success: true,
//       data: {
//         ...updatedProduct,
//         barcode: updatedProduct.barcode
//           ? updatedProduct.barcode.toString()
//           : null,
//       },
//     });
//   } catch (error) {
//     if (error.code === "P2025") {
//       return res.status(404).json({ error: "Product not found." });
//     }
//     console.error("Error editing product:", error);
//     res.status(500).json({ error: "Internal server error." });
//   }
// };



const editProduct = async (req, res) => {
  upload.single('image')(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message });

    try {
      const { id } = req.params;
      const { title, barcode, rrp, caseSize, packetSize, retailSize, caseBarcode, category } = req.body;

      if (!id) return res.status(400).json({ error: "Product ID is required." });

      const existingProduct = await prisma.product.findUnique({ where: { id } });
      if (!existingProduct) {
        if (req.file) fs.unlinkSync(req.file.path);
        return res.status(404).json({ error: "Product not found." });
      }

      // Determine target barcode (existing or new)
      const targetBarcode = barcode || existingProduct.barcode;
      
      // Validate barcode for image upload
      if (req.file && !targetBarcode) {
        fs.unlinkSync(req.file.path);
        return res.status(400).json({ error: "Product barcode is required to upload the image." });
      }
      const dataToUpdate = {};
      // Handle numeric fields with empty values
      const handleNumericField = (value, defaultValue) => {
        if (value === undefined) return undefined;
        if (value === '') return null;
        return parseFloat(value) || defaultValue;
      };
     
      if (title !== undefined) dataToUpdate.title = title;
      if (caseSize !== undefined) dataToUpdate.caseSize = caseSize || null;
      if (packetSize !== undefined) dataToUpdate.packetSize = packetSize || null;
      if (retailSize !== undefined) dataToUpdate.retailSize = retailSize || null;
      if (rrp !== undefined) dataToUpdate.rrp = handleNumericField(rrp, null);
      if (barcode !== undefined) dataToUpdate.barcode = String(barcode);
      if (caseBarcode !== undefined) dataToUpdate.caseBarcode = String(caseBarcode);
      if (category !== undefined) dataToUpdate.category = category || null;
      await assertProductMasterWrite(prisma, id, dataToUpdate);
      if (req.file) {
        const outputFilename = `${targetBarcode}.png`;
        const outputPath = path.join('./images', outputFilename);

        try {
          const blob = await removeBackground(req.file.path, {
            publicPath: `file://${path.resolve('node_modules/@imgly/background-removal-node/dist')}/`,
            output: { format: 'image/png', quality: 0.8 }
          });

          fs.writeFileSync(outputPath, Buffer.from(await blob.arrayBuffer()));
          fs.unlinkSync(req.file.path);
          const imagePath = `/api/image/${targetBarcode}`;

          // Replace existing image with new one
          dataToUpdate.img = imagePath;

        } catch (bgError) {
          console.error("Background removal failed:", bgError);
          try {
            const image = await Jimp.read(req.file.path);
            await image.writeAsync(outputPath);
            fs.unlinkSync(req.file.path);
            const imagePath = `/api/image/${targetBarcode}`;
            dataToUpdate.img = imagePath;
          } catch (jimpError) {
            console.error("Fallback failed:", jimpError);
            return res.status(500).json({ error: "Image processing failed" });
          }
        }
      }

      const updatedProduct = await prisma.product.update({
        where: { id },
        data: dataToUpdate,
        include: { shops: { where: { shop: { shopType: 'WHOLESALE' } },
          include: { shop: true } } }
      });
      indexProduct(updatedProduct);

      const formattedShops = updatedProduct.shops?.map(row => presentSupplierPrice(row)) || [];

      res.status(200).json({
        success: true,
        data: {
          ...updatedProduct,
          barcode: updatedProduct.barcode?.toString(),
          shops: formattedShops,
        },
      });

    } catch (error) {
      if (error.statusCode) {
        if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
        return res.status(error.statusCode).json({ error: error.message, code: error.code });
      }
      if (error.code === "P2025") return res.status(404).json({ error: "Product not found." });
      console.error("Error editing product:", error);
      res.status(500).json({ error: "Internal server error." });
    }
  });
};



const getProductById = async (req, res) => {
  const { id } = req.params;

  try {
    // Validate ID parameter
    if (!id) {
      return res.status(400).json({ error: "Product ID is required." });
    }

    // Fetch product by ID and include related shops
    const product = await prisma.product.findUnique({
      where: { id },
      include: {
        packagingConfigurations: { orderBy: { caseGtin: 'asc' } },
        shops: {
          where: { shop: { shopType: 'WHOLESALE' } },
          include: {
            shop: true, priceTiers: true, // Include shop details
          },
        },
      },
    });

    // Handle case where product is not found
    if (!product) {
      return res.status(404).json({ error: "Product not found." });
    }

    // Format response with shop details
    const formattedShops = product.shops.map(row => presentSupplierPrice(row, product.matchedPackaging));

    res.status(200).json({
      success: true,
      data: {
        ...product,
        barcode: product.barcode ? product.barcode.toString() : null,
        shops: formattedShops, // Include shop details in the response
      },
    });
  } catch (error) {
    console.error("Error fetching product by ID:", error);
    res.status(500).json({ error: "Internal server error." });
  }
};

const getProductByBarcode = async (req, res) => {
  const { barcode } = req.params;
  const field = String(req.query.field || '').trim().toLowerCase();

  try {
    // Validate barcode parameter
    if (!barcode) {
      return res.status(400).json({ error: "Barcode is required." });
    }

    if (field && !['barcode', 'casebarcode'].includes(field)) {
      return res.status(400).json({ error: 'field must be barcode or casebarcode' });
    }
    const cleanBarcode = barcode.trim();
    if (!cleanBarcode) return res.status(400).json({ error: 'Barcode is required.' });
    const product = await resolveProductBarcode(prisma, cleanBarcode, {
      field,
      include: { shops: { where: { shop: { shopType: 'WHOLESALE' } }, include: { shop: true, priceTiers: true } } },
    });

    // Handle case where product is not found
    if (!product) {
      console.log("Product not found for barcode:", cleanBarcode);
      return res.status(404).json({ error: "Product not found." });
    }

    console.log("Product found:", product.title);

    // Format response with shop details
    const formattedShops = product.shops.map(row => presentSupplierPrice(row, product.matchedPackaging));

    res.status(200).json({
      success: true,
      data: {
        ...product,
        barcode: product.barcode ? product.barcode.toString() : null,
        ...(product.matchedPackaging && {
          caseBarcode: product.matchedPackaging.caseBarcode,
          caseSize: String(product.matchedPackaging.unitsPerCase),
          packetSize: product.matchedPackaging.packageSize,
        }),
        shops: formattedShops, // Include shop details in the response
      },
    });
  } catch (error) {
    if (error.statusCode) return res.status(error.statusCode).json({ error: error.message, code: error.code });
    if (error.name === "SyntaxError" || error.message.includes("BigInt")) {
      console.log(error);
      return res.status(400).json({ error: "Invalid barcode format." });
    }
    console.error("Error fetching product by barcode:", error);
    res.status(500).json({ error: "Internal server error." });
  }
};

const quickAddProductFromScan = async (req, res) => {
  try {
    const { barcode, title, retailSize, category, inHandStock } = req.body;

    if (!barcode || !title || !retailSize) {
      return res.status(400).json({
        error: "barcode, title and retailSize are required.",
      });
    }

    const cleanBarcode = String(barcode).trim();
    const cleanTitle = String(title).trim();
    const cleanRetailSize = String(retailSize).trim();
    const cleanCategory = category ? String(category).trim() : '';
    const parsedStock = Number(inHandStock);
    const cleanInHandStock =
      inHandStock !== undefined && inHandStock !== null && Number.isInteger(parsedStock) && parsedStock >= 0
        ? parsedStock
        : null;

    if (!cleanBarcode || !cleanTitle || !cleanRetailSize) {
      return res.status(400).json({
        error: "barcode, title and retailSize cannot be empty.",
      });
    }

    const existingProduct = await resolveProductBarcode(prisma, cleanBarcode);

    if (existingProduct) {
      return res.status(409).json({
        error: "Product already exists for this barcode.",
        data: existingProduct,
      });
    }

    const unknownShop = await getOrCreateUnknownShop();

    const createdProduct = await prisma.product.create({
      data: {
        title: cleanTitle,
        barcode: cleanBarcode,
        retailSize: cleanRetailSize,
        caseSize: '1',
        packetSize: '1',
        // A user-picked category is stored right away; admins can still edit it later.
        category: cleanCategory && cleanCategory !== USER_SUBMITTED_PENDING_CATEGORY
          ? cleanCategory
          : USER_SUBMITTED_PENDING_CATEGORY,
      },
    });
    indexProduct(createdProduct);

    const productAtShop = await prisma.productAtShop.upsert({
      where: {
        shopId_productId: {
          shopId: unknownShop.id,
          productId: createdProduct.id,
        },
      },
      update: {},
      create: {
        shopId: unknownShop.id,
        productId: createdProduct.id,
        price: 0,
        outOfStock: false,

      },
      include: {
        shop: true,
      },
    });

    if (cleanInHandStock != null && req.user.shopId) {
      await prisma.supermarketProductState.upsert({
        where: { shopId_productId: { shopId: req.user.shopId, productId: createdProduct.id } },
        create: { shopId: req.user.shopId, productId: createdProduct.id, inHandStock: cleanInHandStock },
        update: { inHandStock: cleanInHandStock },
      });
    }

    return res.status(201).json({
      success: true,
      data: {
        ...createdProduct,
        productAtShopId: productAtShop.id,
        shopName: productAtShop.shop.name,
      },
    });
  } catch (error) {
    if (error.statusCode) return res.status(error.statusCode).json({ error: error.message, code: error.code });
    console.error("Error quick adding product from scan:", error);
    return res.status(500).json({ error: "Internal server error." });
  }
};

const getPendingSubmittedProducts = async (req, res) => {
  try {
    let products;

    try {
      products = await prisma.product.findMany({
        where: {
          category: USER_SUBMITTED_PENDING_CATEGORY,
        },
        include: {
          shops: {
            where: { shop: { shopType: 'WHOLESALE' } },
          include: {
              shop: true,
            },
          },
        },
        orderBy: {
          title: 'asc',
        },
      });
    } catch (queryError) {
      const isDelegateError =
        queryError instanceof TypeError ||
        (queryError instanceof Error && /findMany/.test(queryError.message));

      if (!isDelegateError) {
        throw queryError;
      }

      products = await prisma.$queryRaw`
        SELECT
          p."id",
          p."title",
          p."productUrl",
          p."caseSize",
          p."packetSize",
          p."barcode",
          p."img",
          p."retailSize",
          p."caseBarcode",
          p."rrp",
          p."category"
        FROM "Product" p
        WHERE p."category" = ${USER_SUBMITTED_PENDING_CATEGORY}
        ORDER BY p."title" ASC
      `;

      products = products.map((product) => ({
        ...product,
        shops: [],
      }));
    }

    const pendingBarcodes = Array.from(
      new Set(
        products
          .map((product) => product.barcode)
          .filter((barcode) => barcode !== null && barcode !== undefined)
          .map((barcode) => String(barcode).trim())
          .filter((barcode) => barcode.length > 0)
      )
    );

    let addedBarcodeSet = new Set();
    if (pendingBarcodes.length > 0) {
      const existingProducts = await prisma.product.findMany({
        where: {
          barcode: { in: pendingBarcodes },
          category: { not: USER_SUBMITTED_PENDING_CATEGORY },
        },
        select: {
          barcode: true,
        },
      });

      addedBarcodeSet = new Set(
        existingProducts
          .map((product) => product.barcode)
          .filter((barcode) => barcode !== null && barcode !== undefined)
          .map((barcode) => String(barcode).trim())
      );
    }

    const enrichedProducts = products.map((product) => {
      const productBarcode = product.barcode !== null && product.barcode !== undefined
        ? String(product.barcode).trim()
        : '';
      return {
        ...product,
        alreadyAdded: productBarcode ? addedBarcodeSet.has(productBarcode) : false,
      };
    });

    return res.status(200).json({
      success: true,
      count: enrichedProducts.length,
      data: enrichedProducts,
    });
  } catch (error) {
    console.error("Error fetching pending submitted products:", error);
    return res.status(500).json({ error: "Internal server error." });
  }
};

const approveSubmittedProduct = async (req, res) => {
  try {
    const { id } = req.params;
    const { title, barcode, caseBarcode, category, rrp, caseSize, packetSize, retailSize } = req.body;

    if (!id) {
      return res.status(400).json({ error: "Product ID is required." });
    }

    const product = await prisma.product.findUnique({ where: { id } });
    if (!product) {
      return res.status(404).json({ error: "Product not found." });
    }

    if (product.category !== USER_SUBMITTED_PENDING_CATEGORY) {
      return res.status(400).json({ error: "Product is not pending approval." });
    }

    const normalizedBarcode = barcode !== undefined && barcode !== null
      ? String(barcode).trim()
      : '';
    const normalizedTitle = title !== undefined && title !== null
      ? String(title).trim()
      : '';
    const hasCaseBarcode = caseBarcode !== undefined;
    const normalizedCaseBarcode = hasCaseBarcode && caseBarcode !== null
      ? String(caseBarcode).trim()
      : '';

    if (normalizedBarcode && normalizedBarcode !== product.barcode) {
      const existingProduct = await prisma.product.findFirst({
        where: {
          barcode: normalizedBarcode,
          NOT: { id },
        },
      });

      if (existingProduct) {
        return res.status(409).json({ error: "Barcode already exists." });
      }
    }

    const normalizedCategory = category && String(category).trim()
      ? String(category).trim()
      : '';
    const approvedCategory = normalizedCategory && normalizedCategory !== USER_SUBMITTED_PENDING_CATEGORY
      ? normalizedCategory
      : 'Uncategorized';

    await assertProductMasterWrite(prisma, id, { barcode: normalizedBarcode || product.barcode, caseBarcode: hasCaseBarcode ? normalizedCaseBarcode || null : product.caseBarcode, caseSize: caseSize !== undefined ? String(caseSize) : product.caseSize, packetSize: packetSize !== undefined ? String(packetSize) : product.packetSize });
    const approvedProduct = await prisma.product.update({
      where: { id },
      data: {
        title: normalizedTitle ? normalizedTitle : product.title,
        barcode: normalizedBarcode ? normalizedBarcode : product.barcode,
        caseBarcode: hasCaseBarcode
          ? (normalizedCaseBarcode ? normalizedCaseBarcode : null)
          : product.caseBarcode,
        category: approvedCategory,
        rrp: rrp !== undefined && rrp !== null && rrp !== '' ? parseFloat(rrp) : product.rrp,
        caseSize: caseSize !== undefined ? String(caseSize) : product.caseSize,
        packetSize: packetSize !== undefined ? String(packetSize) : product.packetSize,
        retailSize: retailSize !== undefined ? String(retailSize) : product.retailSize,
      },
    });
    indexProduct(approvedProduct);

    return res.status(200).json({
      success: true,
      message: 'Product approved and added to product database.',
      data: approvedProduct,
    });
  } catch (error) {
    if (error.statusCode) return res.status(error.statusCode).json({ error: error.message, code: error.code });
    console.error('Error approving submitted product:', error);
    return res.status(500).json({ error: 'Internal server error.' });
  }
};

// Ranked product search by name/barcode (for customers adding to lists)
const searchProducts = async (req, res) => {
  try {
    const { q, limit = 20 } = req.query;

    if (!q || typeof q !== 'string' || q.trim().length < 2) {
      return res.status(400).json({ error: "Search query must be at least 2 characters" });
    }

    const take = Math.min(Math.max(parseInt(limit) || 20, 1), 100);
    // Over-fetch so equally relevant products sold in a shop can be listed first.
    const ranked = await searchProductIds(q, { limit: take * 3 });
    const rankedIds = ranked.map((r) => r.id);
    const scoreById = new Map(ranked.map((r) => [r.id, r.score]));

    const rows = rankedIds.length
      ? await prisma.product.findMany({
          where: { id: { in: rankedIds } },
          include: {
            packagingConfigurations: { orderBy: { caseGtin: 'asc' } },
            shops: {
              where: { shop: { shopType: 'WHOLESALE' } },
          include: {
                shop: true,
              },
            },
          },
        })
      : [];
    const products = orderByRank(rows, rankedIds)
      .map((product, rank) => ({ product, rank }))
      .sort((a, b) =>
        scoreById.get(b.product.id) - scoreById.get(a.product.id) ||
        Number(b.product.shops.length > 0) - Number(a.product.shops.length > 0) ||
        a.rank - b.rank)
      .slice(0, take)
      .map(({ product }) => product);

    // Format response with offer price logic
    const formattedProducts = products.map(product => {
      const effectivePrices = product.shops.map(shop => getEffectivePrice(shop));
      const lowestEffectivePrice = effectivePrices.length > 0 ? 
        Math.min(...effectivePrices.map(ep => ep.price)) : null;
      
      return {
        id: product.id,
        title: product.title,
        barcode: product.barcode,
        rrp: product.rrp ? Number(product.rrp) : null,
        img: product.img,
        caseSize: product.caseSize,
        packetSize: product.packetSize,
        retailSize: product.retailSize,
        packagingConfigurations: product.packagingConfigurations,
        availableInShops: product.shops.length,
        lowestPrice: lowestEffectivePrice,
      };
    });

    res.status(200).json({
      success: true,
      count: formattedProducts.length,
      data: formattedProducts,
    });
  } catch (error) {
    console.error("Error searching products:", error);
    res.status(500).json({ error: "Internal server error" });
  }
};

// Delete a product (Admin only)
const deleteProduct = async (req, res) => {
  try {
    const { id } = req.params;

    if (!id) {
      return res.status(400).json({ error: "Product ID is required" });
    }

    // Check if product exists
    const product = await prisma.product.findUnique({
      where: { id },
      include: {
        shops: true,
      }
    });

    if (!product) {
      return res.status(404).json({ error: "Product not found" });
    }

    // Get all ProductAtShop IDs for this product
    const productAtShopIds = product.shops.map(s => s.id);

    // Delete related records first (cascade delete)
    // 1. Delete from ListProduct (which references ProductAtShop)
    if (productAtShopIds.length > 0) {
      await prisma.listProduct.deleteMany({
        where: { 
          productAtShopId: {
            in: productAtShopIds
          }
        }
      });
    }

    // 2. Delete from ProductAtShop
    await prisma.productAtShop.deleteMany({
      where: { productId: id }
    });

    // 3. Delete price reports related to this product
    await prisma.priceReport.deleteMany({
      where: { productId: id }
    });

    // Finally delete the product
    await prisma.product.delete({
      where: { id }
    });
    removeIndexedProduct(id);

    res.status(200).json({
      success: true,
      message: "Product deleted successfully"
    });
  } catch (error) {
    console.error("Error deleting product:", error);
    res.status(500).json({ error: "Failed to delete product" });
  }
};

export {
  addProduct,
  editProduct,
  getProductById,
  getProductByBarcode,
  searchProducts,
  deleteProduct,
  quickAddProductFromScan,
  getPendingSubmittedProducts,
  approveSubmittedProduct,
};
