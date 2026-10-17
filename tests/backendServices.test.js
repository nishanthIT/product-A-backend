import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout } from 'node:timers/promises';
import { getPrisma, resetDatabase } from './helpers/harness.js';
import { DatabaseCache } from '../src/services/databaseCache.js';
import { RedisService } from '../src/services/redisService.js';
import { verifyServiceSchema } from '../src/services/serviceReadiness.js';
import { serviceError } from '../src/services/serviceErrors.js';
let db, cache, directory, redisProcess;
before(async () => { await resetDatabase(); db = await getPrisma(); cache = new RedisService({ store: new DatabaseCache(db) }); });
after(async () => { await cache?.disconnect(); redisProcess?.kill(); await db?.$disconnect(); if(directory) await rm(directory,{recursive:true,force:true}); });
test('startup checks actual schema and supplies safe actionable diagnostics', async () => {
  assert.equal((await verifyServiceSchema(db)).sessions, 'ready');
  await db.$executeRawUnsafe('ALTER TABLE "ChatSuspension" RENAME COLUMN "scope" TO "old_scope"');
  try {
    await assert.rejects(verifyServiceSchema(db), error => {
      const safe = serviceError(error);
      assert.equal(safe.databaseCode, '42703'); assert.equal(error.service, 'sessions');
      assert.match(safe.action, /migrations/); return true;
    });
  } finally { await db.$executeRawUnsafe('ALTER TABLE "ChatSuspension" RENAME COLUMN "old_scope" TO "scope"'); }
});
test('startup rejects unapplied list migrations before accepting broken list requests', async () => {
  assert.equal((await verifyServiceSchema(db)).lists, 'ready');
  await db.$executeRawUnsafe('ALTER TABLE "ListProduct" RENAME COLUMN "outOfStockSourceListId" TO "old_origin"');
  try {
    await assert.rejects(verifyServiceSchema(db), error => {
      assert.equal(error.service, 'lists');
      assert.equal(serviceError(error).databaseCode, '42703');
      return true;
    });
  } finally { await db.$executeRawUnsafe('ALTER TABLE "ListProduct" RENAME COLUMN "old_origin" TO "outOfStockSourceListId"'); }
});
test('database fallback survives new instances and expires strings, hashes, lists and sets', async () => {
  await cache.set('otp:test', { digest: 'synthetic' }, 60);
  const restarted = new RedisService({ store: new DatabaseCache(db) });
  assert.deepEqual(await restarted.get('otp:test', true), { digest: 'synthetic' });
  await cache.hset('hash', 'field', { a: 1 }); assert.deepEqual(await restarted.hget('hash','field',true), { a: 1 });
  assert.equal(await cache.sadd('set','a','a','b'),2); assert.equal(await cache.srem('set','a','missing'),1);
  assert.deepEqual(await restarted.smembers('set'), ['b']);
  await cache.lpush('list', 'a','b','c'); assert.deepEqual(await restarted.lrange('list',0,-1),['c','b','a']);
  assert.deepEqual(await restarted.lrange('list',-2,-1),['b','a']);
  await cache.ltrim('list',0,0); assert.deepEqual(await restarted.lrange('list',0,-1),['c']);
  for (const key of ['otp:test','hash','set','list']) await cache.expire(key,-1);
  assert.equal(await restarted.get('otp:test'),null); assert.deepEqual(await restarted.hgetall('hash'),{});
  assert.deepEqual(await restarted.smembers('set'),[]); assert.deepEqual(await restarted.lrange('list',0,-1),[]);
  await cache.set('expired','old',-1); assert.equal(await restarted.get('expired'),null);
  await cache.hset('expiredHash','f','v'); await cache.expire('expiredHash',0.001); await setTimeout(10);
  assert.equal(await restarted.hget('expiredHash','f'),null);
  assert.equal(restarted.getStatus().mode,'postgresql');
});
test('concurrent rate limits have atomic increments and TTL, database failure stays fail closed', async () => {
  const other = new RedisService({ store: new DatabaseCache(db) });
  const counts = await Promise.all(Array.from({length:24}, (_,i)=>(i%2?other:cache).incr('rate',60)));
  assert.deepEqual(counts.sort((a,b)=>a-b),Array.from({length:24},(_,i)=>i+1));
  assert.ok((await cache.store.read('rate')).expiresAt > new Date());
  await cache.set('rate','99',-1); assert.equal(await other.incr('rate',60),1);
  const broken = new RedisService({ store: { increment: async () => { throw new Error('DB unavailable'); } } });
  await assert.rejects(broken.incr('rate',60),/DB unavailable/);
});
test('real Redis outage and reconnection cannot resurrect consumed or stale values', {timeout:15000}, async () => {
  directory = await mkdtemp('/tmp/paymi-redis-test-'); const socket = `${directory}/redis.sock`;
  redisProcess = spawn('/usr/bin/redis-server',['--port','0','--unixsocket',socket,'--save','','--appendonly','no'],{stdio:['ignore','pipe','pipe']});
  await new Promise((resolve,reject)=>{ redisProcess.once('error',reject); redisProcess.stdout.on('data',data=>{if(String(data).toLowerCase().includes('ready to accept connections'))resolve();}); });
  assert.equal(await cache.connect(socket),true);
  await cache.set('recovery','old',60);
  const old = await cache.client.get(cache.redisKey('recovery')); assert.ok(old);
  await cache.set('consumed','secret',60);
  const consumed = await cache.client.get(cache.redisKey('consumed'));
  await cache.disconnect(); await cache.set('recovery','new',60); await cache.del('consumed');
  const restarted = new RedisService({ store:new DatabaseCache(db) });
  assert.equal(await restarted.get('recovery'),'new'); assert.equal(await restarted.get('consumed'),null);
  assert.equal(await cache.connect(socket),true);
  await cache.client.set(cache.redisKey('recovery'),old); await cache.client.set(cache.redisKey('consumed'),consumed);
  assert.equal(await cache.get('recovery'),'new'); assert.equal(await cache.get('consumed'),null);
  const closed = once(redisProcess,'exit'); redisProcess.kill(); await closed; redisProcess = null; await setTimeout(10);
  await cache.set('after-outage','durable',60); assert.equal(await restarted.get('after-outage'),'durable');
  assert.equal(cache.getStatus().mode,'postgresql'); await cache.disconnect();
});
