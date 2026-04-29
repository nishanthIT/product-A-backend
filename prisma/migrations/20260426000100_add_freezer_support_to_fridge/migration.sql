-- CreateEnum
CREATE TYPE "CompartmentType" AS ENUM ('FRIDGE', 'FREEZER');

-- AlterTable
ALTER TABLE "Fridge"
ADD COLUMN "hasFreezer" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "freezerTargetTemp" DECIMAL(65,30),
ADD COLUMN "freezerMinSafeTemp" DECIMAL(65,30),
ADD COLUMN "freezerMaxSafeTemp" DECIMAL(65,30);

-- AlterTable
ALTER TABLE "FridgeTemperatureLog"
ADD COLUMN "compartment" "CompartmentType" NOT NULL DEFAULT 'FRIDGE';
