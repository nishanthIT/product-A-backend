import 'dotenv/config';
import { verifyMailConfiguration, sendMailTestEmail } from '../src/services/mailService.js';
import { mailFailureDetails } from '../src/services/mailDiagnostics.js';

try {
  const args = process.argv.slice(2);
  const recipient = args[1];
  if (args.length && (args.length !== 2 || args[0] !== '--to'
    || !/^[^\s@<>;,]+@[^\s@<>;,]+\.[^\s@<>;,]+$/.test(recipient || '') || recipient.length > 254)) {
    throw Object.assign(new Error('Invalid command arguments'), { code: 'MAIL_CHECK_USAGE' });
  }
  await verifyMailConfiguration();
  if (recipient) {
    await sendMailTestEmail(recipient);
    console.log('SMTP accepted the Paymi test email. Check the recipient inbox/spam folder and Zoho delivery logs to confirm delivery.');
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
    MAIL_CONFIG_INVALID: 'Check MAIL_PORT: use 465 for implicit TLS or 587 for STARTTLS.',
    EAUTH: 'Check MAIL_USER, the current Zoho app password, and the SMTP hostname shown in that account\'s Server Configuration Details.',
    EDNS: 'The server cannot resolve MAIL_HOST. Check DNS and the configured Zoho SMTP hostname.',
    ECONNECTION: 'Check outbound SMTP access from this server to MAIL_HOST and MAIL_PORT.',
    ETIMEDOUT: 'SMTP timed out. Check the server firewall and hosting-provider outbound SMTP restrictions.',
    ESOCKET: 'Check outbound SMTP connectivity, TLS certificates, MAIL_HOST and MAIL_PORT.',
    EENVELOPE: 'Zoho rejected the sender or recipient. Check sender authorization and Zoho delivery logs.',
    EMESSAGE: 'Zoho rejected the message. Check sending restrictions and Zoho delivery logs.',
    MAIL_NOT_ACCEPTED: 'The intended recipient was not accepted. Check Zoho delivery logs.',
  };
  console.error('SMTP check failed.', details);
  console.error(hints[code] || 'Check the server mail configuration and Zoho delivery logs. Do not share credentials or raw SMTP responses.');
  process.exitCode = 1;
}
