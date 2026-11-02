import { blockedPeers } from './chatSafety.js';
import { selectedChatShop, visibleShopChat, chatOwningShop, rosterForShop, chatIdentity } from './shopChatScope.js';
import { PrismaClient } from '@prisma/client';
import { findGlobalChat, retailChatRoster, visibleCommunityDirect } from './globalChat.js';
const prisma = new PrismaClient();

/** REST, private attachments and sockets share retail and private-team rules. */
export async function getChatAccess(user, chatId, db = prisma) {
  if (!user || typeof chatId !== 'string') return null;
  const [chat, shop] = await Promise.all([
    db.chat.findUnique({ where: { id: chatId }, include: { participants: true } }),
    selectedChatShop(user, db),
  ]);
  if (!chat) return null;
  const isGlobalChat = !chat.shopId && chat.type === 'GROUP' && (await findGlobalChat(db))?.id === chat.id;
  const owning = isGlobalChat ? null : chat.shopId ? { id: chat.shopId } : await chatOwningShop(chat, db);
  let canRead = !!shop && (isGlobalChat || (chat.type === 'PERSONAL' && !chat.shopId
    ? visibleCommunityDirect(user, chat, await retailChatRoster(db, chat.participants))
    : owning?.id === shop.id && visibleShopChat(user, chat, shop)));
  if (canRead && chat.type === 'PERSONAL') {
    const peers = await blockedPeers(user, db);
    canRead = !chat.participants.some(p => peers.some(b => b.id === p.userId && b.userType === p.userType));
  }
  // Shop-list sharing remains available to two current teammates, but can never
  // expose shop data to the global room or a direct recipient from another shop.
  const teammates = new Set(rosterForShop(shop).map(chatIdentity));
  const listShopId = isGlobalChat || (chat.type === 'PERSONAL' && !chat.participants.every(p => teammates.has(chatIdentity(p)))) ? null : shop?.id;
  return { chat, shopId: listShopId,
    isGlobalChat, canRead, canJoin: canRead && (isGlobalChat || (chat.type === 'GROUP' && chat.id === shop.groupChatId)) };
}
