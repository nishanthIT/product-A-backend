-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "mobile" TEXT NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Product" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "productUrl" TEXT NOT NULL,
    "caseSize" TEXT NOT NULL,
    "packetSize" TEXT NOT NULL,
    "img" TEXT NOT NULL,
    "barcode" INTEGER NOT NULL,

    CONSTRAINT "Product_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Shop" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "mobile" TEXT NOT NULL,

    CONSTRAINT "Shop_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductAtShop" (
    "id" TEXT NOT NULL,
    "price" INTEGER NOT NULL,
    "shopId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,

    CONSTRAINT "ProductAtShop_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_mobile_key" ON "User"("mobile");

-- CreateIndex
CREATE UNIQUE INDEX "Product_barcode_key" ON "Product"("barcode");

-- CreateIndex
CREATE UNIQUE INDEX "Shop_mobile_key" ON "Shop"("mobile");

-- CreateIndex
CREATE UNIQUE INDEX "ProductAtShop_shopId_productId_key" ON "ProductAtShop"("shopId", "productId");

-- AddForeignKey
ALTER TABLE "ProductAtShop" ADD CONSTRAINT "ProductAtShop_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductAtShop" ADD CONSTRAINT "ProductAtShop_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;
