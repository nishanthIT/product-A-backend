ALTER TABLE "Task" ALTER COLUMN "createdById" DROP NOT NULL;
ALTER TABLE "Task" DROP CONSTRAINT "Task_createdById_fkey";
ALTER TABLE "Task" ADD CONSTRAINT "Task_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE TABLE "AccountDeletionJob" ("id" TEXT NOT NULL PRIMARY KEY, "userId" INTEGER NOT NULL, "userType" "UserType" NOT NULL, "receiptHash" TEXT NOT NULL, "status" TEXT NOT NULL DEFAULT 'REQUESTED', "attempts" INTEGER NOT NULL DEFAULT 0, "filePaths" JSONB NOT NULL DEFAULT '[]', "reviewEvidence" JSONB, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL, "completedAt" TIMESTAMP(3));
CREATE UNIQUE INDEX "AccountDeletionJob_receiptHash_key" ON "AccountDeletionJob"("receiptHash");
CREATE UNIQUE INDEX "AccountDeletionJob_userId_userType_key" ON "AccountDeletionJob"("userId", "userType");
CREATE INDEX "AccountDeletionJob_status_createdAt_idx" ON "AccountDeletionJob"("status", "createdAt");
