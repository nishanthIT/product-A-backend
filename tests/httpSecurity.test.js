import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { createServer } from 'node:http';
import { Server } from 'socket.io';
import { io as connectSocket } from 'socket.io-client';
import { trustedProxySetting, corsConfiguration, csrfProtection, securityHeaders, requestConstraints, safeErrorHandler } from '../src/middleware/httpSecurity.js';
import { safeLogger } from '../src/services/safeLogger.js';

const env = { NODE_ENV: 'production', CORS_ALLOWED_ORIGINS: 'https://admin.example.test', PUBLIC_BASE_URL: 'https://api.example.test' };
let server, base;
before(async () => {
  const app = express();
  app.disable('x-powered-by'); app.set('trust proxy', trustedProxySetting('')); app.set('query parser', 'simple');
  app.use(securityHeaders, cors(corsConfiguration(env)), cookieParser(), csrfProtection(env), express.json({ limit: '256kb' }), requestConstraints);
  app.get('/api/ip', (req, res) => res.json({ ip: req.ip }));
  app.post('/api/write', (_req, res) => res.json({ ok: true }));
  app.get('/api/fail', (_req, res) => res.status(500).json({ details: 'database-secret', stack: 'private-stack' }));
  app.use(safeErrorHandler);
  server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { server?.closeAllConnections(); await new Promise(resolve => server?.close(resolve)); });

test('proxy trust defaults closed and rejects numeric hop counts/wildcards', async () => {
  assert.equal(trustedProxySetting(''), false);
  assert.deepEqual(trustedProxySetting('10.1.2.3,192.168.2.0/24'), ['10.1.2.3','192.168.2.0/24']);
  for (const value of ['1','true','*','127.0.0.1/99']) assert.throws(() => trustedProxySetting(value));
  const response = await fetch(`${base}/api/ip`, { headers: { 'X-Forwarded-For': '8.8.8.8' } });
  assert.equal((await response.json()).ip, '127.0.0.1');
});
test('CORS reflects only explicit trusted origins and permits security reauthentication header', async () => {
  const trusted = await fetch(`${base}/api/ip`, { headers: { Origin: 'https://admin.example.test' } });
  assert.equal(trusted.headers.get('access-control-allow-origin'), 'https://admin.example.test');
  const untrusted = await fetch(`${base}/api/ip`, { headers: { Origin: 'https://evil.example.test' } });
  assert.equal(untrusted.headers.get('access-control-allow-origin'), null);
  const preflight = await fetch(`${base}/api/write`, { method: 'OPTIONS', headers: { Origin: 'https://admin.example.test', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'X-Security-Reauth' } });
  assert.equal(preflight.status, 204);
  assert.match(preflight.headers.get('access-control-allow-headers'), /X-Security-Reauth/);
});
test('cookie mutations require trusted Origin; bearer native clients continue working', async () => {
  const write = headers => fetch(`${base}/api/write`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: '{}' });
  assert.equal((await write({ Cookie: 'auth_token=session' })).status, 403);
  assert.equal((await write({ Cookie: 'auth_token=session', Origin: 'https://evil.example.test' })).status, 403);
  assert.equal((await write({ Cookie: 'auth_token=session', Origin: 'https://admin.example.test' })).status, 200);
  assert.equal((await write({ Authorization: 'Bearer native-session' })).status, 200);
});
test('native API Origin and originless clients connect over both socket transports; foreign origins stay denied', async () => {
  const http = createServer();
  const options = corsConfiguration(env);
  const io = new Server(http, { cors: options,
    allowRequest: (req, callback) => options.origin(req.headers.origin, (_error, allowed) => callback(null, Boolean(allowed))),
  });
  await new Promise(resolve => http.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${http.address().port}`;
  try {
    for (const transport of ['websocket', 'polling']) {
      for (const origin of [undefined, env.PUBLIC_BASE_URL, 'https://untrusted.example.test']) {
        const socket = connectSocket(url, { transports: [transport], reconnection: false, timeout: 2000,
          ...(origin && { extraHeaders: { Origin: origin } }),
        });
        try {
          const connection = new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('connect_error', reject); });
          if (origin === 'https://untrusted.example.test') await assert.rejects(connection);
          else await connection;
        } finally { socket.disconnect(); }
      }
    }
  } finally { await new Promise(resolve => io.close(resolve)); }
});
test('headers prevent content sniffing, framing and caching; server errors redact internals', async () => {
  const response = await fetch(`${base}/api/fail`);
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('x-frame-options'), 'DENY');
  assert.equal(response.headers.get('x-powered-by'), null);
  assert.match(response.headers.get('cache-control'), /no-store/);
  assert.deepEqual(await response.json(), { error: 'Internal server error' });
});
test('query limits reject unbounded, duplicate, nested and malformed pagination parameters', async () => {
  for (const query of ['page=0','page=-1','page=1e9','page=1001','limit=501','page=1&page=2','q[x]=y',`q=${'x'.repeat(257)}`]) {
    assert.equal((await fetch(`${base}/api/ip?${query}`)).status, 400, query.slice(0,50));
  }
  assert.equal((await fetch(`${base}/api/ip?page=2&limit=50&q=cola`)).status, 200);
});
test('JSON body bounds reject oversized batches, pollution keys, malformed and huge bodies', async () => {
  const send = body => fetch(`${base}/api/write`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
  assert.equal((await send(JSON.stringify({ ids: Array(501).fill('x') }))).status, 400);
  assert.equal((await send('{"__proto__":{"polluted":true}}')).status, 400);
  assert.equal((await send('{broken')).status, 400);
  assert.equal((await send(JSON.stringify({ text: 'x'.repeat(270000) }))).status, 413);
  assert.equal({}.polluted, undefined);
});

test('application diagnostics omit request credentials, SQL values, pricing and error text', () => {
  const lines = [];
  const logger = safeLogger('test-component', { warn: (...values) => lines.push(values), error: (...values) => lines.push(values) });
  const error = Object.assign(new Error('SELECT secret_password FROM internal'), { code: 'P2022' });
  logger.log({ token: 'bearer-secret', supplierPrice: 123 });
  logger.error('password-value', error, { cookie: 'session-secret' });
  logger.warn('private-supplier-price', { email: 'private-person@example.test' });
  const output = JSON.stringify(lines);
  assert.equal(lines.length, 2); assert.match(output, /P2022/);
  for (const secret of ['SELECT', 'secret_password', 'bearer-secret', 'password-value', 'session-secret', 'private-supplier-price', 'private-person']) assert.ok(!output.includes(secret));
});
