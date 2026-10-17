CREATE TABLE "ChatUpload" ("filename" TEXT NOT NULL PRIMARY KEY, "uploaderId" INTEGER NOT NULL, "uploaderType" "UserType" NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE INDEX "ChatUpload_uploaderId_uploaderType_idx" ON "ChatUpload"("uploaderId", "uploaderType");
