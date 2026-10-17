-- Preserve all existing records; category and product are independently optional.
ALTER TABLE "AgeRestrictedRecord"
  ALTER COLUMN "productCategory" DROP NOT NULL,
  ALTER COLUMN "productName" DROP NOT NULL;

ALTER TABLE "AgeRestrictionRecord"
  ADD COLUMN "productCategory" TEXT,
  ADD COLUMN "productName" TEXT;
