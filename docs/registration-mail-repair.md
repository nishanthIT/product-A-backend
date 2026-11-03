# OTP delivery and password recovery

## Delivery status — 3 November 2026

The earlier sender authenticated but its test message was rejected at the SMTP DATA stage with `EMESSAGE`, status `550`, and an unusual-sending-activity response. The owner reported that Zoho's Blocked Accounts list was empty; the SMTP rejection did not establish that an account would appear in that list.

The owner then replaced the mailbox with `info@paymi.co.uk` and supplied its new app password. The saved local `.env` still contained the old sender, so both transactional credentials were updated in that ignored file. The new sender passed SMTP authentication, Zoho accepted one authorized test email, and the owner confirmed receiving it in the inbox. Credentials and the test recipient are intentionally excluded from this document.

Production uses PM2 on the `vino` DigitalOcean Droplet. The owner ran `npm run check:mail` there and reported `ETIMEDOUT` at stage `CONN`: the server cannot establish the SMTP connection, before authentication occurs. This matches DigitalOcean's documented outbound SMTP restrictions. A local delivery test does not test that network path. HTTPS delivery is now implemented but remains unconfigured until the owner sets up Zoho CPaaS and its Agent key. No hosted deployment, database migration or Zoho account change was performed by the agent.

## Implemented repairs

- Registration and password recovery return a safe, actionable HTTP 503 when mail sending fails. Security middleware preserves only fixed public messages; SMTP details stay private.
- New registration addresses receive a verification code; existing addresses receive sign-in guidance. Password recovery sends codes to existing accounts and account guidance to unregistered addresses. The public responses remain identical for both account states, including SMTP failures. Guidance messages create no account or reset proof.
- Cooldowns track pending versus accepted sends. Concurrent requests cannot report success while SMTP is still pending. Completed requests return the remaining resend wait without extending it.
- Failed attempts remove only their own proof/reservation, allowing a fresh send within existing abuse limits. Late failures cannot remove a newer resend's proof or cooldown. Failed resend attempts require requesting a fresh code; they do not restore a superseded code.
- SMTP success requires acceptance of the intended recipient. Structured recipients prevent address-list parsing, and internationalized domains are normalized for acceptance checks.
- `MAIL_TRANSPORT=zoho-api` sends all OTP/account-guidance messages through Zoho CPaaS HTTPS instead of SMTP. It validates the regional endpoint, refuses redirects, bounds request/response sizes and time, requires the documented acceptance result, and returns only safe error codes. It does not automatically retry ambiguous submissions or fall back to SMTP. The existing SMTP mode remains the default for current local configuration.
- Password reset consumes the proof, updates the password, clears obsolete reset tokens and revokes sessions in one database transaction. A storage failure rolls back proof consumption so the same code can be retried. Concurrent workers can commit only one reset.
- Mobile/web auth screens show failures without advancing, prevent duplicate/overlapping requests, use server-based countdown deadlines after backgrounding, support formatted six-digit paste, and provide sign-in/email-correction paths. The admin frontend has no active OTP screen; admin and employee accounts use the shared recovery API.

## Set up HTTPS delivery on production

1. Create or sign in to [Zoho CPaaS](https://www.zoho.com/cpaas/), previously ZeptoMail. Add `paymi.co.uk` under Domains and associate it with an Agent for Paymi transactional mail. Add the DKIM/TXT and CNAME records shown by Zoho to your DNS, then click Verify. Complete any account approval/credit requirements in Zoho. Use the values supplied to your own account; see [domain setup](https://www.zoho.com/cpaas/help/domains.html).
2. Open the Agent's **SMTP/API → API Setup** section. Copy its API key and regional endpoint into the backend's private environment. This is a separate key from the mailbox app password; see [API authentication](https://www.zoho.com/cpaas/help/api/api-authentication.html).

```dotenv
MAIL_TRANSPORT=zoho-api
MAIL_FROM=info@paymi.co.uk
# Example for an India CPaaS account. Copy the actual URL from API Setup.
ZOHO_MAIL_API_URL=https://cpaas.zoho.in/v1.1/email
ZOHO_MAIL_API_KEY=REPLACE_WITH_YOUR_AGENT_API_KEY
```

3. Deploy the reviewed backend code and set these variables in the production environment. API mode uses no `MAIL_PASS` or `MAIL_PORT`. Keep credentials in `.env` or your secret manager. The known checkout is `/var/www/product-A-backend`; verify that it is the running PM2 process's checkout. Environment values supplied by PM2 take precedence over dotenv, so update that source too if it defines conflicting values.
4. Run `npm run check:mail` from that directory. **In HTTPS mode this validates configuration only; it sends no network request and does not verify the API key or domain.** To test actual delivery, run `npm run check:mail -- --to your-address@example.com` with a mailbox you control or are authorized to contact. Confirm receipt and check CPaaS delivery logs if necessary. Acceptance alone does not prove inbox placement.
5. Use `pm2 ls` to identify the existing API process, then restart it with `pm2 restart <actual-api-name-or-id> --update-env`. Verify registration and password recovery through the production app. No extra npm package, schema migration or mobile release is needed for this transport change.

### Deployment/configuration checks

The owner identified the existing PM2 API as **`A-backend` (ID 0)**. Its restart command is `pm2 restart A-backend --update-env`.

The HTTPS implementation includes the new `src/services/zohoMailApi.js` file. Commit and push it along with the modified mail service, diagnostics and check script before pulling on the server. New untracked files are not included by `git commit -a`. The older check script prints `SMTP check failed` and always attempts SMTP, even if `MAIL_TRANSPORT=zoho-api` is in `.env`. Updating environment settings alone cannot add the HTTPS implementation to that old code.

After pulling, `npm run check:mail` must begin with `Mail transport: zoho-api` for this configuration. It then validates settings without making a network request. Use normal `.env` assignment lines with no shell continuation backslashes and an ordinary `https://` URL. Store the API token only; the implementation also accepts the `Zoho-enczapikey` prefix copied from Zoho's curl example and ensures the outgoing header contains that prefix exactly once. Credentials remain excluded from Git and diagnostics.

The diagnostic command emits only allowlisted error codes, protocol status/stage and rejection categories. `EAUTH` points to credentials/account SMTP settings; connection errors point to server networking; `EMESSAGE` at DATA indicates message rejection, including the observed provider sending block. Do not repeatedly retry a known provider block.

### Local delivery succeeds but production fails

In SMTP mode, `npm run check:mail` tests DNS, connection, TLS and authentication without sending a message. Run it **on the server**, not just the laptop. The app's public `REGISTRATION_EMAIL_UNAVAILABLE` response alone does not establish an SMTP failure: the route also returns it when OTP storage/delivery-state updates fail or another send is still pending.

[DigitalOcean documents that outbound SMTP ports 25, 465 and 587 are blocked on Droplets](https://docs.digitalocean.com/support/why-is-smtp-blocked/). The server's observed connection-stage timeout is consistent with this restriction. Changing between those ports or rotating a working password does not resolve that hosting restriction. The HTTPS transport above uses port 443 and requires the CPaaS Agent key and verified sender domain.

If the server's standalone SMTP check succeeds, inspect the auth controller's safe error code in PM2 logs for a failed registration attempt. `EAUTH` suggests the PM2 process may still have different credentials from the standalone check; `EMESSAGE` indicates message rejection; a database or `OTP_DELIVERY_EXPIRED` code requires investigation of the storage/delivery-state path. Do not paste a full `pm2 env` dump, which exposes secrets.

If a sending restriction returns while Blocked Accounts is empty, sign in to the actual sending mailbox and use its banner or Zoho's UnblockMe page. If no restriction is visible there, provide Zoho support with the SMTP status, rejection category, sender and attempt time. See [Zoho's account-block troubleshooting](https://www.zoho.com/mail/help/usage-policy.html). Zoho's current policy excludes automated/transactional email from regular Zoho Mail and directs OTP senders to Zoho CPaaS; plan a transactional service for sustained production OTP delivery. No provider migration has been performed.

## Verification

- 54 backend tests passed across `mailService`, `zohoMailApi`, `authenticationSecurity`, `httpSecurity`, `authenticationRoutesSecurity` and `passwordRecovery`.
- A subsequent 13-test mail suite passed after adding copied-prefix normalization, malformed-key rejection and an explicit transport label in the diagnostic command.
- Route/database tests used a disposable local PostgreSQL database and mocked SMTP/HTTPS; they did not alter business data or send email. API tests cover valid acceptance, private rejection diagnostics, timeouts, endpoint/redirect protection, response bounds, no SMTP fallback, and complete registration/reset flows.
- Coverage includes accepted/rejected recipients, private responses for both account states, pending-send races, failed-send cleanup, resend timing, unchanged abuse quotas, complete registration/reset flows, reset rollback, and competing workers.
- 154 mobile tests passed, including OTP behavioral regressions; TypeScript and focused ESLint checks passed.
- Live SMTP authentication, acceptance and inbox receipt succeeded locally with the replacement sender. Production's SMTP connection timed out. Live HTTPS delivery remains unverified pending CPaaS setup, production configuration and deployment.
