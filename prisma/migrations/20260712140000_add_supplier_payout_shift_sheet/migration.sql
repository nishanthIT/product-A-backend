-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('TO_PAY', 'PAID');

-- CreateEnum
CREATE TYPE "PaymentMethod" AS ENUM ('CASH', 'CARD');

-- CreateTable
CREATE TABLE "SupplierPayoutRecord" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "supplier" TEXT NOT NULL,
    "amount" DECIMAL(65,30) NOT NULL,
    "paymentStatus" "PaymentStatus" NOT NULL DEFAULT 'TO_PAY',
    "paymentMethod" "PaymentMethod" NOT NULL,
    "notes" TEXT,
    "recordedBy" TEXT NOT NULL,
    "createdById" INTEGER NOT NULL,
    "createdByType" "UserType" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SupplierPayoutRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShiftSheetRecord" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "shiftDate" TIMESTAMP(3) NOT NULL,
    "cashTotal" DECIMAL(65,30) NOT NULL,
    "cardTotal" DECIMAL(65,30) NOT NULL,
    "totalSales" DECIMAL(65,30) NOT NULL,
    "notes" TEXT,
    "recordedBy" TEXT NOT NULL,
    "createdById" INTEGER NOT NULL,
    "createdByType" "UserType" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ShiftSheetRecord_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SupplierPayoutRecord_shopId_idx" ON "SupplierPayoutRecord"("shopId");

-- CreateIndex
CREATE INDEX "SupplierPayoutRecord_supplier_idx" ON "SupplierPayoutRecord"("supplier");

-- CreateIndex
CREATE INDEX "SupplierPayoutRecord_paymentStatus_idx" ON "SupplierPayoutRecord"("paymentStatus");

-- CreateIndex
CREATE INDEX "SupplierPayoutRecord_paymentMethod_idx" ON "SupplierPayoutRecord"("paymentMethod");

-- CreateIndex
CREATE INDEX "SupplierPayoutRecord_recordedBy_idx" ON "SupplierPayoutRecord"("recordedBy");

-- CreateIndex
CREATE INDEX "SupplierPayoutRecord_createdAt_idx" ON "SupplierPayoutRecord"("createdAt");

-- CreateIndex
CREATE INDEX "SupplierPayoutRecord_createdById_createdByType_idx" ON "SupplierPayoutRecord"("createdById", "createdByType");

-- CreateIndex
CREATE INDEX "ShiftSheetRecord_shopId_idx" ON "ShiftSheetRecord"("shopId");

-- CreateIndex
CREATE INDEX "ShiftSheetRecord_shiftDate_idx" ON "ShiftSheetRecord"("shiftDate");

-- CreateIndex
CREATE INDEX "ShiftSheetRecord_recordedBy_idx" ON "ShiftSheetRecord"("recordedBy");

-- CreateIndex
CREATE INDEX "ShiftSheetRecord_createdAt_idx" ON "ShiftSheetRecord"("createdAt");

-- CreateIndex
CREATE INDEX "ShiftSheetRecord_createdById_createdByType_idx" ON "ShiftSheetRecord"("createdById", "createdByType");

-- AddForeignKey
ALTER TABLE "SupplierPayoutRecord" ADD CONSTRAINT "SupplierPayoutRecord_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShiftSheetRecord" ADD CONSTRAINT "ShiftSheetRecord_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;
