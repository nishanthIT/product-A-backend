import redis from './redisService.js';

// Verify provider erasure separately from durable-cache erasure.
export async function purgeAccountCaches(account, type, cache = redis) {
  const email = account.email.trim().toLowerCase();
  const identity = `${type}:${account.id}`;
  const keys = ['register', 'reset'].flatMap(kind => [`otp:${kind}:${email}`, `otp_cd:${kind}:${email}`]);
  keys.push(`user:online:${identity}`, `user:socket:${identity}`);
  const socketId = await cache.get(`user:socket:${identity}`);
  if (socketId) keys.push(`socket:user:${socketId}`);
  for (const key of keys) await cache.del(key);
  if (cache.isConnected && cache.client) {
    const legacySocket = await cache.client.get(`user:socket:${identity}`);
    if (legacySocket) keys.push(`socket:user:${legacySocket}`);
    const providerKeys = keys.flatMap(key => [key, cache.redisKey(key)]);
    await cache.client.del(...providerKeys);
    if ((await cache.client.exists(...providerKeys)) !== 0) throw new Error('Account cache erasure could not be verified');
  } else if (process.env.NODE_ENV === 'production') {
    throw new Error('Redis deletion unavailable; restore the provider connection and retry');
  }
}
