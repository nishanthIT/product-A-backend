import { activeSuspension, blockedPeers } from '../services/chatSafety.js';
import { verifySessionToken } from '../services/sessionTokens.js';
import { canAccessShop, resolvePrincipal, hasShopFeatureAccess, SHOP_FEATURES } from '../services/accessControl.js';
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
      const claims = await verifySessionToken(token);
      const principal = await resolvePrincipal(claims, undefined, socket.handshake.auth?.supermarketId);
      if (!principal.user) {
        socket.emit('auth_error', { message: principal.error });
        return next(new Error('Authentication error: ' + principal.error));
      }
      socket.sessionToken = token;
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
    const principal = await resolvePrincipal(socket.claims, undefined, socket.handshake.auth?.supermarketId);
    return principal.user ?? null;
  };

  const joinOwnRoom = (socket) => {
    const { userType, id } = socket.user;
    socket.join(userRoom(userType, id));
    userSockets.set(userKey(userType, id), socket.id);
    cacheService.setUserOnline(userKey(userType, id), socket.id).catch((err) => console.error('Cache error:', err));
  };

  io.on('connection', (socket) => {
    const expiresIn = socket.claims ? Math.max(0, socket.claims.exp * 1000 - Date.now()) : null;
    const expiryTimer = expiresIn === null ? null : setTimeout(() => socket.disconnect(true), expiresIn);
    socket.on('disconnect', () => { if (expiryTimer) clearTimeout(expiryTimer); });
    socket.use(async (packet, next) => {
      try {
        if (!socket.sessionToken) return next(); // Anonymous handlers cannot join private rooms.
        await verifySessionToken(socket.sessionToken);
        if (!await currentUser(socket)) throw new Error('Session revoked');
        if (['typing_start', 'typing_stop'].includes(packet[0])) {
          const suspension = await activeSuspension(socket.user);
          if (suspension) {
            socket.emit('chat_suspended', suspension);
            return next(new Error('Chat posting suspended'));
          }
        }
        next();
      } catch { socket.disconnect(true); next(new Error('Session expired or revoked')); }
    });
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

    // Messages are created and broadcast by the authenticated REST endpoint.
    // Never relay a client-supplied sender or an unpersisted message.

    socket.on('typing_start', async (data) => {
      const { chatId } = data || {};
      const userInfo = socket.user && { id: socket.user.id, userType: socket.user.userType, name: socket.user.name };
      if (!userInfo || !chatId || !socket.rooms.has(`chat_${chatId}`)) return;
      await cacheService.setTyping(userInfo?.id || userInfo?.userId, chatId);
      socket.to(`chat_${chatId}`).except((await blockedPeers(socket.user)).map(p => userRoom(p.userType, p.id))).emit('user_typing', userInfo);
    });

    socket.on('typing_stop', async (data) => {
      const { chatId } = data || {};
      const userInfo = socket.user && { id: socket.user.id, userType: socket.user.userType, name: socket.user.name };
      if (!userInfo || !chatId || !socket.rooms.has(`chat_${chatId}`)) return;
      await cacheService.clearTyping(userInfo?.id || userInfo?.userId, chatId);
      socket.to(`chat_${chatId}`).except((await blockedPeers(socket.user)).map(p => userRoom(p.userType, p.id))).emit('user_stopped_typing', userInfo);
    });

    socket.on('join_shop_lists', async (shopId) => {
      if (!shopId) return;
      try {
        const principal = await resolvePrincipal(socket.claims, undefined, String(shopId));
        if (!principal.user || (principal.user.userType === 'EMPLOYEE' && !hasShopFeatureAccess(principal.user, SHOP_FEATURES.LISTS)) || !(await canAccessShop(socket.claims, String(shopId)))) {
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
