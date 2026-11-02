-- Additive rollout only. Message expiry is performed by the separately tested worker.
ALTER TABLE "ChatUpload"
  ADD COLUMN "storageProvider" TEXT,
  ADD COLUMN "storageKey" TEXT,
  ADD COLUMN "storageBucket" TEXT,
  ADD COLUMN "storageEndpoint" TEXT,
  ADD COLUMN "storageVersionId" TEXT,
  ADD COLUMN "contentType" TEXT,
  ADD COLUMN "pendingDeletion" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "MessageDelivery" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "messageId" TEXT NOT NULL,
  "userId" INTEGER NOT NULL,
  "userType" "UserType" NOT NULL,
  "deliveredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "MessageDelivery_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "MessageDelivery_messageId_userId_userType_key" ON "MessageDelivery"("messageId","userId","userType");
CREATE INDEX "MessageDelivery_userId_userType_idx" ON "MessageDelivery"("userId","userType");
CREATE INDEX "Message_createdAt_id_idx" ON "Message"("createdAt","id");
CREATE INDEX "Message_attachmentUrl_idx" ON "Message"("attachmentUrl");

CREATE TABLE "ChatRetentionRun" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "cutoff" TIMESTAMP(3) NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'RUNNING',
  "removed" INTEGER NOT NULL DEFAULT 0,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "lastError" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt" TIMESTAMP(3)
);
CREATE TABLE "ChatAttachmentDeletionJob" (
  "filename" TEXT NOT NULL PRIMARY KEY,
  "storageProvider" TEXT,
  "storageKey" TEXT,
  "storageBucket" TEXT,
  "storageEndpoint" TEXT,
  "storageVersionId" TEXT,
  "contentType" TEXT,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "lastError" TEXT,
  "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "ChatAttachmentDeletionJob_nextAttemptAt_idx" ON "ChatAttachmentDeletionJob"("nextAttemptAt");
