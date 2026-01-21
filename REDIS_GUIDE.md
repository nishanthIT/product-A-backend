# Redis Implementation Guide

## Overview

This application uses Redis for:
- **User Online Status** - Track who's online in real-time
- **Chat Message Caching** - Speed up message loading
- **Rate Limiting** - Protect API endpoints
- **Typing Indicators** - Show who's typing in chats
- **Session Management** - Cache user sessions

## Fallback Mode

When Redis is not available (e.g., on Windows development), the system automatically falls back to **in-memory storage**. This means:
- ✅ The app works without Redis installed
- ✅ All caching features work (just not persisted across restarts)
- ⚠️ In-memory mode is NOT suitable for production with multiple server instances

## Production Setup (Linux)

### Install Redis

```bash
# Ubuntu/Debian
sudo apt update
sudo apt install redis-server

# Start Redis
sudo systemctl start redis
sudo systemctl enable redis  # Start on boot

# Test connection
redis-cli ping  # Should return PONG
```

### Configuration

Redis configuration is in `/etc/redis/redis.conf`:

```conf
# Bind to localhost only (recommended for single server)
bind 127.0.0.1

# Set a password (recommended)
requirepass your_secure_password

# Max memory (adjust based on your server)
maxmemory 256mb
maxmemory-policy allkeys-lru
```

After editing, restart Redis:
```bash
sudo systemctl restart redis
```

### Environment Variables

Set in your `.env` file:

```env
# Default (localhost without password)
REDIS_URL=redis://127.0.0.1:6379

# With password
REDIS_URL=redis://:your_secure_password@127.0.0.1:6379

# Remote Redis server
REDIS_URL=redis://:password@redis.example.com:6379
```

## Architecture

### Redis Service (`src/services/redisService.js`)

Low-level Redis operations with fallback:
- `set(key, value, expirySeconds)` - Store a value
- `get(key, parseJson)` - Retrieve a value
- `del(key)` - Delete a key
- `exists(key)` - Check if key exists
- `incr(key)` - Increment a number
- Hash operations: `hset`, `hget`, `hgetall`, `hdel`
- List operations: `lpush`, `lrange`, `ltrim`
- Set operations: `sadd`, `srem`, `smembers`, `sismember`

### Cache Service (`src/services/cacheService.js`)

High-level caching utilities:
- `setUserOnline(userId, socketId)` - Mark user as online
- `setUserOffline(userId)` - Mark user as offline
- `isUserOnline(userId)` - Check online status
- `cacheMessages(chatId, messages)` - Cache chat messages
- `getCachedMessages(chatId)` - Get cached messages
- `invalidateMessages(chatId)` - Clear message cache
- `checkRateLimit(identifier, limit, windowSeconds)` - Rate limiting

### Rate Limiting Middleware (`src/middleware/rateLimiter.js`)

Pre-configured rate limiters:
- `apiLimiter` - 100 requests/minute for general API
- `authLimiter` - 10 attempts/15 minutes for login
- `chatLimiter` - 10 messages/second for chat
- `uploadLimiter` - 10 uploads/minute

## Usage Examples

### Check Redis Status

```bash
curl http://localhost:3000/api/health
```

Response:
```json
{
  "success": true,
  "status": "healthy",
  "timestamp": "2026-01-21T10:00:00.000Z",
  "cache": {
    "connected": true,
    "mode": "redis",
    "memoryKeys": 0
  },
  "uptime": 3600
}
```

### Apply Rate Limiting to Routes

```javascript
import { apiLimiter, chatLimiter } from '../middleware/rateLimiter.js';

// Apply to all routes
app.use('/api', apiLimiter);

// Apply to specific routes
router.post('/send-message', chatLimiter, sendMessage);
```

### Use Cache in Controllers

```javascript
import cacheService from '../services/cacheService.js';

// Cache user's chats
await cacheService.cacheUserChats(userId, chats);

// Get cached chats (returns null if not cached)
const cached = await cacheService.getCachedUserChats(userId);
if (cached) return res.json({ chats: cached });

// Invalidate on changes
await cacheService.invalidateUserChats(userId);
```

## TTL (Time To Live) Settings

| Cache Type | TTL | Purpose |
|------------|-----|---------|
| User Online | 60s | Detect disconnects quickly |
| User Contacts | 5 min | Rarely changes |
| Chat Messages | 10 min | Balance freshness vs performance |
| User Chats | 3 min | Update reasonably often |
| Unread Count | 5 min | Important but not critical |
| Typing Status | 5s | Very short-lived |
| Rate Limit | 1 min | Rolling window |

## Monitoring

### Check Redis Memory

```bash
redis-cli info memory
```

### Check Connected Clients

```bash
redis-cli info clients
```

### Monitor Commands in Real-time

```bash
redis-cli monitor
```

## Troubleshooting

### Redis Won't Start

```bash
# Check status
sudo systemctl status redis

# Check logs
sudo tail -f /var/log/redis/redis-server.log
```

### Connection Refused

1. Check Redis is running: `redis-cli ping`
2. Check firewall: `sudo ufw status`
3. Check bind address in `/etc/redis/redis.conf`

### High Memory Usage

1. Set `maxmemory` in config
2. Use `maxmemory-policy allkeys-lru` to auto-evict old keys
3. Reduce TTL values in cacheService.js

## Future Improvements

1. **Socket.IO Redis Adapter** - For horizontal scaling with multiple server instances
2. **Redis Cluster** - For high availability
3. **Pub/Sub** - For real-time notifications across servers
4. **Session Store** - Replace in-memory sessions with Redis
