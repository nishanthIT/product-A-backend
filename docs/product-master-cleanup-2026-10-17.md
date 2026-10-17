Product master cleanup — 17 October 2026
======================================

The safe portion of `../data_product/redneval_products.json` has been applied to the configured database. The requested capitalized filename does not exist; the lowercase file is the supplied source. No supplier prices, RRP, product titles, images, product IDs, unit barcodes, shop assignments or inventory were imported or changed. Existing uncommitted work was preserved.

Actual changes:

| Measure | Result |
| --- | ---: |
| Source records inspected | 5,274 |
| Source records matched by valid unit GTIN | 5,111 |
| Existing products matched | 4,833 |
| New case configurations | 4,410 |
| Products receiving case configurations | 4,396 |
| Products with multiple new case configurations | 14 |
| Products receiving missing-field updates | 4,369 |
| Missing legacy case barcodes filled | 4,349 |
| Missing packet sizes filled | 3,136 |
| Missing case sizes filled | 2,559 |
| Identical safe source configurations collapsed | 3 |
| Unresolved source records, left unapplied | 861 |
| Products created, deleted or merged | 0 |
| Product count before and after | 66,547 |

Field counts overlap. Null, blank and literal `null`/`undefined`/`N/A` values count as missing. Nonempty legacy values were retained, including questionable values; `warnings` identifies retained legacy fields for review. Products with several cases do not receive an arbitrarily selected default case barcode or case size. For example, unit `5000157062673` retains separate 24 × 400g (`5000157084118`) and 12 × 400g (`5000157132734`) configurations.

`ProductPackaging` stores the owning Product ID, original case barcode, canonical 14-digit case GTIN, saleable units per case, unit/package size, normalized size key, original packing expression, and source references. Nested packs remain explicit: `6 x 4x330ml` is six saleable multipacks, each containing four 330ml items. Layer/pallet information is retained with its original basis in provenance; an unknown basis is not interpreted. Supplier `rcode` values are stored only as `sourceProductCode` in provenance. Source prices and printed prices are excluded even from provenance.

Only string GTINs with valid 8/12/13/14-digit lengths and check digits are eligible for import. Padding is used solely to compare equivalent GTIN formats; existing Product barcodes are not rewritten. This follows [GS1's GTIN representation guidance](https://www.gs1.org/edi-xml/technical-user-guide/Item_Numbers) and [check-digit calculation](https://www.gs1.org/services/how-calculate-check-digit-manually). Names, supplier IDs, `input_barcode`, and the source's `matched_on` field do not establish product identity.

Migration `20261017170000_product_packaging` was applied and recorded in `_prisma_migrations` in the same transaction as the cleanup. Its table has a Product foreign key, unique canonical case GTIN, positive quantity, GTIN format/checksum, and nonempty size constraints. Prisma validation passed, the local client was regenerated, and `prisma migrate status` reports all 47 migrations up to date. Existing database columns absent from Prisma (including legacy stock columns) were preserved; no live `db push`, reset, reseed or broad migration deployment was used.

The transaction verified full-row fingerprints for 13 related tables plus all untouched Product fields, including columns outside Prisma. All 13,318 ProductAtShop records, 3,903 list items, 19 shops, prices, promotions, expiry/waste records and stock values were unchanged. Each Product field change was also checked against the exact plan. Replanning after insertion produced zero new configurations and zero further Product updates.

Review artifacts (local JSON files are intentionally excluded from Git):

- [Final dry-run](../reports/product-master/dry-run-final-2026-10-17.json): matched identities, proposed inserts/updates, unresolved rows with reasons and conflicting IDs, retained values, catalog-wide issues.
- [Committed result](../reports/product-master/applied-2026-10-17.json): actual changes, migration checksum/status and preservation fingerprints.
- [Before-values and planned inserts](../reports/product-master/applied-2026-10-17.json.before.json): written before the first database mutation.
- [Pre-commit validation](../reports/product-master/applied-2026-10-17.json.validated.json): validation evidence written before commit; the committed-result file confirms commit.
- [Independent read-only verification](../reports/product-master/verification-2026-10-17.json): fresh rerun, database integrity, migration checksum and API handler probes.
- [Unresolved records](../reports/product-master/unresolved-2026-10-17.json): the 861 unapplied source records and catalog-wide barcode issues, extracted for review.

Unresolved source reasons overlap; the 861 rows are not a sum of these counts:

| Reason | Records |
| --- | ---: |
| Case GTIN is already a unit GTIN in the database/source | 606 |
| Case GTIN belongs to another product's legacy case field | 404 |
| Existing unit size disagrees | 140 |
| Invalid unit GTIN | 98 |
| Invalid case GTIN | 61 |
| No existing unit match | 58 |
| Ambiguous package expression | 30 |
| Source extraction error | 29 |
| Missing case barcode | 21 |
| Existing case quantity disagrees | 7 |
| Multiple database products share equivalent unit GTINs | 7 |
| Conflicting source unit sizes | 3 |

The whole-catalog audit also found 75 missing unit barcodes, 4,417 invalid unit GTINs, 283 invalid legacy case barcodes, 87 equivalent-unit-GTIN collision groups and five duplicate legacy-case-GTIN groups. These preexisting records were not merged, deleted or corrected speculatively. The source itself declares extraction incomplete, so this run does not establish catalog-wide completeness. Resolve these records using verified physical labels/manufacturer data, with explicit relationship-preserving review for existing duplicate Product rows.

Product API review covered catalog create/edit/detail/filter/search/approval/quick-add, shop product creation/update/listing, global list-item edits, expiry search, pack comparison, list additions and bundle matching, plus read-only consumers in category, price-report, promotion, inventory, waste and expiry workflows. Barcode resolution now queries every packaging configuration, returns `packagingConfigurations`, `matchedPackaging` and `barcodeMatchType`, and returns HTTP 409 for multiple candidate products. Explicit `field=barcode` and `field=casebarcode` modes remain separate. Search, detail, catalog filters, supplier inventory listings, expiry lookup and pack options expose or recognize the new configurations. Legacy edit endpoints reject changes to reviewed identity/packaging fields; ordinary title edits still work.

Existing lists and prices remain associated with Product/ProductAtShop. Scanning a case returns the existing Product ID and its matched case metadata; it does not multiply list quantities or stock or assign a case-specific price. Existing name-based pack-comparison/bundle suggestion logic was reviewed but is not used for master matching. Future supplier pricing must explicitly identify the purchased packaging configuration; that work is outside this cleanup.

All 77 distinct targeted/regression tests passed: 12 parser/planner tests, 10 isolated PostgreSQL migration/import/API tests, and 55 existing authorization, feature, shop and out-of-stock workflow tests. Tests cover equivalent-code conflicts, checksum failures, missing values, nested multipacks, distinct cases, duplicate-source collapse, stale dry-runs, rerun idempotency, read-only dry-runs, preserved inventory/prices, API authorization, scan/detail/search/expiry responses, duplicate quick-add rejection, and adding scans from two cases to one existing list identity. The final search change was also checked by rerunning all 10 packaging integration tests.

Independent post-commit verification passed against the configured database: zero orphaned packages, duplicate canonical case GTINs, case/unit collisions or cross-product legacy case owners among the new configurations. A fresh plan proposes zero inserts and zero updates. Nineteen recorded read-only API handler probes, plus five product-detail checks, passed against live data. Authenticated HTTP workflows were tested against the isolated database; this was not a test of a remotely deployed backend version.

Backend code changes and the generated Prisma client are local. A running deployed backend must load this version to use the new scanning/search behavior. The configured database migration/data changes are already committed. No remote backend deployment was performed.

Rerun from `product-A-backend` with new report filenames:

```sh
node scripts/cleanProductMaster.js --report reports/product-master/review-next.json
node scripts/cleanProductMaster.js --apply \
  --reviewed-report reports/product-master/review-next.json \
  --report reports/product-master/apply-next.json
node scripts/probeProductMaster.js --report reports/product-master/verification-next.json
```

Dry-run is the default. Apply recomputes the plan while holding the Product write lock and refuses changed source, migration checksum, catalog snapshot or planned writes. Reports are created with exclusive filenames and restrictive file permissions. Database mutations and the migration ledger entry are transactional; any pre-commit failure rolls back the whole run. To undo an applied run, use the saved before-values and exact inserted IDs in a reviewed compensating transaction, first confirming that those values/configurations have not been edited or referenced since the run. Do not drop the table or restore a broad database snapshot over unrelated work.
