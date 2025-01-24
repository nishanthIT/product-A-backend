


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

// Controller for filtering products
const filterProducts = async (req, res) => {
  const { search } = req.query;

  try {
    if (!search) {
      return res.status(400).json({ error: "Search query is required" });
    }

    const products = await prisma.product.findMany({
      where: {
        title: {
          contains: search,
          mode: "insensitive",
        },
      },
      take: 40, // Limit results to the top 50
    });

    if (products.length === 0) {
      return res
        .status(404)
        .json({ message: "No products found matching the search term" });
    }

    // Serialize BigInt fields
    const serializedProducts = products.map(serializeBigInt);

    res.status(200).json(serializedProducts);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Something went wrong" });
  }
};

export { filterProducts };

