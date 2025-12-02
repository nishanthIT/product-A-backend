-- Manual Migration: Update ListProduct Schema
-- Run this SQL when database is accessible

-- Step 1: Create new ListProduct table with new schema
CREATE TABLE "ListProduct_new" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "listId" TEXT NOT NULL,
  "productId" TEXT NOT NULL,
  "lowestPrice" DOUBLE PRECISION NOT NULL,
  "shopName" TEXT NOT NULL,
  CONSTRAINT "ListProduct_new_listId_fkey" FOREIGN KEY ("listId") REFERENCES "List"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ListProduct_new_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- Step 2: Create unique constraint
CREATE UNIQUE INDEX "ListProduct_new_listId_productId_key" ON "ListProduct_new"("listId", "productId");

-- Step 3: Migrate data from old table to new table (with lowest price calculation)
INSERT INTO "ListProduct_new" ("id", "listId", "productId", "lowestPrice", "shopName")
SELECT 
  lp.id,
  lp.listId,
  pas.productId,
  pas.price::DOUBLE PRECISION,
  s.name
FROM "ListProduct" lp
INNER JOIN "ProductAtShop" pas ON lp."productAtShopId" = pas.id
INNER JOIN "Shop" s ON pas."shopId" = s.id
WHERE pas.price = (
  SELECT MIN(pas2.price)
  FROM "ListProduct" lp2
  INNER JOIN "ProductAtShop" pas2 ON lp2."productAtShopId" = pas2.id
  WHERE lp2.listId = lp.listId AND pas2.productId = pas.productId
)
ON CONFLICT ("listId", "productId") DO NOTHING;

-- Step 4: Drop old table
DROP TABLE "ListProduct";

-- Step 5: Rename new table
ALTER TABLE "ListProduct_new" RENAME TO "ListProduct";

-- Step 6: Create indexes for better performance
CREATE INDEX "ListProduct_listId_idx" ON "ListProduct"("listId");
CREATE INDEX "ListProduct_productId_idx" ON "ListProduct"("productId");

-- Verify the migration
SELECT COUNT(*) as total_products FROM "ListProduct";
SELECT l.name as list_name, p.title as product_name, lp."lowestPrice", lp."shopName"
FROM "ListProduct" lp
INNER JOIN "List" l ON lp."listId" = l.id
INNER JOIN "Product" p ON lp."productId" = p.id
LIMIT 10;
