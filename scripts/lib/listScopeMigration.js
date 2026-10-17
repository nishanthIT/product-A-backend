import { createHash, randomUUID } from 'node:crypto';
import { inspectDefaultMigration } from './defaultSupermarketMigration.js';

export async function collectListScopeFacts(db) {
  const [lists, customers, employees, shops] = await Promise.all([
    db.list.findMany({ select: { id: true, shopId: true, customerId: true, employeeId: true, adminId: true, creatorType: true, updatedAt: true }, orderBy: { id: 'asc' } }),
    db.customer.findMany({ select: { id: true, shopId: true, supermarketOwnerships: { select: { shopId: true } } }, orderBy: { id: 'asc' } }),
    db.empolyee.findMany({ select: { id: true, shopId: true, createdByCustomerId: true, shopMemberships: { select: { shopId: true, createdByCustomerId: true } } }, orderBy: { id: 'asc' } }),
    db.shop.findMany({ select: { id: true, shopType: true }, orderBy: { id: 'asc' } }),
  ]);
  for (const c of customers) c.supermarketOwnerships.sort((a, b) => a.shopId.localeCompare(b.shopId));
  for (const e of employees) e.shopMemberships.sort((a, b) => a.shopId.localeCompare(b.shopId));
  return { lists, customers, employees, shops };
}
export function buildListScopePlan(facts) {
  const changes = [], reviews = [];
  const isCustomerShop = (id) => facts.shops.some((s) => s.id === id && s.shopType === 'CUSTOMER');
  for (const list of facts.lists) {
    if (list.shopId) {
      if (!isCustomerShop(list.shopId) && list.creatorType !== 'ADMIN') reviews.push({ listId: list.id, reason: 'INVALID_EXISTING_SCOPE' });
      continue;
    }
    if (list.creatorType === 'ADMIN' && list.adminId && !list.customerId && !list.employeeId) continue;
    let shopId = null;
    if (list.creatorType === 'CUSTOMER' && list.customerId && !list.employeeId && !list.adminId) {
      const c = facts.customers.find((c) => c.id === list.customerId);
      if (c?.supermarketOwnerships.length === 1 && c.supermarketOwnerships[0].shopId === c.shopId) shopId = c.shopId;
    } else if (list.creatorType === 'EMPLOYEE' && list.employeeId && !list.customerId && !list.adminId) {
      const e = facts.employees.find((e) => e.id === list.employeeId);
      // Consider ALL historical memberships, not just active ones. Never infer from an employer's other shops.
      const m = e?.shopMemberships.length === 1 ? e.shopMemberships[0] : null;
      const c = facts.customers.find((c) => c.id === m?.createdByCustomerId);
      if (m && e.shopId === m.shopId && e.createdByCustomerId === m.createdByCustomerId && c?.supermarketOwnerships.some((o) => o.shopId === m.shopId)) shopId = m.shopId;
    }
    if (shopId && isCustomerShop(shopId)) changes.push({ kind: 'LIST_SCOPE', listId: list.id, shopId, updatedAt: list.updatedAt });
    else reviews.push({ listId: list.id, reason: 'NO_UNAMBIGUOUS_ORIGINAL_SHOP' });
  }
  return { hash: createHash('sha256').update(JSON.stringify(facts)).digest('hex'), changes, reviews,
    summary: { total: facts.lists.length, scopesToAssociate: changes.length, review: reviews.length } };
}
export async function inspectListScopeMigration(db) {
  const deployment = await inspectDefaultMigration(db);
  const plan = await db.$transaction(async (tx) => buildListScopePlan(await collectListScopeFacts(tx)), { isolationLevel: 'RepeatableRead', timeout: 60000 });
  return { ...deployment, plan };
}
export async function applyListScopePlan(db, reviewed) {
  return db.$transaction(async (tx) => {
    const plan = buildListScopePlan(await collectListScopeFacts(tx));
    if (reviewed.hash !== plan.hash) throw new Error('Relationships changed since dry run. Generate and review a fresh report.');
    for (const row of plan.changes) {
      await tx.$executeRaw`UPDATE "List" SET "shopId" = ${row.shopId} WHERE id = ${row.listId} AND "shopId" IS NULL`;
    }
    return tx.supermarketMigrationRun.create({ data: { id: randomUUID(), planHash: plan.hash, changes: JSON.parse(JSON.stringify(plan.changes)) } });
  }, { isolationLevel: 'Serializable', timeout: 60000, maxWait: 15000 });
}
export async function recoverListScopeRun(db, runId) {
  return db.$transaction(async (tx) => {
    const run = await tx.supermarketMigrationRun.findUnique({ where: { id: runId } });
    if (!run || run.recoveredAt || run.changes.some((c) => c.kind !== 'LIST_SCOPE')) throw new Error('Not an unrecovered list-scope run.');
    for (const row of run.changes) {
      const list = await tx.list.findUnique({ where: { id: row.listId } });
      if (!list || list.shopId !== row.shopId || (list.updatedAt?.toISOString() ?? null) !== row.updatedAt) throw new Error('A list changed after migration. Stop and review; recovery cannot overwrite new work.');
    }
    for (const row of run.changes) await tx.$executeRaw`UPDATE "List" SET "shopId" = NULL WHERE id = ${row.listId}`;
    return tx.supermarketMigrationRun.update({ where: { id: run.id }, data: { recoveredAt: new Date() } });
  }, { isolationLevel: 'Serializable', timeout: 60000 });
}
