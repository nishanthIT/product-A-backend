-- Add in-hand stock tracking to ProductAtShop
ALTER TABLE "ProductAtShop" ADD COLUMN IF NOT EXISTS "inHandStock" INTEGER;

-- Add urgent flag to ListProduct
ALTER TABLE "ListProduct" ADD COLUMN IF NOT EXISTS "isUrgent" BOOLEAN NOT NULL DEFAULT false;
