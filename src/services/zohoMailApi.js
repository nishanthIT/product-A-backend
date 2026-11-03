// HTTPS transport for hosts that cannot make outbound SMTP connections.
// https://www.zoho.com/cpaas/help/api/email-sending.html
const apiHosts = new Set([
  'cpaas.zoho.com', 'cpaas.zoho.eu', 'cpaas.zoho.in',
  'cpaas.zoho.com.au', 'cpaas.zoho.com.cn', 'cpaas.zoho.jp',
]);
const responseLimit = 64 * 1024;

class MailApiError extends Error {
  constructor(code, details = {}) {
    super('Transactional HTTPS mail request failed');
    this.code = code;
    Object.assign(this, details);
  }
}

export function zohoMailApiOptions(env = process.env) {
  const suppliedKey = env.ZOHO_MAIL_API_KEY?.trim() || '';
  // Zoho's curl example includes the authorization scheme. Accept that copied
  // value as well as the raw token, but always send the scheme exactly once.
  const apiKey = suppliedKey.replace(/^Zoho-enczapikey(?:[ \t]+|$)/i, '').trim();
  if (!apiKey || /^REPLACE_/i.test(apiKey) || /[\r\n]/.test(suppliedKey) || /[\s\\"']/.test(apiKey)) {
    throw new MailApiError('MAIL_API_NOT_CONFIGURED');
  }
  let url;
  try { url = new URL(env.ZOHO_MAIL_API_URL?.trim()); } catch {
    throw new MailApiError('MAIL_API_CONFIG_INVALID');
  }
  // Prevent a mistyped endpoint or redirect from receiving the API key/OTP.
  if (url.protocol !== 'https:' || !apiHosts.has(url.hostname) || url.port
    || url.username || url.password || url.search || url.hash || url.pathname !== '/v1.1/email') {
    throw new MailApiError('MAIL_API_CONFIG_INVALID');
  }
  return { url: url.href, apiKey };
}

async function responseJson(response) {
  if (!response.body) throw new MailApiError('MAIL_API_RESPONSE_INVALID');
  const chunks = [];
  let length = 0;
  for await (const chunk of response.body) {
    length += chunk.length;
    if (length > responseLimit) throw new MailApiError('MAIL_API_RESPONSE_INVALID');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch {
    throw new MailApiError('MAIL_API_RESPONSE_INVALID');
  }
}

export async function sendZohoApiEmail(message, { env = process.env, fetchImpl = globalThis.fetch } = {}) {
  const { url, apiKey } = zohoMailApiOptions(env);
  try {
    // No automatic retry or SMTP fallback: an ambiguous failure might already
    // have submitted a message. Existing OTP request limits govern user retries.
    const response = await fetchImpl(url, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000),
      headers: { Authorization: `Zoho-enczapikey ${apiKey}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        from: { address: message.from, name: 'Paymi' },
        to: [{ email_address: { address: message.to } }],
        subject: message.subject,
        textbody: message.text,
        ...(message.html && { htmlbody: message.html }),
        track_opens: false, track_clicks: false,
      }),
    });
    let body;
    try { body = await responseJson(response); } catch (error) {
      if (response.ok || !(error instanceof MailApiError)) throw error;
      // Keep the useful HTTP status when an error response is HTML or empty.
    }
    if (!response.ok) {
      const code = [401, 403].includes(response.status) ? 'MAIL_API_AUTH_FAILED'
        : response.status === 429 ? 'MAIL_API_RATE_LIMITED'
          : response.status >= 500 ? 'MAIL_API_UNAVAILABLE' : 'MAIL_API_REJECTED';
      const providerCode = body?.data?.error_code;
      throw new MailApiError(code, {
        httpStatus: response.status,
        ...(typeof providerCode === 'string' && /^(EM|TM)_[0-9]{1,8}$/.test(providerCode) && { providerCode }),
      });
    }
    // Zoho's documented acceptance response uses EM_104. A generic HTTP 200
    // page or a JSON error must never become a false "code sent" response.
    if (body?.error || body?.message !== 'OK' || !Array.isArray(body.data)
      || body.data.length !== 1 || body.data[0]?.code !== 'EM_104') {
      throw new MailApiError('MAIL_NOT_ACCEPTED');
    }
  } catch (error) {
    if (error instanceof MailApiError) throw error;
    // Do not retain provider bodies, fetch URLs, recipients or nested causes.
    throw new MailApiError(['AbortError', 'TimeoutError'].includes(error?.name)
      ? 'MAIL_API_TIMEOUT' : 'MAIL_API_NETWORK');
  }
}
