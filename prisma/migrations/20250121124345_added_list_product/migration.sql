-- CreateTable
CREATE TABLE "ListProduct" (
    "id" TEXT NOT NULL,
    "listId" TEXT NOT NULL,
    "productAtShopId" TEXT NOT NULL,

    CONSTRAINT "ListProduct_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "ListProduct" ADD CONSTRAINT "ListProduct_listId_fkey" FOREIGN KEY ("listId") REFERENCES "List"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ListProduct" ADD CONSTRAINT "ListProduct_productAtShopId_fkey" FOREIGN KEY ("productAtShopId") REFERENCES "ProductAtShop"("id") ON DELETE CASCADE ON UPDATE CASCADE;
