import Redis from 'ioredis';
import { DatabaseCache, cacheKey } from './databaseCache.js';
import { serviceError } from './serviceErrors.js';

const encode = value => typeof value === 'object' ? JSON.stringify(value) : String(value);
const parse = (value, json) => { if (value && json) { try { return JSON.parse(value); } catch {} } return value; };
const expires = seconds => seconds == null ? null : new Date(Date.now() + seconds * 1000);
function typed(entry, type, empty) {
  if (entry && entry.type !== type) throw Object.assign(new Error('Cache value has the wrong type'), { code: 'WRONGTYPE' });
  return entry?.value ?? empty;
}
function range(list, start, stop) {
  const first = Math.max(0, start < 0 ? list.length + start : start);
  const last = stop < 0 ? list.length + stop : stop;
  return last < first ? [] : list.slice(first, last + 1);
}

export class RedisService {
  constructor({ store = new DatabaseCache(), clientFactory = (url, options) => new Redis(url, options) } = {}) {
    this.store = store;
    this.clientFactory = clientFactory;
    this.client = null;
    this.isConnected = false;
  }
  redisKey(key) { return `paymi:cache:v2:${cacheKey(key)}`; }
  async connect(url = process.env.REDIS_URL || 'redis://127.0.0.1:6379') {
    // Verify the fallback before reporting Redis/cache readiness.
    await this.store.metadata('__readiness__');
    if (this.client) this.client.disconnect();
    this.client = this.clientFactory(url, {
      maxRetriesPerRequest: 1, retryStrategy: null, enableOfflineQueue: false,
      connectTimeout: 3000, commandTimeout: 3000, lazyConnect: true,
    });
    this.client.on('error', error => {
      this.isConnected = false;
      console.error('Redis connection error; PostgreSQL cache remains authoritative', serviceError(error));
    });
    this.client.on('close', () => { this.isConnected = false; });
    try {
      await this.client.connect();
      await this.client.ping();
      this.isConnected = true;
      console.log('Redis ready; durable PostgreSQL fallback ready');
    } catch (error) {
      this.isConnected = false;
      console.warn('Redis unavailable; using PostgreSQL cache', serviceError(error));
      this.client.disconnect(); this.client = null;
    }
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    this.cleanupTimer = setInterval(() => {
      this.store.pruneExpired().catch(error => console.error('Database cache expiry cleanup failed', serviceError(error)));
    }, 60000);
    this.cleanupTimer.unref();
    return this.isConnected;
  }
  async redis(command, ...args) {
    if (!this.isConnected || !this.client) return null;
    try { return await this.client[command](...args); }
    catch (error) {
      console.error(`Redis ${command.toUpperCase()} failed; using PostgreSQL cache`, serviceError(error));
      this.isConnected = false; this.client.disconnect();
      return null;
    }
  }
  async mirror(key, entry) {
    if (!entry) { await this.redis('del', this.redisKey(key)); return; }
    // Revision comparison against PostgreSQL prevents stale data being read after
    // outages, competing writes or restarts. Bound redundant Redis retention.
    const ttl = Math.min(300000, entry.expiresAt ? entry.expiresAt.getTime() - Date.now() : 300000);
    if (ttl > 0) await this.redis('set', this.redisKey(key), JSON.stringify(entry), 'PX', Math.ceil(ttl));
  }
  async read(key) {
    if (!this.isConnected) return this.store.read(key);
    const metadata = await this.store.metadata(key);
    if (!metadata) return null; // Old Redis values cannot resurrect removed keys.
    const cached = await this.redis('get', this.redisKey(key));
    if (cached) {
      try { const entry = JSON.parse(cached); if (entry.revision === metadata.revision) return entry; }
      catch { console.error('Invalid Redis cache payload; reading PostgreSQL'); }
    }
    const entry = await this.store.read(key);
    await this.mirror(key, entry);
    return entry;
  }
  async change(key, fn) {
    const { entry, result } = await this.store.mutate(key, fn);
    await this.mirror(key, entry);
    return result;
  }
  async set(key, value, seconds = null) {
    await this.mirror(key, await this.store.setValue(key, encode(value), expires(seconds)));
    return true;
  }
  async get(key, json = false) { return parse(typed(await this.read(key), 'string', null), json); }
  async del(key) { await this.store.remove(key); await this.mirror(key, null); return true; }
  async exists(key) { return !!await this.store.metadata(key); }
  async expire(key, seconds) {
    return this.change(key, entry => ({ entry: entry && seconds > 0 ? { ...entry, expiresAt: expires(seconds) } : null, result: !!entry }));
  }
  async incr(key, windowSeconds = null) {
    const entry = await this.store.increment(key, expires(windowSeconds));
    await this.mirror(key, entry);
    return Number(entry.value);
  }
  async hset(key, field, value) {
    return this.change(key, entry => ({ entry: { ...entry, type: 'hash', value: { ...typed(entry, 'hash', {}), [field]: encode(value) } }, result: true }));
  }
  async hget(key, field, json = false) {
    const hash = typed(await this.read(key), 'hash', {});
    return parse(Object.hasOwn(hash, field) ? hash[field] : null, json);
  }
  async hgetall(key) { return typed(await this.read(key), 'hash', {}); }
  async hdel(key, field) {
    return this.change(key, entry => {
      const hash = { ...typed(entry, 'hash', {}) }; delete hash[field];
      return { entry: Object.keys(hash).length ? { ...entry, type: 'hash', value: hash } : null, result: true };
    });
  }
  async lpush(key, ...values) {
    return this.change(key, entry => {
      const list = [...values.map(encode).reverse(), ...typed(entry, 'list', [])];
      return { entry: { ...entry, type: 'list', value: list }, result: list.length };
    });
  }
  async lrange(key, start, stop) { return range(typed(await this.read(key), 'list', []), start, stop); }
  async ltrim(key, start, stop) {
    return this.change(key, entry => {
      const list = range(typed(entry, 'list', []), start, stop);
      return { entry: list.length ? { ...entry, type: 'list', value: list } : null, result: true };
    });
  }
  async sadd(key, ...members) {
    return this.change(key, entry => {
      const old = typed(entry, 'set', []), value = [...new Set([...old, ...members.map(String)])];
      return { entry: { ...entry, type: 'set', value }, result: value.length - old.length };
    });
  }
  async srem(key, ...members) {
    return this.change(key, entry => {
      const old = typed(entry, 'set', []), remove = members.map(String), value = old.filter(member => !remove.includes(member));
      return { entry: value.length ? { ...entry, type: 'set', value } : null, result: old.length - value.length };
    });
  }
  async smembers(key) { return typed(await this.read(key), 'set', []); }
  async sismember(key, member) { return (await this.smembers(key)).includes(String(member)); }
  async publish(channel, message) {
    // No callers currently use Pub/Sub. It cannot be emulated by a database cache.
    const result = await this.redis('publish', channel, encode(message));
    if (result === null) throw new Error('Redis Pub/Sub unavailable');
    return result;
  }
  getClient() { return this.client; }
  isRedisConnected() { return this.isConnected; }
  getStatus() { return { connected: this.isConnected, mode: this.isConnected ? 'redis' : 'postgresql', persistence: 'postgresql' }; }
  async disconnect() {
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    this.isConnected = false;
    this.client?.disconnect(); this.client = null;
  }
}
export default new RedisService();
