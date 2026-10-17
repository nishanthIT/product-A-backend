import redisService from './redisService.js';

const DEFAULT_TTL_SECONDS = 300;
const GROUP_INDEX_PREFIX = 'cache:index:';

class MultiLayerCache {
  constructor({ persistentCache = redisService } = {}) {
    this.persistentCache = persistentCache;
    this.inFlight = new Map();
    this.pending = new Set();
    this.locks = new Map();
    this.metrics = { localHits: 0, redisHits: 0, databaseHits: 0, misses: 0 };
  }

  // Cache contents stay in the revision-checked Redis/PostgreSQL service. A
  // process-local value would miss invalidations from another backend worker.
  async getLocal() { return null; }
  pruneExpired() {} // Persistent cache owns expiry, including during Redis outages.

  _log(source, key) { console.log(`[CACHE] ${source} ${key}`); }

  _withLock(scope, action) {
    const previous = this.locks.get(scope) || Promise.resolve();
    const result = previous.then(action);
    const settled = result.catch(() => {});
    this.locks.set(scope, settled);
    settled.then(() => {
      if (this.locks.get(scope) === settled) this.locks.delete(scope);
    });
    return result;
  }

  _withScope(key, groupKey, action) {
    const keyAction = () => this._withLock(JSON.stringify(['key', key]), action);
    return groupKey
      ? this._withLock(JSON.stringify(['group', groupKey]), keyAction)
      : keyAction();
  }

  _invalidatePending(predicate) {
    for (const operation of this.pending) {
      if (!predicate(operation)) continue;
      operation.invalidated = true;
      // A new request must not join a loader that started before this mutation.
      if (this.inFlight.get(operation.key) === operation) this.inFlight.delete(operation.key);
    }
  }

  async _publish(operation, value, ttlSeconds) {
    const { key, groupKey } = operation;
    await this._withScope(key, groupKey, async () => {
      if (operation.invalidated) return;
      try {
        // Record group membership before publishing the value. A failed index
        // update must not leave an untracked value that cannot be invalidated.
        if (groupKey) {
          const indexKey = `${GROUP_INDEX_PREFIX}${groupKey}`;
          await this.persistentCache.sadd(indexKey, key);
          await this.persistentCache.expire(indexKey, ttlSeconds + 60);
        }
        if (!operation.invalidated) await this.persistentCache.set(key, value, ttlSeconds);
      } catch (error) {
        console.warn(`Cache write failed for ${key}:`, error.message);
      }
    });
  }

  async set(key, value, ttlSeconds = DEFAULT_TTL_SECONDS, groupKey = null) {
    const operation = { key, groupKey, invalidated: false };
    this.pending.add(operation);
    try { await this._publish(operation, value, ttlSeconds); }
    finally { this.pending.delete(operation); }
  }

  async getRedis(key) {
    try { return await this.persistentCache.get(key, true); }
    catch (error) {
      console.warn(`Cache read failed for ${key}:`, error.message);
      return null;
    }
  }

  async readThrough({ key, loader, ttlSeconds = DEFAULT_TTL_SECONDS, groupKey = null, cacheNull = false }) {
    const existing = this.inFlight.get(key);
    if (existing) return existing.promise;

    const operation = { key, groupKey, invalidated: false };
    this.pending.add(operation);
    operation.promise = (async () => {
      const cachedValue = await this._withScope(key, groupKey, () => this.getRedis(key));
      if (cachedValue !== null && cachedValue !== undefined) {
        this.metrics.redisHits += 1;
        this._log('PERSISTENT_CACHE', key);
        // Reading must not renew the data/index TTL or perform database writes.
        return cachedValue;
      }

      this.metrics.misses += 1;
      const databaseValue = await loader();
      if (databaseValue !== null && databaseValue !== undefined) {
        this.metrics.databaseHits += 1;
        this._log('DATABASE', key);
      }
      if (cacheNull || (databaseValue !== null && databaseValue !== undefined)) {
        await this._publish(operation, databaseValue, ttlSeconds);
      }
      return databaseValue;
    })();
    this.inFlight.set(key, operation);

    try { return await operation.promise; }
    finally {
      this.pending.delete(operation);
      // An older load can finish after invalidation and a newer request started.
      if (this.inFlight.get(key) === operation) this.inFlight.delete(key);
    }
  }

  async invalidateKey(key, groupKey = null) {
    this._invalidatePending(operation => operation.key === key);
    await this._withScope(key, groupKey, async () => {
      await this.persistentCache.del(key);
      if (groupKey) await this.persistentCache.srem(`${GROUP_INDEX_PREFIX}${groupKey}`, key);
    });
  }

  async invalidateGroup(groupKey) {
    if (!groupKey) return;
    // Mark pending loaders before any network call. Publication and invalidation
    // share locks so a write already underway is removed before this resolves.
    this._invalidatePending(operation => operation.groupKey === groupKey);
    await this._withLock(JSON.stringify(['group', groupKey]), async () => {
      const indexKey = `${GROUP_INDEX_PREFIX}${groupKey}`;
      const keys = await this.persistentCache.smembers(indexKey);
      await Promise.all((keys || []).map(key => this._withLock(
        JSON.stringify(['key', key]), () => this.persistentCache.del(key),
      )));
      await this.persistentCache.del(indexKey);
    });
  }

  getStats() {
    return { ...this.metrics, localEntries: 0, trackedGroups: 0, inFlight: this.inFlight.size };
  }
}

const multiLayerCache = new MultiLayerCache();
export default multiLayerCache;
export { MultiLayerCache };
