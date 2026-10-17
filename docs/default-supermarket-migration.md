# Default supermarket migration — implementation and release runbook

Historical stage-one record. The subsequent local implementation enables additional shops, default editing, explicit multi-shop employee assignments and scoped operations. Use [multi-supermarket-rollout.md](multi-supermarket-rollout.md) for the coordinated release order; the stage-one scope boundaries and test totals below describe that earlier stage only.

Prepared 11 October 2026. Local implementation and tests are complete. **No production schema migration, backfill, deployment, or backup operation has been performed.** Production writes require the user's explicit approval.

**Observed database state**

A read-only transaction against the configured application database succeeded. It inspected current relationship records, deployed column metadata and `_prisma_migrations`.

| Finding | Count |
|---|---:|
| Existing customers | 21 |
| Verified current CUSTOMER supermarket, eligible for ownership/default backfill | 8 |
| No verified supermarket relationship; manual review required | 13 |
| Applied migrations in deployed history | 34 |
| Unfinished/unrolled-back migrations in that history | 0 |

The 13 review accounts have `NO_VERIFIED_SUPERMARKET`; this is not permission to create replacement supermarkets. Keep these accounts and all their existing records. Resolve their ownership using authoritative records/customer confirmation before adding relationships. Names, email domains and supplier catalogues are not ownership evidence.

The private, read-only report is at `/tmp/paymi-default-production-reviewed-plan-2026-10-11.json` (mode 0600). It contains customer/shop IDs and schema metadata, not passwords or customer names. Store it in the approved private change-management location before `/tmp` cleanup. Generate a fresh report for deployment; stale relationship evidence is rejected. The report's target fingerprint also prevents applying a report to another database.

The new migration is not deployed. Historical migration files do not fully reconstruct all existing models; the local rehearsal validates this additive migration against the preceding application schema, not a full reconstruction of production from old migration files. A restored production snapshot remains a release prerequisite.

**What changed**

- `SupermarketOwnership` links existing Customer and CUSTOMER Shop records. Shop IDs/names and the existing `Customer.shopId` remain unchanged.
- A typed foreign key plus SQL CHECK rejects WHOLESALE shops as ownership targets, even for direct SQL writes.
- `Customer.defaultSupermarketId` is a preference referencing the same customer's ownership through a composite FK. It cannot point to another customer's supermarket. A version counter protects recovery from overwriting newer preferences.
- `SupermarketMigrationReview` records ambiguous/missing relationships. It does not reassign employees, grant rights, or force registration.
- `SupermarketMigrationRun` stores recovery evidence in the same transaction as the backfill.
- Registration atomically creates one customer, named first shop, team chat, ownership, default and durable retry receipt. Retries of the same verified request return the committed result for 24 hours, including after OTP consumption. Password changes invalidate replay proof. Different/unverified requests cannot reclaim an account by email.
- OTP consumption happens after a successful commit. If provisioning fails, the transaction rolls back all its writes and the still-valid OTP can be retried.
- Legacy `/api/shop/assign` resumes verified existing setup instead of creating another supermarket and replacing the legacy pointer. Missing ownership is referred for review. Employee creation no longer silently invents a supermarket for an account without one.
- Login and `/auth/me` expose the default ID while preserving the existing `shopId`. For migrated single-shop owners and newly registered owners these identify the same original/first shop, so existing clients continue entering their current shop.
- `GET /api/shop/supermarkets` returns verified ownership/employee membership metadata. It explicitly reports that additional creation and operational switching are not enabled in this migration release.

The selection resolver verifies ownership or active employee membership on every use. An explicit unauthorized selection never falls back to a default. Employee feature permissions remain required. Selection is request-local and never changes the customer's legacy pointer.

**Scope boundary**

This is the default/ownership migration stage of the broader architecture proposal. It does not ship Profile → My Supermarkets creation, a mobile switcher, changed per-shop billing, multi-active employee memberships, or complete operational API/cache scoping. Exposing those controls before all list/operational/offline paths are scoped would be unsafe. The current one-active-employee constraint remains intact. Default editing is not exposed because the existing operational design cannot safely follow a changed default everywhere yet.

The owner-switching test verifies selection of two explicitly owned supermarkets without modifying global pointers and rejects another owner's ID. It is not a claim of end-to-end mobile switching acceptance. Default selection for the current verified single-shop users and atomic new registrations is covered now. The later multi-supermarket release must connect the resolver to all operational APIs and client state before enabling additional shops or changing defaults.

**Classification rules**

1. Preserve a valid existing default supported by verified ownership.
2. Otherwise, use the explicit existing `Customer.shopId` if it points to a CUSTOMER shop, has no unresolved competing legacy owner and has no conflicting operational relationship outside the known verified set.
3. Otherwise, one pre-existing verified ownership can establish a default. Multiple verified ownerships without a usable default/legacy selection are reviewed, not sorted and guessed.
4. Customer-authored list/task links and employee-creator links can flag conflicts; they cannot establish ownership of another supermarket.
5. Missing shops, supplier links, invalid ownership/defaults, shared unverified legacy ownership and conflicting evidence go to review. No supermarket is created by the migration.

Null legacy list scope, employee memberships/permissions, supplier products/prices and all operational rows remain untouched. Their later migration/isolation work is separate.

**Local verification**

Tests use a disposable PostgreSQL instance created under `/tmp/paymi-default-pg`, configured for `127.0.0.1:55439`, with database `paymi_default_test`. It was stopped after verification. The harness refuses non-local databases or names without `test`, and resets only that disposable database.

The actual additive SQL is tested against the preceding schema with seeded customers, supplier prices, employees/memberships and operational records. Snapshot assertions compare all preceding model tables before/after schema migration and backfill. Further tests cover repeatability, changed-plan rejection, review cases, composite FK/type guards, recovery, existing owner/employee login, employee restrictions, request-local owner selection, concurrent HTTP registration, lost responses, password-reset replay rejection, transaction rollback and CLI target/approval guards.

Validation result: **61 tests passed, 0 failed, 1 skipped** across the backend suite. The skipped test is the existing optional artificial database-latency test. Prisma schema validation passes. No mobile/admin application code changed in this task.

The final focused migration suite also passed all **16 tests** after CLI error-handling changes.

To reproduce using an already provisioned disposable local test database:

```sh
TEST_DATABASE_URL=postgresql://n1sh@127.0.0.1:55439/paymi_default_test npm run test:default-supermarkets
TEST_DATABASE_URL=postgresql://n1sh@127.0.0.1:55439/paymi_default_test npm test
```

Use the locally installed Prisma client generator before tests after schema edits. The existing workspace has Prisma CLI 6.2.1 and client 6.4.1; generation reports that mismatch. Dependency upgrades are outside this migration and were not performed.

**Production procedure — not executed**

1. Confirm the target environment/release and review the 8 eligible mappings plus 13 review cases. Determine whether to proceed with verified accounts while retaining unresolved accounts for review. Do not claim all 21 have a verified default.
2. Obtain explicit user approval for the schema migration, backfill and deployment. These are separate from approval to implement/test locally.
3. Use the existing production backup procedure and record backup ID, timestamp, database identity and restore-test evidence. No authoritative backup runbook was found in the checked project files; confirm it with the operator. Do not substitute the source-code archive for a database backup.
4. Restore that backup into an isolated staging database. Confirm actual schema/FKs/indexes and migration history, apply the additive SQL, rehearse the reviewed backfill/recovery, compare original IDs and operational/supplier/membership records, and verify existing/new account login.
5. Coordinate a short provisioning/relationship-change window. Apply only the reviewed additive migration `20261011120000_default_supermarket_ownership`. It uses a transaction and five-second lock timeout; on lock timeout investigate/retry, never reset/drop production schema. Do not modify already-applied historical migrations.
6. Inject the target URL as `MIGRATION_DATABASE_URL` using the approved secret mechanism. The CLI deliberately does not read application `.env` or implicitly use `DATABASE_URL`.
7. Generate and review a fresh read-only report. Use a private, new filename; the CLI refuses to overwrite a report.

```sh
node scripts/migrateDefaultSupermarkets.js --report=/secure/change/default-plan.json
```

8. After approval, a verified backup/restore and report review, apply that exact plan. Non-test writes require the following evidence references; supplying flags is not a substitute for user approval.

```sh
node scripts/migrateDefaultSupermarkets.js \
  --apply=/secure/change/default-plan.json \
  --production-approved=APPROVAL_REFERENCE \
  --backup-ref=BACKUP_REFERENCE \
  --restore-tested-ref=RESTORE_TEST_REFERENCE
```

9. The command checks deployed migration history and the plan/target fingerprints, then rechecks relationships inside a serializable transaction. A stale plan, constraint conflict or serialization failure aborts the operation. Regenerate/review the report rather than bypassing these checks. Save the printed run ID. A network failure after commit is reconciled using the durable run ledger and another read-only report, never by assuming no write occurred.
10. Deploy the matching generated Prisma client/server only after additive schema and backfill checks. Smoke-test existing owner/employee sessions, original shop names and IDs, first registration/retry, counts and company/supplier separation. Existing signed-in customers do not register again. Leave multi-supermarket UI/creation/switching disabled in this release.

For much larger datasets, rehearse transaction duration first; the current backfill intentionally uses one serializable transaction with a 60-second deadline. If it cannot finish within that limit, design and review bounded batches with per-batch evidence before production execution. Do not blindly raise the timeout on a busy production database.

**Recovery**

Recover an applied run only after inspecting current state and obtaining production recovery approval. The same approval/backup/restore-reference flags are required for non-test targets:

```sh
node scripts/migrateDefaultSupermarkets.js \
  --recover=RUN_ID \
  --production-approved=RECOVERY_APPROVAL_REFERENCE \
  --backup-ref=BACKUP_REFERENCE \
  --restore-tested-ref=RESTORE_TEST_REFERENCE
```

Recovery restores only default preferences whose value/version still matches the migration ledger. If any changed, the whole recovery aborts for manual reconciliation. Repeating a completed recovery is a no-op. Ownerships, review records, customer accounts, employee memberships, shops, chats, lists and supplier data are retained. It never resurrects old permissions or removes a supermarket.

Leave additive schema in place. Do not drop the ownership/default/receipt tables, restore a backup over newer customer transactions or delete additional shops to fit an older application. Pause registration during an application rollback to the old nontransactional provisioning code; prefer the compatible server and forward repair. Restored null defaults can be repopulated by a new reviewed dry-run/apply without duplicating shops or ownerships.
