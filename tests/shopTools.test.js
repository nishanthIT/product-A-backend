import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { getPrisma, resetDatabase, seedBase, startApp } from './helpers/harness.js';

let prisma, app, seed, token, other;
before(async () => {
  await resetDatabase();
  prisma = await getPrisma();
  seed = await seedBase(prisma);
  app = await startApp();
  token = (await app.login('alpha-owner@shop.test', seed.password)).token;
  other = (await app.login('bravo-owner@shop.test', seed.password)).token;
});
after(async () => { await app?.close(); await prisma?.$disconnect(); });
const request = (method, path, body) => app.request(method, path, { token, body });
const ok = (result, status = 200) => assert.equal(result.status, status, JSON.stringify(result.body));

test('chiller, freezer and legacy freezer limits survive create, edit and reload; alerts use saved range', async () => {
  for (const hasFreezer of [false, true]) {
    const created = await request('POST', '/fridges', { name: hasFreezer ? 'Freezer' : 'Chiller', hasFreezer,
      minSafeTemp: hasFreezer ? -23 : 0, maxSafeTemp: hasFreezer ? -18 : 8,
      ...(hasFreezer && { freezerMinSafeTemp: '-23', freezerMaxSafeTemp: '-18' }) });
    ok(created, 201);
    const id = created.body.fridge.id;
    ok(await request('PUT', `/fridges/${id}`, { minSafeTemp: hasFreezer ? '-23.5' : '-2.5',
      ...(hasFreezer && { freezerMinSafeTemp: '-23.5' }) }));
    const loaded = await request('GET', '/fridges'); ok(loaded);
    const fridge = loaded.body.fridges.find(f => f.id === id);
    assert.equal(fridge.minSafeTemp, hasFreezer ? -23.5 : -2.5);
    if (hasFreezer) assert.equal(fridge.freezerMinSafeTemp, -23.5);
    const reading = await request('POST', `/fridges/${id}/logs`, { temperature: hasFreezer ? -23 : 0, entryType: 'MORNING', compartment: hasFreezer ? 'FREEZER' : 'FRIDGE' });
    ok(reading, 201);
    const logs = await request('GET', `/fridges/${id}/logs`); ok(logs);
    assert.equal(logs.body.logs[0].isAlert, false);
    ok(await request('PUT', `/fridges/${id}`, hasFreezer ? { freezerMinSafeTemp: -22 } : { minSafeTemp: 1 }));
    const updatedLogs = await request('GET', `/fridges/${id}/logs`); ok(updatedLogs);
    assert.equal(updatedLogs.body.logs[0].isAlert, true);
    ok(await app.request('PUT', `/fridges/${id}`, { token: other, body: { minSafeTemp: -30 } }), 404);
    for (const invalid of ['', ' ', '-', '-23abc', 'Infinity', null, true]) {
      ok(await request('PUT', `/fridges/${id}`, { minSafeTemp: invalid }), 400);
      ok(await request('POST', `/fridges/${id}/logs`, { temperature: invalid, entryType: 'EVENING' }), 400);
    }
    ok(await request('PUT', `/fridges/${id}`, { minSafeTemp: 8, maxSafeTemp: 8 }), 400);
    ok(await request('PUT', `/fridges/${id}`, { minSafeTemp: 9, maxSafeTemp: 8 }), 400);
  }
  const legacy = await request('POST', '/fridges', { name: 'Legacy freezer', minSafeTemp: -23, maxSafeTemp: -18 });
  ok(legacy, 201);
  ok(await request('PUT', `/fridges/${legacy.body.fridge.id}`, { minSafeTemp: -24 }));
  ok(await request('POST', `/fridges/${legacy.body.fridge.id}/logs`, { temperature: -23, entryType: 'MORNING', compartment: 'FREEZER' }), 201);
});

test('both age record APIs accept either, both or neither product details; current records can clear fields', async () => {
  for (const details of [{}, { productCategory: 'Alcohol' }, { productName: 'Wine' }, { productCategory: 'Alcohol', productName: 'Wine' }, { productCategory: ' ', productName: null }]) {
    for (const path of ['/age-restricted-records', '/age-restriction-records']) {
      const result = await request('POST', path, { childGender: 'MALE', occurredAt: new Date().toISOString(), description: 'ID check', ...details });
      ok(result, 201);
      assert.equal(result.body.record.productCategory, details.productCategory?.trim() || null);
      assert.equal(result.body.record.productName, details.productName || null);
      const loaded = await request('GET', path); ok(loaded);
      assert.ok(loaded.body.records.some(r => r.id === result.body.record.id));
      if (path === '/age-restriction-records') {
        const cleared = await request('PUT', `${path}/${result.body.record.id}`, { productCategory: '', productName: null });
        ok(cleared); assert.equal(cleared.body.record.productCategory, null); assert.equal(cleared.body.record.productName, null);
      }
      ok(await request('POST', path, { childGender: 'MALE', occurredAt: new Date().toISOString(), description: 'ID check', productName: {} }), 400);
    }
  }
});

test('payouts persist, list, filter and keep their automatic creation timestamp on edits', async () => {
  const before = Date.now();
  const created = await request('POST', '/supplier-payouts', { supplier: 'Supplier A', amount: 12.50, notes: 'Invoice 1' }); ok(created, 201);
  const record = created.body.record;
  assert.ok(Date.parse(record.createdAt) >= before && Date.parse(record.createdAt) <= Date.now());
  assert.equal(record.canEdit, true);
  const listed = await request('GET', '/supplier-payouts'); ok(listed);
  assert.equal(listed.body.records.length, 1); assert.equal(listed.body.records[0].id, record.id);
  assert.equal(Number(listed.body.records[0].amount), 12.5);
  const edited = await request('PUT', `/supplier-payouts/${record.id}`, { paymentStatus: 'PAID', paymentMethod: 'CASH' }); ok(edited);
  assert.equal(edited.body.record.createdAt, record.createdAt);
  for (const field of ['createdAt', 'updatedAt']) {
    ok(await request('PUT', `/supplier-payouts/${record.id}`, { [field]: '2000-01-01T00:00:00Z' }), 400);
    ok(await request('POST', '/supplier-payouts', { supplier: 'Tamper', amount: 1, [field]: '2000-01-01T00:00:00Z' }), 400);
  }
  const date = record.createdAt.slice(0, 10);
  const filtered = await request('GET', `/supplier-payouts?startDate=${date}&endDate=${date}&paymentStatus=PAID`); ok(filtered); assert.equal(filtered.body.records.length, 1);
  const instant = encodeURIComponent(record.createdAt);
  const exact = await request('GET', `/supplier-payouts?startDate=${instant}&endDate=${instant}`); ok(exact); assert.equal(exact.body.records.length, 1);
  const otherShop = await app.request('GET', '/supplier-payouts', { token: other }); ok(otherShop); assert.equal(otherShop.body.records.length, 0);
  ok(await request('GET', '/supplier-payouts?startDate=invalid'), 400);
  ok(await request('GET', '/supplier-payouts?startDate=2026-10-12&endDate=2026-10-01'), 400);
  assert.equal((await prisma.supplierPayoutRecord.findUnique({ where: { id: record.id } })).createdAt.toISOString(), record.createdAt);
});

test('additive age migration preserves existing rows and allows independent null fields', async () => {
  await prisma.$transaction(async tx => {
    await tx.$executeRawUnsafe('UPDATE "AgeRestrictedRecord" SET "productCategory" = COALESCE("productCategory", \'Legacy category\'), "productName" = COALESCE("productName", \'Legacy product\')');
    await tx.$executeRawUnsafe('ALTER TABLE "AgeRestrictedRecord" ALTER COLUMN "productCategory" SET NOT NULL, ALTER COLUMN "productName" SET NOT NULL');
    await tx.$executeRawUnsafe('ALTER TABLE "AgeRestrictionRecord" DROP COLUMN "productCategory", DROP COLUMN "productName"');
    const before = await tx.$queryRawUnsafe('SELECT * FROM "AgeRestrictedRecord" ORDER BY id');
    const sql = fs.readFileSync(new URL('../prisma/migrations/20261012100000_optional_age_record_products/migration.sql', import.meta.url), 'utf8');
    for (const statement of sql.replace(/^--.*$/gm, '').split(';').filter(s => s.trim())) await tx.$executeRawUnsafe(statement);
    assert.deepEqual(await tx.$queryRawUnsafe('SELECT * FROM "AgeRestrictedRecord" ORDER BY id'), before);
    await tx.$executeRawUnsafe('UPDATE "AgeRestrictedRecord" SET "productCategory" = NULL, "productName" = NULL');
  });
});
