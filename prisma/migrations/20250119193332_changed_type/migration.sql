-- AlterTable
CREATE SEQUENCE customer_id_seq;
ALTER TABLE "Customer" ALTER COLUMN "id" SET DEFAULT nextval('customer_id_seq');
ALTER SEQUENCE customer_id_seq OWNED BY "Customer"."id";

-- AlterTable
ALTER TABLE "ProductAtShop" ALTER COLUMN "price" SET DATA TYPE DECIMAL(65,30);
