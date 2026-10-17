# Multi-supermarket implementation and rollout

Updated 12 October 2026. With explicit user approval, both supermarket schema migrations and the verified default/list backfills have been applied to the confirmed shared Neon database. A refreshed backup was restore-tested and retained, and original data preservation was verified. See [the completed login/schema recovery record](login-schema-mismatch-2026-10-12.md). Application deployment has not been performed. The device walkthrough remains outstanding because this session has no available browser or device automation surface.

## Implemented behavior

- Mobile Profile → My Supermarkets and the home shop header open the integrated supermarket screen. Owners see their verified shops, active/default indicators, employee counts, employee management, default selection, and a name/address creation modal. Employees see only active explicit memberships and cannot create shops.
- Additional creation uses the existing identity and atomically creates the CUSTOMER Shop, ownership, team chat and durable idempotency receipt. The client persists the exact request before submitting; interrupted/repeated requests return the same shop. Existing IDs, names, legacy pointers and default preference are preserved when adding a shop.
- `X-Supermarket-Id` selects a request-local context. Authentication reloads verified ownership or active employee membership. Explicit unauthorized IDs fail instead of falling back. Missing selection uses the verified default/legacy membership rules. Feature permissions remain required.
- Switching preserves authentication, cancels reads, resets shop navigation/drafts, changes the account-and-shop-specific persisted query cache and reconnects realtime with the selected context. Requests capture the scope generation; late responses cannot populate another shop. Switching waits for pending mutations and uploads. It requires online membership validation.
- Offline mutations resume only from their original account/shop cache. The old account-agnostic v1 cache is retained for review and never automatically replayed; users with old pending mutations receive a notice. This preserves evidence without guessing the author or shop.
- Lists, Collect Mode, retail stock, employees, expiry, fridge/cleaning history, incidents, age records, tasks, waste, payouts, shift sheets and certificates use verified scope. Manipulated parent IDs are checked. Incident/age-record photos require parent-record access; certificate downloads carry scope. Revoked active membership clears the visible shop context on directory refresh.
- Retail `inHandStock` writes use `SupermarketProductState(shopId, productId)`. The global Product and WHOLESALE ProductAtShop prices remain shared. Supplier routes reject CUSTOMER shop IDs. Existing shared stock values are retained in place; they cannot safely be attributed to a particular customer automatically.
- Owners can explicitly assign an existing employee they created from another verified owned shop, with separate feature toggles for the new membership. Assignment does not create another login or company membership. Company employees are excluded from the assignable directory. One-active-shop uniqueness is removed while employee/shop uniqueness remains.
- Company Customer Supermarkets has permission-controlled search, sorting, pagination, status filters and details with actual owners, memberships and operational counts. Reads create a durable audit entry. Supplier navigation is labelled Cash & Carry.

Customer shopping-list chat shares are restricted to the same supermarket's team chat and recipients' list permissions. Existing message records remain stored; inaccessible shared-list contents are withheld. Review this deliberate authorization tightening in the chat regression walkthrough.

## Database changes and historical data

Retain typed `Shop` (`CUSTOMER` versus `WHOLESALE`), `Customer`, existing `Empolyee`, `CompanyStaffMembership` and `ShopEmployeeMembership`. No production table rename is necessary. The existing default migration adds verified ownership, a composite ownership/default FK, provisioning receipts and review/recovery ledgers.

The new `20261011160000_multisupermarket_operations` SQL adds creation receipts, typed per-shop product state and admin access logs. It adds a **NOT VALID** FK to existing `List.shopId`: new non-null values are checked, historical invalid values remain for review. The SQL is transactional with a five-second lock timeout and does not reassign existing business records.

`migrateListScopes.js` only associates null list scopes supported by unambiguous relationships. Owner lists require a sole verified ownership matching the legacy pointer. Employee lists require a sole historical membership, matching legacy pointer and creator provenance, plus verified owner access. Multiple/missing relationships and invalid existing scopes are reported, never guessed. Admin-authored unscoped lists stay separate. Original list timestamps and contents are preserved.

The earlier read-only production inspection reported 21 customers: 8 eligible verified shops and 13 accounts needing review, with 34 applied migrations and none unfinished. This is historical evidence, not a fresh release preflight. See the [default migration record](default-supermarket-migration.md). The subsequent approved backfill established 8 verified defaults; the other 13 accounts still require review. Current shared-database migration status is recorded above.

## Release procedure

Database migration and verified backfill steps below are now complete for the confirmed shared Neon target. The 13 customer relationships and 46 list scopes flagged for review remain unresolved and unchanged. Application rollout/device acceptance remains separate.

1. Obtain explicit approval for the target release, schema changes and reviewed backfills. Confirm the operator's production backup procedure, backup reference and successful isolated restore. A source archive is not a database backup. The repository's historical migrations do not reconstruct the complete deployed schema, so rehearse against that restored snapshot.
2. During a coordinated relationship/provisioning write window, inspect actual deployed schema and `_prisma_migrations`. Reconcile drift; do not use reset, db push or edited historical migrations on production.
3. Apply the reviewed additive default ownership migration if absent, then the multi-supermarket operations migration. Generate the matching Prisma client. Resolve lock timeouts instead of bypassing them.
4. Generate/review/apply a fresh default ownership plan using the stage-one CLI and its approval, backup and restore-test references. Keep ambiguous accounts and records intact for operator review.
5. With verified ownership in place, generate and review the list-scope report below. Apply only that exact target-bound report. Relationship facts are hashed and rechecked in a serializable transaction; stale plans abort. Save the durable run ID and private report.
6. Resolve historical null/invalid list scope before enabling the feature for affected accounts. The new API hides unverified lists and creation refuses relevant unscoped legacy lists; this is a release prerequisite to retaining normal access, not a reason to recreate lists. Review any shared legacy retail-stock values with authoritative evidence; do not copy them to all shops.
7. Check orphan list IDs and CUSTOMER typing of customer/employee scopes, then validate `List_supermarket_scope_fkey` after repairs are verified. Check original shop IDs/names, ownership, employee memberships/permissions, record counts and supplier prices against the restored snapshot. The FK alone does not establish customer ownership.
8. Deploy the scoped backend and matching mobile/admin release together. Do not serve multi-shop traffic through old server instances that use global legacy pointers. Old clients without a selection receive the verified default; changing it affects their next requests. Rehearse that compatibility path.
9. Complete the walkthrough below on staging and the approved production smoke check. Enable customer usage only after those checks succeed.

Inject `MIGRATION_DATABASE_URL` with the approved secret mechanism; these scripts deliberately do not read the application `.env` or select a database implicitly. Reports are created with mode 0600 and cannot overwrite an existing file.

```sh
node scripts/migrateListScopes.js --report=/secure/change/list-scope-plan.json

# Only after explicit approval and verified backup/restore evidence:
node scripts/migrateListScopes.js \
  --apply=/secure/change/list-scope-plan.json \
  --production-approved=APPROVAL_REFERENCE \
  --backup-ref=BACKUP_REFERENCE \
  --restore-tested-ref=RESTORE_TEST_REFERENCE
```

Non-local writes require all three references and deployed migration history checks. CLI flags are evidence fields, not authorization from the user. Lost connections after commit must be reconciled against the run ledger before retrying.

## Recovery

Prefer forward repair and keep additive schema. The default migration's recovery restores only unchanged default preferences and keeps ownership/data. List-scope recovery requires every list to retain its recorded scope and timestamp, then restores only those scopes to null atomically:

```sh
node scripts/migrateListScopes.js \
  --recover=LIST_SCOPE_RUN_ID \
  --production-approved=RECOVERY_APPROVAL_REFERENCE \
  --backup-ref=BACKUP_REFERENCE \
  --restore-tested-ref=RESTORE_TEST_REFERENCE
```

Use list recovery only in the controlled rehearsal/release window before new multi-shop operations. Timestamp checks are not proof that no related child record changed. Review all related activity before recovery; do not restore null scopes underneath the new scoped application. Do not downgrade to pointer-based application code after additional shops or employee assignments exist. Retain new shops, memberships, receipts, stock and audit rows; never delete them to make an old release fit. Restoring a backup over subsequent customer transactions requires a separately reviewed recovery plan.

## Validation and remaining acceptance

Backend: **70 passed, 0 failed, 1 optional latency test skipped**. Tests require a disposable local PostgreSQL database; the harness refuses remote/non-test targets and resets test data. The new tests cover concurrent additional creation/retries, default selection, cross-shop record IDs, lists/Collect/stock, employee creation/assignment restrictions, supplier protection, list backfill/recovery, private photos and audited company access. Existing default tests rehearse the actual additive SQL and snapshot original records.

Mobile: **4 isolation tests passed**, covering saved/default selection, identity/shop cache keys, paused offline mutation replay and switch blocking, and upload/request generations. TypeScript passes. Expo web export succeeds and contains the integrated supermarket routes. These checks do not substitute for native interaction testing.

Admin: TypeScript reports the same **28 baseline diagnostics** in AddProduct.tsx, Chat.tsx and Shops.tsx; no new diagnostics in the supermarket page or navigation changes. Prisma validates/generates successfully; the existing CLI 6.2.1 / client 6.4.1 mismatch warning remains.

```sh
# Backend, using a disposable local database only:
TEST_DATABASE_URL=postgresql://n1sh@127.0.0.1:55439/paymi_default_test npm test
npx prisma validate

# Mobile:
npm run test:supermarkets
npx tsc --noEmit --pretty false
npx expo export --platform web --max-workers 2 --output-dir /tmp/paymi-multishop-web

# Admin:
npx tsc -p tsconfig.app.json --noEmit --pretty false
```

Staging device walkthrough still required: sign in as a migrated owner; open Profile → My Supermarkets; create a second named shop; retry a lost response; switch and verify empty independent records; add different records to both shops and switch back; change default and relaunch; test an explicitly assigned employee and a denied employee; queue an offline mutation and confirm switching waits; reconnect and confirm the original-shop write; check scanning, supplier comparison, Collect Mode, chat shares, private images/PDF exports and admin detail audit entries. Verify company staff never appear in customer employee lists and suppliers never appear in the shop switcher. Complete keyboard, small-screen, accessibility and loading/error checks on the actual app before declaring release acceptance.
