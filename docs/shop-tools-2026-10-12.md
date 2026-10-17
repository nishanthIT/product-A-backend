# Shop tools changes — 12 October 2026

Temperature limits accept signed decimals, including -23°C, on create and update. Both ranges must remain ordered (minimum < maximum). Blank, malformed and non-finite input is rejected instead of silently replaced by defaults. The equipment editor reloads the saved freezer range, and temperature alerts use the persisted limits. Existing Decimal columns already support negative values.

Category and Product are independently optional in both age-record APIs. The current mobile form includes optional text fields, displays their saved values, and allows clearing either field. The migration makes the legacy columns nullable and adds nullable columns to the current incident record model. Existing descriptions, dates, photos, permissions and records are preserved.

Payouts use the existing database-generated `createdAt` timestamp; creation/edit APIs reject client timestamp overrides. Forms display the timestamp as read-only. Local date filters now send complete ISO boundaries, and the API also accepts legacy date-only filters. Failed loads have an explicit error/retry state rather than appearing to be an empty ledger; malformed list responses also fail visibly.

## Database rollout

`20261012100000_optional_age_record_products` was applied to the configured shared database after a private backup and a successful restore/migration rehearsal on a fresh local database. Existing age-record values were fingerprinted before and after and matched. All four Category/Product columns were verified nullable. The local Prisma client was regenerated. No app hosting/deployment or dev-server restart was performed.

The private backup and verification results are outside the application repositories in `.private-backups/shop-tools-2026-10-12/` under the workspace root.

## Existing payout data awaiting mapping

Read-only investigation found two payout records, for suppliers “Tug” and “Suplier test”, linked to “Test12's Shop”. Their original customer account no longer exists, and the shop has no verified owner or default relationship. Both records already have valid creation timestamps. They cannot safely be reassigned or exposed to another shop without confirmation of the intended destination supermarket. No payout records or ownership mappings were changed.

## Validation

- Full backend suite on disposable local PostgreSQL: 74 passed, 0 failed, 1 skipped.
- New API regressions cover chiller/freezer/legacy ranges, persisted values, alert behavior, invalid input, both optional-field APIs, payout create/list/filter/update, timestamp tampering and shop isolation.
- Additive migration tested on fixtures and on a restored copy of the configured database.
- Frontend TypeScript check, targeted ESLint and Expo web export passed.
- Frontend temperature/date-boundary unit tests and existing supermarket-isolation tests passed. This host's Node lacks native TypeScript support, so tests used a temporary loader with the installed TypeScript compiler.
- Native iOS/Android device interaction was not exercised.
