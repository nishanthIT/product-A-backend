import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

export async function persistRecoveryJournal(db) {
  const directory = process.env.DELETION_LEDGER_DIR;
  if (!directory && process.env.NODE_ENV !== 'production') return;
  if (!directory || !path.isAbsolute(directory)) throw new Error('Configure an absolute private DELETION_LEDGER_DIR before production erasure');
  const target = path.resolve(directory);
  for (const publicDir of ['uploads', 'public', 'images']) {
    const relative = path.relative(path.resolve(publicDir), target);
    if (!relative.startsWith('..') && !path.isAbsolute(relative)) throw new Error('Deletion ledger cannot be stored in a public directory');
  }
  const { exportDeletionLedger } = await import('./deletionLedger.js');
  const envelope = await exportDeletionLedger(db, process.env.DELETION_LEDGER_KEY);
  await fs.mkdir(target, { recursive: true, mode: 0o700 });
  const file = path.join(target, `ledger-${Date.now()}-${crypto.randomUUID()}.json`);
  const handle = await fs.open(file, 'wx', 0o600);
  try { await handle.writeFile(JSON.stringify(envelope)); await handle.sync(); }
  finally { await handle.close(); }
  const dirHandle = await fs.open(target, 'r');
  try { await dirHandle.sync(); } finally { await dirHandle.close(); }
  // Host operators must verify this directory is an independent durable recovery store.
  // A successful local fsync does not prove provider backups, replication or retention.
}
