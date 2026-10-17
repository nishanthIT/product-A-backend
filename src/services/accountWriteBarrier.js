import { activeSuspension } from './chatSafety.js';
const tables = { CUSTOMER: 'Customer', EMPLOYEE: 'Empolyee', ADMIN: 'Admin' };
export async function lockAccountForWrite(tx, user) {
  const table = tables[user.userType];
  if (!table) throw Object.assign(new Error('Invalid account'), { status: 401 });
  const rows = await tx.$queryRawUnsafe(`SELECT "id" FROM "${table}" WHERE "id" = $1 FOR SHARE`, user.id);
  if (await activeSuspension(user, tx, new Date(), 'ACCOUNT')) throw Object.assign(new Error('Account access is temporarily suspended'), { status: 403 });
  const job = await tx.accountDeletionJob.findUnique({ where: { userId_userType: { userId: user.id, userType: user.userType } }, select: { status: true } });
  if (!rows.length || (job && job.status !== 'REQUESTED')) throw Object.assign(new Error('Personal account deletion is in progress'), { status: 401 });
}
