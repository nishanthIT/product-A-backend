-- CreateEnum
CREATE TYPE "CertificateType" AS ENUM ('INSPECTION', 'INSURANCE', 'ELECTRIC', 'HYGIENE');

-- CreateTable
CREATE TABLE "ShopCertificate" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "type" "CertificateType" NOT NULL,
    "imagePath" TEXT NOT NULL,
    "issuedDate" TIMESTAMP(3),
    "expiryDate" TIMESTAMP(3),
    "renewalDate" TIMESTAMP(3),
    "premiumAmount" DECIMAL(65,30),
    "companyDetails" TEXT,
    "unitRate" DECIMAL(65,30),
    "readingDateDay" TIMESTAMP(3),
    "readingDateNight" TIMESTAMP(3),
    "contractRenewalDate" TIMESTAMP(3),
    "reminderDays" INTEGER NOT NULL DEFAULT 7,
    "createdById" INTEGER NOT NULL,
    "createdByType" "UserType" NOT NULL,
    "updatedById" INTEGER,
    "updatedByType" "UserType",
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ShopCertificate_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ShopCertificate_shopId_idx" ON "ShopCertificate"("shopId");

-- CreateIndex
CREATE INDEX "ShopCertificate_type_idx" ON "ShopCertificate"("type");

-- CreateIndex
CREATE INDEX "ShopCertificate_renewalDate_idx" ON "ShopCertificate"("renewalDate");

-- CreateIndex
CREATE INDEX "ShopCertificate_expiryDate_idx" ON "ShopCertificate"("expiryDate");

-- CreateIndex
CREATE INDEX "ShopCertificate_contractRenewalDate_idx" ON "ShopCertificate"("contractRenewalDate");

-- AddForeignKey
ALTER TABLE "ShopCertificate" ADD CONSTRAINT "ShopCertificate_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;
