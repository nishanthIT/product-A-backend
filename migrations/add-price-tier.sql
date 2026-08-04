CREATE TABLE IF NOT EXISTS "PriceTier" (
  "id" TEXT NOT NULL,
  "productAtShopId" TEXT NOT NULL,
  "quantity" INTEGER NOT NULL,
  "price" DECIMAL(65,30) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PriceTier_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PriceTier_productAtShopId_fkey" FOREIGN KEY ("productAtShopId") REFERENCES "ProductAtShop"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "PriceTier_productAtShopId_quantity_key" ON "PriceTier"("productAtShopId", "quantity");
CREATE INDEX IF NOT EXISTS "PriceTier_productAtShopId_idx" ON "PriceTier"("productAtShopId");
