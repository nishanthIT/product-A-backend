


// import { PrismaClient } from "@prisma/client";
// const prisma = new PrismaClient();

// // Helper function to serialize BigInt to string
// const serializeBigInt = (product) => {
//   const serializedProduct = { ...product };

//   // Check for BigInt properties and convert them to string
//   for (const key in serializedProduct) {
//     if (typeof serializedProduct[key] === "bigint") {
//       serializedProduct[key] = serializedProduct[key].toString();
//     }
//   }

//   return serializedProduct;
// };

// // Controller for filtering products
// const filterProducts = async (req, res) => {
//   const { search } = req.query;

//   try {
//     if (!search) {
//       return res.status(400).json({ error: "Search query is required" });
//     }

//     const products = await prisma.product.findMany({
//       where: {
//         title: {
//           contains: search,
//           mode: "insensitive",
//         },
//       },
//       take: 40, // Limit results to the top 50
//     });

//     if (products.length === 0) {
//       return res
//         .status(404)
//         .json({ message: "No products found matching the search term" });
//     }

//     // Serialize BigInt fields
//     const serializedProducts = products.map(serializeBigInt);

//     res.status(200).json(serializedProducts);
//   } catch (error) {
//     console.error(error);
//     res.status(500).json({ error: "Something went wrong" });
//   }
// };

// export { filterProducts };

import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();

// Helper function to serialize BigInt to string
const serializeBigInt = (product) => {
  const serializedProduct = { ...product };

  // Check for BigInt properties and convert them to string
  for (const key in serializedProduct) {
    if (typeof serializedProduct[key] === "bigint") {
      serializedProduct[key] = serializedProduct[key].toString();
    }
  }

  return serializedProduct;
};

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
  
  // Exact contains match
  if (textLower.includes(searchLower)) return true;
  
  // Split text into words and check each
  const textWords = textLower.split(/\s+/);
  for (const textWord of textWords) {
    // For short words (<=3 chars), require exact match or distance of 1
    const allowedDistance = searchLower.length <= 3 ? 1 : maxDistance;
    
    // Check if word starts with search term (prefix match)
    if (textWord.startsWith(searchLower.substring(0, Math.min(3, searchLower.length)))) {
      const distance = levenshteinDistance(searchLower, textWord.substring(0, searchLower.length + 2));
      if (distance <= allowedDistance) return true;
    }
    
    // Check Levenshtein distance
    if (textWord.length >= searchLower.length - 2 && textWord.length <= searchLower.length + 2) {
      const distance = levenshteinDistance(searchLower, textWord);
      if (distance <= allowedDistance) return true;
    }
  }
  return false;
};

// Controller for filtering products with pagination
const filterProducts = async (req, res) => {
  try {
    console.log("Filter Products Controller - Request Query:", req.query);
    
    const { 
      search, 
      withoutBarcode, 
      withoutCaseBarcode, 
      withoutRrp, 
      withoutImage,
      page = "10",
     // limit = "100"
    } = req.query;
const limit = 100

    // Convert page and limit to numbers
    const pageNum = parseInt(page);
    const limitNum = parseInt(limit);
    const skip = (pageNum - 1) * limitNum;

    console.log("Pagination:", { pageNum, limitNum, skip });

    // Build the where clause based on filters
    const whereClause = {};
    
    // Add search condition if provided - improved fuzzy search with typo tolerance
    if (search) {
      // Split search into words for better matching
      const searchWords = search.trim().split(/\s+/).filter(word => word.length > 0);
      
      if (searchWords.length > 0) {
        // Build OR conditions for each word to match title OR barcode
        // Also add partial matching (first 3+ characters) for typo tolerance
        const searchConditions = searchWords.map(word => {
          const conditions = [
            { title: { contains: word, mode: "insensitive" } },
            { barcode: { contains: word, mode: "insensitive" } },
            { caseBarcode: { contains: word, mode: "insensitive" } }
          ];
          
          // For words longer than 3 characters, also try matching with first part (typo tolerance)
          // e.g., "amtec" will match "amtech" because we search for "amt" as well
          if (word.length > 3) {
            const partialWord = word.substring(0, Math.ceil(word.length * 0.7)); // Match 70% of the word
            if (partialWord.length >= 3) {
              conditions.push({ title: { contains: partialWord, mode: "insensitive" } });
            }
          }
          
          return { OR: conditions };
        });
        
        // All words must match somewhere (AND between words, OR between fields)
        whereClause.AND = searchConditions;
      }
    }
    
    // Without barcode filter
    if (withoutBarcode === 'true') {
      whereClause.barcode = {
        equals: null,
      };
    }
    
    // Without case barcode filter
    if (withoutCaseBarcode === 'true') {
      whereClause.caseBarcode = {
        equals: null,
      };
    }
    
    // Without RRP filter
    if (withoutRrp === 'true') {
      whereClause.rrp = {
        equals: null,
      };
    }
    
    // Without image filter - handle different field structures
    if (withoutImage === 'true') {
      // Check your database schema to determine the correct approach:
      try {
        // Option 1: If images is an array field
        whereClause.img = {
          equals: null,
        };
      } catch (error) {
        console.error("Error with isEmpty condition, trying alternative:", error);
        // Option 2: If images is a string field or URL
        whereClause.images = {
          equals: null,
        };
      }
    }

    // console.log("Where Clause:", JSON.stringify(whereClause));

    // Get total count for pagination
    let totalCount;
    try {
      totalCount = await prisma.product.count({
        where: whereClause
      });
      console.log("Total count:", totalCount);
    } catch (countError) {
      console.error("Error counting products:", countError);
      totalCount = 0;
    }

    // Calculate total pages
    const totalPages = Math.ceil(totalCount / limitNum);

    // Get products with pagination
    let products;
    try {
      products = await prisma.product.findMany({
        where: whereClause,
        skip,
        take: limitNum,
        orderBy: {
          title: 'asc' // You can change the ordering as needed
        }
      });
      console.log(`Found ${products.length} products from DB`);
      
      // If search is provided and we got few results, try fuzzy search on more products
      if (search && products.length < 10) {
        const searchWords = search.trim().split(/\s+/).filter(word => word.length > 0);
        
        // Fetch more products without strict filter for fuzzy matching
        const allProducts = await prisma.product.findMany({
          take: 500, // Get more products to filter
          orderBy: { title: 'asc' }
        });
        
        // Apply fuzzy matching
        const fuzzyMatched = allProducts.filter(product => {
          const searchableText = `${product.title || ''} ${product.barcode || ''} ${product.caseBarcode || ''}`;
          // All search words must fuzzy match
          return searchWords.every(word => fuzzyMatchWord(word, searchableText, 2));
        });
        
        // Merge results (original exact matches first, then fuzzy matches)
        const existingIds = new Set(products.map(p => p.id));
        const additionalProducts = fuzzyMatched.filter(p => !existingIds.has(p.id));
        products = [...products, ...additionalProducts].slice(0, limitNum);
        
        console.log(`After fuzzy matching: ${products.length} products`);
      }
    } catch (findError) {
      console.error("Error finding products:", findError);
      
      // Try a simpler query if the complex one fails
      try {
        console.log("Attempting simpler query...");
        products = await prisma.product.findMany({
          take: limitNum
        });
      } catch (fallbackError) {
        console.error("Even simple query failed:", fallbackError);
        return res.status(500).json({ 
          error: "Database query failed", 
          details: findError.message 
        });
      }
    }

    // Serialize BigInt fields
    const serializedProducts = products.map(serializeBigInt);

    // Return products with pagination metadata
    res.status(200).json({
      products: serializedProducts,
      pagination: {
        total: Math.max(totalCount, products.length),
        page: pageNum,
        limit: limitNum,
        totalPages: Math.max(totalPages, Math.ceil(products.length / limitNum))
      }
    });
  } catch (error) {
    console.error("Uncaught error in filterProducts:", error);
    res.status(500).json({ 
      error: "Something went wrong",
      message: error.message
    });
  }
};

export { filterProducts };