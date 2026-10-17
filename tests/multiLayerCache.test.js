import test from 'node:test';
import assert from 'node:assert/strict';
import { MultiLayerCache } from '../src/services/multiLayerCache.js';

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

// This is an injected test double, never the application's outage fallback.
class PersistentCacheDouble {
  constructor() { this.values = new Map(); this.groups = new Map(); this.writes = []; this.now = 0; }
  async get(key) {
    const entry = this.values.get(key);
    return entry && entry.expiresAt > this.now ? entry.value : null;
  }
  async set(key, value, ttl) {
    this.writes.push(['set', key]);
    this.values.set(key, { value, expiresAt: this.now + ttl * 1000 });
  }
  async del(key) { this.writes.push(['del', key]); this.values.delete(key); this.groups.delete(key); }
  async sadd(key, value) { this.writes.push(['sadd', key]); const group = this.groups.get(key) || new Set(); group.add(value); this.groups.set(key, group); }
  async expire(key, ttl) { this.writes.push(['expire', key, ttl]); }
  async smembers(key) { return [...(this.groups.get(key) || [])]; }
  async srem(key, value) { this.writes.push(['srem', key]); this.groups.get(key)?.delete(value); }
}

function setup(persistentCache = new PersistentCacheDouble()) {
  return { store: persistentCache, cache: new MultiLayerCache({ persistentCache }) };
}

const request = (loader, key = 'inventory:page:1') => ({ key, groupKey: 'shop:inventory', ttlSeconds: 300, loader });

test('a persistent cache hit performs no writes and retains the remaining TTL', async () => {
  const { cache, store } = setup();
  await cache.set('inventory:page:1', ['old'], 10, 'shop:inventory');
  const originalExpiry = store.values.get('inventory:page:1').expiresAt;
  store.writes.length = 0;
  store.now = 9000;
  assert.deepEqual(await cache.readThrough(request(() => assert.fail('cache hit must not load'))), ['old']);
  assert.deepEqual(store.writes, []);
  assert.equal(store.values.get('inventory:page:1').expiresAt, originalExpiry);
  store.now = 10001;
  assert.deepEqual(await cache.readThrough(request(async () => ['fresh'])), ['fresh']);
});

test('another cache instance observes group invalidation instead of returning local inventory', async () => {
  const { cache, store } = setup();
  const other = new MultiLayerCache({ persistentCache: store });
  await cache.readThrough(request(async () => ['old']));
  await other.invalidateGroup('shop:inventory');
  assert.deepEqual(await cache.readThrough(request(async () => ['fresh'])), ['fresh']);
  assert.equal(cache.getStats().localEntries, 0);
});

for (const kind of ['group', 'key']) {
  test(`${kind} invalidation prevents a pending old loader from repopulating inventory`, async () => {
    const { cache, store } = setup();
    const started = deferred(), slow = deferred();
    const oldLoad = cache.readThrough(request(async () => { started.resolve(); return slow.promise; }));
    await started.promise;
    if (kind === 'group') await cache.invalidateGroup('shop:inventory');
    else await cache.invalidateKey('inventory:page:1', 'shop:inventory');

    const newStarted = deferred(), newData = deferred();
    const newLoad = cache.readThrough(request(async () => { newStarted.resolve(); return newData.promise; }));
    await newStarted.promise;
    slow.resolve(['old snapshot']);
    assert.deepEqual(await oldLoad, ['old snapshot']);
    assert.equal(await store.get('inventory:page:1'), null);
    // The old request's finally must not erase the new in-flight registration.
    const joined = cache.readThrough(request(() => assert.fail('must join newer load')));
    newData.resolve(['fresh']);
    assert.deepEqual(await newLoad, ['fresh']);
    assert.deepEqual(await joined, ['fresh']);
    assert.deepEqual(await store.get('inventory:page:1'), ['fresh']);
  });
}

test('group invalidation waits for a publication already writing then removes it', async () => {
  const { cache, store } = setup();
  const writing = deferred(), finishWrite = deferred();
  const originalSet = store.set.bind(store);
  store.set = async (...args) => { writing.resolve(); await finishWrite.promise; return originalSet(...args); };
  const load = cache.readThrough(request(async () => ['before mutation']));
  await writing.promise;
  const invalidation = cache.invalidateGroup('shop:inventory');
  finishWrite.resolve();
  await Promise.all([load, invalidation]);
  assert.equal(await store.get('inventory:page:1'), null);
  assert.deepEqual(await store.smembers('cache:index:shop:inventory'), []);
});

test('new requests wait for invalidation to finish before consulting persistent cache', async () => {
  const { cache, store } = setup();
  await cache.set('inventory:page:1', ['old'], 300, 'shop:inventory');
  const deleting = deferred(), finishDelete = deferred();
  const originalDel = store.del.bind(store);
  store.del = async key => { deleting.resolve(); await finishDelete.promise; return originalDel(key); };
  const invalidation = cache.invalidateGroup('shop:inventory');
  await deleting.promise;
  const fresh = cache.readThrough(request(async () => ['fresh']));
  finishDelete.resolve();
  await invalidation;
  assert.deepEqual(await fresh, ['fresh']);
});

test('a failed loader is shared and subsequent requests can load again', async () => {
  const { cache } = setup();
  const started = deferred(), result = deferred();
  const first = cache.readThrough(request(async () => { started.resolve(); return result.promise; }));
  await started.promise;
  const second = cache.readThrough(request(() => assert.fail('must share first load')));
  const checked = Promise.all([assert.rejects(first, /database unavailable/), assert.rejects(second, /database unavailable/)]);
  result.reject(new Error('database unavailable'));
  await checked;
  assert.equal(cache.getStats().inFlight, 0);
  assert.deepEqual(await cache.readThrough(request(async () => ['recovered'])), ['recovered']);
});

test('cache errors fall through to the source loader without serving an in-memory copy', async () => {
  const { cache, store } = setup();
  await cache.readThrough(request(async () => ['old']));
  store.get = async () => { throw new Error('cache unavailable'); };
  store.sadd = async () => { throw new Error('cache unavailable'); };
  assert.deepEqual(await cache.readThrough(request(async () => ['source result'])), ['source result']);
  assert.equal(cache.getStats().localEntries, 0);
});

test('failed invalidation rejects and releases the lock for a later valid invalidation', async () => {
  const { cache, store } = setup();
  await cache.set('inventory:page:1', ['old'], 300, 'shop:inventory');
  const originalDel = store.del.bind(store);
  store.del = async () => { throw new Error('cache delete unavailable'); };
  await assert.rejects(cache.invalidateKey('inventory:page:1', 'shop:inventory'), /cache delete unavailable/);
  store.del = originalDel;
  await cache.invalidateGroup('shop:inventory');
  assert.equal(await store.get('inventory:page:1'), null);
});
