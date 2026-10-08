-- CreateTable
CREATE TABLE "AgeRestrictionRecord" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "description" TEXT NOT NULL,
    "imageUrl" TEXT,
    "createdById" INTEGER NOT NULL,
    "createdByType" "UserType" NOT NULL,
    "updatedById" INTEGER,
    "updatedByType" "UserType",
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgeRestrictionRecord_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AgeRestrictionRecord_shopId_occurredAt_idx" ON "AgeRestrictionRecord"("shopId", "occurredAt");

-- CreateIndex
CREATE INDEX "AgeRestrictionRecord_createdById_createdByType_idx" ON "AgeRestrictionRecord"("createdById", "createdByType");

-- AddForeignKey
ALTER TABLE "AgeRestrictionRecord" ADD CONSTRAINT "AgeRestrictionRecord_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;
