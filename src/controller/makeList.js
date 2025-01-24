import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();

const makeList = async (req, res) => {
  const customerId = Number(req.params.customerId);
  const { name, description } = req.body;

  try {
    const list = await prisma.list.create({
      data: {
        name,
        description,
        customerId,
      },
    });
    res.status(201).json(list);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Internal server error." });
  }
};

const addProductToList = async (req, res) => {
  const { listId, customerId, productId } = req.body;

  try {
    // Check if the list exists and belongs to the customer
    const list = await prisma.list.findUnique({
      where: {
        id: listId,
      },
      include: {
        customer: true,
      },
    });
    if (!list || list.customerId !== customerId) {
      return res
        .status(404)
        .json({ error: "List not found or does not belong to the customer." });
    }

    // Find the product in all shops
    const productAtShops = await prisma.productAtShop.findMany({
      where: {
        productId,
      },
      include: {
        shop: true, // Include shop details if needed
      },
    });

    if (productAtShops.length === 0) {
      return res.status(404).json({ error: "Product not found in any shop." });
    }

    // Add all the productAtShop entries to the list
    await prisma.listProduct.createMany({
      data: productAtShops.map((product) => ({
        listId,
        productAtShopId: product.id,
      })),
    });

    res.status(200).json({
      success: true,
      message: "Product added to list successfully.",
      data: productAtShops.map((product) => ({
        shopName: product.shop.name,
        price: product.price,
      })),
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Internal server error." });
  }
};

// --------------------------------------------------------------------------------

// Get lowest price for each product in a list
const getLowestPricesInList = async (req, res) => {
  const { listId, customerId } = req.body;

  try {
    // Step 1: Verify the list belongs to the given customer
    const list = await prisma.list.findUnique({
      where: { id: listId },
      include: { customer: true },
    });

    if (!list || list.customerId !== parseInt(customerId, 10)) {
      return res
        .status(404)
        .json({ error: "List not found or does not belong to the customer." });
    }

    // Step 2: Fetch all products in the list along with their associated shops
    const productsInList = await prisma.listProduct.findMany({
      where: { listId },
      include: {
        productAtShop: {
          include: {
            product: true,
            shop: true,
          },
        },
      },
    });

    if (!productsInList.length) {
      return res.status(404).json({ error: "No products found in the list." });
    }

    // Step 3: Group products by shop and calculate lowest price for each product
    const shopsMap = new Map();

    productsInList.forEach((listProduct) => {
      const shop = listProduct.productAtShop.shop;
      const product = listProduct.productAtShop.product;
      const price = listProduct.productAtShop.price;

      if (!shopsMap.has(shop.id)) {
        shopsMap.set(shop.id, {
          shopName: shop.name,
          shopAddress: shop.address,
          shopMobile: shop.mobile,
          items: [],
        });
      }

      const shopData = shopsMap.get(shop.id);
      shopData.items.push({
        productId: product.id,
        productName: product.title,
        lowestPrice: price,
      });
    });

    // Step 4: Prepare response
    const response = Array.from(shopsMap.values());

    res.status(200).json({
      success: true,
      message: "Fetched products with their lowest prices grouped by shop.",
      data: response,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Internal server error." });
  }
};

const removeProductFromList = async (req, res) => {
  const { listId, productId, customerId } = req.body;
  try {
    // Ensure the customer owns the list
    const list = await prisma.list.findFirst({
      where: { id: listId, customerId },
    });

    if (!list) {
      throw new Error("List not found or does not belong to this customer.");
    }

    // Find and delete the ListProduct entry
    const deletedProduct = await prisma.listProduct.deleteMany({
      where: {
        listId,
        productAtShop: { productId },
      },
    });

    if (deletedProduct.count === 0) {
      throw new Error("Product not found in the specified list.");
    }

    res.status(200).json({
      success: true,
      message: "Product removed from list.",
    });
  } catch (error) {
    console.error("Error removing product from list:", error.message);
  }
};

export {
  makeList,
  addProductToList,
  getLowestPricesInList,
  removeProductFromList,
};
