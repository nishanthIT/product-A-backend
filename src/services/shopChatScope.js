import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

export const chatIdentity = p => `${p.userType}:${p.userId ?? p.id}`;
export const shopChatSelect = {
  id: true, name: true, groupChatId: true, shopType: true,
  supermarketOwnerships: { select: { customerId: true } },
  employeeMemberships: { where: { status: 'ACTIVE' }, select: { employeeId: true } },
};
export function rosterForShop(shop) {
  if (!shop || shop.shopType !== 'CUSTOMER') return [];
  return [
    ...shop.supermarketOwnerships.map(o => ({ userId: o.customerId, userType: 'CUSTOMER', isAdmin: true })),
    ...shop.employeeMemberships.map(m => ({ userId: m.employeeId, userType: 'EMPLOYEE', isAdmin: false })),
  ];
}

/** Revalidate the authenticated selection, never legacy pointers or company roles. */
export async function selectedChatShop(user, db = prisma) {
  if (!user?.shopId || !['CUSTOMER', 'EMPLOYEE'].includes(user.userType)) return null;
  const shop = await db.shop.findUnique({ where: { id: user.shopId }, select: shopChatSelect });
  return rosterForShop(shop).some(p => chatIdentity(p) === chatIdentity(user)) ? shop : null;
}

export function participantsForShop(chat, shop) {
  const roster = rosterForShop(shop);
  if (!shop || (chat.shopId && chat.shopId !== shop.id)) return [];
  if (chat.type === 'GROUP' && chat.id === shop.groupChatId) return roster;
  if (chat.shopId !== shop.id) return [];
  const eligible = new Set(roster.map(chatIdentity));
  return chat.participants.filter(p => eligible.has(chatIdentity(p)));
}

export function visibleShopChat(user, chat, shop) {
  if (chat.type === 'GROUP' && chat.name === 'ALL Chat') return false;
  if (!shop || (chat.shopId && chat.shopId !== shop.id)) return false;
  if (chat.type === 'GROUP' && chat.id === shop.groupChatId) return true;
  if (chat.shopId !== shop.id) return false;
  const participants = participantsForShop(chat, shop);
  if (chat.type === 'PERSONAL' && (chat.participants.length !== 2 || participants.length !== 2)) return false;
  return participants.some(p => chatIdentity(p) === chatIdentity(user));
}

export async function chatOwningShop(chat, db = prisma) {
  if (chat.shopId) return db.shop.findUnique({ where: { id: chat.shopId }, select: shopChatSelect });
  if (chat.type !== 'GROUP') return null;
  const linked = await db.shop.findMany({ where: { groupChatId: chat.id }, select: shopChatSelect, take: 2 });
  return linked.length === 1 && linked[0].shopType === 'CUSTOMER' ? linked[0] : null;
}
