import Redis from 'ioredis';

/**
 * Redis Service with graceful fallback to in-memory storage
 * - Works with Redis when available (production Linux: sudo apt install redis-server)
 * - Falls back to in-memory Map when Redis is not available (development)
 */

class RedisService {
  constructor() {
    this.client = null;
    this.isConnected = false;
    this.memoryStore = new Map(); // Fallback storage
    this.memoryExpiry = new Map(); // Track expiry times for fallback
  }

  async connect() {
    const redisUrl = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
    
    try {
      this.client = new Redis(redisUrl, {
        maxRetriesPerRequest: 1,
        retryStrategy: (times) => {
          // Only try once, then give up
          if (times > 1) {
            return null; // Stop retrying
          }
          return 100; // Wait 100ms before first retry
        },
        enableOfflineQueue: false,
        connectTimeout: 3000,
        lazyConnect: true,
      });

      // Suppress unhandled error events
      this.client.on('error', (err) => {
        // Silently handle errors when in fallback mode
        if (!this.isConnected) {
          return; // Already in fallback mode, ignore
        }
        console.warn('⚠️ Redis error:', err.message);
        this.isConnected = false;
      });

      this.client.on('connect', () => {
        console.log('✅ Redis connected successfully');
        this.isConnected = true;
      });

      this.client.on('close', () => {
        if (this.isConnected) {
          console.log('🔌 Redis connection closed');
        }
        this.isConnected = false;
      });

      // Try to connect with timeout
      await Promise.race([
        this.client.connect(),
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error('Connection timeout')), 3000)
        )
      ]);
      
      // Test connection
      await this.client.ping();
      this.isConnected = true;
      console.log('✅ Redis connected at:', redisUrl);
      
    } catch (error) {
      console.warn('⚠️ Redis not available, using in-memory fallback');
      console.warn('   To use Redis on Linux: sudo apt install redis-server && sudo systemctl start redis');
      this.isConnected = false;
      
      // Clean up the failed client
      if (this.client) {
        this.client.disconnect();
        this.client = null;
      }
    }

    // Start memory cleanup interval for fallback mode
    this._startMemoryCleanup();
    
    return this.isConnected;
  }

  // Clean up expired keys in memory fallback
  _startMemoryCleanup() {
    setInterval(() => {
      const now = Date.now();
      for (const [key, expiry] of this.memoryExpiry.entries()) {
        if (expiry && expiry < now) {
          this.memoryStore.delete(key);
          this.memoryExpiry.delete(key);
        }
      }
    }, 60000); // Clean up every minute
  }

  /**
   * SET a key with optional expiry
   * @param {string} key 
   * @param {string|object} value 
   * @param {number} expirySeconds - optional TTL in seconds
   */
  async set(key, value, expirySeconds = null) {
    const stringValue = typeof value === 'object' ? JSON.stringify(value) : String(value);
    
    if (this.isConnected && this.client) {
      try {
        if (expirySeconds) {
          await this.client.setex(key, expirySeconds, stringValue);
        } else {
          await this.client.set(key, stringValue);
        }
        return true;
      } catch (error) {
        console.error('Redis SET error:', error.message);
      }
    }
    
    // Fallback to memory
    this.memoryStore.set(key, stringValue);
    if (expirySeconds) {
      this.memoryExpiry.set(key, Date.now() + (expirySeconds * 1000));
    }
    return true;
  }

  /**
   * GET a key
   * @param {string} key 
   * @param {boolean} parseJson - auto-parse JSON
   */
  async get(key, parseJson = false) {
    let value = null;
    
    if (this.isConnected && this.client) {
      try {
        value = await this.client.get(key);
      } catch (error) {
        console.error('Redis GET error:', error.message);
      }
    } else {
      // Check expiry for memory fallback
      const expiry = this.memoryExpiry.get(key);
      if (expiry && expiry < Date.now()) {
        this.memoryStore.delete(key);
        this.memoryExpiry.delete(key);
        return null;
      }
      value = this.memoryStore.get(key) || null;
    }
    
    if (value && parseJson) {
      try {
        return JSON.parse(value);
      } catch {
        return value;
      }
    }
    return value;
  }

  /**
   * DELETE a key
   */
  async del(key) {
    if (this.isConnected && this.client) {
      try {
        await this.client.del(key);
        return true;
      } catch (error) {
        console.error('Redis DEL error:', error.message);
      }
    }
    
    this.memoryStore.delete(key);
    this.memoryExpiry.delete(key);
    return true;
  }

  /**
   * Check if key EXISTS
   */
  async exists(key) {
    if (this.isConnected && this.client) {
      try {
        return await this.client.exists(key) === 1;
      } catch (error) {
        console.error('Redis EXISTS error:', error.message);
      }
    }
    
    // Check expiry for memory fallback
    const expiry = this.memoryExpiry.get(key);
    if (expiry && expiry < Date.now()) {
      this.memoryStore.delete(key);
      this.memoryExpiry.delete(key);
      return false;
    }
    return this.memoryStore.has(key);
  }

  /**
   * Set expiry on existing key
   */
  async expire(key, seconds) {
    if (this.isConnected && this.client) {
      try {
        await this.client.expire(key, seconds);
        return true;
      } catch (error) {
        console.error('Redis EXPIRE error:', error.message);
      }
    }
    
    if (this.memoryStore.has(key)) {
      this.memoryExpiry.set(key, Date.now() + (seconds * 1000));
    }
    return true;
  }

  /**
   * INCREMENT a key
   */
  async incr(key) {
    if (this.isConnected && this.client) {
      try {
        return await this.client.incr(key);
      } catch (error) {
        console.error('Redis INCR error:', error.message);
      }
    }
    
    const current = parseInt(this.memoryStore.get(key) || '0', 10);
    const newValue = current + 1;
    this.memoryStore.set(key, String(newValue));
    return newValue;
  }

  /**
   * HASH operations - HSET
   */
  async hset(key, field, value) {
    const stringValue = typeof value === 'object' ? JSON.stringify(value) : String(value);
    
    if (this.isConnected && this.client) {
      try {
        await this.client.hset(key, field, stringValue);
        return true;
      } catch (error) {
        console.error('Redis HSET error:', error.message);
      }
    }
    
    // Memory fallback - use nested Map
    if (!this.memoryStore.has(key)) {
      this.memoryStore.set(key, new Map());
    }
    this.memoryStore.get(key).set(field, stringValue);
    return true;
  }

  /**
   * HASH operations - HGET
   */
  async hget(key, field, parseJson = false) {
    let value = null;
    
    if (this.isConnected && this.client) {
      try {
        value = await this.client.hget(key, field);
      } catch (error) {
        console.error('Redis HGET error:', error.message);
      }
    } else {
      const hash = this.memoryStore.get(key);
      value = hash instanceof Map ? hash.get(field) : null;
    }
    
    if (value && parseJson) {
      try {
        return JSON.parse(value);
      } catch {
        return value;
      }
    }
    return value;
  }

  /**
   * HASH operations - HGETALL
   */
  async hgetall(key) {
    if (this.isConnected && this.client) {
      try {
        return await this.client.hgetall(key);
      } catch (error) {
        console.error('Redis HGETALL error:', error.message);
      }
    }
    
    const hash = this.memoryStore.get(key);
    if (hash instanceof Map) {
      return Object.fromEntries(hash);
    }
    return {};
  }

  /**
   * HASH operations - HDEL
   */
  async hdel(key, field) {
    if (this.isConnected && this.client) {
      try {
        await this.client.hdel(key, field);
        return true;
      } catch (error) {
        console.error('Redis HDEL error:', error.message);
      }
    }
    
    const hash = this.memoryStore.get(key);
    if (hash instanceof Map) {
      hash.delete(field);
    }
    return true;
  }

  /**
   * LIST operations - LPUSH (add to beginning)
   */
  async lpush(key, ...values) {
    const stringValues = values.map(v => typeof v === 'object' ? JSON.stringify(v) : String(v));
    
    if (this.isConnected && this.client) {
      try {
        return await this.client.lpush(key, ...stringValues);
      } catch (error) {
        console.error('Redis LPUSH error:', error.message);
      }
    }
    
    if (!this.memoryStore.has(key)) {
      this.memoryStore.set(key, []);
    }
    const list = this.memoryStore.get(key);
    list.unshift(...stringValues.reverse());
    return list.length;
  }

  /**
   * LIST operations - LRANGE
   */
  async lrange(key, start, stop) {
    if (this.isConnected && this.client) {
      try {
        return await this.client.lrange(key, start, stop);
      } catch (error) {
        console.error('Redis LRANGE error:', error.message);
      }
    }
    
    const list = this.memoryStore.get(key) || [];
    const end = stop === -1 ? list.length : stop + 1;
    return list.slice(start, end);
  }

  /**
   * LIST operations - LTRIM (keep only specified range)
   */
  async ltrim(key, start, stop) {
    if (this.isConnected && this.client) {
      try {
        await this.client.ltrim(key, start, stop);
        return true;
      } catch (error) {
        console.error('Redis LTRIM error:', error.message);
      }
    }
    
    const list = this.memoryStore.get(key) || [];
    const end = stop === -1 ? list.length : stop + 1;
    this.memoryStore.set(key, list.slice(start, end));
    return true;
  }

  /**
   * SET operations - SADD
   */
  async sadd(key, ...members) {
    if (this.isConnected && this.client) {
      try {
        return await this.client.sadd(key, ...members);
      } catch (error) {
        console.error('Redis SADD error:', error.message);
      }
    }
    
    if (!this.memoryStore.has(key)) {
      this.memoryStore.set(key, new Set());
    }
    const set = this.memoryStore.get(key);
    members.forEach(m => set.add(String(m)));
    return members.length;
  }

  /**
   * SET operations - SREM
   */
  async srem(key, ...members) {
    if (this.isConnected && this.client) {
      try {
        return await this.client.srem(key, ...members);
      } catch (error) {
        console.error('Redis SREM error:', error.message);
      }
    }
    
    const set = this.memoryStore.get(key);
    if (set instanceof Set) {
      members.forEach(m => set.delete(String(m)));
    }
    return members.length;
  }

  /**
   * SET operations - SMEMBERS
   */
  async smembers(key) {
    if (this.isConnected && this.client) {
      try {
        return await this.client.smembers(key);
      } catch (error) {
        console.error('Redis SMEMBERS error:', error.message);
      }
    }
    
    const set = this.memoryStore.get(key);
    return set instanceof Set ? Array.from(set) : [];
  }

  /**
   * SET operations - SISMEMBER
   */
  async sismember(key, member) {
    if (this.isConnected && this.client) {
      try {
        return await this.client.sismember(key, member) === 1;
      } catch (error) {
        console.error('Redis SISMEMBER error:', error.message);
      }
    }
    
    const set = this.memoryStore.get(key);
    return set instanceof Set ? set.has(String(member)) : false;
  }

  /**
   * Pub/Sub - PUBLISH
   */
  async publish(channel, message) {
    const stringMessage = typeof message === 'object' ? JSON.stringify(message) : String(message);
    
    if (this.isConnected && this.client) {
      try {
        return await this.client.publish(channel, stringMessage);
      } catch (error) {
        console.error('Redis PUBLISH error:', error.message);
      }
    }
    
    // No fallback for pub/sub - single server doesn't need it
    return 0;
  }

  /**
   * Get Redis client for advanced operations (like Socket.IO adapter)
   */
  getClient() {
    return this.client;
  }

  /**
   * Check if Redis is connected
   */
  isRedisConnected() {
    return this.isConnected;
  }

  /**
   * Get status
   */
  getStatus() {
    return {
      connected: this.isConnected,
      mode: this.isConnected ? 'redis' : 'memory',
      memoryKeys: this.memoryStore.size,
    };
  }

  /**
   * Disconnect
   */
  async disconnect() {
    if (this.client) {
      await this.client.quit();
      this.client = null;
      this.isConnected = false;
    }
  }
}

// Export singleton instance
const redisService = new RedisService();
export default redisService;
