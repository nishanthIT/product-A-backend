import { PrismaClient } from '@prisma/client';
import { chatIdentity } from './shopChatScope.js';

const prisma = new PrismaClient();

// Reuse the original community thread, including its ID and message history.
// Shop-owned groups can never become public merely because of their name.
export async function findGlobalChat(db = prisma) {
  const rows = await db.$queryRaw`
    SELECT c.id FROM "Chat" c
    WHERE c.type = 'GROUP' AND c."shopId" IS NULL
      AND c.name IN ('ALL Chat', 'Global Chat')
      AND NOT EXISTS (SELECT 1 FROM "Shop" s WHERE s."groupChatId" = c.id)
    ORDER BY c."createdAt", c.id LIMIT 1`;
  return rows[0] ?? null;
}

// Run at startup, not while listing history. The lock prevents concurrent API
// instances from creating separate global rooms on a new installation.
export async function ensureGlobalChat(db = prisma) {
  return db.$transaction(async tx => {
    await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtextextended('paymi:retail-global-chat', 0))`;
    const existing = await findGlobalChat(tx);
    if (existing) {
      const chat = await tx.chat.findUnique({ where: { id: existing.id } });
      return chat.name === 'Global Chat' ? chat : tx.chat.update({ where: { id: chat.id }, data: { name: 'Global Chat' } });
    }
    return tx.chat.create({ data: { name: 'Global Chat', type: 'GROUP' } });
  }, { maxWait: 15000, timeout: 60000 });
}

// Eligibility comes from verified retail ownership or ACTIVE retail membership,
// never from legacy chat participants, company roles, or wholesale shop pointers.
export async function retailChatRoster(db = prisma, participants) {
  // Direct-chat authorization checks only the two relevant identities. Loading
  // every shop's roster here made opening/sending a DM grow with the whole app.
  const ownerIds = participants?.filter(p => p.userType === 'CUSTOMER').map(p => p.userId ?? p.id);
  const employeeIds = participants?.filter(p => p.userType === 'EMPLOYEE').map(p => p.userId ?? p.id);
  const [owners, employees] = await Promise.all([
    ownerIds?.length === 0 ? [] : db.supermarketOwnership.findMany({ where: { ...(ownerIds && { customerId: { in: ownerIds } }), shop: { shopType: 'CUSTOMER' } }, select: { customerId: true } }),
    employeeIds?.length === 0 ? [] : db.shopEmployeeMembership.findMany({ where: { ...(employeeIds && { employeeId: { in: employeeIds } }), status: 'ACTIVE', shop: { shopType: 'CUSTOMER' } }, select: { employeeId: true } }),
  ]);
  const rows = [
    ...owners.map(o => ({ userId: o.customerId, userType: 'CUSTOMER' })),
    ...employees.map(e => ({ userId: e.employeeId, userType: 'EMPLOYEE' })),
  ];
  return [...new Map(rows.map(p => [chatIdentity(p), p])).values()];
}

export function visibleCommunityDirect(user, chat, roster) {
  if (chat.type !== 'PERSONAL' || chat.shopId || chat.participants.length !== 2) return false;
  const eligible = new Set(roster.map(chatIdentity));
  return chat.participants.every(p => eligible.has(chatIdentity(p))) &&
    chat.participants.some(p => chatIdentity(p) === chatIdentity(user));
}
