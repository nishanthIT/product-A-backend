import { PrismaClient } from '@prisma/client';
import cacheService from './cacheService.js';
import { disconnectUser, userKey } from './realtime.js';

const prisma = new PrismaClient();

// Interactive transactions default to a 5s timeout; against a remote DB (~1.6s per round
// trip) a handful of queries exceeds it, so writes below use batched transactions instead.
export const SLOW_DB_TX_OPTIONS = { maxWait: 15_000, timeout: 60_000 };

/** Drops cached chat/contact data derived from the old membership. */
export async function invalidateEmployeeCaches(employeeId) {
  await Promise.all([
    cacheService.invalidateUserChats(userKey('EMPLOYEE', employeeId)),
    cacheService.invalidateUserContacts(userKey('EMPLOYEE', employeeId)),
  ]).catch((err) => console.warn('Cache invalidation failed:', err.message));
}

/** Mirrors the ACTIVE shop membership into the legacy Empolyee.shopId column. */
export async function syncEmployeeShopPointer(db, employeeId) {
  const active = await db.shopEmployeeMembership.findFirst({
    where: { employeeId, status: 'ACTIVE' },
    select: { shopId: true },
  });
  await db.empolyee.update({ where: { id: employeeId }, data: { shopId: active?.shopId ?? null } });
  return active?.shopId ?? null;
}

export async function bumpSessionVersion(db, employeeId) {
  await db.empolyee.update({ where: { id: employeeId }, data: { sessionVersion: { increment: 1 } } });
}

/** Query builders (not awaited) for joining/leaving a shop's group chat. */
function groupChatOps(db, groupChatId, employeeId, join) {
  if (!groupChatId) return [];
  const key = { chatId: groupChatId, userId: employeeId, userType: 'EMPLOYEE' };
  return join
    ? [db.chatParticipant.upsert({ where: { chatId_userId_userType: key }, create: { ...key, isAdmin: false }, update: {} })]
    : [db.chatParticipant.deleteMany({ where: key })];
}

/**
 * Changes one shop membership's status. Only that membership is touched; any
 * company membership the same account holds is left as-is.
 */
export async function setShopMembershipStatus(membershipId, status, db = prisma) {
  const membership = await db.shopEmployeeMembership.findUnique({
    where: { id: membershipId },
    include: { shop: { select: { groupChatId: true } } },
  });
  if (!membership) return null;

  const otherActive = await db.shopEmployeeMembership.findFirst({
    where: { employeeId: membership.employeeId, status: 'ACTIVE', id: { not: membershipId } },
    select: { shopId: true },
  });
  if (status === 'ACTIVE' && otherActive) {
    const err = new Error('This person is already active in another shop');
    err.status = 409;
    throw err;
  }

  const pointer = status === 'ACTIVE' ? membership.shopId : otherActive?.shopId ?? null;
  // The partial unique index on ACTIVE memberships guards against a concurrent second activation.
  const [updated] = await db.$transaction([
    db.shopEmployeeMembership.update({
      where: { id: membershipId },
      data: {
        status,
        deactivatedAt: status === 'ACTIVE' || status === 'INVITED' ? null : new Date(),
      },
    }),
    db.empolyee.update({ where: { id: membership.employeeId }, data: { shopId: pointer } }),
    ...groupChatOps(db, membership.shop.groupChatId, membership.employeeId, status === 'ACTIVE'),
  ]);

  await invalidateEmployeeCaches(updated.employeeId);
  if (status !== 'ACTIVE') disconnectUser('EMPLOYEE', updated.employeeId);
  return updated;
}

/** Adds an existing account to a shop inside an interactive transaction (use SLOW_DB_TX_OPTIONS). */
export async function createShopMembership(tx, { employeeId, shopId, role, permissions, createdByCustomerId, source }) {
  const membership = await tx.shopEmployeeMembership.create({
    data: {
      employeeId,
      shopId,
      role,
      permissions,
      status: 'ACTIVE',
      createdByCustomerId: createdByCustomerId ?? null,
      source: source ?? 'SHOP_OWNER_FLOW',
    },
    include: { shop: { select: { groupChatId: true } } },
  });
  await tx.empolyee.update({ where: { id: employeeId }, data: { shopId } });
  for (const op of groupChatOps(tx, membership.shop.groupChatId, employeeId, true)) await op;
  return membership;
}
