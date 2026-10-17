import { PrismaClient } from '@prisma/client';
const db = new PrismaClient();
export const COMMUNITY_VERSION = '2026-10-12';
export async function activeSuspension(user, prisma = db, now = new Date(), scope = 'CHAT') {
  return prisma.chatSuspension.findFirst({ where: { userId: user.id, userType: user.userType, scope, until: { gt: now } }, select: { until: true, reason: true, startedAt: true, scope: true } });
}
export async function requireChatPosting(req, res, next) {
  try {
    const suspension = await activeSuspension(req.user);
    if (suspension) return res.status(403).json({ code: 'CHAT_SUSPENDED', error: `Chat posting is suspended until ${suspension.until.toISOString()}. ${suspension.reason}`, suspension });
    next();
  } catch (error) { next(error); }
}
export async function blockedPeers(user, prisma = db) {
  const rows = await prisma.userBlock.findMany({ where: { OR: [{ userId: user.id, userType: user.userType }, { blockedId: user.id, blockedType: user.userType }] } });
  return rows.map(row => row.userId === user.id && row.userType === user.userType ? { id: row.blockedId, userType: row.blockedType } : { id: row.userId, userType: row.userType });
}
export async function hiddenAuthors(user, prisma = db) {
  return (await blockedPeers(user, prisma)).map(p => ({ senderId: p.id, senderType: p.userType }));
}
