import nodemailer from 'nodemailer';

/**
 * Zoho Mail transporter for transactional Paymi email (OTP + password reset).
 * Uses MAIL_* env vars so the legacy EMAIL_* gmail config used by the expiry
 * service keeps working independently.
 *
 * Created lazily so dotenv.config() (which runs after imports in server.js)
 * has populated process.env by the time we read it.
 */
let transporter = null;

function getTransporter() {
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: process.env.MAIL_HOST || 'smtp.zoho.eu',
      port: Number(process.env.MAIL_PORT || 465),
      secure: true,
      auth: {
        user: process.env.MAIL_USER || 'noreply@paymi.co.uk',
        pass: process.env.MAIL_PASS,
      },
    });
  }
  return transporter;
}

const from = () => `"Paymi" <${process.env.MAIL_USER || 'noreply@paymi.co.uk'}>`;

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
  await getTransporter().sendMail({
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

export async function sendPasswordResetOtpEmail(to, code) {
  await getTransporter().sendMail({
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
