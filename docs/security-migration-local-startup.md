# Local backend startup: security schema rollout

After explicit user approval on 30 October 2026, migration `20261027130000_central_security_protection` was applied to the configured remote database. The application returned `status: "applied"` and `committed: true`. A separate read-only confirmation returned `status: "already-applied"`, `action: "none"` and no missing tables. All 50 unrelated migration records remained unchanged. Existing business rows were neither modified nor deleted.

The initial read-only inspection that day found every table and scalar column required by the sessions, moderation, cache, lists and chat readiness checks. These five entire tables were missing and have now been created:

- `SecurityEvent`
- `SecurityRestriction`
- `SecurityException`
- `SecurityPolicy`
- `SecurityAdminAudit`

The local backend uses that configured remote database. Running the backend locally does not make a migration to `DATABASE_URL` a local database change. Preparation, the initial preview and the local rehearsal made no remote writes; the later approved apply was the remote schema change recorded above. Local API startup and phone connectivity verification are separate from this migration record.

## Reviewed change

`scripts/applySecurityProtection.js` applies only `20261027130000_central_security_protection`. The SQL checksum is `f3fffd9be0a5004aea3b364f85ecca0c5d997c33051e0cad979895bdb544c797`.

The approved application created the five tables, their indexes/checks, the audit serial sequence, the append-only audit function and its UPDATE/DELETE/TRUNCATE guards. It added one completed record for this migration in the existing Prisma ledger. It changed or deleted zero existing business rows and did not run retention jobs or other pending migrations. The preview and subsequent confirmation both report 50 unrelated ledger records untouched.

Approved application evidence: [apply result](evidence/security/security-migration-approved-apply-2026-10-30.json) and [independent read-only confirmation](evidence/security/security-migration-approved-confirmation-2026-10-30.json). The verified schema fingerprint is `0ad96d67894f0cc0b406261bc77a9e093cb83b051af5b3ae99eedec313b3afdb`; the apply report's `schemaFingerprint` describes the inspected pre-apply state, and the confirmation contains the completed schema fingerprint.

## Commands

Run from `product-A-backend`. The runner uses the existing `DATABASE_URL` and never prints it.

```sh
node scripts/applySecurityProtection.js
# Equivalent explicit read-only preview:
node scripts/applySecurityProtection.js --dry-run
```

The following command performed the approved change. It is now a verified no-op for this database when its schema and recorded checksum still match. A different target database needs its own reviewed preview and authorization:

```sh
node scripts/applySecurityProtection.js --apply
```

The default preview uses a read-only repeatable-read transaction. Apply takes a transaction-scoped advisory lock and locks the migration ledger, checks the migration checksum and complete schema fingerprint, and commits schema plus ledger together. Repeating apply is a no-op when both already match. An exact complete schema without its ledger entry may be recorded without replaying DDL. Partial schema, altered types/defaults/indexes/checks/triggers, disabled audit triggers, an unfinished target migration, a missing ledger or a mismatched recorded checksum are refused. This runner does not infer a baseline or mark unrelated migrations as applied.

Failures before COMMIT roll back the transaction. A lost COMMIT acknowledgement is different: the server may already have committed. The runner reports `commitStatus: "unknown"`, `committed: null` and `recheckRequired: true`; run `--dry-run` before retrying. `already-applied` confirms the schema and ledger match, while `ready` with missing tables confirms that the migration still needs applying. After a successful application, keep these additive tables and the ledger entry while investigating any application rollback; dropping security evidence is not an automatic rollback step. An independently reviewed rollback is required for any later removal.

## Verification

Nine tests passed on disposable local PostgreSQL 18: read-only preview; apply/idempotence and business-row preservation; exact-schema ledger reconciliation; partial/disabled-trigger rejection; unfinished/checksum/missing-ledger rejection; atomic rollback after an injected failure; concurrent apply serialization; lost-COMMIT-acknowledgement recovery; and distinct reporting of connection failures versus ambiguous commits. Evidence is in `docs/evidence/security/security-migration-runner-tests-2026-10-30.txt` and `security-migration-preview-2026-10-30.json`.

```sh
TEST_DATABASE_URL=postgresql://USER@127.0.0.1:PORT/paymi_security_migration_test \
  node --test --test-concurrency=1 tests/securityMigrationRunner.test.js
```

The test rejects nonlocal hosts and database names without `test`. It resets its security tables, migration ledger and synthetic business fixture in that disposable database.
