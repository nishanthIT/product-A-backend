-- CreateEnum
CREATE TYPE "IncidentSeverity" AS ENUM ('LOW', 'MEDIUM', 'HIGH');

-- CreateTable
CREATE TABLE "IncidentLog" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "incidentAt" TIMESTAMP(3) NOT NULL,
    "description" TEXT NOT NULL,
    "severity" "IncidentSeverity" NOT NULL DEFAULT 'MEDIUM',
    "createdById" INTEGER NOT NULL,
    "createdByType" "UserType" NOT NULL,
    "updatedById" INTEGER,
    "updatedByType" "UserType",
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IncidentLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "IncidentLog_shopId_idx" ON "IncidentLog"("shopId");

-- CreateIndex
CREATE INDEX "IncidentLog_incidentAt_idx" ON "IncidentLog"("incidentAt");

-- CreateIndex
CREATE INDEX "IncidentLog_severity_idx" ON "IncidentLog"("severity");

-- CreateIndex
CREATE INDEX "IncidentLog_createdById_createdByType_idx" ON "IncidentLog"("createdById", "createdByType");

-- AddForeignKey
ALTER TABLE "IncidentLog" ADD CONSTRAINT "IncidentLog_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;
