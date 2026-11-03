import 'dotenv/config';
import { verifyMailConfiguration, sendMailTestEmail, mailTransport } from '../src/services/mailService.js';
import { mailFailureDetails } from '../src/services/mailDiagnostics.js';

try {
  const args = process.argv.slice(2);
  const recipient = args[1];
  if (args.length && (args.length !== 2 || args[0] !== '--to'
    || !/^[^\s@<>;,]+@[^\s@<>;,]+\.[^\s@<>;,]+$/.test(recipient || '') || recipient.length > 254)) {
    throw Object.assign(new Error('Invalid command arguments'), { code: 'MAIL_CHECK_USAGE' });
  }
  const transport = mailTransport();
  console.log(`Mail transport: ${transport}`);
  await verifyMailConfiguration();
  if (recipient) {
    await sendMailTestEmail(recipient);
    console.log('The mail provider accepted the Paymi test email. Check the recipient inbox/spam folder and provider delivery logs to confirm delivery.');
  } else if (transport === 'zoho-api') {
    console.log('HTTPS mail configuration is valid. No network request or email was sent; API authentication and delivery are NOT verified. Use --to with an authorized test mailbox to check delivery.');
  } else {
    console.log('SMTP connection and authentication verified. No email was sent.');
  }
} catch (error) {
  // Never print the SMTP response: it can contain addresses or credentials.
  const details = mailFailureDetails(error);
  const { code } = details;
  const hints = {
    MAIL_CHECK_USAGE: 'Usage: node scripts/checkMail.js [--to address@example.com]. Use --to only for a mailbox you are authorized to send a test to.',
    MAIL_NOT_CONFIGURED: 'Set MAIL_PASS to the Zoho app password in the backend runtime environment.',
    MAIL_CONFIG_INVALID: 'Check MAIL_TRANSPORT, MAIL_FROM and MAIL_PORT. SMTP uses 465 for implicit TLS or 587 for STARTTLS.',
    EAUTH: 'Check MAIL_USER, the current Zoho app password, and the SMTP hostname shown in that account\'s Server Configuration Details.',
    EDNS: 'The server cannot resolve MAIL_HOST. Check DNS and the configured Zoho SMTP hostname.',
    ECONNECTION: 'Check outbound SMTP access from this server to MAIL_HOST and MAIL_PORT.',
    ETIMEDOUT: 'SMTP timed out. Check the server firewall and hosting-provider outbound SMTP restrictions.',
    ESOCKET: 'Check outbound SMTP connectivity, TLS certificates, MAIL_HOST and MAIL_PORT.',
    EENVELOPE: 'Zoho rejected the sender or recipient. Check sender authorization and Zoho delivery logs.',
    EMESSAGE: 'Zoho rejected the message. Check sending restrictions and Zoho delivery logs.',
    MAIL_NOT_ACCEPTED: 'The intended recipient was not accepted. Check Zoho delivery logs.',
    MAIL_API_NOT_CONFIGURED: 'Set ZOHO_MAIL_API_KEY to the Agent API key from Zoho CPaaS. A Zoho Mail app password cannot be used as this key.',
    MAIL_API_CONFIG_INVALID: 'Set ZOHO_MAIL_API_URL to the exact regional HTTPS /v1.1/email endpoint shown in your Zoho CPaaS API Setup page. Use a normal https:// URL with no backslashes or trailing line-continuation characters.',
    MAIL_API_AUTH_FAILED: 'Check the Agent API key, its data center, account approval and IP restrictions in Zoho CPaaS.',
    MAIL_API_RATE_LIMITED: 'Zoho CPaaS rate-limited the request. Wait before retrying and check sending limits.',
    MAIL_API_REJECTED: 'Zoho CPaaS rejected the request. Check the verified sender domain, account approval, sending credits and provider error code.',
    MAIL_API_UNAVAILABLE: 'Zoho CPaaS is temporarily unavailable. Check provider status before retrying.',
    MAIL_API_TIMEOUT: 'The HTTPS request timed out. Check outbound HTTPS access on port 443.',
    MAIL_API_NETWORK: 'The HTTPS request failed. Check DNS, TLS, outbound port 443 and the account-specific API endpoint.',
    MAIL_API_RESPONSE_INVALID: 'The HTTPS endpoint returned an invalid or oversized response. Check the API endpoint and provider status.',
  };
  console.error('Mail check failed.', details);
  console.error(hints[code] || 'Check the server mail configuration and Zoho delivery logs. Do not share credentials or raw SMTP responses.');
  process.exitCode = 1;
}
