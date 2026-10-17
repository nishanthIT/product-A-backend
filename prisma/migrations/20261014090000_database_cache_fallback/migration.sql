-- New transient cache storage only; no existing application records are changed.
CREATE TABLE "CacheEntry" (
  "key" TEXT NOT NULL PRIMARY KEY,
  "type" TEXT NOT NULL,
  "value" JSONB NOT NULL,
  "revision" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3)
);
CREATE INDEX "CacheEntry_expiresAt_idx" ON "CacheEntry"("expiresAt");
