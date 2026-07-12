-- CreateEnum
CREATE TYPE "ChildGender" AS ENUM ('MALE', 'FEMALE');

-- CreateTable
CREATE TABLE "AgeRestrictedRecord" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "requestedAt" TIMESTAMP(3) NOT NULL,
    "childGender" "ChildGender" NOT NULL,
    "productCategory" TEXT NOT NULL,
    "productName" TEXT NOT NULL,
    "description" TEXT,
    "recordedBy" TEXT NOT NULL,
    "createdById" INTEGER NOT NULL,
    "createdByType" "UserType" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgeRestrictedRecord_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AgeRestrictedRecord_shopId_idx" ON "AgeRestrictedRecord"("shopId");

-- CreateIndex
CREATE INDEX "AgeRestrictedRecord_requestedAt_idx" ON "AgeRestrictedRecord"("requestedAt");

-- CreateIndex
CREATE INDEX "AgeRestrictedRecord_childGender_idx" ON "AgeRestrictedRecord"("childGender");

-- CreateIndex
CREATE INDEX "AgeRestrictedRecord_productCategory_idx" ON "AgeRestrictedRecord"("productCategory");

-- CreateIndex
CREATE INDEX "AgeRestrictedRecord_recordedBy_idx" ON "AgeRestrictedRecord"("recordedBy");

-- CreateIndex
CREATE INDEX "AgeRestrictedRecord_createdById_createdByType_idx" ON "AgeRestrictedRecord"("createdById", "createdByType");

-- AddForeignKey
ALTER TABLE "AgeRestrictedRecord" ADD CONSTRAINT "AgeRestrictedRecord_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;
