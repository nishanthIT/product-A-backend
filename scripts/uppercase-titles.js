import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function uppercaseAllTitles() {
  console.log('Starting to convert all product titles to uppercase...\n');

  try {
    // Use raw SQL for bulk update - much faster for 65k+ products
    const result = await prisma.$executeRaw`
      UPDATE "Product" 
      SET title = UPPER(title) 
      WHERE title IS NOT NULL 
        AND title != UPPER(title)
    `;

    console.log(`\n✅ Done! Updated ${result} products to uppercase.`);

  } catch (error) {
    console.error('Error updating titles:', error);
  } finally {
    await prisma.$disconnect();
  }
}

uppercaseAllTitles();
