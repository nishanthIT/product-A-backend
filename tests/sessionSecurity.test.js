import test from 'node:test';
import assert from 'node:assert/strict';
import { jwtSecret, readSessionToken, sessionCookieOptions } from '../src/services/sessionSecurity.js';

test('explicit credentials cannot authenticate as the previous cookie account', () => {
  assert.equal(readSessionToken({ headers: { authorization: 'Bearer new-account' }, cookies: { auth_token: 'old-account' } }), 'new-account');
  assert.equal(readSessionToken({ headers: { authorization: 'Basic invalid' }, cookies: { auth_token: 'old-account' } }), null);
  assert.equal(readSessionToken({ headers: {}, cookies: { auth_token: 'browser-account' } }), 'browser-account');
});

test('missing and known fallback signing secrets fail closed', () => {
  const previous = process.env.JWT_SECRET;
  try {
    delete process.env.JWT_SECRET;
    assert.throws(jwtSecret, /private JWT_SECRET/);
    process.env.JWT_SECRET = 'your-secret-key';
    assert.throws(jwtSecret, /private JWT_SECRET/);
    process.env.JWT_SECRET = 'disposable-test-secret';
    assert.equal(jwtSecret(), 'disposable-test-secret');
  } finally {
    if (previous === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = previous;
  }
});

test('production cookies require TLS and resist cross-site requests', () => {
  const previous = process.env.NODE_ENV;
  try {
    process.env.NODE_ENV = 'production';
    assert.deepEqual(sessionCookieOptions(), { secure: true, httpOnly: true, sameSite: 'lax', path: '/' });
    process.env.NODE_ENV = 'development';
    assert.equal(sessionCookieOptions().secure, false);
  } finally {
    if (previous === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous;
  }
});
