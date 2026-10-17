BEGIN;
SET LOCAL lock_timeout = '5s';
-- Membership uniqueness remains (employeeId, shopId); explicit assignment can span shops.
DROP INDEX IF EXISTS "ShopEmployeeMembership_one_active_per_employee";
CREATE TABLE "SupermarketCreationReceipt" (
  "customerId" INTEGER NOT NULL, "requestKey" TEXT NOT NULL, "payloadHash" TEXT NOT NULL,
  "shopId" TEXT NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SupermarketCreationReceipt_pkey" PRIMARY KEY ("customerId", "requestKey"),
  CONSTRAINT "SupermarketCreationReceipt_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "SupermarketCreationReceipt_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE TABLE "SupermarketProductState" (
  "shopId" TEXT NOT NULL, "shopType" "ShopType" NOT NULL DEFAULT 'CUSTOMER', "productId" TEXT NOT NULL,
  "inHandStock" INTEGER, "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SupermarketProductState_pkey" PRIMARY KEY ("shopId", "productId"),
  CONSTRAINT "SupermarketProductState_customer_shop_only" CHECK ("shopType" = 'CUSTOMER'),
  CONSTRAINT "SupermarketProductState_nonnegative" CHECK ("inHandStock" IS NULL OR "inHandStock" >= 0),
  CONSTRAINT "SupermarketProductState_shopId_shopType_fkey" FOREIGN KEY ("shopId", "shopType") REFERENCES "Shop"("id", "shopType") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "SupermarketProductState_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "SupermarketProductState_productId_idx" ON "SupermarketProductState"("productId");
-- Existing rows are audited by the separate reviewed backfill. New non-null scopes are FK checked.
ALTER TABLE "List" ADD CONSTRAINT "List_supermarket_scope_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE RESTRICT NOT VALID;
CREATE TABLE "SupermarketAdminAccessLog" (
  "id" TEXT NOT NULL PRIMARY KEY, "actorId" INTEGER NOT NULL, "actorType" "UserType" NOT NULL,
  "action" TEXT NOT NULL, "supermarketId" TEXT, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "SupermarketAdminAccessLog_actorId_actorType_createdAt_idx" ON "SupermarketAdminAccessLog"("actorId", "actorType", "createdAt");
CREATE INDEX "SupermarketAdminAccessLog_supermarketId_createdAt_idx" ON "SupermarketAdminAccessLog"("supermarketId", "createdAt");
COMMIT;
