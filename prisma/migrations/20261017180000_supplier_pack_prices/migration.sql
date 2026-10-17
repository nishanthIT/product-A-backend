-- Additive: existing supplier IDs, prices, tiers and stock are retained.
ALTER TABLE "ProductAtShop"
  ADD COLUMN "packagingId" TEXT,
  ADD COLUMN "unitsPerPack" INTEGER,
  ADD COLUMN "pricedUnitSize" TEXT,
  ADD COLUMN "sourcePricing" JSONB,
  ADD COLUMN "priceObservedAt" TIMESTAMP(3),
  ADD COLUMN "offerPriceSource" TEXT,
  ADD CONSTRAINT "ProductAtShop_unitsPerPack_positive" CHECK ("unitsPerPack" > 0),
  ADD CONSTRAINT "ProductAtShop_offerPriceSource_supported" CHECK ("offerPriceSource" IS NULL OR "offerPriceSource" = 'DHAMECHA_CURRENT'),
  ADD CONSTRAINT "ProductAtShop_packagingId_fkey" FOREIGN KEY ("packagingId") REFERENCES "ProductPackaging"(id) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PriceTier"
  ADD COLUMN "packagingId" TEXT,
  ADD COLUMN "sourcePricing" JSONB,
  ADD COLUMN "priceObservedAt" TIMESTAMP(3),
  ADD CONSTRAINT "PriceTier_packagingId_fkey" FOREIGN KEY ("packagingId") REFERENCES "ProductPackaging"(id) ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "ProductAtShop_packagingId_idx" ON "ProductAtShop"("packagingId");
CREATE INDEX "PriceTier_packagingId_idx" ON "PriceTier"("packagingId");
