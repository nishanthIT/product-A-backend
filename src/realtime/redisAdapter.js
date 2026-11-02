import Redis from 'ioredis';
import { createAdapter } from '@socket.io/redis-adapter';
import { serviceError } from '../services/serviceErrors.js';

const initialized = new WeakMap();
/** Configure before HTTP listen. Every instance must use the same Redis/key. */
export async function initRealtimeAdapter(io, { url = process.env.CHAT_REDIS_URL || process.env.REDIS_URL, key = process.env.CHAT_REDIS_CHANNEL_PREFIX || 'paymi:chat:socket.io', clientFactory = (connection, options) => new Redis(connection, options) } = {}) {
  if (initialized.has(io)) return initialized.get(io);
  const setup = (async () => {
    if (!url) return { mode: 'single-instance', close: async () => {} };
    const options = { lazyConnect: true, connectTimeout: 5000, commandTimeout: 5000, maxRetriesPerRequest: 1,
      enableOfflineQueue: false, retryStrategy: attempt => Math.min(attempt * 250, 5000) };
    const pub = clientFactory(url, options);
    const sub = pub.duplicate();
    for (const client of [pub, sub]) client.on('error', error => console.warn('Chat realtime Redis unavailable; clients reconcile through REST', serviceError(error)));
    try {
      await Promise.all([pub.connect(), sub.connect()]);
      io.adapter(createAdapter(pub, sub, { key, publishOnSpecificResponseChannel: true, requestsTimeout: 5000 }));
      return { mode: 'redis', close: async () => { pub.disconnect(); sub.disconnect(); } };
    } catch (error) {
      pub.disconnect(); sub.disconnect();
      throw new Error('Chat realtime Redis is configured but unavailable', { cause: error });
    }
  })();
  initialized.set(io, setup);
  return setup;
}
