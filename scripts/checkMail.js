import 'dotenv/config';
import { verifyMailConfiguration } from '../src/services/mailService.js';

try {
  await verifyMailConfiguration();
  console.log('SMTP connection and authentication verified. No email was sent.');
} catch (error) {
  // Never print the SMTP response: it can contain addresses or credentials.
  const code = typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{0,40}$/.test(error.code)
    ? error.code : 'UNKNOWN';
  console.error('SMTP verification failed.', { code });
  process.exitCode = 1;
}
