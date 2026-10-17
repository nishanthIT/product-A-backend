# Login P2022 diagnosis and completed recovery

12 October 2026 (Asia/Kolkata). **The approved shared Neon database fix completed at 08:44:59 IST.** Both pending migrations and the verified relationship backfills were applied after explicit user approval, a refreshed backup, successful restore, and local rehearsal. Application deployment was not performed.

An earlier attempt was rejected by automatic approval review and did not execute. The user subsequently explicitly approved “applying the two pending migrations and verified backfills to the shared Neon database.” That approved operation succeeded.

Before that rejected attempt, the target and pending migrations were reconfirmed and a fresh read-only backup was successfully restored into a new local database. The latest private backup is `/tmp/paymi-schema-recovery-Yy2zaL/neon-before.dump` (3,959,676 bytes; SHA-256 `ccbd39304cad499014e3a18cddc66cf463f83a14347d50b7a8f5462745b0d831`). Restore evidence is `/tmp/paymi-schema-recovery-Yy2zaL/local-target.json`; the restored database is `paymi_schema_rehearsal_test_cfe0d846` on `127.0.0.1:55439`. The earlier rehearsal evidence below remains available.

The refreshed backup and verification evidence are also retained outside `/tmp` in `/home/n1sh/Start_up/Paymi/.private-backups/neon-login-fix-2026-10-12/` (private directory, mode 0700; files mode 0600; excluded from Git). The retained dump checksum was verified after copying.

## Shared-database outcome

- Both pending migrations applied through `prisma migrate deploy`. Migration status: **up to date**, 36 completed migrations. The generated client successfully reads the new Customer columns on shared Neon; no regeneration or environment change was needed.
- Before/after fingerprints across all 44 original tables matched exactly after schema expansion. After backfill, original values still matched except the approved `List.shopId` assignments. Exact scopes for all 95 lists were separately compared against the restored backup plus the 48 approved assignments and matched.
- Eight verified ownership/default relationships were created. Default recovery ledger run: `edc7b8d4-185b-4938-b3f8-af169d05924d`.
- Forty-eight verified list scopes were associated. List recovery ledger run: `81078993-8d40-401e-a7f3-2f9e32d6d25f`.
- Thirteen customer accounts and 46 lists remain intact for relationship review. No ownership was guessed; no customer, employee, supermarket, supplier or operational record was deleted. Existing passwords, shop IDs/names, memberships, permissions and supplier prices were unchanged.
- The real backend was started in an isolated local process against shared Neon for verification, with a temporary session key and outbound mail disabled. Full Customer/Employee model queries succeeded; owner session verification and shop directory returned HTTP 200. Invalid passwords returned the expected HTTP 401 instead of P2022/500. Live account passwords were not changed. Successful password-based owner/employee login was already verified on the restored copy; users must retry their normal live credentials.
- Final authentication check completed at 08:45:43 IST with no P2022 and no invalid owner/default relationships. The temporary verification server was stopped.

Private evidence files: `neon-applied-result.json`, `neon-auth-verification-result.json`, `neon-before-fingerprints.json`, `neon-default-plan.json`, and `neon-list-plan.json` in the retained backup directory.

## Cause and confirmed target

`product-A-backend/.env` selects PostgreSQL database `neondb`, schema `public`, on `ep-icy-unit-a54o0zhr-pooler.us-east-2.aws.neon.tech:5432`. The user confirmed that this existing shared Neon database is the intended target. `paymi_v2/.env` selecting `LOCAL` means the mobile app uses the local backend; it does not make the backend's database local. No environment configuration was changed.

The checked-in Prisma schema and generated Prisma Client 6.4.1 both contained `Customer.defaultSupermarketId` and `Customer.defaultSupermarketVersion`. Before this fix, the actual database contained neither column and none of the seven tables introduced by the two pending supermarket migrations. Login's unrestricted `Customer.findFirst` selects generated scalar fields; `/auth/me` explicitly selects `defaultSupermarketId`. Both therefore referenced a nonexistent database column. This was an unapplied-schema release mismatch, not a stale generated client or an invalid customer password.

The initial read-only SQL inspection and `prisma migrate status` agreed:

- 34 completed migrations; no unfinished/unrolled-back migration.
- Pending: `20261011120000_default_supermarket_ownership`.
- Pending: `20261011160000_multisupermarket_operations`.
- Nine historical raw checksum differences exactly match conversion of local LF line endings to CRLF. No semantic SQL change was required to reproduce their recorded hashes. Migration files/history were not edited or marked applied.
- Snapshot counts: 21 customers, 25 employees, 9 CUSTOMER shops, 9 WHOLESALE suppliers.

The installed Prisma CLI is 6.2.1 and generated client is 6.4.1, a pre-existing version mismatch. Both understand the new fields. Regeneration is not the missing database migration and was not necessary for the successful rehearsal.

## Backup and non-destructive local rehearsal

A read-only custom-format `pg_dump` was written to a private local directory (directory mode 0700, backup/report mode 0600):

`/tmp/paymi-schema-recovery-X8zPcp/neon-before.dump`

Size: 3,959,471 bytes. SHA-256: `a0ffc79f77fb1f97cabf89b502af24bce62f64f4ee2122cfee85206e04813691`.

The backup restored successfully into a **fresh** database `paymi_schema_rehearsal_test_4c18142f` on `127.0.0.1:55439`. No database reset, destructive synchronization, dropped tables, migration-history deletion, or production write was used. This is a locally restore-tested snapshot; retain it in the approved durable backup location before `/tmp` cleanup and confirm the operator's managed production recovery procedure before release.

On that local copy:

1. A generated-client query reproduced P2022 before migration.
2. `prisma migrate deploy` successfully applied the two existing pending migrations.
3. Fingerprints of all original columns/rows across 44 original tables matched before and after the schema migration. Original customers, passwords, shop IDs/names, employees, supplier prices and operational records remained unchanged.
4. The reviewed default backfill created 8 verified ownership/default relationships. Thirteen customers with `NO_VERIFIED_SUPERMARKET` remained unassigned and were recorded for review. No shop was created or renamed.
5. The reviewed list backfill associated 48 of 95 lists. It left 46 for review: 19 without an unambiguous original shop and 27 with invalid existing scope. The separate admin-list case remained unchanged. No ambiguous list was reassigned. After backfill, all original-column fingerprints still matched except the 48 intended `List.shopId` assignments; new default/ownership fields were verified separately.
6. Migration status reported up to date. The generated customer query succeeded, and all 8 non-null defaults referenced verified ownerships.

Evidence in the private directory: `backup.json`, `original-record-fingerprints.json`, `local-default-plan.json`, `local-list-plan.json`, `rehearsal-result.json`, `auth-rehearsal-result.json`. A separate `neon-default-plan.json` is generated read-only against the actual target; local report hashes must never be used as production approval plans.

## Actual backend authentication checks

The actual `server.js` started against the isolated restored copy with a temporary JWT secret, local Redis fallback and external service credentials disabled. Tests used copied existing accounts. Random temporary passwords were installed **only on the local copy** for one owner and one active shop employee, then both original password hashes were restored in cleanup. No live credentials were changed or disclosed.

| Check | Result |
|---|---|
| Backend health | Passed |
| Existing copied owner login, `/auth/me`, supermarket directory | HTTP 200 for all three |
| Existing copied employee login, `/auth/me`, supermarket directory | HTTP 200 for all three |
| Wrong password | HTTP 401 |
| Authentication verification for all 21 copied customers | HTTP 200 |
| Owner original shop/default | Preserved |
| Employee memberships and feature permissions | Unchanged; no creation rights |
| P2022 in local backend log | None |

The temporary backend process was stopped. These are the earlier restored-copy results; shared-database verification is recorded above. Accounts with unresolved ownership can authenticate but need relationship review before using scoped shop features; authentication success does not establish shop ownership.

## Approved shared-database procedure — completed

Apply the two existing additive migrations to the confirmed shared Neon target using normal Prisma deployment, then generate/review fresh target-bound default and list plans and apply only the verified mappings rehearsed above. If relationships changed, stop and review the new plan. Keep the 13 unresolved accounts and 46 unresolved lists intact; do not invent ownership or replacement shops. See [the rollout procedure](multi-supermarket-rollout.md) and [default migration safeguards](default-supermarket-migration.md).

Before writing, reconfirm target/migration status, backup freshness and restore evidence. Preserve/inspect existing records and constraints, then verify the expected columns, migration history, original data and authorized relationships after commit. Restart the local backend using the same intended `.env` and verify actual customer/employee sign-in without resetting their passwords. No application deployment is implied by migration approval.

Recovery should retain additive schema and use reviewed ledger recovery/forward repair. Never erase migration history, delete shops, guess list scope, restore a backup over newer transactions, or downgrade to legacy pointer-based code after multi-shop usage.

## Files changed in this investigation

This diagnostic document and the rollout record were updated. Temporary diagnostic, backup, restore and rehearsal scripts live under `/tmp`; retained backup evidence is in the private directory identified above. Application code, Prisma schema, existing migration files, generated client and environment files were unchanged in this login-fix task. The two existing shared Neon migrations and verified data backfills have now been applied.
