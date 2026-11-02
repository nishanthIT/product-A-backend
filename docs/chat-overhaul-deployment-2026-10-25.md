# Chat recovery, search and deployment

The configured shared database does not contain `Chat.shopId`. A read-only metadata inspection on 2026-10-25 confirmed the column is absent and the shop-chat migration has not been applied. The current shop-scoped directory query therefore fails with a Prisma missing-column error. Retrying a phone connection cannot resolve that failure.

The public `https://backend.h7tex.com/api/health` endpoint returned HTTP 200 with sessions and moderation ready, but publishes no code version. Its prior readiness check does not verify the Chat models. This change adds those models to startup and health checks so a server with an incomplete chat schema cannot report itself ready.

## Implemented behavior

- `GET /chat?search=term` searches authorized conversation names, eligible participant names and all visible message content/attachment names, including older history. Matching private message bodies are not exposed in directory responses.
- `GET /chat/:id?search=term&limit=50&before=cursor` returns chronological messages and `chat.pagination` with `hasMore`, `nextCursor` and `limit`. Opaque cursors preserve timestamp/ID ordering across concurrent inserts, timestamp ties and deletion of a boundary message. Existing page/limit clients remain supported. Limits are validated and capped at 100.
- Search uses the same selected-shop, active membership, block and deleted-message rules as normal history. `%`, `_` and backslashes are literal search text.
- Missing schema returns HTTP 503 with `CHAT_SCHEMA_NOT_READY`; other service failures return `CHAT_UNAVAILABLE`. API responses contain no SQL or connection details.
- Stable `clientMessageId` retry protection now covers text, document and list-share messages in addition to photos. Photo IDs remain compatible. Retries reuse the persisted message and deleted retries cannot resurrect history. The response/socket echoes the identifier; the pre-existing database schema does not persist a recoverable client identifier for history reads.
- Cache or realtime notification failure after a successful write no longer turns a persisted send into an HTTP 500. Focus/reconnect refresh recovers persisted history.

## Reviewed migration impact

Read-only aggregate snapshot from the configured database:

| Item | Count |
| --- | ---: |
| Existing conversations | 33 |
| Existing messages | 68 |
| Existing participant records | 77 |
| Existing canonical teams to associate with their shop | 9 |
| Unambiguous private histories to associate with their shop | 3 |
| Missing canonical team records repairable at their existing linked ID | 1 |
| Shops without verified owners, still requiring separate review | 1 |

The migration preserves every existing message and participant. It grants no ownership or employee membership. Ambiguous and global histories stay stored and inaccessible. The expected chat count for this snapshot becomes 34; counts may grow normally before deployment.

Two migrations are pending:

1. `20261017210000_packaging_without_outer_barcode` — unrelated supplier packaging change; not included in this chat deployment.
2. `20261024100000_shop_chat_scope` — the required additive chat change.

## Targeted repair — applied to the configured shared database

After the full frontend/backend verification, `20261024100000_shop_chat_scope` was applied on 2026-10-25 using `scripts/applyShopChatScope.js`. The runner defaults to a read-only plan; `--apply` uses the application’s Prisma driver and one bounded transaction. It locks the affected relationships, verifies the reviewed SQL checksum, checks SHA256 snapshots of every existing message, participant and original chat field, verifies each intended shop association and records only the chat migration in Prisma’s ledger before committing. Unexpected changes roll back both schema and data.

The committed result was **33 → 34 chats, 68 → 68 messages, 77 → 77 participants**. Twelve existing conversations were associated with their verified shops and one dangling canonical team was restored at its existing linked ID. No ownership or employee membership was granted. The unrelated packaging migration was not applied. The Prisma client was regenerated and the local development API was restarted.

For another environment, use the reviewed targeted tool from `product-A-backend`:

```bash
node scripts/applyShopChatScope.js --dry-run
node scripts/applyShopChatScope.js --apply
npx prisma generate
```

A normal successful rerun reports `already-applied`; an unfinished migration, checksum mismatch or an unrecorded pre-existing column requires review. Avoid broad `prisma migrate deploy` for this chat-only operation because it also includes the unrelated supplier migration.

Verify the chat readiness check and the exact reviewed row associations, confirm every pre-existing message and participant remains, then test owner/employee directory, older-message search, direct send/reply and reconnect against the deployed service. Verify supplier/company-only/cross-shop accounts are denied. Do not repair the ownerless shop by guessing ownership.

## Validation

The guarded disposable local database test harness refuses remote/non-test databases. Regression coverage includes older-history and filename search, literal wildcard search, deleted/blocked/cross-shop filtering, timestamp ties and concurrent arrivals, deleting a pagination boundary, invalid queries, schema readiness/errors, concurrent text retries, deleted retry tombstones, document retries, and post-commit cache failures. Existing shop-isolation tests exercise the additive migration against a simulated pre-migration schema and compare all message/participant rows before and after.

The configured shared database repair is complete. The production-hosted API at `backend.h7tex.com` was not redeployed; the frontend’s configured LOCAL API was restarted. Authenticated physical-device/browser end-to-end verification remains pending. The read-only post-migration service audit and exact validation results are in the frontend release report and evidence directory.

Full backend suite after the final changes: 237 passed, 0 failed, 1 optional latency test skipped. Migration-runner tests cover dry-run, successful apply, replay, and rollback on unexpected history mutation using both PostgreSQL and Prisma transaction paths. Tests run only against the harness-guarded disposable local test database.

Post-apply read-only verification passed for all 18 authorized account/shop combinations across the 10 configured customer shops. Every eligible roster member receives its selected shop team; no other-shop summaries were returned. One shop has no verified roster and remains denied. Message/participant counts remained 68/77; the unrelated packaging migration remains unapplied. The restarted local API returned HTTP 200 from health in 3.2 seconds. Healthy schema validation now takes one round trip, retaining per-service diagnosis on failure.
