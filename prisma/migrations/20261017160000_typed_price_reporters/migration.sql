-- Keep every existing customer report, owner link and awarded earning unchanged.
-- Historical reports are not reattributed using ambiguous numeric IDs.
ALTER TABLE "PriceReport"
  ALTER COLUMN "reporterId" DROP NOT NULL,
  ADD COLUMN "reporterType" "UserType" NOT NULL DEFAULT 'CUSTOMER',
  ADD COLUMN "reporterEmployeeId" INTEGER,
  ADD COLUMN "reporterAdminId" INTEGER,
  ADD COLUMN "reviewedByEmployeeId" INTEGER;

ALTER TABLE "PriceReport"
  ADD CONSTRAINT "PriceReport_reporterEmployeeId_fkey" FOREIGN KEY ("reporterEmployeeId") REFERENCES "Empolyee"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "PriceReport_reporterAdminId_fkey" FOREIGN KEY ("reporterAdminId") REFERENCES "Admin"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "PriceReport_reviewedByEmployeeId_fkey" FOREIGN KEY ("reviewedByEmployeeId") REFERENCES "Empolyee"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "PriceReport_typed_reporter" CHECK (
    ("reporterType" = 'CUSTOMER' AND "reporterId" IS NOT NULL AND "reporterEmployeeId" IS NULL AND "reporterAdminId" IS NULL) OR
    ("reporterType" = 'EMPLOYEE' AND "reporterId" IS NULL AND "reporterEmployeeId" IS NOT NULL AND "reporterAdminId" IS NULL) OR
    ("reporterType" = 'ADMIN' AND "reporterId" IS NULL AND "reporterEmployeeId" IS NULL AND "reporterAdminId" IS NOT NULL)
  ),
  ADD CONSTRAINT "PriceReport_single_reviewer" CHECK ("reviewedBy" IS NULL OR "reviewedByEmployeeId" IS NULL);

CREATE INDEX "PriceReport_reporterEmployeeId_status_idx" ON "PriceReport"("reporterEmployeeId", "status");
CREATE INDEX "PriceReport_reporterAdminId_status_idx" ON "PriceReport"("reporterAdminId", "status");
