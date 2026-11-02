Bestway import and verification — 17 October 2026
================================================

The Bestway-only dry run and reviewed transaction completed with **zero database writes**. The verified prices were already present from the earlier authorized combined import. This stage strengthened source identity validation, rechecked the case master, and independently verified Bestway without importing Dhamecha or Active Hub/Costcutter.

The reused importer is [scripts/importSupplierPrices.js](../scripts/importSupplierPrices.js), with normalization and matching in [scripts/lib/supplierPricePlan.js](../scripts/lib/supplierPricePlan.js). No scraper, application pricing rules, Prisma schema or migration was changed in this stage.

All four actual files under `../data_suppliers/bestway/` were inspected:

| File | Structure | Product rows |
| --- | --- | ---: |
| `Data_Bestway_2026-09-22_13-20-30-153711_all_299.json` | Flat array, 13 fields | 299 |
| `Data_Bestway_2026-09-22_13-37-46-519835_all_421.json` | Flat array, 13 fields | 421 |
| `Data_Bestway_2026-09-22_21-04-02-812355_all_3624.json` | Flat array, 13 fields | 3,624 |
| `Data_Bestway_2026-09-22_21-04-02-812355_all_collecting.checkpoint.json` | Object; 421 older enriched rows and 3,203 detailed rows in `products` | 3,624 |

These are overlapping snapshots, not four independent catalogues. The 7,968 raw product rows represent 3,624 distinct source configurations and 2,640 distinct retail GTINs; 4,344 rows repeat a source configuration. The checkpoint is explicitly incomplete (`stopped`, `login_required`), with five pending URLs and 55 additional unresolved records outside `products`. Prices are the 22 September 2026 snapshot for depot 810; no new supplier fetch was performed.

Source identity and packaging
-----------------------------

Detailed records use `product_code`, `sku`, `name`, the original product URL, typed `barcodes`, `pack_size`, `pack_display`, `units_per_priced_pack`, and `wholesale_price`. The older checkpoint rows retain the product SKU in their URL. Flat exports intentionally omit supplier IDs; the existing scraper's `simple_product` projection explains that loss.

The importer now requires a source product ID and a nonblank name for Bestway. It validates agreement between product code, SKU and the Bestway product URL. Each of the 4,344 ID-less flat rows was linked to one unambiguous checkpoint identity through the exact retail GTIN, name, package size/display, wholesale price and currency. Missing or conflicting IDs are rejected; names and supplier IDs never replace GTIN matching against the master. Identity evidence and checkpoint row references are recorded in `sourceIdentityAudit` without rewriting existing stored pricing provenance.

Retail EAN values from actual `barcodes` data take precedence, including supported `retail_barcode` forms. Root `barcode` is used only for older flattened records without typed barcode data. Invalid checksums, conflicting retail fields, duplicate master unit GTINs and cross-product legacy case aliases are rejected. Cases must match one verified `ProductPackaging` by product, unit quantity and normalized package size.

The `500ml × 12` / quantity `1` issue is real. For example, Lakeland semi-skimmed milk, SKU `818152-1`, GTIN `5010652988170`, has `pack_size: 500ml`, `pack_display: 500ml × 12 × 1`, `units_per_priced_pack: 1`, and `wholesale_price: 7.99`. The existing scraper extracts only the final multiplier from `.prodsize`. Its attributes and price fields do not independently establish the price basis. The importer excludes these contradictions; it does not multiply the factors, infer a case from price/RSP/POR, or repair the source by guessing. Both direct size/count disagreements and nested expressions are tested.

Pricing and actual results
--------------------------

The existing WHOLESALE shop remains `Bestway`, ID `cmlxrkf550002caussfk5azlh`. No supplier or master products were created. `wholesale_price` remains a GBP pack total: a verified unit price uses `ProductAtShop` with `unitsPerPack = 1`; an additional verified case uses `PriceTier` with its exact `packagingId` and retail-unit quantity. A sole case price can use a case-linked base record. RSP, POR, listing promotion text and RRP do not create Bestway promotional prices, discounts or expiry dates. Existing offers and unrelated quantity tiers remain protected.

| Measure | Actual result |
| --- | ---: |
| Product rows with verified source ID and nonblank name | 7,968 |
| Raw rows accepted after master/packaging checks | 1,598 |
| Duplicate accepted rows collapsed | 948 |
| Verified master products / Bestway base associations | 447 |
| Individual-unit base prices | 446 |
| Case-only base prices | 1 |
| Linked case-price tiers | 203 |
| Total verified price configurations | 650 |
| Base prices created / updated in this transaction | 0 / 0 |
| Case tiers created / updated in this transaction | 0 / 0 |
| Master products, packaging records or RRPs changed | 0 |
| Writes proposed on rerun | 0 |
| Total existing Bestway product associations | 609 |

The 609 total includes 162 older Bestway associations outside the accepted source set; they were preserved. For historical clarity, the earlier combined import retained 419 new Bestway associations, 28 updates and 203 new case tiers. A prior guarded correction withdrew one newly created, unused ambiguous-barcode association. Those historical actions are not new writes in this Bestway-only run.

Unresolved records
------------------

There are **6,370 unresolved raw product rows**, representing **2,974 distinct source configurations**, plus the checkpoint's 55 separate unresolved records. Reasons overlap:

| Reason | Raw rows | Distinct source configurations |
| --- | ---: | ---: |
| No matching master product | 3,674 | 1,701 |
| Conflicting packaging fields / uncertain price basis | 3,042 | 1,498 |
| No verified case configuration of the required size/count | 531 | 224 |
| Master unit-size disagreement | 200 | 88 |
| Missing or ambiguous package size | 197 | 85 |
| Ambiguous master barcode match | 20 | 7 |
| Unverified legacy case barcode only | 2 | 1 |

None of the 7,968 product rows has a missing/invalid wholesale price or an unresolved required source ID/name after exact checkpoint reconciliation. All 55 separate checkpoint-unresolved records lack a usable retail barcode; seven also carry an invalid-checksum warning. The full file/row/barcode/reason lists and concrete packaging conflicts are in the [review report](../reports/supplier-prices/bestway-review-2026-10-17.json). No ambiguous product or case configuration was invented to reduce these counts.

Verification
------------

- The transaction checked the reviewed source hash, migration checksum, database snapshot and exact plan, saved a private before-state, then verified preservation and a zero-write rerun before committing. Dhamecha and all non-target prices, inventory, existing identities, shop/list relationships, master RRPs and promotions were unchanged.
- Both required migrations were already applied: `20261017170000_product_packaging` and `20261017180000_supplier_pack_prices`. Ledger/checksum checks passed; no migration was applied now.
- The live master check verified 66,547 products and 4,410 case configurations, including 14 products with multiple cases. It found zero orphaned configurations, duplicate case GTINs, case/unit collisions or cross-product legacy case owners among verified configurations. It recorded 19 scan/search probes plus five product-detail checks; master replanning proposes zero writes. The earlier Redneval cleanup still has 861 unresolved source records.
- **30 targeted automated tests passed:** 20 source/planner/selector tests, six disposable-PostgreSQL integration tests, and four frontend comparison-engine tests. Coverage includes all four export formats, exact ID reconciliation, missing/conflicting identity, uncertain price basis, separate unit/case prices, existing offers, transaction migration, supplier isolation, stale-review rejection, authenticated comparison/scanning, and a repeated Bestway apply preserving every record and timestamp. Expected negative-test rejection messages are not import failures. The disposable test database was stopped afterward.
- Independent read-only verification checked **all 650 accepted database prices**, including exact product/shop identity, amount, quantity and packaging linkage, and again confirmed zero writes on rerun. **24 live-data application/frontend-engine probes passed** across seven products: 11 comparison options, seven unit scans, five case scans and one expected ambiguous-barcode rejection (HTTP 409). The sample includes unit-only prices, unit-plus-case tiers and the case-only base. Prices, per-unit ranking and case labels were correct; no Bestway promotion was invented. Results are in [the supplier verification report](../reports/supplier-prices/bestway-verification-2026-10-17.json).
- **Deployed visual UI verification remains outstanding:** the computer-use inventory returned no connected browsers or apps. Checks exercise the local application's real handlers against live database records, authenticated HTTP routes against disposable fixtures, and the frontend comparison engine. No remote backend/frontend deployment was performed; a deployed visual UI or physical camera scan is not claimed.

Execution and artifacts
-----------------------

Executed from `product-A-backend`:

```sh
node scripts/importSupplierPrices.js --supplier BESTWAY \
  --report reports/supplier-prices/bestway-dry-run-2026-10-17.json

node scripts/importSupplierPrices.js --supplier BESTWAY --apply \
  --reviewed-report reports/supplier-prices/bestway-dry-run-2026-10-17.json \
  --report reports/supplier-prices/bestway-apply-2026-10-17.json

node --import ../paymi_v2/scripts/register-ts-hook.mjs scripts/probeSupplierPrices.js \
  --supplier BESTWAY \
  --applied-report reports/supplier-prices/bestway-apply-2026-10-17.json \
  --report reports/supplier-prices/bestway-verification-2026-10-17.json
```

Use new report filenames on subsequent runs; existing reports are not overwritten. The CLI accepts one supplier per invocation and defaults to Dhamecha, so **always pass `--supplier BESTWAY` for this stage**.

- [Dry run](../reports/supplier-prices/bestway-dry-run-2026-10-17.json)
- [Committed transaction and verification](../reports/supplier-prices/bestway-apply-2026-10-17.json)
- [Before-state and preservation fingerprints](../reports/supplier-prices/bestway-apply-2026-10-17.json.before.json)
- [Source inventory, conflicts and unresolved records](../reports/supplier-prices/bestway-review-2026-10-17.json)
- [Independent supplier verification](../reports/supplier-prices/bestway-verification-2026-10-17.json)
- [Independent master/scanning verification](../reports/product-master/bestway-stage-verification-2026-10-17.json)

JSON reports are local, access-restricted and excluded from Git. Active Hub/Costcutter has not been started.
