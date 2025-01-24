import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();

// Add a new product
const addProduct = async (req, res) => {
  try {
    const {
      title,
      productUrl,
      caseSize,
      packetSize,
      retailSize,
      img,
      barcode,
    } = req.body;

    // Validate required fields
    if (
      !title ||
      !productUrl ||
      !caseSize ||
      !packetSize ||
      !retailSize ||
      !barcode
    ) {
      return res.status(400).json({ error: "All fields are required." });
    }

    // Check if the product already exists
    const existingProduct = await prisma.product.findUnique({
      where: { barcode: BigInt(barcode) }, // Ensure barcode is treated as BigInt
    });

    if (existingProduct) {
      return res.status(409).json({ error: "Product already exists." });
    }

    // Create a new product
    const newProduct = await prisma.product.create({
      data: {
        title,
        productUrl,
        caseSize,
        packetSize,
        retailSize,
        img,
        barcode: BigInt(barcode), // Convert barcode to BigInt
      },
    });

    // Format response with BigInt converted to string
    res.status(201).json({
      success: true,
      data: {
        ...newProduct,
        barcode: newProduct.barcode.toString(), // Convert barcode to string
      },
    });
  } catch (error) {
    console.error("Error adding product:", error);
    res.status(500).json({ error: "Internal server error." });
  }
};

// Edit an existing product
const editProduct = async (req, res) => {
  const { id } = req.params;

  try {
    const {
      title,
      productUrl,
      caseSize,
      packetSize,
      retailSize,
      img,
      barcode,
    } = req.body;

    // Validate required fields
    if (!id) {
      return res.status(400).json({ error: "Product ID is required." });
    }

    // Check if the product exists
    const existingProduct = await prisma.product.findUnique({
      where: { id },
    });
    if (!existingProduct) {
      return res.status(404).json({ error: "Product not found." });
    }

    // Prepare the data for update
    const dataToUpdate = {};
    if (title !== undefined) dataToUpdate.title = title;
    if (productUrl !== undefined) dataToUpdate.productUrl = productUrl;
    if (caseSize !== undefined) dataToUpdate.caseSize = caseSize;
    if (packetSize !== undefined) dataToUpdate.packetSize = packetSize;
    if (retailSize !== undefined) dataToUpdate.retailSize = retailSize;
    if (img !== undefined) dataToUpdate.img = img;
    if (barcode !== undefined) dataToUpdate.barcode = BigInt(barcode);

    // Update the product
    const updatedProduct = await prisma.product.update({
      where: { id },
      data: dataToUpdate,
    });

    // Format response with BigInt converted to string
    res.status(200).json({
      success: true,
      data: {
        ...updatedProduct,
        barcode: updatedProduct.barcode
          ? updatedProduct.barcode.toString()
          : null,
      },
    });
  } catch (error) {
    if (error.code === "P2025") {
      return res.status(404).json({ error: "Product not found." });
    }
    console.error("Error editing product:", error);
    res.status(500).json({ error: "Internal server error." });
  }
};

export { addProduct, editProduct };
