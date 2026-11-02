import { resolvePrincipal } from './accessControl.js';
import { getChatAccess } from './chatAccess.js';
import { blockedPeers } from './chatSafety.js';
import { verifySessionToken } from './sessionTokens.js';
import { chatParticipantRows } from './chatDirectory.js';
import { userRoom } from './realtime.js';
import { serviceError } from './serviceErrors.js';
import { PrismaClient } from '@prisma/client';

const db = new PrismaClient();
const pending = new Set();
/** Committed writes succeed even when optional notification infrastructure fails. */
export function deferChatWork(work) {
  const task = Promise.resolve().then(work).catch(error => console.warn('Chat saved; realtime refresh deferred', serviceError(error)));
  pending.add(task);
  task.finally(() => pending.delete(task));
  return task;
}
export async function drainChatWork() { while (pending.size) await Promise.allSettled([...pending]); }
export async function settleChatWork(tasks) {
  const results = await Promise.allSettled(tasks);
  for (const result of results) if (result.status === 'rejected') console.warn('Chat refresh deferred', serviceError(result.reason));
}

/** Room membership is a hint, never ongoing authorization after staff changes. */
export async function broadcastChat(io, chatId, event, payload, { sender, exceptSocketId, includeUserRooms = false, participants } = {}) {
  if (!io) return;
  const blocked = sender ? await blockedPeers(sender) : [];
  const rooms = [`chat_${chatId}`];
  if (includeUserRooms) {
    if (!participants) {
      const chat = await db.chat.findUnique({ where: { id: chatId }, include: { participants: true } });
      if (!chat) return;
      participants = await chatParticipantRows(chat, db);
    }
    rooms.push(...participants.map(p => userRoom(p.userType, p.userId)));
  }
  // A union fetch reaches foreground inboxes and every device without double
  // delivery when a device is in both its user room and the conversation room.
  const sockets = await io.in(rooms).fetchSockets();
  const accessChecks = new Map();
  await Promise.all(sockets.map(async socket => {
    try {
      const token = socket.handshake.auth?.token;
      const selectedShop = socket.handshake.auth?.supermarketId;
      const key = JSON.stringify([token, selectedShop]);
      if (!accessChecks.has(key)) accessChecks.set(key, (async () => {
        const claims = await verifySessionToken(token);
        const { user } = await resolvePrincipal(claims, undefined, selectedShop);
        return user && (await getChatAccess(user, chatId))?.canRead ? user : null;
      })());
      const user = await accessChecks.get(key);
      if (!user) {
        await socket.leave(`chat_${chatId}`);
        socket.emit('chat_join_denied', { chatId });
        return;
      }
      if (socket.id === exceptSocketId || blocked.some(p => p.id === user.id && p.userType === user.userType)) return;
      socket.emit(event, event === 'message_received' ? {
        ...payload, isOwnMessage: payload.senderId === user.id && payload.senderType === user.userType,
      } : payload);
      if (includeUserRooms) socket.emit('chats_changed', { chatId, reason: event === 'message_received' ? 'message' : event === 'message_read' ? 'read' : event === 'message_deleted' ? 'deleted' : event });
    } catch (error) {
      await socket.leave(`chat_${chatId}`);
      console.warn('Chat recipient check deferred', serviceError(error));
    }
  }));
}
