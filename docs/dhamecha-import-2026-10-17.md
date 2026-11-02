Dhamecha import and verification — 17 October 2026
=================================================

The importer now runs **one supplier per invocation**, defaults to **DHAMECHA**, and requires a dry-run report for the same supplier before applying. This Dhamecha-only stage committed a verified no-op: the accepted Dhamecha records had already been written under the earlier combined-supplier request. No Bestway or Active Hub/Costcutter data was changed by the Dhamecha-only run.

Historical scope matters: Bestway had already been imported under that earlier request. Its final retained changes were 419 new supplier records, 28 updates and 203 case-price tiers. A separate guarded correction withdrew one newly created, unused Bestway price after a legacy case-barcode collision was discovered. Those earlier Bestway records were left in place; this stage did not import further Bestway data. Active Hub/Costcutter has not been imported.

Results
-------

| Dhamecha measure | Actual result |
| --- | ---: |
| Source rows inspected | 7,059 |
| Rows with nonnull product ID and nonblank product name | 719 |
| Skipped: null product ID and product name | 6,340 |
| Verified product/packaging price records | 134 |
| Verified case prices | 92 |
| Verified individual-unit prices | 42 |
| Eligible records requiring review before pricing import | 585 |
| Previously created Dhamecha supplier associations | 44 |
| Previously updated Dhamecha pricing records | 90 |
| Previously filled missing master RRPs from Dhamecha | 95 |
| New/updated price records in this Dhamecha-only transaction | 0 / 0 |
| Additional RRP changes in this transaction | 0 |
| Further writes proposed on rerun | 0 |
| Total existing Dhamecha supplier associations after verification | 6,909 |

The 6,909 total includes older supplier records outside this source import. No master products were created, merged or deleted. Product IDs, unit barcodes, inventory, list/shop relationships, other suppliers' records and existing ProductPromotion rows were preserved.

The actual source is `../data_suppliers/Dhamecha/barcode_products_22_sep.checkpoint.jsonl`. Each line contains `result` and `evidence`; product identity, pricing and packaging are in `result`, and scan/depot/capture evidence is retained alongside it. All 719 found records have both required identity fields and valid regular/current money values. The 6,340 unavailable records have null IDs, null names and no prices. They are explicitly logged with `missing_product_id`, `missing_product_name` and `source_not_available` reasons.

Matching and prices
-------------------

Existing supplier `cmhmfswa60000dgqs90qv3x02`, named `DAM&CHA CASH & CARRY`, remains the same WHOLESALE shop. The importer uses checksum-valid unit/case GTINs and verified case configurations to identify products. Names and supplier `product_id` values establish eligibility/provenance only. They are never used as product barcodes or as name-only master matches. Canonical duplicate unit codes and conflicting legacy case aliases are quarantined.

- `original_price_1` → ProductAtShop.price, preserving the regular price.
- `product_price` → ProductAtShop.offerPrice with the explicit `DHAMECHA_CURRENT` source marker. The existing shared selector uses that source-current price without fabricating an expiry date.
- Source promotion flags, names/IDs and all raw price fields are retained in sourcePricing. Null promotion fields do not create discounts. Of the 134 accepted records, 117 have a lower current price and an explicit source promotion flag; 17 have equal prices and are not labelled discounted.
- `product_price_1` and `original_price_2` remain raw evidence because their alternate price basis is not verified. No unit or case prices are invented from them.
- Valid source RRP fills only a missing master RRP. A uniquely identified retail unit can receive RRP even when its case quantity cannot support a price import. All RRP candidates now also require the source product ID and name.
- Case totals carry packagingId, unitsPerPack and pricedUnitSize. Known individual-unit pricing cannot be overwritten by a case price. Unknown case quantities and mismatched size/count configurations are rejected.

Prices are the source snapshot recorded on 22 September 2026, not a new online price fetch. Capture timestamps and raw values remain available for review. Manual price/promotion edits clear the imported-current marker and prevent an older source from reversing newer pricing.

Case master
-----------

The actual master source is the lowercase `../data_product/redneval_products.json`; the capitalized filename in the request is absent. The prior reviewed cleanup imported 4,410 case configurations for 4,396 existing products, including 14 products with multiple cases. This stage verified those configurations and proposed zero further master changes. There remain 861 unresolved Redneval source records; see the [product-master report](product-master-cleanup-2026-10-17.md).

Each verified case retains its barcode, owning master Product ID, unit quantity and package size. Scanning a case returns the same master identity as its unit barcode, plus the exact matched configuration. A case scan selects only a price linked to that case; it never presents another case's price or a unit price as that scanned case's total.

Both existing migrations are applied: `20261017170000_product_packaging` and `20261017180000_supplier_pack_prices`. Their ledger/checksum checks passed. No additional migration was created or applied in this Dhamecha-only stage.

Unresolved pricing records
--------------------------

The following reasons overlap across the 585 eligible records requiring review:

| Reason | Rows |
| --- | ---: |
| Missing/ambiguous quantity or package expression | 443 |
| No matching verified case configuration | 129 |
| Master unit size disagreement | 10 |
| Missing/invalid GTIN | 5 |
| No matching master product | 5 |
| Ambiguous product or legacy case alias | 3 |

No new master products or guessed case configurations were created to resolve these rows. The report preserves source file/line, barcode, available packaging and reason codes.

Verification and limits
-----------------------

- **27 targeted tests passed:** 17 source/planner/selector tests, 6 disposable-PostgreSQL integration tests and 4 frontend comparison tests. These cover supplier isolation, null identity gates, unit-price preservation, migration safety, transactions, stale-review rejection, reruns, manual edits, legacy-alias protection, HTTP comparison and unit/case scanning. Other-supplier fixtures are test-only.
- Independent read-only Dhamecha verification checked all 134 accepted mappings through replanning, confirmed zero writes on rerun, and recorded **16 live-data scan/comparison/frontend-engine probes**.
- Independent master verification recorded **19 scan/search probes**, plus five detail checks. There were zero orphaned configurations, duplicate case GTINs, case/unit collisions or cross-product legacy case owners among the verified configurations.
- Database totals remain 66,547 master products and 4,410 packaging configurations. The Dhamecha-only transaction preserved all other supplier prices and relationships.
- These checks use the current local handlers against live data, authenticated HTTP tests against a disposable database, and the frontend comparison engine. **The deployed visual UI was not verified:** no browser is connected, and no remote backend/frontend deployment was performed. The running application must load the pricing/scanning implementation for these results to appear there. Bestway/Active Hub work should not be advanced on the strength of an unperformed deployed-UI check.

Scripts and artifacts
---------------------

- [Reusable importer](../scripts/importSupplierPrices.js)
- [Matching/normalization planner](../scripts/lib/supplierPricePlan.js)
- [Independent supplier verifier](../scripts/probeSupplierPrices.js)
- [Dhamecha dry run](../reports/supplier-prices/dhamecha-dry-run-2026-10-17.json)
- [Committed Dhamecha-only transaction](../reports/supplier-prices/dhamecha-apply-2026-10-17.json)
- [Before-state and preservation fingerprints](../reports/supplier-prices/dhamecha-apply-2026-10-17.json.before.json)
- [Dhamecha verification](../reports/supplier-prices/dhamecha-verification-2026-10-17.json)
- [585 review records and 6,340 skipped records](../reports/supplier-prices/dhamecha-review-2026-10-17.json)
- [Case-master verification](../reports/product-master/dhamecha-stage-verification-2026-10-17.json)
- [Earlier combined import's final retained changes](../reports/supplier-prices/final-2026-10-17.json)

JSON reports are local, access-restricted and excluded from Git. Use new report filenames when rerunning:

```sh
# From product-A-backend; defaults to a read-only Dhamecha dry run.
node scripts/importSupplierPrices.js --supplier DHAMECHA \
  --report reports/supplier-prices/dhamecha-next-dry.json

node scripts/importSupplierPrices.js --supplier DHAMECHA --apply \
  --reviewed-report reports/supplier-prices/dhamecha-next-dry.json \
  --report reports/supplier-prices/dhamecha-next-apply.json

node --import ../paymi_v2/scripts/register-ts-hook.mjs scripts/probeSupplierPrices.js \
  --supplier DHAMECHA \
  --applied-report reports/supplier-prices/dhamecha-next-apply.json \
  --report reports/supplier-prices/dhamecha-next-verification.json
```

Apply validates the selected supplier, source hash, schema migration checksum, complete snapshot and exact planned writes before mutation. It writes a private before-state, uses a transaction, verifies preservation and rerun idempotency, then commits. A changed source/database requires a fresh dry run. Other supplier files are only inventoried; they are not parsed or admitted into a Dhamecha import plan.
