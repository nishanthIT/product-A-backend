# Global Chat rollout

The latest requirement permits one shared retail community chat across shops, replacing the earlier universal same-shop restriction. Private team conversations remain shop-scoped. New private community conversations admit only their two eligible retail participants.

Deploy the current backend files together, including `src/services/globalChat.js`, the updated chat controller, directory, access service and `server.js`. No additional schema migration is introduced here; the previous `Chat.shopId` migration is still required. Startup verifies the schema and then reuses/renames the original unscoped ALL Chat to Global Chat. It does not recreate its history, merge duplicate legacy threads, or bulk-add account permissions. On a new installation it creates one shared room under a transaction advisory lock.

Ship the matching frontend so `isGlobalChat` and `isCommunityChat` API flags are honored. Global Chat is pinned under All Chats, and sender actions can create or reopen a private conversation shown in Direct.

The configured database was restored on 26 October 2026: its existing Global Chat retains the original ID and all 31 messages. All 68 database messages and 77 participant records were preserved. The local API was restarted and returned healthy status. The hosted production API has not been deployed as part of this work.

Validation: 247 backend tests passed (one optional latency test skipped), 122 frontend tests passed, TypeScript/ESLint passed, and iOS/Android/web exports passed. Read-only checks verified 18 eligible account/shop selections and denied seven excluded accounts. See the frontend release report and evidence at `paymi_v2/docs/release/global-chat-2026-10-26.md`.
