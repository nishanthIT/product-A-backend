import { safeLogger } from '../services/safeLogger.js';
const securityLog = safeLogger('realtime/socketServer.js');
import { activeSecurityRestriction, securityBudgets, securityBudgetIdentity, subjectKeyOf } from '../services/securityProtection.js';
import cookieParser from 'cookie-parser';
import { readSessionToken } from '../services/sessionSecurity.js';
import { serviceError } from '../services/serviceErrors.js';
import { activeSuspension } from '../services/chatSafety.js';
import { broadcastChat } from '../services/chatBroadcast.js';
import { verifySessionToken } from '../services/sessionTokens.js';
import { canAccessShop, resolvePrincipal, hasShopFeatureAccess, SHOP_FEATURES } from '../services/accessControl.js';
import { getChatAccess } from '../services/chatAccess.js';
import { setRealtimeServer, userKey, userRoom } from '../services/realtime.js';
import { recordChatReceipts } from '../services/chatReceipts.js';

/**
 * Socket.IO auth + room handlers. Every room join is authorized against the same
 * memberships the REST API uses; client-supplied user ids are ignored.
 */
export function attachSocketServer(io, { userSockets, cacheService }) {
  setRealtimeServer(io);
  const parseCookies = cookieParser();
  const requestedLimit = Number(process.env.SOCKET_EVENTS_PER_MINUTE || 300);
  const eventLimit = Number.isInteger(requestedLimit) && requestedLimit >= 60 && requestedLimit <= 3000 ? requestedLimit : 300;

  io.use(async (socket, next) => {
    const offered = socket.handshake.auth?.token;
    let token;
    if (offered !== undefined && offered !== null) {
      // A malformed explicit credential must never fall back to another account's cookie.
      if (typeof offered !== 'string' || !offered || offered.length > 8192) return next(new Error('Authentication failed'));
      token = offered;
    } else {
      parseCookies(socket.request, {}, () => {});
      token = readSessionToken(socket.request);
    }
    try {
      const ip = socket.handshake.address;
      const connected = await securityBudgets.consume(`socket-ip:${ip}`, 'socket-connections', { limit: 120, seconds: 60 });
      if (!connected.allowed) return next(new Error('Too many connection attempts. Please retry later.'));
      if (!token) {
        // Anonymous connections have no private rooms or data subscriptions.
        socket.user = null;
        return next();
      }
      const claims = await verifySessionToken(token);
      const principal = await resolvePrincipal(claims, undefined, socket.handshake.auth?.supermarketId);
      if (!principal.user) {
        socket.emit('auth_error', { message: principal.error });
        return next(new Error('Authentication error: ' + principal.error));
      }
      if (await activeSecurityRestriction({ user: principal.user, ip: socket.handshake.address })) return next(new Error('Account temporarily restricted'));
      socket.sessionToken = token;
      socket.claims = claims;
      socket.user = principal.user;
      next();
    } catch (err) {
      socket.emit('auth_error', { message: 'Token expired or invalid' });
      return next(new Error('Authentication failed'));
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
    if (userType === 'ADMIN') socket.join('security_admins');
    else socket.leave('security_admins');
    userSockets.set(userKey(userType, id), socket.id);
    cacheService.setUserOnline(userKey(userType, id), socket.id).catch((err) => securityLog.error('Cache error:', serviceError(err)));
  };

  io.on('connection', (socket) => {
    const expiresIn = socket.claims ? Math.max(0, socket.claims.exp * 1000 - Date.now()) : null;
    const expiryTimer = expiresIn === null ? null : setTimeout(() => socket.disconnect(true), expiresIn);
    socket.on('disconnect', () => { if (expiryTimer) clearTimeout(expiryTimer); });
    socket.use(async (packet, next) => {
      try {
        const subject = socket.user ? await securityBudgetIdentity(subjectKeyOf(socket.user)) : `socket-ip:${socket.handshake.address}`;
        const budget = await securityBudgets.consume(subject, 'socket-events', { limit: socket.user ? eventLimit : 30, seconds: 60 });
        if (!budget.allowed) { socket.disconnect(true); return next(new Error('Too many events. Please retry later.')); }
        if (!socket.sessionToken) return next(); // Anonymous handlers cannot join private rooms.
        await verifySessionToken(socket.sessionToken);
        socket.user = await currentUser(socket);
        if (!socket.user) throw new Error('Session revoked');
        if (await activeSecurityRestriction({ user: socket.user, ip: socket.handshake.address })) throw new Error('Account temporarily restricted');
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

    socket.on('join_chat', async (chatId, acknowledge) => {
      try {
        const user = await currentUser(socket);
        const access = user && (await getChatAccess(user, chatId));
        if (!access?.canRead) {
          socket.emit('chat_join_denied', { chatId });
          if (typeof acknowledge === 'function') acknowledge({ success: false, code: 'CHAT_ACCESS_DENIED' });
          return;
        }
        await socket.join(`chat_${chatId}`);
        if (typeof acknowledge === 'function') acknowledge({ success: true });
      } catch (err) {
        securityLog.error('join_chat check failed:', err.message);
        if (typeof acknowledge === 'function') acknowledge({ success: false, code: 'CHAT_UNAVAILABLE' });
      }
    });

    socket.on('leave_chat', (chatId) => {
      socket.leave(`chat_${chatId}`);
    });

    // An acknowledgement proves a client received persisted content; merely
    // emitting to a socket or seeing an online flag must never mark delivery.
    socket.on('message_delivered', async (payload, acknowledge) => {
      try {
        const { chatId, messageIds } = payload && typeof payload === 'object' ? payload : {};
        const user = await currentUser(socket);
        if (!user || typeof chatId !== 'string' || !chatId) {
          if (typeof acknowledge === 'function') acknowledge({ success: false, code: 'CHAT_ACCESS_DENIED' });
          return;
        }
        await recordChatReceipts({ user, chatId, messageIds, kind: 'delivered', io });
        if (typeof acknowledge === 'function') acknowledge({ success: true });
      } catch (error) {
        if (typeof acknowledge === 'function') acknowledge({ success: false, code: [403, 404].includes(error.status) ? 'CHAT_ACCESS_DENIED' : 'CHAT_UNAVAILABLE' });
      }
    });

    // Messages are created and broadcast by the authenticated REST endpoint.
    // Never relay a client-supplied sender or an unpersisted message.

    for (const [incoming, outgoing, action] of [['typing_start', 'user_typing', 'setTyping'], ['typing_stop', 'user_stopped_typing', 'clearTyping']]) {
      socket.on(incoming, async ({ chatId } = {}) => {
        try {
          const user = await currentUser(socket);
          if (!user || typeof chatId !== 'string' || !socket.rooms.has(`chat_${chatId}`)) return;
          if (!(await getChatAccess(user, chatId))?.canRead) {
            socket.leave(`chat_${chatId}`);
            socket.emit('chat_join_denied', { chatId });
            return;
          }
          await cacheService[action](user.id, chatId);
          await broadcastChat(io, chatId, outgoing, { id: user.id, userType: user.userType, name: user.name, chatId }, { sender: user, exceptSocketId: socket.id });
        } catch (error) { securityLog.warn('Chat typing check failed:', error.message); }
      });
    }

    socket.on('join_shop_lists', async (shopId) => {
      if (!shopId) return;
      try {
        const principal = await resolvePrincipal(socket.claims, undefined, String(shopId));
        if (!principal.user || (principal.user.userType === 'EMPLOYEE' && !hasShopFeatureAccess(principal.user, SHOP_FEATURES.LISTS)) || !(await canAccessShop(socket.claims, String(shopId)))) {
          socket.emit('shop_lists_denied', { shopId });
          return;
        }
      } catch (err) {
        securityLog.error('join_shop_lists check failed:', err.message);
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
        await cacheService.setUserOffline(key).catch(error => securityLog.error('Socket offline cache update failed', serviceError(error)));
      }
    });
  });
}
