-- Keep all existing GTIN validation and ownership constraints. A verified case
-- quantity/size need not have an exposed outer barcode; never invent one.
ALTER TABLE "ProductPackaging"
  ALTER COLUMN "caseBarcode" DROP NOT NULL,
  ALTER COLUMN "caseGtin" DROP NOT NULL,
  ADD CONSTRAINT "ProductPackaging_barcode_pair" CHECK (
    ("caseBarcode" IS NULL) = ("caseGtin" IS NULL)
  );
CREATE UNIQUE INDEX "ProductPackaging_unbarcoded_configuration_key"
  ON "ProductPackaging" ("productId", "unitsPerCase", "packageSizeKey")
  WHERE "caseGtin" IS NULL;
