ALTER TABLE "ContentReport" ADD COLUMN "evidence" JSONB, ADD COLUMN "evidenceFile" TEXT;
CREATE TABLE "ChatSuspension" (
  "id" TEXT NOT NULL PRIMARY KEY, "userId" INTEGER NOT NULL, "userType" "UserType" NOT NULL,
  "until" TIMESTAMP(3) NOT NULL, "reason" TEXT NOT NULL, "moderatorId" INTEGER, "updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE UNIQUE INDEX "ChatSuspension_userId_userType_key" ON "ChatSuspension"("userId", "userType");
CREATE INDEX "ChatSuspension_until_idx" ON "ChatSuspension"("until");
CREATE TABLE "ChatModerationAction" (
  "id" TEXT NOT NULL PRIMARY KEY, "userId" INTEGER NOT NULL, "userType" "UserType" NOT NULL,
  "moderatorId" INTEGER, "action" TEXT NOT NULL, "reason" TEXT NOT NULL,
  "until" TIMESTAMP(3), "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "ChatModerationAction_userId_userType_createdAt_idx" ON "ChatModerationAction"("userId", "userType", "createdAt");
