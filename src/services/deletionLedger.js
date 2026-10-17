import crypto from 'node:crypto';
import { accountTable, processDeletion, receiptDigest } from './accountDeletion.js';

const mac = (payload, key) => {
  if (typeof key !== 'string' || key.length < 32) throw new Error('A private DELETION_LEDGER_KEY of at least 32 characters is required');
  return crypto.createHmac('sha256', key).update(payload).digest('hex');
};
export async function exportDeletionLedger(db, key) {
  const entries = await db.accountDeletionJob.findMany({ where: { status: { not: 'REQUESTED' } }, select: { id: true, userId: true, userType: true, createdAt: true }, orderBy: { id: 'asc' } });
  const payload = JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), entries });
  return { payload, signature: mac(payload, key) };
}
export function verifyDeletionLedger(envelope, key) {
  if (typeof envelope?.payload !== 'string' || !/^[a-f0-9]{64}$/.test(envelope.signature || '')) throw new Error('Invalid deletion ledger');
  if (!crypto.timingSafeEqual(Buffer.from(envelope.signature, 'hex'), Buffer.from(mac(envelope.payload, key), 'hex'))) throw new Error('Deletion ledger integrity check failed');
  const ledger = JSON.parse(envelope.payload);
  if (ledger.version !== 1 || !Number.isFinite(Date.parse(ledger.exportedAt)) || !Array.isArray(ledger.entries)) throw new Error('Invalid ledger format');
  for (const row of ledger.entries) if (!accountTable(row.userType) || !Number.isSafeInteger(row.userId) || row.userId < 1 || typeof row.id !== 'string') throw new Error('Invalid ledger identity');
  return ledger;
}

// Only call against an isolated, traffic-disabled restore. Provider/files review remains mandatory.
export async function replayDeletionLedger(db, envelope, key, options = {}) {
  const ledger = verifyDeletionLedger(envelope, key);
  const results = [];
  for (const entry of ledger.entries) {
    const identity = { userId: entry.userId, userType: entry.userType };
    const exists = await db[accountTable(entry.userType)].findUnique({ where: { id: entry.userId }, select: { id: true } });
    const job = await db.accountDeletionJob.upsert({ where: { userId_userType: identity },
      create: { ...identity, receiptHash: receiptDigest(crypto.randomBytes(32).toString('hex')), status: exists ? 'PROCESSING' : 'EXTERNAL_REVIEW' },
      update: exists ? { status: 'PROCESSING', completedAt: null, reviewEvidence: {} } : {} });
    results.push(exists ? await processDeletion(db, job.id, options) : { id: job.id, status: job.status });
  }
  // Restoring old sequences must not allocate an erased identity to a newly registered person.
  for (const [type, table] of Object.entries({ CUSTOMER: 'Customer', EMPLOYEE: 'Empolyee', ADMIN: 'Admin' })) {
    const maxDeleted = Math.max(0, ...ledger.entries.filter(e => e.userType === type).map(e => e.userId));
    // table is a closed server-side allowlist; values use query parameters.
    await db.$executeRawUnsafe(`SELECT setval(pg_get_serial_sequence('"${table}"', 'id'), GREATEST(COALESCE((SELECT MAX("id") FROM "${table}"), 1), $1, (SELECT last_value FROM "${table}_id_seq")), true)`, maxDeleted);
  }
  return { exportedAt: ledger.exportedAt, replayed: results.length, results, providerReviewRequired: true };
}
