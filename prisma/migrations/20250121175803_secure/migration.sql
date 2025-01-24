/*
  Warnings:

  - A unique constraint covering the columns `[email]` on the table `Customer` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateEnum
CREATE TYPE "UserType" AS ENUM ('ADMIN', 'CUSTOMER', 'EMPLOYEE');

-- DropForeignKey
ALTER TABLE "ProductAtShop" DROP CONSTRAINT "ProductAtShop_listId_fkey";

-- DropIndex
DROP INDEX "Shop_mobile_key";

-- AlterTable
ALTER TABLE "Admin" ADD COLUMN     "userType" "UserType" NOT NULL DEFAULT 'ADMIN';

-- AlterTable
ALTER TABLE "Customer" ADD COLUMN     "userType" "UserType" NOT NULL DEFAULT 'CUSTOMER';

-- AlterTable
ALTER TABLE "Empolyee" ADD COLUMN     "userType" "UserType" NOT NULL DEFAULT 'EMPLOYEE';

-- CreateIndex
CREATE UNIQUE INDEX "Customer_email_key" ON "Customer"("email");
