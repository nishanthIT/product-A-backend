import { teamShopWhere } from './chatDirectory.js';
import { blockedPeers } from './chatSafety.js';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

export const GLOBAL_CHAT_NAME = 'ALL Chat';


/**
 * Who may read/post in a chat. A shop's group chat is reachable only through the
 * caller's verified ownership or ACTIVE membership; stale participants never grant access.
 * Returns { chat, canRead, canJoin } or null if the chat does not exist.
 */
export async function getChatAccess(user, chatId, db = prisma) {
  if (!user || !chatId) return null;
  const chat = await db.chat.findUnique({
    where: { id: String(chatId) },
    select: { id: true, type: true, name: true, participants: { select: { userId: true, userType: true } } },
  });
  if (!chat) return null;

  if (chat.type === 'PERSONAL') {
    const peers = await blockedPeers(user, db);
    if (chat.participants.some(p => peers.some(b => b.id === p.userId && b.userType === p.userType))) return { chat, canRead: false, canJoin: false };
  }
  const isParticipant = chat.participants.some((p) => p.userId === user.id && p.userType === user.userType);
  const isAdmin = user.userType === 'ADMIN';

  if (chat.type === 'GROUP') {
    const shop = await db.shop.findFirst({ where: { groupChatId: chat.id }, select: { id: true } });
    if (shop) {
      const ownShop = !!await db.shop.findFirst({ where: { id: shop.id, ...teamShopWhere(user) }, select: { id: true } });
      return { chat, shopId: shop.id, canRead: ownShop || isAdmin, canJoin: ownShop };
    }
    if (chat.name === GLOBAL_CHAT_NAME) return { chat, canRead: true, canJoin: true };
  }

  return { chat, canRead: isParticipant || isAdmin, canJoin: false };
}
