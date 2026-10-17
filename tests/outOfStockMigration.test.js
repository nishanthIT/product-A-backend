import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import pg from 'pg';
import { getPrisma, resetDatabase, seedBase } from './helpers/harness.js';

let db;
before(async () => { await resetDatabase(); db = await getPrisma(); });
after(async () => { await db?.$disconnect(); });

test('Out of Stock provenance migration upgrades existing rows additively without inventing historical origins', async () => {
  const seed = await seedBase(db);
  const supplierProduct = await db.productAtShop.findFirstOrThrow({ where: { productId: seed.product.id } });
  const lists = await Promise.all(['Restock', 'Out of Stock · Historic supplier'].map(name => db.list.create({ data: {
    name, description: 'Existing record', customerId: seed.a.owner.id, shopId: seed.a.shop.id,
  } })));
  await db.listProduct.createMany({ data: lists.map((list, index) => ({ listId: list.id, productAtShopId: supplierProduct.id, quantity: index + 4, isUrgent: true })) });
  const client = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
  await client.connect();
  try {
    // The harness pins all destructive setup to a disposable local *test* DB.
    await client.query('ALTER TABLE "ListProduct" DROP COLUMN "outOfStockSourceListId"');
    const tables = ['List', 'ListProduct', 'Customer', 'Chat', 'ChatParticipant', 'SupermarketOwnership'];
    const snapshot = async () => Object.fromEntries(await Promise.all(tables.map(async table => [table,
      (await client.query(`SELECT to_jsonb(t) - 'outOfStockSourceListId' AS row FROM "${table}" t ORDER BY t.id`)).rows,
    ])));
    const before = await snapshot();
    await client.query(await fs.readFile(new URL('../prisma/migrations/20261016160000_out_of_stock_origin/migration.sql', import.meta.url), 'utf8'));
    assert.deepEqual(await snapshot(), before, 'every preexisting field and row is unchanged');
    const restored = await db.list.findMany({ where: { id: { in: lists.map(list => list.id) } }, include: { products: true } });
    assert.equal(restored.flatMap(list => list.products).length, 2);
    assert.ok(restored.flatMap(list => list.products).every(row => row.outOfStockSourceListId === null));
  } finally { await client.end(); }
});
