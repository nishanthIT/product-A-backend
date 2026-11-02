# Security rollout and operations

Verified locally on 29 October 2026. These are deployment instructions, not a record of a production deployment. The source audit, findings and remaining risks are in [the workspace report](../../security.md); machine-readable results are in [verification.json](evidence/security/verification.json).

## Release prerequisites

1. Rotate the exposed database, JWT and mail credentials identified by the redacted history scan. Review provider access logs and invalidate sessions signed with the old JWT key. Do not put credentials in terminal transcripts, tickets, Git or generated reports. Use the deployment secret manager. Repository cleanup does not revoke credentials.
2. Review existing customer password records privately. Older administrative customer writes could store plaintext. Identify affected rows without selecting or logging their password values, invalidate their sessions/reset proofs, and arrange forced resets. Preserve evidence under restricted access; do not bulk hash unknown legacy values or email passwords to customers.
3. Resolve or explicitly assess the remaining dependency advisories and the admin's pre-existing TypeScript errors. Current audit results are release blockers, not ignored CI findings. Align Prisma CLI/client versions in the release environment, regenerate, and rerun tests; this checkout still has the pre-existing CLI/client version mismatch.
4. Rehearse on an isolated restore with test mail/storage providers. This workspace contains unrelated pre-existing changes and migrations. Review the release diff and **all pending migrations**, including the earlier chat/ownership work, before applying anything to production.
5. Take and verify a recoverable database/storage backup, preserve the deletion-ledger restore process, and define an operator rollback window. Runtime credentials must not be the database owner or migration owner.

## Configuration

Start from [`.env.example`](../.env.example), replacing every placeholder. Retain the deployment's existing chat storage, retention, realtime and mail configuration. Node 24.19.0 was used for verification.

| Setting | Required behavior |
|---|---|
| `NODE_ENV` | `production` on every live replica. |
| `JWT_SECRET` | Independent random secret of at least 32 bytes. Rotate exposed signing material and require sign-in again. Never use example/test values. |
| `SECURITY_AUDIT_KEY` | A different random secret of at least 32 bytes, shared by every replica. Back up in restricted secret storage. Changing it breaks verification of existing audit rows; see audit operations below. |
| `JWT_ISSUER`, `JWT_AUDIENCE` | Consistent on all replicas; defaults are `paymi-api` and `paymi-app`. |
| `JWT_REQUIRE_ISSUER_AUDIENCE` | Set `true` for this credential-rotation rollout. Without it, legacy tokens lacking those claims may finish their existing lifetime; new tokens always include both claims. |
| `DATABASE_URL` | Same authoritative PostgreSQL database on every replica, using a restricted runtime role and verified TLS on remote connections. No read replica or independent database for quota/session writes. |
| `REDIS_URL` | Private, authenticated Redis; use `rediss://` where the provider supports TLS. Restrict network access and keep it inaccessible from the public Internet. |
| `PUBLIC_BASE_URL` | Canonical HTTPS API URL, with the expected public host. |
| `CORS_ALLOWED_ORIGINS` | Comma-separated exact browser origins, including scheme and port. No wildcards, paths or trailing slash. Include the admin and web application origins. |
| `TRUSTED_PROXY_CIDRS` | Exact ingress proxy IPs/CIDRs. Empty means no proxy trust. Do not use hop counts or ranges that include untrusted clients. |
| `HOST`, `PORT` | Bind to the intended private interface/container; expose only through the approved ingress. |
| Mail settings | Preserve the configuration consumed by the existing transport, with newly rotated credentials. Test delivery using a non-production mailbox first. |

The admin stores bearer tokens in memory and relies on the HttpOnly, Secure, SameSite=Lax cookie to restore a session after reload. Host the admin and API on the same HTTPS site (for example, sibling subdomains). Test the actual domain arrangement. A truly cross-site deployment may lose reload authentication; do not change the cookie policy without a separate CSRF review. Native clients continue using bearer tokens.

The reverse proxy must replace client-supplied forwarding headers and prevent direct public access to the origin. Verify the resulting `req.ip` and HTTPS detection using a controlled staging request; forged `X-Forwarded-For` must not change the client identity. Set ingress request/header/body limits consistent with real upload workflows. Configure browser security headers/CSP at the **admin static host** as well; API headers do not cover a separately hosted frontend.

## Database preparation and migration

The new migration is [`20261027130000_central_security_protection`](../prisma/migrations/20261027130000_central_security_protection/migration.sql). It adds `SecurityEvent`, `SecurityRestriction`, `SecurityException`, `SecurityPolicy` and `SecurityAdminAudit`. It does not modify existing business/account rows. It also creates two triggers rejecting audit UPDATE/DELETE and TRUNCATE. Prisma `db push` alone does **not** install these SQL protections.

Use the migration-owner connection only in the release job. With the approved deployment environment injected, the normal release sequence is:

```sh
npm ci --ignore-scripts
npx prisma generate
npx prisma migrate status
# Review pending migration names and rehearse the complete chain before proceeding.
npx prisma migrate deploy
```

These commands were not run against production. If the migration ledger differs from the live schema, stop and reconcile it from the rehearsed backup. Do not use `db push --force-reset`, `migrate reset`, `--accept-data-loss`, or blindly mark migrations applied on a live database. The security migration itself was executed in an isolated PostgreSQL schema by the test suite, including all three audit mutation-denial checks; that does not validate a specific production migration history.

Grant the runtime role SELECT/INSERT/UPDATE/DELETE on the four mutable security tables, SELECT/INSERT on `SecurityAdminAudit`, and USAGE/SELECT on its sequence, together with its existing business/cache permissions. Revoke audit UPDATE/DELETE/TRUNCATE and schema CREATE privileges. The runtime role must not own these tables, be a superuser, inherit the migration owner, disable triggers, or change `session_replication_role`. PostgreSQL transaction advisory locks are needed by `CacheEntry` and the audit writer. Rehearse these grants with the actual runtime role, not the owner used by the local test harness.

Verify the SQL protections after migration using a read-only query:

```sql
SELECT tgname, tgenabled
FROM pg_trigger
WHERE tgrelid = '"SecurityAdminAudit"'::regclass AND NOT tgisinternal;
```

Expect `security_audit_append_only` and `security_audit_no_truncate`, both enabled. Startup schema verification checks table/column availability; it does not prove runtime least privileges or trigger presence.

Set per-role database statement, lock and idle-transaction timeouts appropriate to measured legitimate workloads, with bounded connection pools across **all** replicas. A starting staging profile can use a 20-second statement timeout and 5-second lock timeout, then tune using imports and ordinary traffic. Apply different limits to offline maintenance where necessary. HTTP timeouts cannot cancel already-running database work. Do not assume the 30-second application deadline bounds database resource consumption.

## Deployment order and verification

1. Complete the prerequisites, backup and migration rehearsal. Coordinate key rotation across replicas and drain old replicas so they cannot continue accepting old sessions.
2. Apply the approved additive migration with the migration role. Start one backend replica with the runtime role and required configuration; allow no traffic until dependency startup succeeds.
3. Verify `/api/health` returns only a minimal healthy response, protected catalogue and `/api/admin/security/overview` requests return 401 without credentials, untrusted browser write origins return 403, and API responses include no-store/nosniff/frame restrictions. HTTPS ingress must add HSTS through correct secure-request detection. Local production-mode evidence: [startup-smoke.json](evidence/security/startup-smoke.json).
4. Using seeded staging accounts, test login/reload/logout, OTP delivery and single-use reset, old-session rejection, customer/shop isolation, company permissions, catalogue searches/barcodes/comparisons, paged selection/transfers, product photos/documents, and private uploads. Test real devices and photo formats including HEIC before releasing mobile changes.
5. Sign in as an Admin, open `/security`, confirm events and private realtime refresh, and complete password confirmation. Block/unblock a **staging** account with a reason, change its duration, revoke its sessions, add a note, verify an expiring exception, and check audit integrity. Confirm ordinary accounts cannot call the same API directly. Platform-admin restriction/session recovery requires the operator process.
6. Exercise two backend replicas against the same database/Redis. Verify shared budgets, temporary restrictions and immediate unblock propagation. Disconnect test Redis and confirm counters remain enforced by PostgreSQL. A database failure must deny protected access, not switch to an in-memory allowance.
7. Measure legitimate traffic under realistic remote-database latency, office/shared-IP concurrency, imports and price comparisons. PostgreSQL is authoritative for every quota and can become a throughput bottleneck; local passing tests are not capacity evidence. Tune bounded policies using the dashboard and monitor the result before expanding traffic.
8. Deploy the admin build after the API. Release the mobile validation changes after its workflows pass. Run hosted CI/CodeQL and authenticated staging DAST; those remote checks have not run in this workspace.

All security integration tests are destructive to their **disposable local test database** and enforce a localhost database name containing `test`. For repeat verification, set `DOTENV_CONFIG_PATH=/dev/null`, `NODE_ENV=test`, `TEST_DATABASE_URL` and `DATABASE_URL` to that disposable database, provide fixture-only signing/audit keys and test Redis, and run `npm test`. Never point these tests at a live or shared staging database containing valuable data. Evidence contains 345 passing backend tests, the separately enabled latency scenario, and a final 12-test auth/upload/realtime regression after dependency/import changes.

## Policies, monitoring and incident response

Policy values persist in PostgreSQL and are edited through the Admin-only Security Center, with password reauthentication valid for ten minutes and a mandatory reason. Server-side bounds reject unsafe policy values. Default account/session/IP request budgets are 300/240/1,800 per minute; catalogue 120/minute; uploads 120/hour; distinct products 1,200/hour and 4,000/day; supplier-price records 6,000/hour; distinct searches/pages 300/120 per hour; concurrency 12; JSON responses 8 MiB; application deadline 30 seconds. Company catalogue staff receive the bounded catalogue multiplier of eight. These values are operational configuration, not customer-facing details.

Repeated account violations progress from 429/Retry-After to temporary scope restrictions, initially four hours and bounded at 24 hours for repeated automated enforcement. Shared-IP budget violations do not automatically suspend accounts. Exceptions are scoped and expire; they do not bypass tenant authorization or manual restrictions. Use a documented investigation reason for any manual unblock or exception. Do not remove all protection to accommodate a bulk integration.

Monitor request latency, 401/403/429/503 rates, PostgreSQL connections/lock waits, cache-table growth, security event write failures, active restrictions, unusual distinct-record retrieval, Redis health and admin action volume. Existing event notifications use the authenticated admin Socket.IO room with polling fallback; external pager/email integration is not configured. Assign an operator to review high/critical events and repeated false positives.

During an incident, preserve redacted event IDs, time range, account/session hashes, related events and audit anchors. Restrict the narrowest justified account/scope, revoke compromised sessions, and investigate before extending an IP restriction that may affect a shared office. Review expiry and legitimate access after mitigation. Use the existing admin notes/review/resolution tools to record the outcome.

## Audit integrity, retention and key custody

Administrative actions are serialized into a canonical HMAC chain under `SECURITY_AUDIT_KEY`. The Admin-only `GET /api/admin/security/audit/integrity` endpoint returns the verified terminal sequence/hash. Export that anchor, time and release identity to separately controlled append-only storage on an operational schedule. The export is an operator responsibility, not an installed automated job. A privileged database owner can disable triggers or remove the tail; an independent anchor is needed to detect that case. HMAC is tamper evidence, not a signature that remains trustworthy after the application and its key are both compromised.

Keep the audit key stable across releases and back it up independently of JWT credentials. The current format has no per-row key version, so **do not rotate it blindly**: earlier rows would stop verifying. Rotation needs a rehearsed versioned-key/archive migration, preservation of the old verification key, and external anchoring; that migration is not implemented. JWT rotation does not require changing this independent audit key.

Security events default to 90-day retention (bounded policy range 7–365 days) and are pruned hourly. Administrative audit rows are retained; implement restricted archival/retention operations before storage growth requires them. Events contain source IP/user agent and account identifiers; restrict dashboard/database/backup access and agree the retention period with the business. Do not log passwords, OTPs, tokens or raw request bodies during troubleshooting.

## Rollback and known limits

Retain the additive security tables, triggers, audit history, keys and evidence during application rollback. Do not reverse credential rotation, restore plaintext credentials, delete audit history or reset quota tables as a shortcut. Preserve compatible session revocation semantics. An older backend may omit these security protections; if it must be restored, restrict ingress to a maintenance state or previously approved limited audience until a corrected secure build is ready. Deploy matching admin/mobile versions if API behavior changed. Restore a database only through the existing deletion-ledger replay and backup process, with explicit operator approval.

Remaining source/operational limits are documented in the workspace report: historical credentials and plaintext records need remediation; some old tenant collections still require query pagination; document/video signatures are not malware scanning; legacy stored uploads need review; Expo web persistence needs further hardening; colluding low-volume accounts cannot be prevented from accumulating all information they are authorized to view; dependency, hosted CI/DAST, infrastructure and real-provider checks remain outstanding. No production readiness claim follows from local tests alone.
