const { PrismaClient } = require("@prisma/client");
const seedData = require("./seedData.json");

const prisma = new PrismaClient();

// Function to extract barcode from image URL
function extractBarcode(imageUrl) {
  if (Array.isArray(imageUrl) && imageUrl.length > 0) {
    const url = imageUrl[0]; // Access the first image URL
    const matches = url.match(/\/(\d+)\.jpg$/);
    return matches ? matches[1] : null;
  }
  return null;
}

// Add barcode and handle missing imageUrl
seedData.products.forEach((product) => {
  if (product.imageUrl && product.imageUrl.length > 0) {
    const barcode = extractBarcode(product.imageUrl);
    product.barcode = barcode || null;
  } else {
    product.imageUrl = null; // Explicitly set imageUrl to null
    product.barcode = null;
  }
});

async function main() {
  console.log("Starting seeding process...");

  // Seed products
  for (const product of seedData.products) {
    const existingProduct = await prisma.product.findUnique({
      where: { id: product.uniqueId }, // Ensure `id` is unique in your schema
    });

    if (!existingProduct) {
      await prisma.product.create({
        data: {
          id: product.uniqueId,
          title: product.title,
          productUrl: product.productUrl,
          caseSize: product.caseSize,
          packetSize: product.packSize,
          retailSize: product.retailSize,
          img: product.imageUrl, // Null if no imageUrl is provided
          barcode: product.barcode, // Null if no barcode can be extracted
        },
      });
      console.log(`Product added: ${product.title}`);
    } else {
      console.log(`Product already exists: ${product.title}`);
    }
  }

  // Seed other data (users, shops, etc.)
  await prisma.user.createMany({ data: seedData.users });
  console.log("Users added successfully!");

  await prisma.shop.createMany({ data: seedData.shops });
  console.log("Shops added successfully!");

  await prisma.productAtShop.createMany({ data: seedData.productAtShops });
  console.log("Products at shops added successfully!");
}

main()
  .then(() => console.log("Database seeded successfully!"))
  .catch((e) => {
    console.error("Seeding failed:", e);
  })
  .finally(async () => await prisma.$disconnect());
