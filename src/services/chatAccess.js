import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

export const GLOBAL_CHAT_NAME = 'ALL Chat';

async function userShopId(user, db) {
  if (user.userType === 'EMPLOYEE') return user.shopId ?? null;
  if (user.userType === 'CUSTOMER') {
    const customer = await db.customer.findUnique({ where: { id: user.id }, select: { shopId: true } });
    return customer?.shopId ?? null;
  }
  return null;
}

/**
 * Who may read/post in a chat. A shop's group chat is reachable only through the
 * caller's current shop (owner or ACTIVE employee); stale participant rows never grant it.
 * Returns { chat, canRead, canJoin } or null if the chat does not exist.
 */
export async function getChatAccess(user, chatId, db = prisma) {
  if (!user || !chatId) return null;
  const chat = await db.chat.findUnique({
    where: { id: String(chatId) },
    select: { id: true, type: true, name: true, participants: { select: { userId: true, userType: true } } },
  });
  if (!chat) return null;

  const isParticipant = chat.participants.some((p) => p.userId === user.id && p.userType === user.userType);
  const isAdmin = user.userType === 'ADMIN';

  if (chat.type === 'GROUP') {
    const shop = await db.shop.findFirst({ where: { groupChatId: chat.id }, select: { id: true } });
    if (shop) {
      const ownShop = shop.id === (await userShopId(user, db));
      return { chat, shopId: shop.id, canRead: ownShop || isAdmin, canJoin: ownShop };
    }
    if (chat.name === GLOBAL_CHAT_NAME) return { chat, canRead: true, canJoin: true };
  }

  return { chat, canRead: isParticipant || isAdmin, canJoin: false };
}
