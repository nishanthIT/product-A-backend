-- Add electric bill reading values (day/night)
ALTER TABLE "ShopCertificate"
ADD COLUMN "readingValueDay" DECIMAL(65,30),
ADD COLUMN "readingValueNight" DECIMAL(65,30);
