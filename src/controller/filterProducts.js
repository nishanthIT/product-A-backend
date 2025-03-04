


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
      page = "1",
      limit = "10"
    } = req.query;

    // Convert page and limit to numbers
    const pageNum = parseInt(page);
    const limitNum = parseInt(limit);
    const skip = (pageNum - 1) * limitNum;

    console.log("Pagination:", { pageNum, limitNum, skip });

    // Build the where clause based on filters
    const whereClause = {};
    
    // Add search condition if provided
    if (search) {
      whereClause.title = {
        contains: search,
        mode: "insensitive",
      };
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
      console.log(`Found ${products.length} products`);
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
        total: totalCount,
        page: pageNum,
        limit: limitNum,
        totalPages
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