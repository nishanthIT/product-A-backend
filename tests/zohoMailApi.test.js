import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import nodemailer from 'nodemailer';
import { zohoMailApiOptions, sendZohoApiEmail } from '../src/services/zohoMailApi.js';
import { mailFailureDetails } from '../src/services/mailDiagnostics.js';

const env = { ZOHO_MAIL_API_URL: 'https://cpaas.zoho.in/v1.1/email', ZOHO_MAIL_API_KEY: 'fixture-agent-key' };
const message = { from: 'info@example.test', to: 'recipient@example.test', subject: '123456 is your Paymi verification code', text: 'Your code is 123456', html: '<p>123456</p>' };
const accepted = () => Response.json({ data: [{ code: 'EM_104', message: 'OK' }], message: 'OK', request_id: 'fixture-request' });

test('HTTPS configuration requires an Agent key and a trusted regional endpoint', () => {
  assert.equal(zohoMailApiOptions(env).url, env.ZOHO_MAIL_API_URL);
  for (const url of [
    'http://cpaas.zoho.in/v1.1/email', 'https://cpaas.zoho.in.evil.test/v1.1/email',
    'https://evil.test/v1.1/email', 'https://cpaas.zoho.in:465/v1.1/email',
    'https://secret@cpaas.zoho.in/v1.1/email', 'https://cpaas.zoho.in/v1.1/email?key=secret',
    'https://cpaas.zoho.in/v1.1/email#secret', 'https://cpaas.zoho.in/other', '',
  ]) assert.throws(() => zohoMailApiOptions({ ...env, ZOHO_MAIL_API_URL: url }), { code: 'MAIL_API_CONFIG_INVALID' });
  for (const key of ['', ' ', 'REPLACE_WITH_KEY', 'key\nheader', 'Zoho-enczapikey', 'Zoho-enczapikey Zoho-enczapikey token', 'token\\', '"token"', undefined]) {
    assert.throws(() => zohoMailApiOptions({ ...env, ZOHO_MAIL_API_KEY: key, MAIL_PASS: 'smtp-is-not-an-api-key' }), { code: 'MAIL_API_NOT_CONFIGURED' });
  }
});

test('copying the curl authorization value sends the Zoho scheme exactly once', async () => {
  for (const key of ['fixture-agent-key', 'Zoho-enczapikey fixture-agent-key', '  zoho-enczapikey\tfixture-agent-key  ']) {
    const configured = { ...env, ZOHO_MAIL_API_KEY: key };
    assert.equal(zohoMailApiOptions(configured).apiKey, 'fixture-agent-key');
    await sendZohoApiEmail(message, { env: configured, fetchImpl: async (_url, options) => {
      assert.equal(options.headers.Authorization, 'Zoho-enczapikey fixture-agent-key');
      return accepted();
    } });
  }
});

test('HTTPS sends one authenticated request with tracking disabled and an abort signal', async () => {
  let calls = 0;
  await sendZohoApiEmail(message, { env, fetchImpl: async (url, options) => {
    calls++;
    assert.equal(url, env.ZOHO_MAIL_API_URL);
    assert.equal(options.method, 'POST');
    assert.equal(options.redirect, 'error');
    assert.ok(options.signal instanceof AbortSignal);
    assert.equal(options.headers.Authorization, `Zoho-enczapikey ${env.ZOHO_MAIL_API_KEY}`);
    assert.deepEqual(JSON.parse(options.body), {
      from: { address: message.from, name: 'Paymi' },
      to: [{ email_address: { address: message.to } }],
      subject: message.subject, textbody: message.text, htmlbody: message.html,
      track_opens: false, track_clicks: false,
    });
    return accepted();
  } });
  assert.equal(calls, 1);
});

test('provider failures return safe diagnostics and never retry automatically', async () => {
  for (const [status, code] of [[400, 'MAIL_API_REJECTED'], [401, 'MAIL_API_AUTH_FAILED'], [403, 'MAIL_API_AUTH_FAILED'], [429, 'MAIL_API_RATE_LIMITED'], [503, 'MAIL_API_UNAVAILABLE']]) {
    let calls = 0;
    await assert.rejects(sendZohoApiEmail(message, { env, fetchImpl: async () => {
      calls++;
      return Response.json({ data: { error_code: 'TM_3004', message: 'recipient@example.test 123456 fixture-agent-key' }, message: 'error' }, { status });
    } }), error => {
      assert.equal(error.code, code);
      assert.deepEqual(mailFailureDetails(error), { code, httpStatus: status, providerCode: 'TM_3004' });
      assert.doesNotMatch(JSON.stringify(error) + error.message, /recipient@|123456|fixture-agent-key/);
      return true;
    });
    assert.equal(calls, 1);
  }
  await assert.rejects(sendZohoApiEmail(message, { env, fetchImpl: async () => new Response('private HTML error', { status: 502 }) }), { code: 'MAIL_API_UNAVAILABLE' });
});

test('HTTP success requires documented acceptance and a bounded valid response', async () => {
  for (const body of [{}, { error: 'rejected', message: 'OK', data: [{ code: 'EM_104' }] }, { message: 'OK', data: [] }, { message: 'OK', data: [{ code: 'UNKNOWN' }] }]) {
    await assert.rejects(sendZohoApiEmail(message, { env, fetchImpl: async () => Response.json(body) }), { code: 'MAIL_NOT_ACCEPTED' });
  }
  for (const body of ['not JSON', JSON.stringify({ content: 'x'.repeat(70000) })]) {
    await assert.rejects(sendZohoApiEmail(message, { env, fetchImpl: async () => new Response(body) }), { code: 'MAIL_API_RESPONSE_INVALID' });
  }
});

test('network and timeout errors discard private fetch messages and nested causes', async () => {
  for (const [name, code] of [['TimeoutError', 'MAIL_API_TIMEOUT'], ['AbortError', 'MAIL_API_TIMEOUT'], ['TypeError', 'MAIL_API_NETWORK']]) {
    await assert.rejects(sendZohoApiEmail(message, { env, fetchImpl: async () => {
      throw Object.assign(new Error('fixture-agent-key recipient@example.test 123456'), { name, cause: { token: 'fixture-agent-key' } });
    } }), error => {
      assert.equal(error.code, code);
      assert.doesNotMatch(error.message + JSON.stringify(error), /fixture-agent-key|recipient@|123456/);
      return true;
    });
  }
});

test('all OTP mail uses HTTPS when selected, without SMTP credentials or silent fallback', async () => {
  const values = { ...env, MAIL_TRANSPORT: 'zoho-api', MAIL_FROM: 'info@example.test', MAIL_USER: '', MAIL_PASS: '' };
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  Object.assign(process.env, values);
  const messages = [];
  let reject = false;
  const smtp = mock.method(nodemailer, 'createTransport', () => assert.fail('SMTP must not be used in HTTPS mode'));
  const http = mock.method(globalThis, 'fetch', async (_url, options) => {
    messages.push(JSON.parse(options.body));
    return reject ? Response.json({ message: 'error' }, { status: 401 }) : accepted();
  });
  try {
    const service = await import('../src/services/mailService.js?https-tests');
    assert.deepEqual(await service.verifyMailConfiguration(), { transport: 'zoho-api', authenticationVerified: false });
    assert.equal(messages.length, 0, 'configuration check must not send a message or claim to authenticate');
    await service.sendRegistrationOtpEmail('owner@bücher.example', '123456');
    await service.sendPasswordResetOtpEmail('owner@example.test', '654321');
    await service.sendRegistrationSignInEmail('owner@example.test');
    await service.sendPasswordResetSignUpEmail('owner@example.test');
    await service.sendMailTestEmail('owner@example.test');
    assert.equal(messages.length, 5);
    assert.ok(messages.every(value => value.from.address === 'info@example.test'));
    assert.equal(messages[0].to[0].email_address.address, 'owner@xn--bcher-kva.example');
    assert.match(messages[0].htmlbody, /123456/);
    assert.match(messages[1].htmlbody, /654321/);
    reject = true;
    await assert.rejects(service.sendRegistrationOtpEmail('owner@example.test', '123456'), { code: 'MAIL_API_AUTH_FAILED' });
    assert.equal(messages.length, 6);
    process.env.MAIL_FROM = '';
    await assert.rejects(service.verifyMailConfiguration(), { code: 'MAIL_CONFIG_INVALID' });
    process.env.MAIL_TRANSPORT = 'typo';
    await assert.rejects(service.verifyMailConfiguration(), { code: 'MAIL_CONFIG_INVALID' });
  } finally {
    smtp.mock.restore(); http.mock.restore();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});
