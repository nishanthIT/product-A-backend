import { createHash, randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
export const cacheKey = key => createHash('sha256').update(String(key)).digest('hex');
export const liveEntry = row => row && (!row.expiresAt || row.expiresAt.getTime() > Date.now()) ? row : null;

// PostgreSQL is the durable write-through store. Per-key transaction locks keep
// counters, collection updates and expiry atomic across backend processes.
export class DatabaseCache {
  constructor(db = prisma) { this.db = db; }
  async metadata(key) {
    return liveEntry(await this.db.cacheEntry.findUnique({ where: { key: cacheKey(key) }, select: { revision: true, expiresAt: true } }));
  }
  async read(key) { return liveEntry(await this.db.cacheEntry.findUnique({ where: { key: cacheKey(key) } })); }
  // Common auth/cache operations execute in one database round trip. The same
  // transaction-scoped key lock serializes them with collection mutations.
  async setValue(key, value, expiresAt) {
    const hash = cacheKey(key), revision = randomUUID();
    const rows = await this.db.$queryRaw`
      WITH locked AS MATERIALIZED (SELECT pg_advisory_xact_lock(hashtextextended(${hash}, 0)))
      INSERT INTO "CacheEntry" (key,type,value,revision,"expiresAt")
      SELECT ${hash}, 'string', ${JSON.stringify(value)}::jsonb, ${revision}, (${expiresAt?.toISOString() ?? null}::timestamptz AT TIME ZONE 'UTC') FROM locked
      ON CONFLICT (key) DO UPDATE SET type='string', value=EXCLUDED.value, revision=EXCLUDED.revision, "expiresAt"=EXCLUDED."expiresAt"
      RETURNING *`;
    return rows[0];
  }
  async increment(key, deadline) {
    const hash = cacheKey(key), revision = randomUUID();
    const rows = await this.db.$queryRaw`
      WITH locked AS MATERIALIZED (SELECT pg_advisory_xact_lock(hashtextextended(${hash}, 0)))
      INSERT INTO "CacheEntry" (key,type,value,revision,"expiresAt")
      SELECT ${hash}, 'string', to_jsonb('1'::text), ${revision}, (${deadline?.toISOString() ?? null}::timestamptz AT TIME ZONE 'UTC') FROM locked
      ON CONFLICT (key) DO UPDATE SET
        value=CASE WHEN "CacheEntry"."expiresAt" <= (CURRENT_TIMESTAMP AT TIME ZONE 'UTC') THEN to_jsonb('1'::text)
          ELSE to_jsonb(((("CacheEntry".value #>> '{}')::bigint)+1)::text) END,
        "expiresAt"=CASE WHEN "CacheEntry"."expiresAt" <= (CURRENT_TIMESTAMP AT TIME ZONE 'UTC') THEN EXCLUDED."expiresAt"
          ELSE COALESCE("CacheEntry"."expiresAt",EXCLUDED."expiresAt") END,
        revision=EXCLUDED.revision,type='string'
      WHERE "CacheEntry".type='string' OR "CacheEntry"."expiresAt" <= (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')
      RETURNING *`;
    if (!rows[0] || !Number.isSafeInteger(Number(rows[0].value))) throw new Error('Cache counter is not a safe integer');
    return rows[0];
  }
  async remove(key) {
    const hash = cacheKey(key);
    await this.db.$executeRaw`
      WITH locked AS MATERIALIZED (SELECT pg_advisory_xact_lock(hashtextextended(${hash}, 0)))
      DELETE FROM "CacheEntry" USING locked WHERE key=${hash}`;
  }
  async mutate(key, change) {
    const hash = cacheKey(key);
    return this.db.$transaction(async tx => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${hash}, 0))::text`;
      const current = liveEntry(await tx.cacheEntry.findUnique({ where: { key: hash } }));
      const { entry, result } = change(current);
      if (!entry) {
        await tx.cacheEntry.deleteMany({ where: { key: hash } });
        return { entry: null, result };
      }
      const data = { type: entry.type, value: entry.value, expiresAt: entry.expiresAt ?? null, revision: randomUUID() };
      const saved = await tx.cacheEntry.upsert({ where: { key: hash }, create: { key: hash, ...data }, update: data });
      return { entry: saved, result };
    }, { maxWait: 10000, timeout: 15000 });
  }
  async pruneExpired() {
    // This table contains only transient cache data, never conversations/messages.
    return this.db.cacheEntry.deleteMany({ where: { expiresAt: { lte: new Date() } } });
  }
}
