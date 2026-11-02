import { PrismaClient } from '@prisma/client';
import { chatParticipantRows } from './chatDirectory.js';
import cacheService from './cacheService.js';
import { emitToUser, userKey } from './realtime.js';

const prisma = new PrismaClient();

// Call only after the membership transaction commits. Events contain identifiers,
// never a roster or messages: clients refetch through current REST authorization.
export async function notifyShopTeamChanged(shopId, employeeId, db = prisma) {
  try {
    const shop = await db.shop.findUnique({ where: { id: shopId }, select: { groupChatId: true } });
    if (!shop?.groupChatId) return;
    const chat = await db.chat.findUnique({ where: { id: shop.groupChatId }, include: { participants: true } });
    if (!chat) return;
    const rows = await chatParticipantRows(chat, db);
    if (employeeId !== undefined) rows.push({ userId: employeeId, userType: 'EMPLOYEE' });
    const recipients = new Map(rows.map(p => [userKey(p.userType, p.userId), p]));
    await Promise.all([...recipients].map(async ([key, p]) => {
      emitToUser(null, p.userType, p.userId, 'chats_changed');
      emitToUser(null, p.userType, p.userId, 'chat_participants_changed', { chatId: chat.id, shopId });
      await Promise.all([cacheService.invalidateUserChats(key), cacheService.invalidateUserContacts(key)]);
    }));
  } catch (error) {
    // Membership has already committed. A transient notification failure must not
    // make the owner retry a successful create; focus/reconnect refetches recover.
    console.warn('Team chat refresh notification deferred:', error.code || error.name);
  }
}
