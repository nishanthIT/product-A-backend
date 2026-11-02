# Direct messaging and 30-day retention rollout

The API now reuses valid personal conversations, serializes simultaneous pair creation in PostgreSQL, sends committed messages to authorized inboxes on every connected device, and persists delivery/read receipts. The app opens an immediate, cancellable conversation skeleton, deduplicates simultaneous opening requests, updates previews/unread counts/receipt ticks live, and reconciles after reconnect. In-app alerts are tappable and use haptics where available. **Alerts after the app is terminated are not implemented: this repository has no APNs/FCM push registration or delivery service.**

## DigitalOcean deployment

The confirmed backend checkout is `/var/www/product-A-backend` on the `vino` Droplet. No SSH session or deployment has been performed by this change. The user confirmed that the existing API is supervised by **PM2**. Restart that existing process; do not start a second competing server. Check `pm2 ls` for its actual process name/ID before restarting it. Keep secrets in the existing protected server environment file, not source control.

The targeted additive migration has already been applied to the database configured for this workspace, with **37 conversations, 68 messages, 83 participants and all existing upload records unchanged**. That database operation does not deploy the Droplet's code or enable retention. The local API currently has retention disabled. On the Droplet, the migration preview will report `already-applied` if it uses that same database; a separate staging database still needs its own checked migration.

Deploy the reviewed backend files, package lock, Prisma schema/migration, frontend changes and scripts through the normal release workflow. From the backend directory:

```sh
cd /var/www/product-A-backend
npm ci
npx prisma generate
node scripts/applyChatDeliveryStorage.js --dry-run
node scripts/chatRetention.js --dry-run
```

The migration runner is read-only by default. Review its counts, then run `node scripts/applyChatDeliveryStorage.js --apply`. It applies only `20261026090000_chat_delivery_retention_storage`, verifies that messages/conversations/participants/existing uploads are unchanged, and records that one migration atomically. **Do not blindly run `prisma migrate deploy`: this checkout also contains an unrelated pending packaging migration.** Partial/unrecorded schema state, checksum drift or a failed preservation check aborts and rolls back.

Retention is disabled unless explicitly enabled, to prevent a developer process connected to the hosted database from completing deletion jobs against the wrong local disk. Configure these values in the Droplet environment before restarting the existing supervised API:

```dotenv
CHAT_RETENTION_ENABLED=true
CHAT_RETENTION_HOUR_UTC=2
CHAT_STORAGE_PROVIDER=local
CHAT_STORAGE_ROOT=/var/www/product-A-backend/uploads/chat
CHAT_STORAGE_TIMEOUT_MS=15000
```

The existing `uploads/chat` contents need no move. The code resolves storage through configuration and falls back to a path relative to the installed backend module, never the shell working directory. Keep the directory private, writable by the API service user and on persistent storage. If local development connects to the same database as this Droplet, set `CHAT_RETENTION_ENABLED=false` in local development: local disk cannot delete Droplet files. Run cleanup only against the storage belonging to that database, or use a shared object-storage configuration. `CHAT_RETENTION_HOUR_UTC=2` means 02:00 UTC daily (07:30 India time). Set `CHAT_RETENTION_ENABLED=false` for a staged schema-only rollout until the expiry preview and file configuration have been checked.

For the confirmed PM2 service, restart its actual name with `pm2 restart <existing-api-name> --update-env`; use `pm2 save` and the host's configured `pm2 startup` integration so it survives reboot. The placeholder requires the actual PM2 process name; the hostname `vino` is not necessarily that name. `pm2 startup` may print a host-specific command that must be completed once. Verify the startup integration before relying on reboot recovery. See the official [PM2 startup instructions](https://pm2.keymetrics.io/docs/usage/startup/) and [environment-update command](https://pm2.keymetrics.io/docs/usage/process-management/#updating-environment-variables-and-options). A long-running supervised API is sufficient; no laptop cron, active terminal or extra daily scheduler is needed. Do not run an additional periodic CLI job alongside it.

Each API instance polls the durable worker every minute. Expiry batches use bulk database queries and copy at most one missing moderation attachment per transaction, keeping remote-database and object-storage work bounded. PostgreSQL has one `ChatRetentionRun` per UTC schedule day; row locks serialize bounded batches across instances. Restarts resume incomplete runs. Downtime is caught up using the latest due cutoff. Completed daily rows prevent repeated expiry. File failures remain in `ChatAttachmentDeletionJob` with bounded exponential retries; missing files count as successful deletion. Messages and their attachment jobs commit in the same transaction. Pending deletion blocks new attachment references, and dispatch checks again for shared references before touching bytes.

The rolling daily cutoff deletes messages strictly older than 30 days at the scheduled instant, so maximum normal residence is under 31 days between daily runs. All conversation types are included. Newer/boundary messages, room IDs and participants remain. Read/delivery receipts cascade with expired messages. Report evidence is preserved under the existing separate moderation policy. Unrecognized external URLs are not fetched or guessed as local paths. Expired orphan uploads are also cleaned. Failed uploads retain their storage descriptor and a deletion job with a five-minute grace period, so an interrupted PUT that finishes remotely can still be removed; an immediate missing-object response cannot discard its ownership record. `scripts/releaseMaintenance.js` now uses the same provider-aware deletion queue.

`node scripts/chatRetention.js --run-once` explicitly runs one bounded pass for operations/recovery; repeated calls are safe. Do not run it merely to preview. Review `/api/health` fields `services.chatRetention` and backend logs; alert on `unavailable`, file retry failures, stale `lastPollAt`, or a growing pending file queue. The health response exposes status/counts only. The worker pauses during `PAYMI_RESTORE_MODE=1`; after restoring a backup, replay deletion ledgers and follow existing restore procedures before reopening the API.

## Object storage / DigitalOcean Spaces

Use private S3 or an S3-compatible bucket. Existing legacy local descriptors continue to resolve through `CHAT_STORAGE_ROOT`; keep that volume until old local files have expired or been deliberately migrated.

```dotenv
CHAT_STORAGE_PROVIDER=s3
CHAT_S3_BUCKET=your-private-space
CHAT_S3_REGION=us-east-1
CHAT_S3_ENDPOINT=https://your-space-region.digitaloceanspaces.com
CHAT_S3_PREFIX=chat
CHAT_S3_FORCE_PATH_STYLE=false
CHAT_S3_VERSIONING=auto
CHAT_S3_CONDITIONAL_WRITES=false
# AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY: supply securely to the service.
```

The Spaces example follows [DigitalOcean’s SDK setup](https://docs.digitalocean.com/products/spaces/reference/aws-sdks/): the endpoint selects the Spaces region. Its [API reference](https://docs.digitalocean.com/reference/api/spaces/) does not list conditional `If-None-Match` headers for PUT, so this example explicitly disables them; SDK retries are disabled in that mode to avoid creating extra versions after an uncertain write. Server-generated UUID keys remain unique, and lost responses leave cleanup metadata. AWS S3 uses conditional writes by default.

For AWS S3, omit `CHAT_S3_ENDPOINT`; the SDK default credential chain supports IAM roles and standard AWS environment variables. Never expose bucket credentials to the mobile app. Upload/download URLs remain authenticated PayMi API routes. Each upload/deletion job records its actual provider, bucket, key, endpoint and version ID. Endpoint mismatches fail closed and retry rather than deleting from a different environment. Each environment needs its own bucket/prefix or volume and matching database.

Permissions: allow `s3:PutObject`, `s3:GetObject` and `s3:DeleteObject` only for the chat object prefix. Versioned reads/deletes also need `s3:GetObjectVersion` and `s3:DeleteObjectVersion`; unknown-version recovery needs bucket-level `s3:ListBucketVersions`, constrained to the chat prefix where the provider supports prefix conditions. Known versions are removed explicitly; for an interrupted upload without a recorded version, only versions/delete markers of the exact server-generated UUID key can be removed. No arbitrary prefix deletion is used. If the provider does not support versioning/list versions (for example an explicitly unversioned compatible service), set `CHAT_S3_VERSIONING=disabled` **only after confirming that bucket cannot retain prior versions**. Recorded version IDs are always deleted explicitly, even if that setting later changes; unsupported operations fail closed. Configure object-lock/lifecycle policies consistently; provider denial remains a logged retry, not a falsely completed job. Actual cloud credentials/bucket behavior still require a staging smoke test.

## Multiple API instances

Set `CHAT_REDIS_URL` (or existing `REDIS_URL`) to the same private authenticated Redis deployment on all instances, plus the same `CHAT_REDIS_CHANNEL_PREFIX` (default `paymi:chat:socket.io`). Use a different prefix per environment. The Socket.IO Redis adapter routes user rooms and remote socket authorization checks across servers; Redis must not be publicly accessible. A configured but unreachable Redis blocks startup; a runtime outage leaves committed writes intact and clients recover via REST polling/reconnect. Without this configuration realtime delivery is single-instance only. Retention coordination always uses PostgreSQL and does not depend on Redis. Multiple filesystem-backed instances must share the same persistent upload volume; otherwise use object storage.

## Verification and release gates

Automated checks cover simultaneous opens, existing-history reuse, authorized unopened inboxes/multiple devices, delivery/read idempotence, blocked/revoked accounts, Redis cross-server fanout, UTC cutoff boundaries, shared-file protection, rollback/restart/missing-file retries, provider safety and migration preservation. See the final verification evidence for executed test counts. Test fixtures use a disposable local database, not production accounts.

The [sanitized verification summary](evidence/chat-direct-retention-2026-10-26/verification-summary.json) records 292 passing backend tests, one optional skipped test and zero failures in the final full run (293 total). The frontend suite passed 142 tests. Desktop/mobile Chromium flows and Android/iOS/web production exports also passed; see the [frontend verification report](../../paymi_v2/docs/release/direct-chat-retention-2026-10-27.md). The backend run includes bounded bulk retention, independent report-evidence copies and late-object cleanup after an uncertain PUT. The protocol test uses the official AWS SDK against a local test server, not DigitalOcean Spaces or AWS credentials. [Migration evidence](evidence/chat-direct-retention-2026-10-26/migration-applied.json) records the preservation checks. The [read-only retention preview](evidence/chat-direct-retention-2026-10-26/retention-preview.json), for the 2026-10-26 scheduled cutoff, identified 56 expired messages, 12 retained messages and three attachment candidates. **That preview deleted no messages or files.** Rerun it against the deployed database immediately before enabling retention because the daily cutoff and counts change.

Before release, smoke-test on the DigitalOcean staging deployment with two retail accounts, multiple devices, a supplier denial, airplane mode/reconnect, existing global/team history, photo upload/preview, and the retention dry run. Verify download/send/delete against the real storage provider, correct process supervision and a reboot/restart. Android/iOS builds and physical-device notification/camera behavior require actual devices/development builds; export success alone does not certify those behaviors. Deploy and verify the backend migration before releasing the corresponding frontend.
