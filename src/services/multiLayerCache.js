import redisService from './redisService.js';

const DEFAULT_MAX_ENTRIES = 500;
const DEFAULT_TTL_SECONDS = 300;
const GROUP_INDEX_PREFIX = 'cache:index:';

class MultiLayerCache {
  constructor({ maxEntries = DEFAULT_MAX_ENTRIES } = {}) {
    this.maxEntries = maxEntries;
    this.localCache = new Map();
    this.localGroups = new Map();
    this.inFlight = new Map();
    this.metrics = {
      localHits: 0,
      redisHits: 0,
      databaseHits: 0,
      misses: 0,
    };

    this.cleanupTimer = setInterval(() => {
      this.pruneExpired();
    }, 60000);

    if (typeof this.cleanupTimer.unref === 'function') {
      this.cleanupTimer.unref();
    }
  }

  _now() {
    return Date.now();
  }

  _createEntry(value, ttlSeconds) {
    const expiresAt = ttlSeconds ? this._now() + ttlSeconds * 1000 : null;
    return { value, expiresAt };
  }

  _isExpired(entry) {
    return Boolean(entry?.expiresAt && entry.expiresAt <= this._now());
  }

  _touchLocalKey(key, entry) {
    this.localCache.delete(key);
    this.localCache.set(key, entry);
  }

  _trackGroupKey(groupKey, key) {
    if (!groupKey) {
      return;
    }

    let keys = this.localGroups.get(groupKey);
    if (!keys) {
      keys = new Set();
      this.localGroups.set(groupKey, keys);
    }

    keys.add(key);
  }

  _removeGroupReference(groupKey, key) {
    if (!groupKey) {
      return;
    }

    const keys = this.localGroups.get(groupKey);
    if (!keys) {
      return;
    }

    keys.delete(key);
    if (keys.size === 0) {
      this.localGroups.delete(groupKey);
    }
  }

  _log(source, key) {
    console.log(`[CACHE] ${source} ${key}`);
  }

  async set(key, value, ttlSeconds = DEFAULT_TTL_SECONDS, groupKey = null) {
    const entry = this._createEntry(value, ttlSeconds);
    this.localCache.set(key, entry);
    this._trackGroupKey(groupKey, key);
    this._evictIfNeeded();

    try {
      await redisService.set(key, value, ttlSeconds);
      if (groupKey) {
        const indexKey = `${GROUP_INDEX_PREFIX}${groupKey}`;
        await redisService.sadd(indexKey, key);
        await redisService.expire(indexKey, ttlSeconds + 60);
      }
    } catch (error) {
      console.warn(`Cache write failed for ${key}:`, error.message);
    }
  }

  async getLocal(key) {
    const entry = this.localCache.get(key);
    if (!entry) {
      return null;
    }

    if (this._isExpired(entry)) {
      this.localCache.delete(key);
      return null;
    }

    this._touchLocalKey(key, entry);
    return entry.value;
  }

  async getRedis(key) {
    try {
      return await redisService.get(key, true);
    } catch (error) {
      console.warn(`Cache read failed for ${key}:`, error.message);
      return null;
    }
  }

  async readThrough({
    key,
    loader,
    ttlSeconds = DEFAULT_TTL_SECONDS,
    groupKey = null,
    cacheNull = false,
  }) {
    const localValue = await this.getLocal(key);
    if (localValue !== null) {
      this.metrics.localHits += 1;
      this._log('LOCAL_CACHE', key);
      return localValue;
    }

    const inFlight = this.inFlight.get(key);
    if (inFlight) {
      return inFlight;
    }

    const loadPromise = (async () => {
      const redisValue = await this.getRedis(key);
      if (redisValue !== null && redisValue !== undefined) {
        this.metrics.redisHits += 1;
        this._log('REDIS', key);
        await this.set(key, redisValue, ttlSeconds, groupKey);
        return redisValue;
      }

      this.metrics.misses += 1;
      const databaseValue = await loader();
      if (databaseValue === null || databaseValue === undefined) {
        if (cacheNull) {
          await this.set(key, databaseValue, ttlSeconds, groupKey);
        }
        return databaseValue;
      }

      this.metrics.databaseHits += 1;
      this._log('DATABASE', key);
      await this.set(key, databaseValue, ttlSeconds, groupKey);
      return databaseValue;
    })();

    this.inFlight.set(key, loadPromise);

    try {
      return await loadPromise;
    } finally {
      this.inFlight.delete(key);
    }
  }

  async invalidateKey(key, groupKey = null) {
    this.localCache.delete(key);
    this._removeGroupReference(groupKey, key);

    try {
      await redisService.del(key);
      if (groupKey) {
        await redisService.srem(`${GROUP_INDEX_PREFIX}${groupKey}`, key);
      }
    } catch (error) {
      console.warn(`Cache invalidation failed for ${key}:`, error.message);
    }
  }

  async invalidateGroup(groupKey) {
    if (!groupKey) {
      return;
    }

    const indexKey = `${GROUP_INDEX_PREFIX}${groupKey}`;
    const localKeys = this.localGroups.get(groupKey);
    const redisKeys = await redisService.smembers(indexKey);
    const keysToRemove = new Set([
      ...(localKeys ? Array.from(localKeys) : []),
      ...(redisKeys || []),
    ]);

    await Promise.all(Array.from(keysToRemove).map((key) => this.invalidateKey(key)));

    this.localGroups.delete(groupKey);
    await redisService.del(indexKey);
  }

  pruneExpired() {
    const now = this._now();
    for (const [key, entry] of this.localCache.entries()) {
      if (entry?.expiresAt && entry.expiresAt <= now) {
        this.localCache.delete(key);
      }
    }

    for (const [groupKey, keys] of this.localGroups.entries()) {
      for (const key of keys) {
        if (!this.localCache.has(key)) {
          keys.delete(key);
        }
      }

      if (keys.size === 0) {
        this.localGroups.delete(groupKey);
      }
    }
  }

  _evictIfNeeded() {
    while (this.localCache.size > this.maxEntries) {
      const oldestKey = this.localCache.keys().next().value;
      if (!oldestKey) {
        break;
      }

      this.localCache.delete(oldestKey);
      for (const keys of this.localGroups.values()) {
        keys.delete(oldestKey);
      }
    }
  }

  getStats() {
    return {
      ...this.metrics,
      localEntries: this.localCache.size,
      trackedGroups: this.localGroups.size,
      inFlight: this.inFlight.size,
    };
  }
}

const multiLayerCache = new MultiLayerCache();

export default multiLayerCache;
export { MultiLayerCache };