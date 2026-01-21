import redisService from './redisService.js';

/**
 * Cache Service - High-level caching utilities for the application
 * Uses Redis when available, falls back to in-memory
 */

// Cache TTL constants (in seconds)
const CACHE_TTL = {
  USER_ONLINE: 60,           // 1 minute - online status
  USER_CONTACTS: 300,        // 5 minutes
  CHAT_MESSAGES: 600,        // 10 minutes - recent messages
  CHAT_METADATA: 300,        // 5 minutes - chat info
  USER_CHATS: 180,           // 3 minutes - user's chat list
  UNREAD_COUNT: 60,          // 1 minute - unread message count
  RATE_LIMIT: 60,            // 1 minute - rate limiting window
  TYPING_STATUS: 5,          // 5 seconds - typing indicator
};

// Cache key prefixes
const KEY_PREFIX = {
  USER_ONLINE: 'user:online:',
  USER_CONTACTS: 'user:contacts:',
  CHAT_MESSAGES: 'chat:messages:',
  CHAT_METADATA: 'chat:meta:',
  USER_CHATS: 'user:chats:',
  UNREAD_COUNT: 'unread:',
  RATE_LIMIT: 'rate:',
  TYPING: 'typing:',
  SOCKET_USER: 'socket:user:',
  USER_SOCKET: 'user:socket:',
};

class CacheService {
  // ============================================
  // USER ONLINE STATUS
  // ============================================
  
  /**
   * Set user as online
   */
  async setUserOnline(userId, socketId) {
    const key = `${KEY_PREFIX.USER_ONLINE}${userId}`;
    await redisService.set(key, { 
      online: true, 
      socketId, 
      lastSeen: Date.now() 
    }, CACHE_TTL.USER_ONLINE);
    
    // Also map socket -> user for quick lookup
    await redisService.set(`${KEY_PREFIX.SOCKET_USER}${socketId}`, userId, CACHE_TTL.USER_ONLINE * 2);
    await redisService.set(`${KEY_PREFIX.USER_SOCKET}${userId}`, socketId, CACHE_TTL.USER_ONLINE * 2);
  }

  /**
   * Set user as offline
   */
  async setUserOffline(userId) {
    const key = `${KEY_PREFIX.USER_ONLINE}${userId}`;
    await redisService.set(key, { 
      online: false, 
      lastSeen: Date.now() 
    }, CACHE_TTL.USER_ONLINE * 5);
    
    // Clean up socket mapping
    const socketId = await redisService.get(`${KEY_PREFIX.USER_SOCKET}${userId}`);
    if (socketId) {
      await redisService.del(`${KEY_PREFIX.SOCKET_USER}${socketId}`);
      await redisService.del(`${KEY_PREFIX.USER_SOCKET}${userId}`);
    }
  }

  /**
   * Check if user is online
   */
  async isUserOnline(userId) {
    const key = `${KEY_PREFIX.USER_ONLINE}${userId}`;
    const data = await redisService.get(key, true);
    return data?.online || false;
  }

  /**
   * Get user's socket ID
   */
  async getUserSocketId(userId) {
    return await redisService.get(`${KEY_PREFIX.USER_SOCKET}${userId}`);
  }

  /**
   * Get user ID from socket ID
   */
  async getUserIdFromSocket(socketId) {
    const userId = await redisService.get(`${KEY_PREFIX.SOCKET_USER}${socketId}`);
    return userId ? parseInt(userId, 10) : null;
  }

  /**
   * Heartbeat - refresh online status
   */
  async heartbeat(userId) {
    const key = `${KEY_PREFIX.USER_ONLINE}${userId}`;
    await redisService.expire(key, CACHE_TTL.USER_ONLINE);
  }

  // ============================================
  // CHAT MESSAGES CACHING
  // ============================================

  /**
   * Cache recent messages for a chat
   */
  async cacheMessages(chatId, messages) {
    const key = `${KEY_PREFIX.CHAT_MESSAGES}${chatId}`;
    await redisService.set(key, messages, CACHE_TTL.CHAT_MESSAGES);
  }

  /**
   * Get cached messages for a chat
   */
  async getCachedMessages(chatId) {
    const key = `${KEY_PREFIX.CHAT_MESSAGES}${chatId}`;
    return await redisService.get(key, true);
  }

  /**
   * Add a new message to the cache (prepend)
   */
  async addMessageToCache(chatId, message) {
    const key = `${KEY_PREFIX.CHAT_MESSAGES}${chatId}`;
    const cached = await redisService.get(key, true);
    
    if (cached && Array.isArray(cached)) {
      cached.unshift(message);
      // Keep only last 50 messages in cache
      if (cached.length > 50) {
        cached.pop();
      }
      await redisService.set(key, cached, CACHE_TTL.CHAT_MESSAGES);
    }
  }

  /**
   * Invalidate messages cache for a chat
   */
  async invalidateMessages(chatId) {
    const key = `${KEY_PREFIX.CHAT_MESSAGES}${chatId}`;
    await redisService.del(key);
  }

  // ============================================
  // USER'S CHAT LIST
  // ============================================

  /**
   * Cache user's chat list
   */
  async cacheUserChats(userId, chats) {
    const key = `${KEY_PREFIX.USER_CHATS}${userId}`;
    await redisService.set(key, chats, CACHE_TTL.USER_CHATS);
  }

  /**
   * Get cached user's chat list
   */
  async getCachedUserChats(userId) {
    const key = `${KEY_PREFIX.USER_CHATS}${userId}`;
    return await redisService.get(key, true);
  }

  /**
   * Invalidate user's chat list cache
   */
  async invalidateUserChats(userId) {
    const key = `${KEY_PREFIX.USER_CHATS}${userId}`;
    await redisService.del(key);
  }

  // ============================================
  // UNREAD MESSAGE COUNT
  // ============================================

  /**
   * Set unread count for user in a chat
   */
  async setUnreadCount(userId, chatId, count) {
    const key = `${KEY_PREFIX.UNREAD_COUNT}${userId}:${chatId}`;
    await redisService.set(key, count, CACHE_TTL.UNREAD_COUNT * 5);
  }

  /**
   * Increment unread count
   */
  async incrementUnread(userId, chatId) {
    const key = `${KEY_PREFIX.UNREAD_COUNT}${userId}:${chatId}`;
    return await redisService.incr(key);
  }

  /**
   * Get unread count
   */
  async getUnreadCount(userId, chatId) {
    const key = `${KEY_PREFIX.UNREAD_COUNT}${userId}:${chatId}`;
    const count = await redisService.get(key);
    return count ? parseInt(count, 10) : 0;
  }

  /**
   * Clear unread count (when user reads messages)
   */
  async clearUnreadCount(userId, chatId) {
    const key = `${KEY_PREFIX.UNREAD_COUNT}${userId}:${chatId}`;
    await redisService.del(key);
  }

  // ============================================
  // TYPING INDICATOR
  // ============================================

  /**
   * Set user typing in a chat
   */
  async setTyping(userId, chatId) {
    const key = `${KEY_PREFIX.TYPING}${chatId}`;
    await redisService.sadd(key, userId);
    await redisService.expire(key, CACHE_TTL.TYPING_STATUS);
  }

  /**
   * Clear user typing
   */
  async clearTyping(userId, chatId) {
    const key = `${KEY_PREFIX.TYPING}${chatId}`;
    await redisService.srem(key, userId);
  }

  /**
   * Get users currently typing in a chat
   */
  async getTypingUsers(chatId) {
    const key = `${KEY_PREFIX.TYPING}${chatId}`;
    return await redisService.smembers(key);
  }

  // ============================================
  // RATE LIMITING
  // ============================================

  /**
   * Check and increment rate limit
   * @returns {object} { allowed: boolean, remaining: number, resetIn: number }
   */
  async checkRateLimit(identifier, limit = 100, windowSeconds = 60) {
    const key = `${KEY_PREFIX.RATE_LIMIT}${identifier}`;
    const current = await redisService.incr(key);
    
    // Set expiry on first request
    if (current === 1) {
      await redisService.expire(key, windowSeconds);
    }
    
    return {
      allowed: current <= limit,
      remaining: Math.max(0, limit - current),
      current,
      limit,
    };
  }

  // ============================================
  // CHAT METADATA
  // ============================================

  /**
   * Cache chat metadata (participants, name, etc.)
   */
  async cacheChatMetadata(chatId, metadata) {
    const key = `${KEY_PREFIX.CHAT_METADATA}${chatId}`;
    await redisService.set(key, metadata, CACHE_TTL.CHAT_METADATA);
  }

  /**
   * Get cached chat metadata
   */
  async getCachedChatMetadata(chatId) {
    const key = `${KEY_PREFIX.CHAT_METADATA}${chatId}`;
    return await redisService.get(key, true);
  }

  /**
   * Invalidate chat metadata
   */
  async invalidateChatMetadata(chatId) {
    const key = `${KEY_PREFIX.CHAT_METADATA}${chatId}`;
    await redisService.del(key);
  }

  // ============================================
  // USER CONTACTS
  // ============================================

  /**
   * Cache user contacts
   */
  async cacheUserContacts(userId, contacts) {
    const key = `${KEY_PREFIX.USER_CONTACTS}${userId}`;
    await redisService.set(key, contacts, CACHE_TTL.USER_CONTACTS);
  }

  /**
   * Get cached user contacts
   */
  async getCachedUserContacts(userId) {
    const key = `${KEY_PREFIX.USER_CONTACTS}${userId}`;
    return await redisService.get(key, true);
  }

  /**
   * Invalidate user contacts cache
   */
  async invalidateUserContacts(userId) {
    const key = `${KEY_PREFIX.USER_CONTACTS}${userId}`;
    await redisService.del(key);
  }

  // ============================================
  // SHOPPING LISTS
  // ============================================

  /**
   * Cache user's shopping lists
   */
  async cacheUserLists(userId, lists) {
    const key = `list:user:${userId}`;
    await redisService.set(key, lists, 300); // 5 minutes
  }

  /**
   * Get cached user's shopping lists
   */
  async getCachedUserLists(userId) {
    const key = `list:user:${userId}`;
    const cached = await redisService.get(key, true);
    return cached;
  }

  /**
   * Invalidate user's shopping lists cache
   */
  async invalidateUserLists(userId) {
    const key = `list:user:${userId}`;
    await redisService.del(key);
  }

  /**
   * Cache a specific list's details
   */
  async cacheListDetail(listId, listData) {
    const key = `list:detail:${listId}`;
    await redisService.set(key, listData, 180); // 3 minutes
  }

  /**
   * Get cached list details
   */
  async getCachedListDetail(listId) {
    const key = `list:detail:${listId}`;
    return await redisService.get(key, true);
  }

  /**
   * Invalidate a specific list's cache
   */
  async invalidateListDetail(listId) {
    const key = `list:detail:${listId}`;
    await redisService.del(key);
  }

  /**
   * Invalidate all list-related cache for a user
   */
  async invalidateAllUserListCache(userId, listId = null) {
    await this.invalidateUserLists(userId);
    if (listId) {
      await this.invalidateListDetail(listId);
    }
  }

  // ============================================
  // UTILITIES
  // ============================================

  /**
   * Get cache status
   */
  getStatus() {
    return redisService.getStatus();
  }

  /**
   * Clear all cache (use with caution)
   */
  async clearAll() {
    if (redisService.isRedisConnected()) {
      // In production, be very careful with FLUSHDB
      console.warn('⚠️ Clearing all Redis cache...');
      const client = redisService.getClient();
      if (client) {
        await client.flushdb();
      }
    }
  }
}

// Export singleton
const cacheService = new CacheService();
export default cacheService;
