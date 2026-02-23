import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();

// Levenshtein distance function for fuzzy matching
function levenshteinDistance(str1, str2) {
  const m = str1.length;
  const n = str2.length;
  
  // Create a 2D array to store distances
  const dp = Array(m + 1).fill(null).map(() => Array(n + 1).fill(0));
  
  // Initialize first column and row
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  
  // Fill the rest of the matrix
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (str1[i - 1].toLowerCase() === str2[j - 1].toLowerCase()) {
        dp[i][j] = dp[i - 1][j - 1];
      } else {
        dp[i][j] = 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
      }
    }
  }
  
  return dp[m][n];
}

// Fuzzy match a word against a text
function fuzzyMatchWord(searchWord, text, maxDistance = 2) {
  if (!searchWord || !text) return false;
  
  const lowerWord = searchWord.toLowerCase();
  const lowerText = text.toLowerCase();
  
  // Direct contains check
  if (lowerText.includes(lowerWord)) return true;
  
  // Check each word in the text
  const textWords = lowerText.split(/\s+/);
  
  for (const textWord of textWords) {
    // Exact match
    if (textWord === lowerWord) return true;
    
    // Starts with the search word
    if (textWord.startsWith(lowerWord) || lowerWord.startsWith(textWord)) return true;
    
    // Levenshtein distance check for words of similar length
    const lengthDiff = Math.abs(textWord.length - lowerWord.length);
    if (lengthDiff <= maxDistance) {
      const distance = levenshteinDistance(textWord, lowerWord);
      const threshold = lowerWord.length <= 4 ? 1 : maxDistance;
      if (distance <= threshold) return true;
    }
  }
  
  return false;
}

// Helper function to get effective price (considering active offers)
const getEffectivePrice = (productAtShop) => {
  const currentDate = new Date();
  const hasActiveOffer = productAtShop.offerPrice && 
                        productAtShop.offerExpiryDate && 
                        new Date(productAtShop.offerExpiryDate) > currentDate;
  
  const effectivePrice = hasActiveOffer ? productAtShop.offerPrice : productAtShop.price;
  return {
    price: parseFloat(effectivePrice),
    originalPrice: parseFloat(productAtShop.price),
    offerPrice: productAtShop.offerPrice ? parseFloat(productAtShop.offerPrice) : null,
    hasActiveOffer,
  };
};

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
          title: title.toUpperCase(),
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

      res.status(201).json({
        success: true,
        data: {
          ...newProduct,
          rrp: newProduct.rrp?.toString() || null,
        }
      });

    } catch (error) {
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
     
      if (title !== undefined) dataToUpdate.title = title.toUpperCase();
      if (caseSize !== undefined) dataToUpdate.caseSize = caseSize || null;
      if (packetSize !== undefined) dataToUpdate.packetSize = packetSize || null;
      if (retailSize !== undefined) dataToUpdate.retailSize = retailSize || null;
      if (rrp !== undefined) dataToUpdate.rrp = handleNumericField(rrp, null);
      if (barcode !== undefined) dataToUpdate.barcode = String(barcode);
      if (caseBarcode !== undefined) dataToUpdate.caseBarcode = String(caseBarcode);
      if (category !== undefined) dataToUpdate.category = category || null;
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
        include: { shops: { include: { shop: true } } }
      });

      const formattedShops = updatedProduct.shops?.map((productAtShop) => ({
        name: productAtShop.shop.name,
        location: productAtShop.shop.address,
        price: productAtShop.price,
      })) || [];

      res.status(200).json({
        success: true,
        data: {
          ...updatedProduct,
          barcode: updatedProduct.barcode?.toString(),
          shops: formattedShops,
        },
      });

    } catch (error) {
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
        shops: {
          include: {
            shop: true, // Include shop details
          },
        },
      },
    });

    // Handle case where product is not found
    if (!product) {
      return res.status(404).json({ error: "Product not found." });
    }

    // Format response with shop details
    const formattedShops = product.shops.map((productAtShop) => ({
      name: productAtShop.shop.name,
      location: productAtShop.shop.address,
      price: productAtShop.price,
    }));

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

  try {
    // Validate barcode parameter
    if (!barcode) {
      return res.status(400).json({ error: "Barcode is required." });
    }

    // Trim and clean the barcode
    const cleanBarcode = barcode.trim();
    console.log("Searching for barcode:", cleanBarcode);

    // First try exact match on barcode field
    let product = await prisma.product.findUnique({
      where: { barcode: cleanBarcode },
      include: {
        shops: {
          include: {
            shop: true, // Include shop details
          },
        },
      },
    });

    // If not found, try searching in caseBarcode field
    if (!product) {
      console.log("Not found in barcode field, trying caseBarcode...");
      product = await prisma.product.findFirst({
        where: { caseBarcode: cleanBarcode },
        include: {
          shops: {
            include: {
              shop: true,
            },
          },
        },
      });
    }

    // If still not found, try case-insensitive search on both fields
    if (!product) {
      console.log("Trying case-insensitive search...");
      product = await prisma.product.findFirst({
        where: {
          OR: [
            { barcode: { equals: cleanBarcode, mode: 'insensitive' } },
            { caseBarcode: { equals: cleanBarcode, mode: 'insensitive' } }
          ]
        },
        include: {
          shops: {
            include: {
              shop: true,
            },
          },
        },
      });
    }

    // Handle case where product is not found
    if (!product) {
      console.log("Product not found for barcode:", cleanBarcode);
      return res.status(404).json({ error: "Product not found." });
    }

    console.log("Product found:", product.title);

    // Format response with shop details
    const formattedShops = product.shops.map((productAtShop) => ({
      name: productAtShop.shop.name,
      location: productAtShop.shop.address,
      price: productAtShop.price,
    }));

    res.status(200).json({
      success: true,
      data: {
        ...product,
        barcode: product.barcode ? product.barcode.toString() : null,
        shops: formattedShops, // Include shop details in the response
      },
    });
  } catch (error) {
    if (error.name === "SyntaxError" || error.message.includes("BigInt")) {
      console.log(error);
      return res.status(400).json({ error: "Invalid barcode format." });
    }
    console.error("Error fetching product by barcode:", error);
    res.status(500).json({ error: "Internal server error." });
  }
};

// Search products by title/name with fuzzy matching (for customers adding to lists)
const searchProducts = async (req, res) => {
  try {
    const { q, limit = 20 } = req.query;

    if (!q || typeof q !== 'string' || q.trim().length < 2) {
      return res.status(400).json({ error: "Search query must be at least 2 characters" });
    }

    const searchTerm = q.trim();
    const searchWords = searchTerm.split(/\s+/).filter(word => word.length > 0);

    // Build search conditions for each word
    const searchConditions = searchWords.map(word => {
      const conditions = [
        { title: { contains: word, mode: 'insensitive' } },
        { barcode: { contains: word, mode: 'insensitive' } }
      ];
      
      // For words longer than 3 characters, also try partial matching
      if (word.length > 3) {
        const partialWord = word.substring(0, Math.ceil(word.length * 0.7));
        if (partialWord.length >= 3) {
          conditions.push({ title: { contains: partialWord, mode: 'insensitive' } });
        }
      }
      
      return { OR: conditions };
    });

    // Search products by title and barcode (case-insensitive)
    let products = await prisma.product.findMany({
      where: {
        AND: searchConditions
      },
      include: {
        shops: {
          include: {
            shop: true,
          },
        },
      },
      take: parseInt(limit) * 2, // Get more for potential fuzzy filtering
      orderBy: {
        title: 'asc',
      },
    });

    // If few results, apply fuzzy matching to a broader search
    if (products.length < parseInt(limit) / 2) {
      const broadProducts = await prisma.product.findMany({
        include: {
          shops: {
            include: {
              shop: true,
            },
          },
        },
        take: 300,
        orderBy: {
          title: 'asc',
        },
      });
      
      // Apply fuzzy matching
      const fuzzyMatched = broadProducts.filter(product => {
        const searchableText = `${product.title || ''} ${product.barcode || ''}`;
        return searchWords.every(word => fuzzyMatchWord(word, searchableText, 2));
      });
      
      // Merge with existing results
      const existingIds = new Set(products.map(p => p.id));
      const additionalProducts = fuzzyMatched.filter(p => !existingIds.has(p.id));
      products = [...products, ...additionalProducts];
    }

    // Limit results
    products = products.slice(0, parseInt(limit));

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

    res.status(200).json({
      success: true,
      message: "Product deleted successfully"
    });
  } catch (error) {
    console.error("Error deleting product:", error);
    res.status(500).json({ error: "Failed to delete product" });
  }
};

export { addProduct, editProduct, getProductById, getProductByBarcode, searchProducts, deleteProduct };
