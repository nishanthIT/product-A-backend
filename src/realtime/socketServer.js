import jwt from 'jsonwebtoken';
import { canAccessShop, resolvePrincipal } from '../services/accessControl.js';
import { getChatAccess } from '../services/chatAccess.js';
import { setRealtimeServer, userKey, userRoom } from '../services/realtime.js';

/**
 * Socket.IO auth + room handlers. Every room join is authorized against the same
 * memberships the REST API uses; client-supplied user ids are ignored.
 */
export function attachSocketServer(io, { userSockets, cacheService }) {
  setRealtimeServer(io);

  io.use(async (socket, next) => {
    const token = socket.handshake.auth?.token;
    if (!token) {
      // Unauthenticated sockets may connect but cannot join any private room.
      socket.user = null;
      return next();
    }
    try {
      const claims = jwt.verify(token, process.env.JWT_SECRET || 'your-secret-key');
      const principal = await resolvePrincipal(claims);
      if (!principal.user) {
        socket.emit('auth_error', { message: principal.error });
        return next(new Error('Authentication error: ' + principal.error));
      }
      socket.claims = claims;
      socket.user = principal.user;
      next();
    } catch (err) {
      socket.emit('auth_error', { message: 'Token expired or invalid' });
      return next(new Error('Authentication error: ' + err.message));
    }
  });

  // Re-checks the token's memberships so revoked access stops at the next join.
  const currentUser = async (socket) => {
    if (!socket.claims) return null;
    const principal = await resolvePrincipal(socket.claims);
    return principal.user ?? null;
  };

  const joinOwnRoom = (socket) => {
    const { userType, id } = socket.user;
    socket.join(userRoom(userType, id));
    userSockets.set(userKey(userType, id), socket.id);
    cacheService.setUserOnline(userKey(userType, id), socket.id).catch((err) => console.error('Cache error:', err));
  };

  io.on('connection', (socket) => {
    if (socket.user) joinOwnRoom(socket);

    // Legacy clients send their id; the room is always taken from the verified token.
    socket.on('join_user_room', () => {
      if (socket.user) joinOwnRoom(socket);
    });

    socket.on('join_chat', async (chatId) => {
      try {
        const user = await currentUser(socket);
        const access = user && (await getChatAccess(user, chatId));
        if (!access?.canRead) {
          socket.emit('chat_join_denied', { chatId });
          return;
        }
        socket.join(`chat_${chatId}`);
      } catch (err) {
        console.error('join_chat check failed:', err.message);
      }
    });

    socket.on('leave_chat', (chatId) => {
      socket.leave(`chat_${chatId}`);
    });

    // Relays only within rooms this socket was authorized to join.
    socket.on('new_message', async (data) => {
      const { chatId, message } = data || {};
      if (!chatId || !socket.rooms.has(`chat_${chatId}`)) return;
      await cacheService.addMessageToCache(chatId, message);
      socket.to(`chat_${chatId}`).emit('message_received', message);
    });

    socket.on('typing_start', async (data) => {
      const { chatId, userInfo } = data || {};
      if (!chatId || !socket.rooms.has(`chat_${chatId}`)) return;
      await cacheService.setTyping(userInfo?.id || userInfo?.userId, chatId);
      socket.to(`chat_${chatId}`).emit('user_typing', userInfo);
    });

    socket.on('typing_stop', async (data) => {
      const { chatId, userInfo } = data || {};
      if (!chatId || !socket.rooms.has(`chat_${chatId}`)) return;
      await cacheService.clearTyping(userInfo?.id || userInfo?.userId, chatId);
      socket.to(`chat_${chatId}`).emit('user_stopped_typing', userInfo);
    });

    socket.on('join_shop_lists', async (shopId) => {
      if (!shopId) return;
      try {
        if (!(await canAccessShop(socket.claims, String(shopId)))) {
          socket.emit('shop_lists_denied', { shopId });
          return;
        }
      } catch (err) {
        console.error('join_shop_lists check failed:', err.message);
        return;
      }
      socket.join(`shop_${shopId}_lists`);
    });

    socket.on('leave_shop_lists', (shopId) => {
      if (!shopId) return;
      socket.leave(`shop_${shopId}_lists`);
    });

    socket.on('disconnect', async () => {
      if (!socket.user) return;
      const key = userKey(socket.user.userType, socket.user.id);
      if (userSockets.get(key) === socket.id) {
        userSockets.delete(key);
        await cacheService.setUserOffline(key);
      }
    });
  });
}
