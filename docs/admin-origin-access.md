# Admin origin access — 3 November 2026

The admin at `https://bigsave.h7tex.com` calls `https://backend.h7tex.com/api`. The backend's strict origin allowlist previously omitted the admin unless `CORS_ALLOWED_ORIGINS` explicitly included it. This prevented browsers from reading `/api/auth/me`, rejected JSON login preflight, blocked cookie writes and refused Socket.IO handshakes.

`src/middleware/httpSecurity.js` now includes the exact HTTPS admin and native API origins in the shared allowlist, including when production environment configuration is absent or specifies other additional origins. HTTP, lookalike domains and unlisted subdomains remain untrusted. Authentication and administrator authorization are still required. The frontend's existing `VITE_API_BASE_URL=https://backend.h7tex.com/api` is correct.

## Apply to the hosted backend

Deploy the updated backend code and restart its process. Alternatively, the existing deployed backend already supports this environment setting:

```dotenv
CORS_ALLOWED_ORIGINS=https://bigsave.h7tex.com,https://backend.h7tex.com
```

If the hosted variable already contains other approved origins, append this origin, separated by a comma. Use no trailing slash. Restart the hosted backend after changing it; the running process reads its origin policy during startup. Updating a local `.env` or rebuilding only the frontend does not update the hosted backend.

The local backend `.env` and `.env.example` now include the origin. No hosted deployment was performed in this repair; no hosting deployment configuration or management connection was available in the repository.

After the hosted restart, verify:

```sh
curl -i -X OPTIONS 'https://backend.h7tex.com/api/auth/login' \
  -H 'Origin: https://bigsave.h7tex.com' \
  -H 'Access-Control-Request-Method: POST' \
  -H 'Access-Control-Request-Headers: content-type,authorization'

curl -i 'https://backend.h7tex.com/api/auth/me' \
  -H 'Origin: https://bigsave.h7tex.com'
```

Preflight should return 204. Both responses should include `Access-Control-Allow-Origin: https://bigsave.h7tex.com` and `Access-Control-Allow-Credentials: true`; unauthenticated `/auth/me` should still return 401. Then reload the admin and sign in. If an ingress returns its own error response before Express, fix that error at the ingress as well.

The console warning attributed to `Grammarly-check.js` is separate from the API origin rejection; disabling application security headers is not needed to solve this CORS failure.

## Native app compatibility

Phone users do not need to provide an IP address, app bundle ID or proxy setting. Originless native HTTP requests are accepted, and the native WebSocket API origin `https://backend.h7tex.com` is explicitly trusted even if `PUBLIC_BASE_URL` is missing or points to another local API. React Native does not enforce browser CORS rules, but backend origin checks still apply; Android's native WebSocket implementation sends the server's HTTP(S) origin. [React Native networking](https://reactnative.dev/docs/network).

The iOS/Android client now uses `withCredentials: false` for HTTP and retains the SecureStore bearer-token interceptor. This avoids an old OS cookie triggering cookie-only CSRF rejection during sign-in/reset. Web cookie behavior is preserved. Native private image/document requests already supply their own authorization headers. Ship the mobile change with the next app update; origin allowlisting is a backend deployment change.

`TRUSTED_PROXY_CIDRS` describes the server's reverse proxy, not a phone or its VPN. Direct connections use the empty default. For a reverse-proxied deployment, the operator must match the actual ingress addresses so client IPs and per-IP limits are accurate; do not guess or enable unconditional trust. [Express proxy guidance](https://expressjs.com/en/guide/behind-proxies/). Origin compatibility does not bypass login, tenant permissions or abuse restrictions, and physical-device verification is still needed after release.

## Verification

The added regression cases failed before the fix: missing default origin, missing preflight/session response headers, denied cookie login, and denied socket handshake. All 11 HTTP/security tests pass after the change. These run against disposable local HTTP/socket servers without accessing the configured database or real admin credentials. Tests verify both WebSocket and polling, continued foreign-origin denial and browser-readable 401 responses.

Command: `DOTENV_CONFIG_PATH=/dev/null node --test tests/httpSecurity.test.js` (Node 24.19.0).

Evidence: [test results](evidence/security/admin-origin-tests-2026-11-03.txt). A read-only check of the still-unmodified hosted backend returned 401 for `/api/auth/me` and a fallback OPTIONS response for login, both without `Access-Control-Allow-Origin` for the admin. That check does not represent a deployed fix.

The native-compatibility follow-up passes **12/12 backend HTTP/socket tests**, **149/149 mobile tests**, and mobile `tsc --noEmit`. Tests exercise originless login, native bearer writes, the production API Origin with an unrelated configured API, both socket transports, rejection of lookalike origins, and iOS/Android/web Axios session transport. [Backend results](evidence/security/native-origin-tests-2026-11-03.txt), [mobile verification](../../paymi_v2/docs/evidence/native-http/verification.json).
