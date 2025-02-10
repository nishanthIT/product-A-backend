import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();

const addProductAtShop = async (req, res) => {
  
  const {
    shopId,
    title,
    productUrl,
    caseSize,
    packetSize,
    retailSize,
    img,
    barcode,
    caseBarcode,
    price,
    employeeId,
    aiel
  } = req.body;

  try {
    const shopExists = await prisma.shop.findUnique({ where: { id: shopId } });
    if (!shopExists) {
      return res.status(404).json({ error: "Shop not found." });
    }
    // Use findFirst instead of findUnique to search for non-unique fields
    const existingProduct = await prisma.product.findFirst({
      where: { caseBarcode }, // caseBarcode can be non-unique
    });

    if (existingProduct) {
      return res.status(409).json({ error: "Product already exists." });
    }

    // Create the product in the database
    const newProduct = await prisma.product.create({
      data: {
        title,
        productUrl: productUrl || null,
        caseSize: String(caseSize) ,
        packetSize:String(packetSize),
        retailSize: String(retailSize),
        img:img || null,
        barcode: barcode || null, // Ensure barcode can be nullable
        caseBarcode: caseBarcode || null, // Ensure caseBarcode can be nullable
        

      },
    });

    // Add product to the shop
    const addedProductAtShop = await prisma.productAtShop.create({
      data: {
        shopId,
        productId: newProduct.id, // Use the generated product ID
        price,
        employeeId: parseInt(employeeId, 10),
        card_aiel_number: aiel || null,
      },
    });
 
 

    const actionLog = await prisma.actionLog.create({
      data: {
        employeeId: parseInt(employeeId, 10),
        shopId,
        productId: newProduct.id,
        actionType: "ADD",
      },
    });

    res.status(201).json({ message: "Product added to shop successfully." });
    console.log("Created ProductAtShop:", addedProductAtShop);
    console.log("Created ActionLog:", actionLog);
  } catch (error) {
    console.error("Error adding product at shop:", error);
    res
      .status(500)
      .json({ error: "An error occurred while adding the product." });
  }
};

const updateProductPriceAtShop = async (req, res) => {
  const { shopId } = req.params; // Params for identifying product and shop
  const { productId, price, employeeId } = req.body; // Updated price and employee performing the action

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
      data: { price, updatedAt: new Date() },
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

const addProductAtShopifExistAtProduct = async (req, res) => {
  
  const { shopId, id, price,employeeId, casebarcode,aiel } = req.body;

  console.log(shopId, id, price,employeeId, casebarcode,aiel)

  try {
    const shopExists = await prisma.shop.findUnique({ where: { id: shopId } });
    if (!shopExists) return res.status(404).json({ error: "Shop not found." });

    const product = await prisma.product.findUnique({
      where: { id: id },
    });

    if (!product) {
      return res
        .status(404)
        .json({ error: "Product not found in Products database." });
    }

    // Check if the product already exists in productAtShop
    const productAtShopExists = await prisma.productAtShop.findUnique({
      where: {
        shopId_productId: { shopId, productId: product.id },
      },
    });

    if (productAtShopExists) {
      const updatedProductAtShop = await prisma.productAtShop.update({
        where: {
          shopId_productId: { shopId, productId: product.id },
        },
        data: { price, updatedAt: new Date(),card_aiel_number: aiel },
      });

      const updateProduct = await prisma.product.update({
        where: {
          id: id,
        },
        data: {
          caseBarcode: casebarcode,
          },
      })
      
      console.log("productAtShop updated");

      res.status(200).json({
        success: true,
        message: "Product price updated successfully.",
        data: updatedProductAtShop,
      });
    } else {
      // Add the product to productAtShop
      await prisma.productAtShop.create({
        data: {
          shopId,
          productId: product.id,
          price,
          employeeId: parseInt(employeeId, 10),
        },
      });

      const actionLog = await prisma.actionLog.create({
        data: {
          employeeId: parseInt(employeeId, 10),
          shopId,
          productId: product.id,
          actionType: "ADD",
        },
      });
      console.log("productAtShop created");

      res.status(201).json({ message: "Product added to shop successfully." });
    }
  } catch (error) {
    console.error("Error:", error);
    res.status(500).json({
      error: "An error occurred while adding the product to the shop.",
    });
  }
};


async function getProductAtShop(req, res) {
  const { shopId } = req.params;  // Assuming it's in the body

  if (!shopId) {
    return res.status(400).json({ error: "Shop ID is required" });
  }

  try {
    const productsAtShop = await prisma.shop.findUnique({
      where: {
        id: shopId,
      },
      include: {
        products: {
          select: {
            product: {  // Accessing the related 'Product' model
              select: {
                title: true,  // Fetch the title from Product model
                retailSize: true,  // Fetch the retailSize from Product model
                caseSize: true,  // Fetch the caseSize from Product model
                img: true, // Fetch the img from Product model
              },
            },
            price: true,  // Fetch the price from ProductAtShop model
            productId: true,  // Fetch the productId from ProductAtShop model
          },
        },
      },
    });

    if (!productsAtShop) {
      return res.status(404).json({ error: "Shop not found" });
    }

    // Flatten the results to return only the product details
    const productDetails = productsAtShop.products.map(productAtShop => ({
      title: productAtShop.product.title,
      retailSize: productAtShop.product.retailSize,
      price: productAtShop.price,  // Price from ProductAtShop
      productId: productAtShop.productId,  // productId from ProductAtShop
      caseSize: productAtShop.product.caseSize,  // caseSize from Product model
      img: productAtShop.product.img, //
    }));

    return res.json(productDetails);  // Return only the products data
  } catch (error) {
    console.error("Error fetching products at shop:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
}

export {
  addProductAtShop,
  updateProductPriceAtShop,
  addProductAtShopifExistAtProduct,getProductAtShop
};
