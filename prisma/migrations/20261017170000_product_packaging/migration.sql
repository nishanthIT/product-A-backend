-- Additive only: preserves every existing Product and all shop/stock/price relationships.
CREATE TABLE "ProductPackaging" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "caseBarcode" TEXT NOT NULL,
    "caseGtin" TEXT NOT NULL,
    "unitsPerCase" INTEGER NOT NULL,
    "packageSize" TEXT NOT NULL,
    "packageSizeKey" TEXT NOT NULL,
    "packing" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "sourceReferences" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ProductPackaging_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ProductPackaging_positive_quantity" CHECK ("unitsPerCase" > 0),
    CONSTRAINT "ProductPackaging_gtin_format" CHECK (
      "caseBarcode" ~ '^(\d{8}|\d{12}|\d{13}|\d{14})$'
      AND "caseGtin" ~ '^\d{14}$' AND "caseGtin" <> '00000000000000'
      AND "caseGtin" = lpad("caseBarcode", 14, '0')
    ),
    CONSTRAINT "ProductPackaging_gtin_checksum" CHECK ((
      3 * (substring("caseGtin",1,1)::int + substring("caseGtin",3,1)::int + substring("caseGtin",5,1)::int + substring("caseGtin",7,1)::int + substring("caseGtin",9,1)::int + substring("caseGtin",11,1)::int + substring("caseGtin",13,1)::int)
      + substring("caseGtin",2,1)::int + substring("caseGtin",4,1)::int + substring("caseGtin",6,1)::int + substring("caseGtin",8,1)::int + substring("caseGtin",10,1)::int + substring("caseGtin",12,1)::int + substring("caseGtin",14,1)::int
    ) % 10 = 0),
    CONSTRAINT "ProductPackaging_nonempty_size" CHECK (btrim("packageSize") <> '' AND btrim("packageSizeKey") <> '' AND btrim("packing") <> ''),
    CONSTRAINT "ProductPackaging_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "ProductPackaging_caseGtin_key" ON "ProductPackaging"("caseGtin");
CREATE INDEX "ProductPackaging_productId_idx" ON "ProductPackaging"("productId");
CREATE INDEX "ProductPackaging_caseBarcode_idx" ON "ProductPackaging"("caseBarcode");
