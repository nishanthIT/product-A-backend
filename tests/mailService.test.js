import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import nodemailer from 'nodemailer';
import { mailTransportOptions } from '../src/services/mailService.js';
import { safeLogger } from '../src/services/safeLogger.js';

const configuration = {
  MAIL_HOST: ' smtp.example.test ', MAIL_PORT: '465',
  MAIL_USER: ' noreply@example.test ', MAIL_PASS: 'fixture-only-password',
};

test('transactional SMTP uses MAIL credentials, implicit TLS on 465 and bounded timeouts', () => {
  const options = mailTransportOptions({ ...configuration, EMAIL_PASS: 'unrelated-expiry-password' });
  assert.equal(options.host, 'smtp.example.test');
  assert.deepEqual(options.auth, { user: 'noreply@example.test', pass: configuration.MAIL_PASS });
  assert.equal(options.port, 465);
  assert.equal(options.secure, true);
  assert.equal(options.requireTLS, false);
  for (const key of ['connectionTimeout', 'greetingTimeout', 'socketTimeout']) {
    assert.ok(options[key] > 0 && options[key] <= 10000);
  }
  assert.equal(options.logger, false);
  assert.equal(options.debug, false);
});

test('port 587 requires STARTTLS instead of an implicit TLS handshake', () => {
  const options = mailTransportOptions({ ...configuration, MAIL_PORT: '587' });
  assert.equal(options.secure, false);
  assert.equal(options.requireTLS, true);
});

test('missing credentials and invalid ports fail with safe diagnostic codes', () => {
  for (const pass of ['', '   ', undefined]) {
    assert.throws(() => mailTransportOptions({ ...configuration, MAIL_PASS: pass }), { code: 'MAIL_NOT_CONFIGURED' });
  }
  for (const port of ['invalid', '0', '65536', '465.5']) {
    assert.throws(() => mailTransportOptions({ ...configuration, MAIL_PORT: port }), { code: 'MAIL_CONFIG_INVALID' });
  }
});

test('registration and reset messages retain their recipient, code and expiry; verification sends no message', async () => {
  const previous = Object.fromEntries(Object.keys(configuration).map(key => [key, process.env[key]]));
  Object.assign(process.env, configuration);
  const messages = [];
  let created = 0, verified = 0, rejectNext = false;
  const transportMock = mock.method(nodemailer, 'createTransport', options => {
    created++;
    assert.equal(options.auth.user, 'noreply@example.test');
    return {
      verify: async () => { verified++; return true; },
      sendMail: async message => {
        if (rejectNext) throw Object.assign(new Error('SMTP rejected authentication'), { code: 'EAUTH' });
        messages.push(message);
        return { accepted: [message.to] };
      },
    };
  });
  try {
    const service = await import('../src/services/mailService.js?mail-test');
    assert.equal(created, 0, 'transporter must wait until environment has been loaded');
    await service.verifyMailConfiguration();
    assert.equal(verified, 1);
    assert.equal(messages.length, 0);
    await service.sendRegistrationOtpEmail('new-owner@example.test', '123456');
    await service.sendPasswordResetOtpEmail('owner@example.test', '654321');
    assert.equal(created, 1);
    assert.equal(messages.length, 2);
    for (const [index, code] of ['123456', '654321'].entries()) {
      assert.equal(messages[index].from, '"Paymi" <noreply@example.test>');
      assert.ok(messages[index].subject.includes(code));
      assert.ok(messages[index].text.includes(code));
      assert.ok(messages[index].html.includes(code));
      assert.match(messages[index].text, /10 minutes/);
    }
    assert.equal(messages[0].to, 'new-owner@example.test');
    assert.equal(messages[1].to, 'owner@example.test');
    rejectNext = true;
    await assert.rejects(service.sendRegistrationOtpEmail('new-owner@example.test', '123456'), { code: 'EAUTH' });
  } finally {
    transportMock.mock.restore();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

test('SMTP diagnostics retain the error code without logging credentials, recipient or OTP', () => {
  const output = [];
  const log = safeLogger('controller/auth.js', { warn: (...args) => output.push(args) });
  log.warn('Registration email delivery unavailable', Object.assign(
    new Error('SMTP secret fixture-only-password recipient new-owner@example.test code 123456'),
    { code: 'EAUTH', response: 'fixture-only-password', command: 'AUTH PLAIN' },
  ));
  assert.equal(output[0][1].error.code, 'EAUTH');
  assert.doesNotMatch(JSON.stringify(output), /fixture-only-password|new-owner@example\.test|123456|AUTH PLAIN/);
});
