# Registration mail configuration and diagnostics

The local transactional mail configuration now uses the supplied replacement app credential for `noreply@paymi.co.uk`. Zoho SMTP authentication was verified successfully against the configured India endpoint. The credential is stored only in the ignored backend `.env`; it is not in source, tests, or this document.

The mail service now validates missing credentials and invalid ports, uses implicit TLS for port 465 or required STARTTLS for other SMTP ports, and bounds connection/greeting/socket waits. SMTP failures reach the existing safe logger with their error code; credentials, recipients, OTPs, and raw SMTP responses remain excluded.

The public registration/recovery responses remain generic so they do not reveal whether an email address has an account. OTP hashing, expiry, attempt limits, resend cooldown, and registration routes are unchanged. A successful generic response alone does not prove inbox delivery.

## Verification

- `node scripts/checkMail.js`: verified DNS/TLS/SMTP authentication without sending email.
- 13 focused mail and authentication unit tests passed.
- Eight authentication route integration tests passed against a disposable local PostgreSQL database with a mocked mail transport.
- The new route test requests a registration email, extracts its six-digit code from the captured message, checks resend cooldown preserves that code, and successfully creates the test account/shop using it.
- The local backend was restarted to load the replacement credential.

To check a server's actual mail configuration, run `node scripts/checkMail.js` from the backend directory. It prints only success or a safe diagnostic code. It sends no message and does not prove inbox placement or recipient acceptance.

Only the local environment was updated. A hosted deployment needs the same replacement `MAIL_PASS` in its secret configuration and a backend restart; no remote deployment was performed.
