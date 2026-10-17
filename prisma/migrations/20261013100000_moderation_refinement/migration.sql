-- Additive refinement: preserves accounts, legacy acceptance records, reports and evidence.
ALTER TABLE "ContentReport" ADD COLUMN "explanation" TEXT, ADD COLUMN "reportedUserId" INTEGER,
 ADD COLUMN "reportedUserType" "UserType", ADD COLUMN "chatId" TEXT;
UPDATE "ContentReport" r SET "reportedUserId" = m."senderId", "reportedUserType" = m."senderType", "chatId" = m."chatId" FROM "Message" m WHERE r."messageId" = m.id;
UPDATE "ContentReport" SET "reportedUserId" = COALESCE("reportedUserId", ("evidence"->>'senderId')::INTEGER),
 "reportedUserType" = COALESCE("reportedUserType", ("evidence"->>'senderType')::"UserType"), "chatId" = COALESCE("chatId", "evidence"->>'chatId') WHERE "evidence" IS NOT NULL;
UPDATE "ContentReport" SET status = CASE status WHEN 'OPEN' THEN 'PENDING' WHEN 'REMOVE' THEN 'RESOLVED' WHEN 'NO_VIOLATION' THEN 'DISMISSED' ELSE status END;
ALTER TABLE "ContentReport" ALTER COLUMN status SET DEFAULT 'PENDING';
ALTER TABLE "ChatSuspension" ADD COLUMN scope TEXT NOT NULL DEFAULT 'CHAT', ADD COLUMN "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
DROP INDEX "ChatSuspension_userId_userType_key";
CREATE UNIQUE INDEX "ChatSuspension_userId_userType_scope_key" ON "ChatSuspension"("userId", "userType", scope);
ALTER TABLE "ChatSuspension" ADD CONSTRAINT "ChatSuspension_scope_check" CHECK (scope IN ('CHAT','ACCOUNT'));
ALTER TABLE "ChatModerationAction" ADD COLUMN "reportId" TEXT REFERENCES "ContentReport"(id) ON DELETE SET NULL;
CREATE TABLE "ModerationDeletionJob" (
 id TEXT PRIMARY KEY, "userId" INTEGER NOT NULL, "userType" "UserType" NOT NULL, "moderatorId" INTEGER,
 reason TEXT NOT NULL, cutoff TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, status TEXT NOT NULL DEFAULT 'PENDING',
 removed INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0, "lastError" TEXT, "updatedAt" TIMESTAMP(3) NOT NULL, "completedAt" TIMESTAMP(3)
);
CREATE INDEX "ModerationDeletionJob_status_updatedAt_idx" ON "ModerationDeletionJob"(status, "updatedAt");
CREATE INDEX "Message_sender_moderation_idx" ON "Message"("senderType", "senderId", "createdAt") WHERE "deletedAt" IS NULL;
ALTER TABLE "ContentReport" ADD CONSTRAINT "ContentReport_chatId_fkey" FOREIGN KEY ("chatId") REFERENCES "Chat"(id) ON DELETE SET NULL ON UPDATE CASCADE;
