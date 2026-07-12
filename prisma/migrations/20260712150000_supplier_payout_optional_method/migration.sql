-- AlterTable: make paymentMethod nullable (no method needed when status is TO_PAY)
ALTER TABLE "SupplierPayoutRecord" ALTER COLUMN "paymentMethod" DROP NOT NULL;
