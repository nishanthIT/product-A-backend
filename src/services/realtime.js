// Per-user socket rooms and keys must include the account type: Admin, Customer and
// Empolyee ids come from separate tables and collide (customer 5 ≠ employee 5).
export const userRoom = (userType, userId) => `user_${userType}_${userId}`;
export const userKey = (userType, userId) => `${userType}:${userId}`;

let ioInstance = null;

export function setRealtimeServer(io) {
  ioInstance = io;
}

export function emitToUser(io, userType, userId, event, payload) {
  (io ?? ioInstance)?.to(userRoom(userType, userId)).emit(event, payload);
}

/** Drops live sockets so removed access cannot keep receiving room broadcasts. */
export function disconnectUser(userType, userId) {
  ioInstance?.in(userRoom(userType, userId)).disconnectSockets(true);
}
