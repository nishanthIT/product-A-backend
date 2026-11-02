-- Additive security controls: no existing business/account rows are changed.
CREATE TABLE "SecurityEvent" (
  "id" TEXT NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "subjectKey" TEXT, "userId" INTEGER, "userType" TEXT, "username" TEXT, "shopId" TEXT,
  "sourceIp" TEXT, "ipHash" TEXT, "sessionHash" TEXT, "endpoint" TEXT NOT NULL,
  "method" TEXT NOT NULL, "userAgent" TEXT NOT NULL, "category" TEXT NOT NULL,
  "severity" TEXT NOT NULL, "rule" TEXT NOT NULL, "reason" TEXT NOT NULL,
  "action" TEXT NOT NULL, "evidence" JSONB NOT NULL, "riskScore" INTEGER NOT NULL DEFAULT 0,
  "restrictionId" TEXT, "status" TEXT NOT NULL DEFAULT 'OPEN', "reviewedBy" INTEGER,
  "reviewedAt" TIMESTAMP(3), CONSTRAINT "SecurityEvent_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "SecurityEvent_score" CHECK ("riskScore" BETWEEN 0 AND 100),
  CONSTRAINT "SecurityEvent_status" CHECK ("status" IN ('OPEN','REVIEWED','RESOLVED'))
);
CREATE INDEX "SecurityEvent_createdAt_idx" ON "SecurityEvent"("createdAt");
CREATE INDEX "SecurityEvent_subjectKey_createdAt_idx" ON "SecurityEvent"("subjectKey","createdAt");
CREATE INDEX "SecurityEvent_ipHash_createdAt_idx" ON "SecurityEvent"("ipHash","createdAt");
CREATE INDEX "SecurityEvent_category_severity_createdAt_idx" ON "SecurityEvent"("category","severity","createdAt");
CREATE INDEX "SecurityEvent_status_createdAt_idx" ON "SecurityEvent"("status","createdAt");
CREATE TABLE "SecurityRestriction" (
  "id" TEXT NOT NULL, "subjectKey" TEXT NOT NULL, "scope" TEXT NOT NULL,
  "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "until" TIMESTAMP(3) NOT NULL,
  "liftedAt" TIMESTAMP(3), "reason" TEXT NOT NULL, "source" TEXT NOT NULL, "createdBy" INTEGER, "enforcementCount" INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT "SecurityRestriction_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "SecurityRestriction_scope" CHECK ("scope" IN ('account','catalogue','auth','upload'))
);
CREATE UNIQUE INDEX "SecurityRestriction_subjectKey_scope_key" ON "SecurityRestriction"("subjectKey","scope");
CREATE INDEX "SecurityRestriction_until_idx" ON "SecurityRestriction"("until");
CREATE TABLE "SecurityException" (
  "id" TEXT NOT NULL, "subjectKey" TEXT NOT NULL, "scope" TEXT NOT NULL,
  "until" TIMESTAMP(3) NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "liftedAt" TIMESTAMP(3), "createdBy" INTEGER NOT NULL, "reason" TEXT NOT NULL,
  CONSTRAINT "SecurityException_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "SecurityException_scope" CHECK ("scope" IN ('catalogue','upload'))
);
CREATE INDEX "SecurityException_subjectKey_scope_until_idx" ON "SecurityException"("subjectKey","scope","until");
CREATE TABLE "SecurityPolicy" (
  "id" TEXT NOT NULL DEFAULT 'default', "values" JSONB NOT NULL,
  "updatedAt" TIMESTAMP(3) NOT NULL, "updatedBy" INTEGER NOT NULL,
  CONSTRAINT "SecurityPolicy_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "SecurityAdminAudit" (
  "sequence" SERIAL NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "adminId" INTEGER NOT NULL, "action" TEXT NOT NULL, "reason" TEXT NOT NULL,
  "details" JSONB NOT NULL, "sourceIp" TEXT, "previousHash" TEXT NOT NULL, "hash" TEXT NOT NULL,
  CONSTRAINT "SecurityAdminAudit_pkey" PRIMARY KEY ("sequence")
);
CREATE INDEX "SecurityAdminAudit_createdAt_idx" ON "SecurityAdminAudit"("createdAt");
CREATE FUNCTION paymi_security_audit_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Security administrative audit records are append-only'; END $$;
CREATE TRIGGER security_audit_append_only BEFORE UPDATE OR DELETE ON "SecurityAdminAudit"
FOR EACH ROW EXECUTE FUNCTION paymi_security_audit_append_only();

CREATE TRIGGER security_audit_no_truncate BEFORE TRUNCATE ON "SecurityAdminAudit"
FOR EACH STATEMENT EXECUTE FUNCTION paymi_security_audit_append_only();
