-- Add provenance without modifying/recreating any existing list or item.
-- Deliberately nullable: historical origins cannot be inferred safely.
ALTER TABLE "ListProduct" ADD COLUMN "outOfStockSourceListId" TEXT;
