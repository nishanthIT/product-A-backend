// Read-only local API diagnostics against an existing verified owner/workspace.
// Never logs credentials, account/list IDs, names, product details or chat contents.
import 'dotenv/config';
import fs from 'node:fs/promises';
import { PrismaClient } from '@prisma/client';
import jwt from 'jsonwebtoken';
import { jwtSecret } from '../src/services/sessionSecurity.js';
import { serviceError } from '../src/services/serviceErrors.js';
import { isOutOfStock } from '../src/services/outOfStock.js';
import { verifyServiceSchema } from '../src/services/serviceReadiness.js';

const db = new PrismaClient();
const evidence = { checkedAt: new Date().toISOString(), tests: [] };
const fingerprint = () => db.$transaction(async tx => {
  await tx.$executeRaw`SET TRANSACTION READ ONLY`;
  const rows = {};
  for (const table of ['List', 'ListProduct', 'Chat', 'Message', 'ChatParticipant', 'PriceReport', 'Customer']) {
    rows[table] = (await tx.$queryRawUnsafe(`SELECT count(*)::int AS count, md5(coalesce(string_agg(md5(to_jsonb(t)::text), '' ORDER BY id::text), '')) AS digest FROM "${table}" t`))[0];
  }
  return rows;
}, { isolationLevel: 'RepeatableRead', timeout: 90000 });

try {
  evidence.schema = await verifyServiceSchema(db);
  evidence.before = await fingerprint();
  const owners = await db.customer.findMany({
    where: { supermarketOwnerships: { some: {} } },
    select: { id: true, sessionVersion: true, supermarketOwnerships: { select: { shopId: true, shop: { select: { _count: { select: { operationalLists: true } } } } } } },
  });
  const candidates = owners.flatMap(owner => owner.supermarketOwnerships.map(link => ({ owner, link })));
  candidates.sort((a, b) => b.link.shop._count.operationalLists - a.link.shop._count.operationalLists);
  const candidate = candidates[0];
  if (!candidate) throw Object.assign(new Error('No verified workspace'), { code: 'NO_VERIFIED_WORKSPACE' });
  const origin = `http://127.0.0.1:${Number(process.env.PORT || 3000)}`;
  async function get(route, label = route) {
    const token = jwt.sign({ id: candidate.owner.id, userType: 'CUSTOMER', sv: candidate.owner.sessionVersion }, jwtSecret(), { algorithm: 'HS256', expiresIn: '120s' });
    const started = Date.now();
    const response = await fetch(origin + route, { headers: { Authorization: `Bearer ${token}`, 'X-Supermarket-Id': candidate.link.shopId }, signal: AbortSignal.timeout(90000) });
    const body = await response.json();
    const rows = body.lists ?? body.products;
    evidence.tests.push({ route: label, status: response.status, durationMs: Date.now() - started, ...(Array.isArray(rows) && { count: rows.length }), ...(label === '/api/health' && { services: body.services, cache: body.cache }) });
    if (response.status !== 200) throw Object.assign(new Error('HTTP check failed'), { code: `HTTP_${response.status}` });
    return body;
  }
  await get('/api/health');
  const summaries = (await get('/api/lists')).lists;
  const collection = await get('/api/lists/out-of-stock');
  const sources = summaries.filter(list => isOutOfStock(list.name));
  const expectedRows = await db.listProduct.findMany({ where: { listId: { in: sources.map(list => list.id) } }, select: { id: true } });
  evidence.aggregateMatchesAccessibleStoredRows = JSON.stringify(expectedRows.map(row => row.id).sort()) === JSON.stringify(collection.products.map(row => row.id).sort());
  if (!evidence.aggregateMatchesAccessibleStoredRows) throw Object.assign(new Error('Aggregate mismatch'), { code: 'ITEM_MISMATCH' });
  // Verify real source URLs remain usable, plus an ordinary list using the same editor.
  for (const list of sources) await get(`/api/lists/${list.id}`, '/api/lists/:existing-out-of-stock-list');
  const ordinary = summaries.find(list => !isOutOfStock(list.name));
  if (ordinary) await get(`/api/lists/${ordinary.id}`, '/api/lists/:ordinary-list');
  evidence.after = await fingerprint();
  evidence.existingDataUnchanged = JSON.stringify(evidence.before) === JSON.stringify(evidence.after);
  if (!evidence.existingDataUnchanged) throw Object.assign(new Error('Data changed during read-only probe'), { code: 'CONCURRENT_DATA_CHANGE' });
  evidence.migrations = await db.$queryRaw`SELECT migration_name, finished_at IS NOT NULL AS applied FROM "_prisma_migrations" WHERE migration_name IN ('20261016160000_out_of_stock_origin', '20261017160000_typed_price_reporters') AND rolled_back_at IS NULL ORDER BY migration_name`;
} catch (error) {
  evidence.error = serviceError(error); process.exitCode = 1;
} finally {
  await db.$disconnect();
  if (process.argv[2]) await fs.writeFile(process.argv[2], JSON.stringify(evidence, null, 2) + '\n');
  console.log(JSON.stringify({ tests: evidence.tests, schema: evidence.schema, aggregateMatchesAccessibleStoredRows: evidence.aggregateMatchesAccessibleStoredRows, existingDataUnchanged: evidence.existingDataUnchanged, error: evidence.error }, null, 2));
}
