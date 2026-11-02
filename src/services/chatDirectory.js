import { PrismaClient } from '@prisma/client';
import { blockedPeers } from './chatSafety.js';
import { selectedChatShop, participantsForShop, visibleShopChat, chatOwningShop } from './shopChatScope.js';
import { messageSearchWhere } from './chatQuery.js';
import { findGlobalChat, retailChatRoster, visibleCommunityDirect } from './globalChat.js';
const prisma = new PrismaClient();
const models = { CUSTOMER: 'customer', EMPLOYEE: 'empolyee', ADMIN: 'admin' };
const identity = p => `${p.userType}:${p.userId ?? p.id}`;
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
// The same roster drives REST responses and realtime notifications. Historical
// ChatParticipant rows alone omit employees who have never posted in the team.
export async function chatParticipantRows(chat, db = prisma) {
  if (!chat.shopId && chat.type === 'GROUP' && (await findGlobalChat(db))?.id === chat.id) return retailChatRoster(db);
  if (!chat.shopId && chat.type === 'PERSONAL') {
    const eligible = new Set((await retailChatRoster(db, chat.participants)).map(identity));
    return chat.participants.filter(p => eligible.has(identity(p)));
  }
  const shop = await chatOwningShop(chat, db);
  const rows = participantsForShop(chat, shop);
  return [...new Map(rows.map(p => [identity(p), p])).values()];
}
export async function chatParticipantView(chat, db = prisma) {
  const rows = await chatParticipantRows(chat, db);
  return participantView(rows, await hydrateChatPeople(rows, db));
}

// A read-only projection of existing records. Never creates replacement chats,
// rewrites shop links, or changes stored participants while listing history.
export async function listUserChats(user, db = prisma, { search = '' } = {}) {
  const shop = await selectedChatShop(user, db);
  if (!shop) return [];
  const [global, retailRoster] = await Promise.all([findGlobalChat(db), retailChatRoster(db)]);
  const blocked = await blockedPeers(user, db);
  const hidden = blocked.map(p => ({ senderId: p.id, senderType: p.userType }));
  const chats = await db.chat.findMany({
    where: { OR: [{ shopId: shop.id }, ...(shop.groupChatId ? [{ id: shop.groupChatId, type: 'GROUP' }] : []),
      ...(global ? [{ id: global.id }] : []),
      { type: 'PERSONAL', shopId: null, participants: { some: { userId: user.id, userType: user.userType } } }] },
    include: { participants: true, messages: { where: { deletedAt: null, NOT: hidden }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 1 } },
  });
  const eligible = await Promise.all(chats.map(async chat => {
    if (chat.id === global?.id) return true;
    if (chat.type === 'PERSONAL' && !chat.shopId) return visibleCommunityDirect(user, chat, retailRoster) &&
      !chat.participants.some(p => blocked.some(b => b.id === p.userId && b.userType === p.userType));
    if (!chat.shopId && (await chatOwningShop(chat, db))?.id !== shop.id) return false;
    return visibleShopChat(user, chat, shop) && (chat.type !== 'PERSONAL' || !chat.participants.some(p => blocked.some(b => b.id === p.userId && b.userType === p.userType)));
  }));
  const visible = chats.filter((_chat, index) => eligible[index]);
  const participants = new Map(visible.map(chat => [chat.id, chat.id === global?.id ? retailRoster :
    chat.type === 'PERSONAL' && !chat.shopId ? chat.participants : participantsForShop(chat, shop)]));
  const [users, unread] = await Promise.all([
    hydrateChatPeople([...participants.values()].flat(), db),
    db.message.groupBy({ by: ['chatId'], where: { chatId: { in: visible.map(c => c.id) }, deletedAt: null, NOT: [...hidden, { senderId: user.id, senderType: user.userType }], readReceipts: { none: { userId: user.id, userType: user.userType } } }, _count: { _all: true } }),
  ]);
  const counts = new Map(unread.map(row => [row.chatId, row._count._all]));
  const summaries = visible.map(chat => {
    const people = participantView(participants.get(chat.id), users);
    const others = people.filter(p => identity(p) !== identity(user));
    const latest = chat.messages[0];
    return { id: chat.id, name: chat.id === global?.id ? 'Global Chat' : chat.name || others.map(p => p.name).join(', '), type: chat.type,
      createdAt: chat.createdAt, lastMessage: latest?.content, lastMessageTime: latest?.createdAt,
      lastActivityAt: latest?.createdAt ?? chat.createdAt, unreadCount: counts.get(chat.id) ?? 0,
      participants: people, otherParticipants: others, participantCount: people.length,
      shopId: chat.id === global?.id || !chat.shopId && chat.type === 'PERSONAL' ? null : shop.id,
      isGlobalChat: chat.id === global?.id, isCommunityChat: chat.id === global?.id || !chat.shopId && chat.type === 'PERSONAL',
      shopName: shop.name, isTeamChat: chat.type === 'GROUP' && chat.id === shop.groupChatId };
  }).sort((a,b) => b.lastActivityAt - a.lastActivityAt || a.id.localeCompare(b.id));
  if (!search) return summaries;
  // Search the complete visible history, after the same authorization/block
  // projection as the normal directory. Do not expose matching private bodies.
  const matches = await db.message.groupBy({
    by: ['chatId'],
    where: { chatId: { in: summaries.map(c => c.id) }, deletedAt: null, NOT: hidden, ...messageSearchWhere(search) },
  });
  const messageChats = new Set(matches.map(message => message.chatId));
  const term = search.toLocaleLowerCase();
  return summaries.filter(chat => messageChats.has(chat.id) || [chat.name, ...chat.participants.map(p => p.name)]
    .some(name => (name || '').toLocaleLowerCase().includes(term)));
}
