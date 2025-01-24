/*
  Warnings:

  - You are about to drop the `User` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropForeignKey
ALTER TABLE "ProductAtShop" DROP CONSTRAINT "ProductAtShop_userId_fkey";

-- DropTable
DROP TABLE "User";

-- CreateTable
CREATE TABLE "Customer" (
    "id" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "mobile" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "password" TEXT NOT NULL,

    CONSTRAINT "Customer_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Customer_mobile_key" ON "Customer"("mobile");

-- AddForeignKey
ALTER TABLE "ProductAtShop" ADD CONSTRAINT "ProductAtShop_userId_fkey" FOREIGN KEY ("userId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;
