import { PrismaClient } from '@prisma/client';
;

const prisma = new PrismaClient();

async function standardizeImageUrls() {
  try {
    // Get all products that have image data
    const products = await prisma.product.findMany({
      where: {
        img: {
          not: null,
        },
      },
      select: {
        id: true,
        img: true,
        barcode: true,
      },
    });

    console.log(`Found ${products.length} products with images to process`);

    let updatedCount = 0;
    let skippedCount = 0;

    for (const product of products) {
      // Skip products without barcodes as we need them for the new URL format
      if (!product.barcode) {
        console.log(`Skipping product ${product.id}: No barcode available`);
        skippedCount++;
        continue;
      }

      let imgArray = product.img;
      
      if (!Array.isArray(imgArray)) {
        console.log(`Skipping product ${product.id}: Image data is not an array`);
        skippedCount++;
        continue;
      }

      // Create a new standardized URL using the barcode
      const standardizedUrl = `https://backend.h7tex.com/api/image/${product.barcode}`;
      
      // Update the product with the new standardized URL
      await prisma.product.update({
        where: { id: product.id },
        data: { 
          img: [standardizedUrl]  // Now it's an array with a single standardized URL
        },
      });

      updatedCount++;
      console.log(`Updated product ${product.id} with barcode ${product.barcode}`);
    }

    console.log(`Standardization complete: Updated ${updatedCount} products, skipped ${skippedCount} products`);
  } catch (error) {
    console.error('Error standardizing image URLs:', error);
  } finally {
    await prisma.$disconnect();
  }
}

// Run the function
standardizeImageUrls()
  .then(() => console.log('Process completed successfully'))
  .catch((error) => console.error('Process failed:', error));