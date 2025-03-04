import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();

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
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    file.mimetype.startsWith('image/') ? cb(null, true) : cb(new Error('Only images allowed'));
  }
});

const addProduct = async (req, res) => {
  upload.single('image')(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message });

    try {
      const { title, rrp, caseSize, packetSize, retailSize, barcode } = req.body;
      
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
          imgPath = `/images/${outputFilename}`;

        } catch (bgError) {
          console.error("Background removal failed:", bgError);
          
          // Jimp fallback
          try {
            const image = await Jimp.read(req.file.path);
            await image.writeAsync(outputPath);
            fs.unlinkSync(req.file.path);
            imgPath = `localhost:3000/images/${outputFilename}`;
          } catch (jimpError) {
            console.error("Fallback failed:", jimpError);
            return res.status(500).json({ error: "Image processing failed" });
          }
        }
      }

      // Create product
      const newProduct = await prisma.product.create({
        data: {
          title,
          rrp: rrp ? parseFloat(rrp) : null,
          caseSize: caseSize || null,
          packetSize: packetSize || null,
          retailSize: retailSize || null,
          img: imgPath,
          barcode: String(barcode),
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
      const { title, barcode, rrp, caseSize, packetSize, retailSize,caseBarcode } = req.body;

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
          const imagePath = `/images/${outputFilename}`;

          // Replace existing image with new one
          dataToUpdate.img = imagePath;

        } catch (bgError) {
          console.error("Background removal failed:", bgError);
          try {
            const image = await Jimp.read(req.file.path);
            await image.writeAsync(outputPath);
            fs.unlinkSync(req.file.path);
            const imagePath = `localhost:3000/images/${outputFilename}`;
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

    // Fetch product by barcode and include related shops
    const product = await prisma.product.findUnique({
      where: { barcode },
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
    if (error.name === "SyntaxError" || error.message.includes("BigInt")) {
      console.log(error);
      return res.status(400).json({ error: "Invalid barcode format." });
    }
    console.error("Error fetching product by barcode:", error);
    res.status(500).json({ error: "Internal server error." });
  }
};

export { addProduct, editProduct, getProductById, getProductByBarcode  };
