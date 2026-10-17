// Local read-only diagnostics. Never prints credentials, account IDs or row contents.
import 'dotenv/config';
import fs from 'node:fs/promises';
import { PrismaClient } from '@prisma/client';
import jwt from 'jsonwebtoken';
import { jwtSecret } from '../src/services/sessionSecurity.js';
import { serviceError } from '../src/services/serviceErrors.js';

const db = new PrismaClient();
try {
  const tables = ['Chat', 'Message', 'ChatParticipant', 'List', 'ListProduct', 'ShopEmployeeMembership', 'Product', 'ProductAtShop'];
  const fingerprints = await db.$transaction(async tx => {
    await tx.$executeRaw`SET TRANSACTION READ ONLY`;
    const results = {};
    for (const table of tables) {
      results[table] = (await tx.$queryRawUnsafe(`SELECT count(*)::int AS count, md5(coalesce(string_agg(md5(row_to_json(t)::text),'' ORDER BY id::text),'')) AS digest FROM "${table}" t`))[0];
    }
    return results;
  }, { timeout: 90000 });
  const owners = await db.customer.findMany({
    where: { supermarketOwnerships: { some: {} } },
    select: { id: true, sessionVersion: true, defaultSupermarketId: true,
      supermarketOwnerships: { select: { shopId: true, shop: { select: { _count: { select: { operationalLists: true, employeeMemberships: true } } } } } } },
  });
  const candidates = owners.flatMap(owner => owner.supermarketOwnerships.map(link => ({ owner, link })));
  candidates.sort((a, b) => b.link.shop._count.operationalLists + b.link.shop._count.employeeMemberships - a.link.shop._count.operationalLists - a.link.shop._count.employeeMemberships);
  const candidate = candidates[0];
  if (!candidate) throw new Error('No existing owned workspace for diagnostic');
  const evidence = { checkedAt: new Date().toISOString(), fingerprints, tests: [] };
  const origin = `http://127.0.0.1:${Number(process.env.PORT || 3000)}`;
  for (const route of ['/api/health', '/api/shop/supermarkets', '/api/lists', '/api/employees', '/api/products/search?q=milk']) {
    const token = jwt.sign({ id: candidate.owner.id, userType: 'CUSTOMER', sv: candidate.owner.sessionVersion }, jwtSecret(), { algorithm: 'HS256', expiresIn: '120s' });
    const started = Date.now();
    const response = await fetch(origin + route, { headers: { Authorization: `Bearer ${token}`, 'X-Supermarket-Id': candidate.link.shopId }, signal: AbortSignal.timeout(90000) });
    const body = await response.json();
    const rows = Array.isArray(body) ? body : body.supermarkets ?? body.lists ?? body.employees ?? body.products ?? body.data;
    const result = { route, status: response.status, durationMs: Date.now() - started, ...(Array.isArray(rows) && { count: rows.length }) };
    if (route === '/api/health') { result.services = body.services; result.cache = body.cache; }
    if (body.code) result.code = body.code;
    evidence.tests.push(result);
    if (response.status !== 200) process.exitCode = 1;
  }
  if (process.argv[2]) {
    const previous = JSON.parse(await fs.readFile(process.argv[2], 'utf8'));
    evidence.existingDataUnchanged = JSON.stringify(previous.fingerprints) === JSON.stringify(fingerprints);
  }
  console.log(JSON.stringify(evidence, null, 2));
} catch (error) { console.error(JSON.stringify(serviceError(error))); process.exitCode = 1; }
finally { await db.$disconnect(); }
