-- Migration to add quantity field to ListProduct table
-- Run this manually or through Prisma migration

-- Add quantity column with default value of 1
ALTER TABLE "ListProduct" ADD COLUMN "quantity" INTEGER DEFAULT 1;

-- Update any existing records to have quantity 1 if they don't already have it
UPDATE "ListProduct" SET "quantity" = 1 WHERE "quantity" IS NULL;

-- Make the column NOT NULL after setting defaults
ALTER TABLE "ListProduct" ALTER COLUMN "quantity" SET NOT NULL;