import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createServer as createTcpServer } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Server } from 'socket.io';
import { initRealtimeAdapter } from '../src/realtime/redisAdapter.js';

const waitFor = async predicate => {
  for (let i = 0; i < 200; i++) { if (await predicate()) return; await delay(15); }
  assert.fail('Expected cross-instance realtime event did not arrive');
};

// This exercises the actual adapter and a disposable Redis process, not a mocked
// transport. It does not touch an application database or configured Redis.
test('two Socket.IO instances share user-room events and authorized remote-socket operations through Redis', async t => {
  const probe = createTcpServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const dir = await mkdtemp(path.join(tmpdir(), 'paymi-chat-redis-test-'));
  const redis = spawn('redis-server', ['--bind', '127.0.0.1', '--port', String(port), '--save', '', '--appendonly', 'no', '--dir', dir], { stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = '', missing = false;
  const ready = new Promise((resolve, reject) => {
    const capture = chunk => { logs += chunk.toString(); if (logs.includes('Ready to accept connections')) resolve(); };
    redis.stdout.on('data', capture); redis.stderr.on('data', capture);
    redis.once('error', error => { if (error.code === 'ENOENT') { missing = true; resolve(); } else reject(error); });
    redis.once('exit', code => { if (code !== null && code !== 0) reject(new Error(`Disposable Redis exited (${code})`)); });
  });
  const servers = [], clients = [], adapters = [];
  try {
    await Promise.race([ready, delay(5000).then(() => { throw new Error('Disposable Redis did not start'); })]);
    if (missing) { t.skip('redis-server is not installed'); return; }
    const { io: connect } = await import('socket.io-client');
    for (let i = 0; i < 2; i++) {
      const http = createServer(); const io = new Server(http);
      const adapter = await initRealtimeAdapter(io, { url: `redis://127.0.0.1:${port}`, key: `test:${port}` });
      adapters.push(adapter); servers.push({ io, http });
      io.on('connection', socket => {
        socket.join('user_EMPLOYEE_123'); socket.join('chat_test');
        socket.on('ready', ack => ack());
      });
      await new Promise(resolve => http.listen(0, '127.0.0.1', resolve));
      const client = connect(`http://127.0.0.1:${http.address().port}`, { auth: { token: `test-token-${i}`, supermarketId: 'shop-test' }, transports: ['websocket'], reconnection: false });
      clients.push(client); client.events = []; client.onAny((event, payload) => client.events.push({ event, payload }));
      await new Promise((resolve, reject) => { client.once('connect', resolve); client.once('connect_error', reject); });
      await client.timeout(3000).emitWithAck('ready');
    }
    assert.ok(adapters.every(adapter => adapter.mode === 'redis'));
    const sockets = await servers[0].io.in(['chat_test', 'user_EMPLOYEE_123']).fetchSockets();
    assert.equal(sockets.length, 2); assert.equal(new Set(sockets.map(socket => socket.id)).size, 2);
    assert.deepEqual(new Set(sockets.map(socket => socket.handshake.auth.token)), new Set(['test-token-0', 'test-token-1']));
    // chatBroadcast uses these remote socket operations after checking each
    // socket's current token/membership, including leaving revoked rooms.
    const remote = sockets.find(socket => socket.id === clients[1].id);
    remote.emit('message_received', { id: 'saved-message', chatId: 'test' });
    await waitFor(() => clients[1].events.some(event => event.event === 'message_received'));
    assert.equal(clients[0].events.filter(event => event.event === 'message_received').length, 0);
    await remote.leave('chat_test');
    await waitFor(async () => (await servers[0].io.in('chat_test').fetchSockets()).length === 1);
    servers[0].io.to('user_EMPLOYEE_123').emit('chats_changed', { chatId: 'test', reason: 'read' });
    await waitFor(() => clients.every(client => client.events.some(event => event.event === 'chats_changed')));
  } finally {
    clients.forEach(client => client.disconnect());
    for (const { io } of servers) await new Promise(resolve => io.close(resolve));
    await Promise.all(adapters.map(adapter => adapter.close()));
    if (redis.pid && redis.exitCode === null) {
      redis.kill('SIGTERM');
      await Promise.race([new Promise(resolve => redis.once('exit', resolve)), delay(3000)]);
      if (redis.exitCode === null) redis.kill('SIGKILL');
    }
    await rm(dir, { recursive: true, force: true });
  }
});
