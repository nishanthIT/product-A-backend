-- AddProductCategory
-- Add category field to Product table
ALTER TABLE "Product" ADD COLUMN IF NOT EXISTS "category" TEXT;

-- Create Category table
CREATE TABLE IF NOT EXISTS "Category" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Category_pkey" PRIMARY KEY ("id")
);

-- Create unique index on Category name
CREATE UNIQUE INDEX IF NOT EXISTS "Category_name_key" ON "Category"("name");
