/*
  Warnings:

  - A unique constraint covering the columns `[email]` on the table `Empolyee` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[phoneNo]` on the table `Empolyee` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateIndex
CREATE INDEX "ActionLog_employeeId_timestamp_idx" ON "ActionLog"("employeeId", "timestamp");

-- CreateIndex
CREATE INDEX "ActionLog_shopId_timestamp_idx" ON "ActionLog"("shopId", "timestamp");

-- CreateIndex
CREATE INDEX "ActionLog_productId_timestamp_idx" ON "ActionLog"("productId", "timestamp");

-- CreateIndex
CREATE UNIQUE INDEX "Empolyee_email_key" ON "Empolyee"("email");

-- CreateIndex
CREATE UNIQUE INDEX "Empolyee_phoneNo_key" ON "Empolyee"("phoneNo");

-- AddForeignKey
ALTER TABLE "ActionLog" ADD CONSTRAINT "ActionLog_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActionLog" ADD CONSTRAINT "ActionLog_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActionLog" ADD CONSTRAINT "ActionLog_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Empolyee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
