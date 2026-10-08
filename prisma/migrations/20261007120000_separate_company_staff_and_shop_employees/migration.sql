-- Separate company staff from shop employees.
-- Schema only: existing employees are classified and mapped by
-- scripts/migrateEmployeeMemberships.js (dry-run by default).

-- CreateEnum
CREATE TYPE "MembershipStatus" AS ENUM ('INVITED', 'ACTIVE', 'INACTIVE', 'REMOVED');

-- CreateEnum
CREATE TYPE "CompanyStaffRole" AS ENUM ('STAFF', 'MANAGER');

-- CreateEnum
CREATE TYPE "ShopEmployeeRole" AS ENUM ('EMPLOYEE', 'MANAGER');

-- CreateEnum
CREATE TYPE "AccessReviewStatus" AS ENUM ('OPEN', 'RESOLVED');

-- AlterTable
ALTER TABLE "Empolyee" ADD COLUMN     "lastActiveAt" TIMESTAMP(3),
ADD COLUMN     "sessionVersion" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "CompanyStaffMembership" (
    "id" TEXT NOT NULL,
    "employeeId" INTEGER NOT NULL,
    "role" "CompanyStaffRole" NOT NULL DEFAULT 'STAFF',
    "permissions" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "status" "MembershipStatus" NOT NULL DEFAULT 'ACTIVE',
    "grantedByAdminId" INTEGER,
    "source" TEXT NOT NULL DEFAULT 'COMPANY_STAFF_FLOW',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deactivatedAt" TIMESTAMP(3),

    CONSTRAINT "CompanyStaffMembership_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShopEmployeeMembership" (
    "id" TEXT NOT NULL,
    "employeeId" INTEGER NOT NULL,
    "shopId" TEXT NOT NULL,
    "role" "ShopEmployeeRole" NOT NULL DEFAULT 'EMPLOYEE',
    "permissions" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "status" "MembershipStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdByCustomerId" INTEGER,
    "source" TEXT NOT NULL DEFAULT 'SHOP_OWNER_FLOW',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deactivatedAt" TIMESTAMP(3),
    "lastActiveAt" TIMESTAMP(3),

    CONSTRAINT "ShopEmployeeMembership_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmployeeAccessReview" (
    "id" TEXT NOT NULL,
    "employeeId" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "evidence" JSONB NOT NULL,
    "status" "AccessReviewStatus" NOT NULL DEFAULT 'OPEN',
    "resolution" TEXT,
    "resolutionNote" TEXT,
    "resolvedById" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "EmployeeAccessReview_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CompanyStaffMembership_employeeId_key" ON "CompanyStaffMembership"("employeeId");

-- CreateIndex
CREATE INDEX "CompanyStaffMembership_status_idx" ON "CompanyStaffMembership"("status");

-- CreateIndex
CREATE INDEX "ShopEmployeeMembership_shopId_status_idx" ON "ShopEmployeeMembership"("shopId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ShopEmployeeMembership_employeeId_shopId_key" ON "ShopEmployeeMembership"("employeeId", "shopId");

-- At most one ACTIVE shop membership per employee (not expressible in Prisma schema).
CREATE UNIQUE INDEX "ShopEmployeeMembership_one_active_per_employee" ON "ShopEmployeeMembership"("employeeId") WHERE "status" = 'ACTIVE';

-- CreateIndex
CREATE INDEX "EmployeeAccessReview_status_idx" ON "EmployeeAccessReview"("status");

-- CreateIndex
CREATE UNIQUE INDEX "EmployeeAccessReview_employeeId_reason_key" ON "EmployeeAccessReview"("employeeId", "reason");

-- AddForeignKey
ALTER TABLE "CompanyStaffMembership" ADD CONSTRAINT "CompanyStaffMembership_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Empolyee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CompanyStaffMembership" ADD CONSTRAINT "CompanyStaffMembership_grantedByAdminId_fkey" FOREIGN KEY ("grantedByAdminId") REFERENCES "Admin"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShopEmployeeMembership" ADD CONSTRAINT "ShopEmployeeMembership_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Empolyee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShopEmployeeMembership" ADD CONSTRAINT "ShopEmployeeMembership_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShopEmployeeMembership" ADD CONSTRAINT "ShopEmployeeMembership_createdByCustomerId_fkey" FOREIGN KEY ("createdByCustomerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmployeeAccessReview" ADD CONSTRAINT "EmployeeAccessReview_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Empolyee"("id") ON DELETE CASCADE ON UPDATE CASCADE;
