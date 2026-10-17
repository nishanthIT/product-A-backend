ALTER TABLE "Admin" ADD COLUMN "sessionVersion" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Customer" ADD COLUMN "sessionVersion" INTEGER NOT NULL DEFAULT 0;
CREATE TABLE "RevokedSession" ("tokenHash" TEXT NOT NULL PRIMARY KEY, "expiresAt" TIMESTAMP(3) NOT NULL);
CREATE INDEX "RevokedSession_expiresAt_idx" ON "RevokedSession"("expiresAt");
