import { createHash, randomUUID } from 'node:crypto';

export const SOURCE = 'DEFAULT_SUPERMARKET_MIGRATION_V1';
const fingerprint = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Only explicit ownership and the existing customer FK are ownership evidence.
 * Other operational links can flag a conflict, but can never create ownership.
 */
export function buildDefaultPlan(facts) {
  const shops = new Map(facts.shops.map((s) => [s.id, s.shopType]));
  const items = facts.customers.map((customer) => {
    const owned = facts.ownerships.filter((o) => o.customerId === customer.id);
    const verifiedIds = owned.filter((o) => o.shopType === 'CUSTOMER' && shops.get(o.shopId) === 'CUSTOMER').map((o) => o.shopId);
    const evidence = {
      legacyShopId: customer.shopId,
      existingDefault: customer.defaultSupermarketId,
      verifiedShopIds: [...verifiedIds].sort(),
      otherRecordShopIds: [...new Set(facts.links.filter((l) => l.customerId === customer.id).map((l) => l.shopId))].sort(),
    };
    const base = { customerId: customer.id, evidence };
    const review = (reason) => ({ ...base, outcome: 'REVIEW', reason });
    if (owned.length !== verifiedIds.length) return review('INVALID_EXISTING_OWNERSHIP');
    if (customer.defaultSupermarketId && !verifiedIds.includes(customer.defaultSupermarketId)) return review('INVALID_DEFAULT');
    if (customer.shopId && shops.get(customer.shopId) !== 'CUSTOMER') return review('LEGACY_SHOP_MISSING_OR_SUPPLIER');
    if (customer.shopId && facts.customers.filter((c) => c.shopId === customer.shopId).length > 1 && !verifiedIds.includes(customer.shopId)) {
      return review('MULTIPLE_LEGACY_OWNERS');
    }
    const known = new Set([...verifiedIds, ...(customer.shopId ? [customer.shopId] : [])]);
    if (evidence.otherRecordShopIds.some((id) => !known.has(id))) return review('CONFLICTING_OPERATIONAL_RELATIONSHIPS');
    const defaultShopId = customer.defaultSupermarketId || customer.shopId || (verifiedIds.length === 1 ? verifiedIds[0] : null);
    if (!defaultShopId) return review(verifiedIds.length > 1 ? 'MULTIPLE_SHOPS_NO_VERIFIED_DEFAULT' : 'NO_VERIFIED_SUPERMARKET');
    // Preserve every pre-existing ownership; add only the explicit legacy relationship.
    const createShopId = customer.shopId && !verifiedIds.includes(customer.shopId) ? customer.shopId : null;
    return {
      ...base, outcome: 'VERIFIED', createShopId, defaultShopId,
      setDefault: customer.defaultSupermarketId !== defaultShopId,
      previousDefault: customer.defaultSupermarketId,
      previousVersion: customer.defaultSupermarketVersion,
    };
  });
  return {
    version: 1,
    // Bind approval to exact relationship evidence, not just the chosen outcome.
    hash: fingerprint(facts), items,
    summary: {
      customers: items.length,
      ownershipsToCreate: items.filter((i) => i.createShopId).length,
      defaultsToSet: items.filter((i) => i.setDefault).length,
      needsReview: items.filter((i) => i.outcome === 'REVIEW').length,
      unchanged: items.filter((i) => i.outcome === 'VERIFIED' && !i.createShopId && !i.setDefault).length,
    },
  };
}

/** Safe before the additive migration too. Never reads credentials or infers names. */
export async function collectDefaultFacts(db) {
  const [state] = await db.$queryRaw`
    SELECT to_regclass('"SupermarketOwnership"') IS NOT NULL AS ownership,
      EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema()
        AND table_name = 'Customer' AND column_name = 'defaultSupermarketId') AS defaults`;
  if (state.ownership !== state.defaults) throw new Error('Partially installed default-supermarket schema; reconcile before continuing');
  const customers = state.defaults
    ? await db.customer.findMany({ select: { id: true, shopId: true, defaultSupermarketId: true, defaultSupermarketVersion: true }, orderBy: { id: 'asc' } })
    : (await db.customer.findMany({ select: { id: true, shopId: true }, orderBy: { id: 'asc' } }))
      .map((c) => ({ ...c, defaultSupermarketId: null, defaultSupermarketVersion: 0 }));
  const shops = await db.shop.findMany({ select: { id: true, shopType: true }, orderBy: { id: 'asc' } });
  const ownerships = state.ownership ? await db.supermarketOwnership.findMany({
    select: { id: true, customerId: true, shopId: true, shopType: true, source: true }, orderBy: { id: 'asc' },
  }) : [];
  const lists = await db.list.groupBy({ by: ['customerId', 'shopId'], where: { customerId: { not: null }, shopId: { not: null }, creatorType: 'CUSTOMER' } });
  const tasks = await db.task.groupBy({ by: ['createdById', 'shopId'] });
  const employees = await db.shopEmployeeMembership.groupBy({ by: ['createdByCustomerId', 'shopId'], where: { createdByCustomerId: { not: null } } });
  const links = [
    ...lists.map((x) => ({ customerId: x.customerId, shopId: x.shopId, kind: 'LIST' })),
    ...tasks.map((x) => ({ customerId: x.createdById, shopId: x.shopId, kind: 'TASK' })),
    ...employees.map((x) => ({ customerId: x.createdByCustomerId, shopId: x.shopId, kind: 'EMPLOYEE_MEMBERSHIP' })),
  ].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return { customers, shops, ownerships, links };
}

export async function inspectDefaultMigration(db) {
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SET TRANSACTION READ ONLY`;
    const facts = await collectDefaultFacts(tx);
    const [exists] = await tx.$queryRaw`SELECT to_regclass('"_prisma_migrations"') IS NOT NULL AS present`;
    const migrations = exists.present ? await tx.$queryRaw`
      SELECT migration_name, finished_at, rolled_back_at FROM "_prisma_migrations" ORDER BY started_at` : [];
    const schemaColumns = await tx.$queryRaw`
      SELECT table_name, column_name, data_type, udt_name, is_nullable
      FROM information_schema.columns WHERE table_schema = current_schema()
      AND table_name IN ('Customer', 'Shop', 'ShopEmployeeMembership', 'SupermarketOwnership',
        'RegistrationReceipt', 'SupermarketMigrationReview', 'SupermarketMigrationRun')
      ORDER BY table_name, ordinal_position`;
    return { plan: buildDefaultPlan(facts), migrations, migrationHistoryPresent: exists.present, schemaColumns };
  }, { isolationLevel: 'RepeatableRead', timeout: 60000 });
}

export async function applyDefaultPlan(db, approvedPlan) {
  return db.$transaction(async (tx) => {
    const current = buildDefaultPlan(await collectDefaultFacts(tx));
    if (current.hash !== approvedPlan.hash) throw new Error('Relationships changed since dry run. Generate and review a new plan.');
    const changes = [];
    for (const item of current.items) {
      if (item.outcome === 'REVIEW') {
        const key = { customerId: item.customerId, reason: item.reason };
        await tx.supermarketMigrationReview.upsert({
          where: { customerId_reason: key },
          create: { ...key, evidence: item.evidence }, update: {},
        });
        continue;
      }
      let ownershipId = null;
      if (item.createShopId) {
        const ownership = await tx.supermarketOwnership.create({ data: {
          customerId: item.customerId, shopId: item.createShopId, source: SOURCE,
        } });
        ownershipId = ownership.id;
      }
      if (item.setDefault) {
        await tx.customer.update({ where: { id: item.customerId }, data: {
          defaultSupermarketId: item.defaultShopId, defaultSupermarketVersion: { increment: 1 },
        } });
      }
      if (ownershipId || item.setDefault) changes.push({
        customerId: item.customerId, ownershipId,
        previousDefault: item.previousDefault,
        appliedDefault: item.defaultShopId,
        appliedVersion: item.previousVersion + (item.setDefault ? 1 : 0),
        changedDefault: item.setDefault,
      });
    }
    return tx.supermarketMigrationRun.create({ data: { id: randomUUID(), planHash: current.hash, changes } });
  }, { isolationLevel: 'Serializable', timeout: 60000 });
}

/** Recovery restores only unchanged preferences, retaining ALL ownership and business data.
 * Never delete an ownership that may now be used by the running application.
 */
export async function recoverDefaultRun(db, runId) {
  return db.$transaction(async (tx) => {
    const run = await tx.supermarketMigrationRun.findUnique({ where: { id: runId } });
    if (!run) throw new Error('Unknown migration run');
    if (run.changes.some((change) => change.kind === 'LIST_SCOPE')) throw new Error('Use migrateListScopes.js to recover this list-scope run.');
    if (run.recoveredAt) return run;
    for (const change of run.changes.filter((c) => c.changedDefault)) {
      const result = await tx.customer.updateMany({
        where: { id: change.customerId, defaultSupermarketId: change.appliedDefault, defaultSupermarketVersion: change.appliedVersion },
        data: { defaultSupermarketId: change.previousDefault, defaultSupermarketVersion: { increment: 1 } },
      });
      if (result.count !== 1) throw new Error(`Customer ${change.customerId} changed since migration; recover manually without overwriting newer preferences`);
    }
    return tx.supermarketMigrationRun.update({ where: { id: runId }, data: { recoveredAt: new Date() } });
  }, { isolationLevel: 'Serializable', timeout: 60000 });
}
