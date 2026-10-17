CREATE TABLE "UserBlock" (
 "id" TEXT NOT NULL, "userId" INTEGER NOT NULL, "userType" "UserType" NOT NULL,
 "blockedId" INTEGER NOT NULL, "blockedType" "UserType" NOT NULL,
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "UserBlock_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "UserBlock_userId_userType_blockedId_blockedType_key" ON "UserBlock"("userId", "userType", "blockedId", "blockedType");
CREATE INDEX "UserBlock_blockedId_blockedType_idx" ON "UserBlock"("blockedId", "blockedType");
CREATE TABLE "CommunityAcceptance" (
 "userId" INTEGER NOT NULL, "userType" "UserType" NOT NULL, "version" TEXT NOT NULL,
 "acceptedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "CommunityAcceptance_pkey" PRIMARY KEY ("userId", "userType")
);
CREATE TABLE "ContentReport" (
 "id" TEXT NOT NULL, "messageId" TEXT, "reporterId" INTEGER, "reporterType" "UserType" NOT NULL,
 "reason" TEXT NOT NULL, "status" TEXT NOT NULL DEFAULT 'OPEN',
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "resolvedAt" TIMESTAMP(3),
 "moderatorId" INTEGER, "resolutionNote" TEXT,
 CONSTRAINT "ContentReport_pkey" PRIMARY KEY ("id"),
 CONSTRAINT "ContentReport_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE INDEX "ContentReport_status_createdAt_idx" ON "ContentReport"("status", "createdAt");
CREATE INDEX "ContentReport_reporterId_reporterType_idx" ON "ContentReport"("reporterId", "reporterType");
