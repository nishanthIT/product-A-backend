import { PrismaClient, Prisma } from '@prisma/client';
const prisma = new PrismaClient();
const quote = name => `"${name.replaceAll('"', '""')}"`;

// Parse all scalar columns without loading account data. Batched SQL statements
// validate the schema; checking each model separately cost 19s on the live link.
export async function verifyServiceSchema(db = prisma) {
  const checks = {
    sessions: ['revokedSession', 'admin', 'customer', 'empolyee', 'accountDeletionJob', 'chatSuspension'],
    moderation: ['moderationDeletionJob', 'contentReport', 'chatModerationAction', 'userBlock', 'chatUpload'],
    cache: ['cacheEntry'],
    security: ['securityEvent', 'securityRestriction', 'securityException', 'securityPolicy', 'securityAdminAudit'],
    lists: ['list', 'listProduct', 'trackedList', 'priceReport'],
    chat: ['chat', 'chatParticipant', 'message', 'messageRead', 'messageDelivery', 'chatRetentionRun', 'chatAttachmentDeletionJob'],
  };
  const statements = [];
  for (const [service, models] of Object.entries(checks)) {
    const queries = models.map((name, index) => {
      const model = Prisma.dmmf.datamodel.models.find(m => m.name[0].toLowerCase() + m.name.slice(1) === name);
      if (!db[name] || !model) throw Object.assign(new Error('Generated Prisma client is outdated'), { code: 'CLIENT_SCHEMA_MISMATCH', meta: { modelName: name } });
      const columns = model.fields.filter(f => f.kind !== 'object').map(f => quote(f.dbName || f.name));
      return `${service}_check_${index} AS (SELECT ${columns.join(',')} FROM ${quote(model.dbName || model.name)} LIMIT 0)`;
    });
    statements.push({ service, queries });
  }
  // A healthy request needs one database round trip, even on a high-latency
  // connection. Only diagnose each service separately after a schema failure.
  try { await db.$queryRawUnsafe(`WITH ${statements.flatMap(item => item.queries).join(',')} SELECT 1 AS ready`); }
  catch (failure) {
    for (const { service, queries } of statements) {
      try { await db.$queryRawUnsafe(`WITH ${queries.join(',')} SELECT 1 AS ready`); }
      catch (error) { error.service = service; throw error; }
    }
    throw failure;
  }
  return Object.fromEntries(Object.keys(checks).map(service => [service, 'ready']));
}
