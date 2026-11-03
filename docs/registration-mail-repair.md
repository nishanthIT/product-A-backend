# OTP delivery and password recovery

## Delivery status — 3 November 2026

The earlier sender authenticated but its test message was rejected at the SMTP DATA stage with `EMESSAGE`, status `550`, and an unusual-sending-activity response. The owner reported that Zoho's Blocked Accounts list was empty; the SMTP rejection did not establish that an account would appear in that list.

The owner then replaced the mailbox with `info@paymi.co.uk` and supplied its new app password. The saved local `.env` still contained the old sender, so both transactional credentials were updated in that ignored file. The new sender passed SMTP authentication, Zoho accepted one authorized test email, and the owner confirmed receiving it in the inbox. Credentials and the test recipient are intentionally excluded from this document.

The owner confirmed that production uses PM2. Hosted OTP delivery still needs verification after restarting the existing backend with its updated server environment. A successful local test does not establish that the PM2 process loaded the same configuration. No hosted deployment, database migration or Zoho account change was performed by the agent.

## Implemented repairs

- Registration and password recovery return a safe, actionable HTTP 503 when mail sending fails. Security middleware preserves only fixed public messages; SMTP details stay private.
- New registration addresses receive a verification code; existing addresses receive sign-in guidance. Password recovery sends codes to existing accounts and account guidance to unregistered addresses. The public responses remain identical for both account states, including SMTP failures. Guidance messages create no account or reset proof.
- Cooldowns track pending versus accepted sends. Concurrent requests cannot report success while SMTP is still pending. Completed requests return the remaining resend wait without extending it.
- Failed attempts remove only their own proof/reservation, allowing a fresh send within existing abuse limits. Late failures cannot remove a newer resend's proof or cooldown. Failed resend attempts require requesting a fresh code; they do not restore a superseded code.
- SMTP success requires acceptance of the intended recipient. Structured recipients prevent address-list parsing, and internationalized domains are normalized for acceptance checks.
- Password reset consumes the proof, updates the password, clears obsolete reset tokens and revokes sessions in one database transaction. A storage failure rolls back proof consumption so the same code can be retried. Concurrent workers can commit only one reset.
- Mobile/web auth screens show failures without advancing, prevent duplicate/overlapping requests, use server-based countdown deadlines after backgrounding, support formatted six-digit paste, and provide sign-in/email-correction paths. The admin frontend has no active OTP screen; admin and employee accounts use the shared recovery API.

## Restore delivery

1. Ensure the hosted backend environment contains the new transactional sender and its matching app password. Use `pm2 ls` to identify the existing API process, then restart that process with `pm2 restart <actual-api-name-or-id> --update-env`. The known checkout is `/var/www/product-A-backend`; verify that this is the running PM2 process's checkout. Do not start a second competing server. Environment variables supplied by PM2 take precedence over dotenv values; update that source too if it defines stale `MAIL_*` credentials.
2. Deploy the backend changes. Use the SMTP hostname shown in that Zoho account's Server Configuration Details. Port 465 uses implicit TLS; 587 requires STARTTLS. SMTP credentials remain separate from the legacy `EMAIL_*` expiry-notification configuration.
3. From the backend directory **on the hosted server**, run `npm run check:mail`. This checks authentication without sending email.
4. To test delivery to a mailbox you control or are authorized to contact, run `npm run check:mail -- --to your-address@example.com`. This sends a clearly labelled test with no OTP or account changes. Confirm it appears in the inbox/spam folder and inspect Zoho delivery logs if necessary. Acceptance alone does not prove inbox placement.
5. Release the mobile/web client updates and verify registration and password recovery with a controlled account after Zoho has restored sending.

The diagnostic command emits only allowlisted error codes, protocol status/stage and rejection categories. `EAUTH` points to credentials/account SMTP settings; connection errors point to server networking; `EMESSAGE` at DATA indicates message rejection, including the observed provider sending block. Do not repeatedly retry a known provider block.

If a sending restriction returns while Blocked Accounts is empty, sign in to the actual sending mailbox and use its banner or Zoho's UnblockMe page. If no restriction is visible there, provide Zoho support with the SMTP status, rejection category, sender and attempt time. See [Zoho's account-block troubleshooting](https://www.zoho.com/mail/help/usage-policy.html). Zoho's current policy excludes automated/transactional email from regular Zoho Mail and directs OTP senders to Zoho CPaaS; plan a transactional service for sustained production OTP delivery. No provider migration has been performed.

## Verification

- 47 backend tests passed across `mailService`, `authenticationSecurity`, `httpSecurity`, `authenticationRoutesSecurity` and `passwordRecovery`.
- Route/database tests used a disposable local PostgreSQL database and mocked SMTP; they did not alter business data or send email.
- Coverage includes accepted/rejected recipients, private responses for both account states, pending-send races, failed-send cleanup, resend timing, unchanged abuse quotas, complete registration/reset flows, reset rollback, and competing workers.
- 154 mobile tests passed, including OTP behavioral regressions; TypeScript and focused ESLint checks passed.
- Live SMTP authentication, acceptance and inbox receipt succeeded with the replacement sender. Hosted application OTP delivery remains to be checked after the PM2 environment reload.
