-- Additive schema only. Backfill is a separate dry-run-first, reviewed operation.
-- Existing Shop/Customer.shopId/employee/list/product records are not modified.
BEGIN;
SET LOCAL lock_timeout = '5s';

-- AlterTable
ALTER TABLE "Customer" ADD COLUMN     "defaultSupermarketId" TEXT,
ADD COLUMN     "defaultSupermarketVersion" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "SupermarketOwnership" (
    "id" TEXT NOT NULL,
    "customerId" INTEGER NOT NULL,
    "shopId" TEXT NOT NULL,
    "shopType" "ShopType" NOT NULL DEFAULT 'CUSTOMER',
    "source" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SupermarketOwnership_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupermarketMigrationReview" (
    "id" TEXT NOT NULL,
    "customerId" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "evidence" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "SupermarketMigrationReview_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupermarketMigrationRun" (
    "id" TEXT NOT NULL,
    "planHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "recoveredAt" TIMESTAMP(3),
    "changes" JSONB NOT NULL,

    CONSTRAINT "SupermarketMigrationRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RegistrationReceipt" (
    "requestHash" TEXT NOT NULL,
    "customerId" INTEGER NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RegistrationReceipt_pkey" PRIMARY KEY ("requestHash")
);

-- CreateIndex
CREATE INDEX "SupermarketOwnership_shopId_idx" ON "SupermarketOwnership"("shopId");

-- CreateIndex
CREATE UNIQUE INDEX "SupermarketOwnership_customerId_shopId_key" ON "SupermarketOwnership"("customerId", "shopId");

-- CreateIndex
CREATE UNIQUE INDEX "SupermarketMigrationReview_customerId_reason_key" ON "SupermarketMigrationReview"("customerId", "reason");

-- CreateIndex
CREATE UNIQUE INDEX "RegistrationReceipt_customerId_key" ON "RegistrationReceipt"("customerId");

-- CreateIndex
CREATE UNIQUE INDEX "Shop_id_shopType_key" ON "Shop"("id", "shopType");

-- AddForeignKey
ALTER TABLE "Customer" ADD CONSTRAINT "Customer_id_defaultSupermarketId_fkey" FOREIGN KEY ("id", "defaultSupermarketId") REFERENCES "SupermarketOwnership"("customerId", "shopId") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "SupermarketOwnership" ADD CONSTRAINT "SupermarketOwnership_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupermarketOwnership" ADD CONSTRAINT "SupermarketOwnership_shopId_shopType_fkey" FOREIGN KEY ("shopId", "shopType") REFERENCES "Shop"("id", "shopType") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SupermarketMigrationReview" ADD CONSTRAINT "SupermarketMigrationReview_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RegistrationReceipt" ADD CONSTRAINT "RegistrationReceipt_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "SupermarketOwnership" ADD CONSTRAINT "SupermarketOwnership_customer_shop_only" CHECK ("shopType" = 'CUSTOMER');

COMMIT;

