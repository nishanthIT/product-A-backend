import { PrismaClient } from "@prisma/client";
import { execSync } from "child_process";

const prisma = new PrismaClient();

async function testAndMigrate() {
  console.log("🔍 Testing database connection...");
  
  try {
    // Test connection
    await prisma.$connect();
    console.log("✅ Database connection successful!");
    
    // Check current schema
    const tableInfo = await prisma.$queryRaw`
      SELECT column_name, data_type 
      FROM information_schema.columns 
      WHERE table_name = 'ListProduct'
      ORDER BY ordinal_position;
    `;
    
    console.log("\n📋 Current ListProduct schema:");
    console.table(tableInfo);
    
    // Check if migration is needed
    const hasOldSchema = tableInfo.some(col => col.column_name === 'productAtShopId');
    const hasNewSchema = tableInfo.some(col => col.column_name === 'productId');
    
    if (hasOldSchema && !hasNewSchema) {
      console.log("\n⚠️  Migration needed! Old schema detected.");
      console.log("Run one of these commands:");
      console.log("  1. npx prisma db push");
      console.log("  2. npx prisma migrate dev --name update-list-product-schema");
      console.log("  3. Execute manual-migration.sql directly on database");
    } else if (hasNewSchema) {
      console.log("\n✅ Schema is up to date!");
      
      // Test the new schema
      const sampleData = await prisma.listProduct.findFirst({
        include: {
          product: true,
          list: true,
        },
      });
      
      if (sampleData) {
        console.log("\n📦 Sample product in list:");
        console.log({
          listName: sampleData.list.name,
          productName: sampleData.product.title,
          lowestPrice: sampleData.lowestPrice,
          shopName: sampleData.shopName,
        });
      } else {
        console.log("\n📦 No products in any lists yet.");
      }
    } else {
      console.log("\n❓ Unknown schema state. Please check manually.");
    }
    
  } catch (error) {
    console.error("\n❌ Database connection failed:");
    console.error(error.message);
    console.log("\n💡 Troubleshooting:");
    console.log("  1. Check if database server is running");
    console.log("  2. Verify DATABASE_URL in .env file");
    console.log("  3. Check network connection");
    console.log("  4. Verify database credentials");
  } finally {
    await prisma.$disconnect();
  }
}

testAndMigrate();
