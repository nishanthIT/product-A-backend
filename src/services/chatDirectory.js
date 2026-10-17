import { PrismaClient } from '@prisma/client';
import { blockedPeers } from './chatSafety.js';
const prisma = new PrismaClient();
const models = { CUSTOMER: 'customer', EMPLOYEE: 'empolyee', ADMIN: 'admin' };
const identity = p => `${p.userType}:${p.userId ?? p.id}`;
export function teamShopWhere(user) {
  if (user.userType === 'ADMIN') return {};
  if (user.userType === 'CUSTOMER') return { shopType: 'CUSTOMER', supermarketOwnerships: { some: { customerId: user.id } } };
  if (user.userType === 'EMPLOYEE') return { shopType: 'CUSTOMER', employeeMemberships: { some: { employeeId: user.id, status: 'ACTIVE' } } };
  return { id: { in: [] } };
}
export const teamSelect = {
  id: true, name: true, groupChatId: true,
  supermarketOwnerships: { select: { customerId: true } },
  employeeMemberships: { where: { status: 'ACTIVE' }, select: { employeeId: true } },
};
function teamParticipants(shop, original) {
  return [
    ...shop.supermarketOwnerships.map(o => ({ userId: o.customerId, userType: 'CUSTOMER', isAdmin: true })),
    ...shop.employeeMemberships.map(m => ({ userId: m.employeeId, userType: 'EMPLOYEE', isAdmin: false })),
    ...original.filter(p => p.userType === 'ADMIN'),
  ];
}
export async function hydrateChatPeople(rows, db = prisma) {
  const users = await Promise.all(Object.entries(models).map(async ([type, model]) => {
    const ids = [...new Set(rows.filter(p => p.userType === type).map(p => p.userId))];
    return ids.length ? (await db[model].findMany({ where: { id: { in: ids } }, select: { id: true, name: true } })).map(u => ({ ...u, userType: type })) : [];
  }));
  return new Map(users.flat().map(u => [identity(u), u]));
}
function participantView(rows, users) {
  return [...new Map(rows.map(p => [identity(p), p])).values()].flatMap(p => {
    const user = users.get(identity(p));
    return user ? [{ ...user, isAdmin: !!p.isAdmin }] : [];
  });
}
export async function chatParticipantView(chat, db = prisma) {
  const shop = chat.type === 'GROUP' ? await db.shop.findFirst({ where: { groupChatId: chat.id }, select: teamSelect }) : null;
  const rows = shop ? teamParticipants(shop, chat.participants) : chat.participants;
  return participantView(rows, await hydrateChatPeople(rows, db));
}

// A read-only projection of existing records. Never creates replacement chats,
// rewrites shop links, or changes stored participants while listing history.
export async function listUserChats(user, db = prisma) {
  const [shops, blocked] = await Promise.all([
    db.shop.findMany({ where: { ...teamShopWhere(user), groupChatId: { not: null } }, select: teamSelect }),
    blockedPeers(user, db),
  ]);
  const hidden = blocked.map(p => ({ senderId: p.id, senderType: p.userType }));
  const chats = await db.chat.findMany({
    where: { OR: [
      { type: 'GROUP', name: 'ALL Chat' },
      { participants: { some: { userId: user.id, userType: user.userType } } },
      { type: 'GROUP', id: { in: shops.map(s => s.groupChatId) } },
      ...(user.userType === 'ADMIN' ? [{ type: 'GROUP' }] : []),
    ] },
    include: { participants: true, messages: { where: { deletedAt: null, NOT: hidden }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 1 } },
  });
  const linked = await db.shop.findMany({ where: { groupChatId: { in: chats.filter(c => c.type === 'GROUP').map(c => c.id) } }, select: { groupChatId: true } });
  const linkedIds = new Set(linked.map(s => s.groupChatId));
  const teams = new Map(shops.map(s => [s.groupChatId, s]));
  const visible = chats.filter(chat => {
    if (chat.type === 'GROUP' && linkedIds.has(chat.id)) return teams.has(chat.id);
    return chat.type !== 'PERSONAL' || !chat.participants.some(p => blocked.some(b => b.id === p.userId && b.userType === p.userType));
  });
  const participants = new Map(visible.map(chat => [chat.id, teams.has(chat.id) ? teamParticipants(teams.get(chat.id), chat.participants) : chat.participants]));
  const [users, unread] = await Promise.all([
    hydrateChatPeople([...participants.values()].flat(), db),
    db.message.groupBy({ by: ['chatId'], where: { chatId: { in: visible.map(c => c.id) }, deletedAt: null, NOT: [...hidden, { senderId: user.id, senderType: user.userType }], readReceipts: { none: { userId: user.id, userType: user.userType } } }, _count: { _all: true } }),
  ]);
  const counts = new Map(unread.map(row => [row.chatId, row._count._all]));
  return visible.map(chat => {
    const people = participantView(participants.get(chat.id), users);
    const others = people.filter(p => identity(p) !== identity(user));
    const latest = chat.messages[0];
    return { id: chat.id, name: chat.name || others.map(p => p.name).join(', '), type: chat.type,
      createdAt: chat.createdAt, lastMessage: latest?.content, lastMessageTime: latest?.createdAt,
      lastActivityAt: latest?.createdAt ?? chat.createdAt, unreadCount: counts.get(chat.id) ?? 0,
      participants: people, otherParticipants: others, participantCount: people.length,
      shopId: teams.get(chat.id)?.id ?? null, shopName: teams.get(chat.id)?.name ?? null };
  }).sort((a,b) => b.lastActivityAt - a.lastActivityAt || a.id.localeCompare(b.id));
}
