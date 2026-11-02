import { PrismaClient } from '@prisma/client';
import { getChatAccess } from './chatAccess.js';
import { hiddenAuthors } from './chatSafety.js';
import { broadcastChat, deferChatWork, settleChatWork } from './chatBroadcast.js';
import cacheService from './cacheService.js';
import { userKey } from './realtime.js';
import { lockAccountForWrite } from './accountWriteBarrier.js';

const prisma = new PrismaClient();
const invalid = (status, message) => Object.assign(new Error(message), { status });

/** Both receipt transports persist only messages the current account may read. */
export async function recordChatReceipts({ user, messageIds, chatId, kind, io, db = prisma }) {
  if (!['read', 'delivered'].includes(kind) || !Array.isArray(messageIds) || messageIds.length > 500 || messageIds.some(id => typeof id !== 'string' || !id)) {
    throw invalid(400, 'Message IDs array is required');
  }
  const ids = [...new Set(messageIds)];
  if (!ids.length) return { success: true };
  const messages = await db.message.findMany({ where: { id: { in: ids }, deletedAt: null, ...(chatId && { chatId }), NOT: await hiddenAuthors(user, db) }, select: { id: true, chatId: true, senderId: true, senderType: true } });
  if (messages.length !== ids.length) throw invalid(404, 'Messages not found');
  const chats = [...new Set(messages.map(m => m.chatId))];
  const access = await Promise.all(chats.map(id => getChatAccess(user, id, db)));
  if (access.some(value => !value?.canRead)) throw invalid(403, 'You do not have access to this chat');
  const incoming = messages.filter(m => m.senderId !== user.id || m.senderType !== user.userType);
  const now = new Date();
  const data = incoming.map(m => ({ messageId: m.id, userId: user.id, userType: user.userType }));
  if (!data.length) return { success: true };
  // One batch replaces one database round trip per message. Unique constraints
  // make retransmitted acknowledgements and multi-device reads idempotent.
  const changed = await db.$transaction(async tx => {
    await lockAccountForWrite(tx, user);
    const delivery = await tx.messageDelivery.createMany({ data: data.map(row => ({ ...row, deliveredAt: now })), skipDuplicates: true });
    if (kind === 'read') return (await tx.messageRead.createMany({ data: data.map(row => ({ ...row, readAt: now })), skipDuplicates: true })).count;
    return delivery.count;
  }, { maxWait: 15000, timeout: 60000 });
  if (!changed) return { success: true };
  deferChatWork(async () => {
    await settleChatWork([
      cacheService.invalidateUserChats(userKey(user.userType, user.id)),
      ...chats.map(id => broadcastChat(io, id, kind === 'read' ? 'message_read' : 'message_delivered', {
        chatId: id, messageIds: incoming.filter(m => m.chatId === id).map(m => m.id), userId: user.id, userType: user.userType,
        ...(kind === 'read' ? { readAt: now } : { deliveredAt: now }),
      }, { sender: user, includeUserRooms: true })),
    ]);
  });
  return { success: true };
}
