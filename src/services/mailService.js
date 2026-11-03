import nodemailer from 'nodemailer';
import { domainToASCII } from 'node:url';

/**
 * Zoho Mail transporter for transactional Paymi email (OTP + password reset).
 * Uses MAIL_* env vars so the legacy EMAIL_* gmail config used by the expiry
 * service keeps working independently.
 *
 * Created lazily so dotenv.config() (which runs after imports in server.js)
 * has populated process.env by the time we read it.
 */
let transporter = null;

export function mailTransportOptions(env = process.env) {
  const host = env.MAIL_HOST?.trim() || 'smtp.zoho.eu';
  const user = env.MAIL_USER?.trim() || 'noreply@paymi.co.uk';
  const port = Number(env.MAIL_PORT || 465);
  if (!env.MAIL_PASS || !env.MAIL_PASS.trim()) {
    throw Object.assign(new Error('Transactional mail credentials are not configured'), { code: 'MAIL_NOT_CONFIGURED' });
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw Object.assign(new Error('Transactional mail port is invalid'), { code: 'MAIL_CONFIG_INVALID' });
  }
  return {
    host,
    port,
    secure: port === 465,
    requireTLS: port !== 465,
    auth: { user, pass: env.MAIL_PASS },
    // Do not leave OTP requests waiting on Nodemailer's multi-minute defaults.
    connectionTimeout: 5000,
    greetingTimeout: 5000,
    socketTimeout: 10000,
    logger: false,
    debug: false,
  };
}

function getTransporter() {
  if (!transporter) {
    transporter = nodemailer.createTransport(mailTransportOptions());
  }
  return transporter;
}

/** Checks DNS, TLS and SMTP authentication without sending an email. */
export async function verifyMailConfiguration() {
  return getTransporter().verify();
}

const from = () => `"Paymi" <${process.env.MAIL_USER?.trim() || 'noreply@paymi.co.uk'}>`;

const normalizeMailbox = address => {
  if (typeof address !== 'string' || !/^[^\s@<>;,"]+@[^\s@<>;,"]+\.[^\s@<>;,"]+$/.test(address)) return '';
  const [local, domain] = address.split('@');
  const asciiDomain = domainToASCII(domain);
  return asciiDomain ? `${local.toLowerCase()}@${asciiDomain.toLowerCase()}` : '';
};

async function sendTransactionalEmail(message) {
  const recipient = normalizeMailbox(message.to);
  if (!recipient) throw Object.assign(new Error('Invalid mail recipient'), { code: 'MAIL_INVALID_RECIPIENT' });
  // A structured address prevents SMTP list/display-name parsing of API input.
  const result = await getTransporter().sendMail({ ...message, to: { address: recipient } });
  // A completed SMTP call is only successful if the intended recipient was
  // accepted. This still does not guarantee inbox placement.
  if (!result?.accepted?.some(address => normalizeMailbox(address) === recipient)) {
    throw Object.assign(new Error('Mail provider did not accept the recipient'), { code: 'MAIL_NOT_ACCEPTED' });
  }
}

function otpTemplate({ heading, intro, code, footer }) {
  return `
    <div style="font-family: -apple-system, 'Segoe UI', Roboto, Arial, sans-serif; background:#F7F3EA; padding:32px 16px;">
      <div style="max-width:440px; margin:0 auto; background:#FFFFFF; border-radius:14px; overflow:hidden; border:1px solid #DDD2BF;">
        <div style="background:#C79A4B; padding:20px 28px;">
          <span style="color:#FFFFFF; font-size:22px; font-weight:700; letter-spacing:0.5px;">Paymi</span>
        </div>
        <div style="padding:28px;">
          <h2 style="margin:0 0 10px 0; color:#2B2620; font-size:19px;">${heading}</h2>
          <p style="margin:0 0 22px 0; color:#5D5548; font-size:14px; line-height:1.6;">${intro}</p>
          <div style="text-align:center; margin:0 0 22px 0;">
            <span style="display:inline-block; background:#F7F3EA; border:1px solid #DDD2BF; border-radius:10px; padding:14px 28px; font-size:30px; font-weight:700; letter-spacing:10px; color:#2B2620;">${code}</span>
          </div>
          <p style="margin:0 0 6px 0; color:#5D5548; font-size:13px;">This code expires in <strong>10 minutes</strong>.</p>
          <p style="margin:0; color:#8A8070; font-size:12px; line-height:1.6;">${footer}</p>
        </div>
      </div>
      <p style="max-width:440px; margin:14px auto 0 auto; text-align:center; color:#8A8070; font-size:11px;">© ${new Date().getFullYear()} Paymi · This is an automated message, please do not reply.</p>
    </div>`;
}

export async function sendRegistrationOtpEmail(to, code) {
  await sendTransactionalEmail({
    from: from(),
    to,
    subject: `${code} is your Paymi verification code`,
    text: `Your Paymi verification code is ${code}. It expires in 10 minutes. If you didn't create a Paymi account, you can ignore this email.`,
    html: otpTemplate({
      heading: 'Verify your email',
      intro: 'Welcome to Paymi! Enter this code in the app to finish creating your account.',
      code,
      footer: "If you didn't create a Paymi account, you can safely ignore this email — no account has been created.",
    }),
  });
}

// Keep account existence private in the HTTP response. An existing account's
// mailbox receives useful guidance instead of silently receiving nothing.
export async function sendRegistrationSignInEmail(to) {
  await sendTransactionalEmail({
    from: from(),
    to,
    subject: 'Your Paymi registration request',
    text: 'A Paymi account already uses this email address. Open the Paymi app and sign in, or use Forgot password to reset your password. No new account was created and your password has not changed. If you did not request registration, you can ignore this email.',
  });
}

export async function sendMailTestEmail(to) {
  await sendTransactionalEmail({
    from: from(),
    to,
    subject: 'Paymi email delivery test',
    text: 'This is a Paymi email delivery test requested by the server operator. It contains no verification code and does not create or change an account.',
  });
}

export async function sendPasswordResetOtpEmail(to, code) {
  await sendTransactionalEmail({
    from: from(),
    to,
    subject: `${code} is your Paymi password reset code`,
    text: `Your Paymi password reset code is ${code}. It expires in 10 minutes. If you didn't request a reset, you can ignore this email.`,
    html: otpTemplate({
      heading: 'Reset your password',
      intro: 'Enter this code in the Paymi app to choose a new password.',
      code,
      footer: "If you didn't request a password reset, you can safely ignore this email — your password has not been changed.",
    }),
  });
}

export async function sendPasswordResetSignUpEmail(to) {
  await sendTransactionalEmail({
    from: from(),
    to,
    subject: 'Your Paymi password reset request',
    text: 'There is no Paymi account using this email address. Check that you entered the email used to register, or open the Paymi app to create an account. No account or password has been changed. If you did not request a password reset, you can ignore this email.',
  });
}
