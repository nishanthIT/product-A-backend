import { safeLogger } from '../services/safeLogger.js';
const securityLog = safeLogger('controller/chat.js');
import { broadcastChat, deferChatWork, settleChatWork } from '../services/chatBroadcast.js';
import { recordChatReceipts } from '../services/chatReceipts.js';
import { listUserChats, chatParticipantRows, chatParticipantView, hydrateChatPeople } from '../services/chatDirectory.js';
import { serviceError } from '../services/serviceErrors.js';
import { lockAccountForWrite } from '../services/accountWriteBarrier.js';
import { activeSuspension } from '../services/chatSafety.js';
import { blockedPeers, hiddenAuthors } from '../services/chatSafety.js';
import { hasShopFeatureAccess, SHOP_FEATURES } from '../services/accessControl.js';
import { PrismaClient } from '@prisma/client';
import { createHash } from 'node:crypto';
import { attachmentFilename } from '../services/chatStorage.js';
import { queueUnusedAttachment, queueUnusedAttachments, deleteQueuedAttachment } from '../services/chatRetention.js';
import cacheService from '../services/cacheService.js';
import { getChatAccess } from '../services/chatAccess.js';
import { selectedChatShop, chatIdentity, visibleShopChat } from '../services/shopChatScope.js';
import { retailChatRoster, visibleCommunityDirect } from '../services/globalChat.js';
import { userKey, userRoom } from '../services/realtime.js';
import { chatSearchTerm, messagePageQuery, messageSearchWhere, messageCursorBoundary, encodeMessageCursor, chatUnavailableResponse } from '../services/chatQuery.js';

const prisma = new PrismaClient();
const IMAGE_RETRY_PREFIX = 'retry_image_';
const MESSAGE_RETRY_PREFIX = 'retry_message_';

// List existing authorized conversations without changing any chat records.
export const getUserChats = async (req, res) => {
  try { res.status(200).json({ success: true, chats: await listUserChats(req.user, prisma, { search: chatSearchTerm(req.query.search) }) }); }
  catch (error) {
    if (error.status === 400) return res.status(400).json({ success: false, message: error.message });
    securityLog.error('Chat directory unavailable', serviceError(error));
    res.status(503).json(chatUnavailableResponse(error));
  }
};

// Create or reopen a private conversation between eligible retail app users.
export const createChat = async (req, res) => {
  try {
    const { type, participantIds } = req.body;
    if (type !== 'PERSONAL' || !Array.isArray(participantIds) || participantIds.length !== 1) {
      return res.status(400).json({ error: 'Choose one person for a direct conversation. Use Global Chat or Team Chat for group messages.' });
    }
    const input = participantIds[0];
    const peer = { userId: Number(input?.userId), userType: input?.userType };
    if (!Number.isSafeInteger(peer.userId) || peer.userId <= 0 || !['CUSTOMER', 'EMPLOYEE'].includes(peer.userType) || chatIdentity(peer) === chatIdentity(req.user)) {
      return res.status(400).json({ error: 'Choose another eligible shop teammate.' });
    }
    const pair = [chatIdentity(req.user), chatIdentity(peer)].sort();
    const result = await prisma.$transaction(async tx => {
      await lockAccountForWrite(tx, req.user);
      // The pair lock covers lookup AND creation across requests/server instances.
      // Membership is checked after acquiring it, so a queued opener revalidates.
      const key = JSON.stringify(['retail-direct', ...pair]);
      await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
      const [shop, roster, blocked] = await Promise.all([
        selectedChatShop(req.user, tx), retailChatRoster(tx, [peer]), blockedPeers(req.user, tx),
      ]);
      if (!shop || !roster.some(p => chatIdentity(p) === chatIdentity(peer))) throw Object.assign(new Error('This person is not an eligible retail shop user.'), { status: 403 });
      if (blocked.some(p => p.id === peer.userId && p.userType === peer.userType)) throw Object.assign(new Error('This conversation is blocked.'), { status: 403 });
      const identities = pair.map(identity => {
        const [userType, userId] = identity.split(':');
        return { userType, userId: Number(userId) };
      });
      const existing = await tx.chat.findMany({
        where: { type: 'PERSONAL', OR: [{ shopId: null }, { shopId: shop.id }],
          participants: { every: { OR: identities } },
          AND: identities.map(identity => ({ participants: { some: identity } })),
        }, include: { participants: true }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      });
      const reusable = existing.find(chat => visibleCommunityDirect(req.user, chat, [req.user, peer])) ??
        existing.find(chat => visibleShopChat(req.user, chat, shop));
      if (reusable) return { chat: reusable, created: false };
      const chat = await tx.chat.create({ data: { type: 'PERSONAL', participants: { create: identities } }, include: { participants: true } });
      return { chat, created: true };
    }, { maxWait: 15000, timeout: 60000 });
    // Membership was validated inside the pair lock; only hydrate these two names.
    const [users, latest, unreadCount] = await Promise.all([
      hydrateChatPeople(result.chat.participants, prisma),
      result.created ? null : prisma.message.findFirst({ where: { chatId: result.chat.id, deletedAt: null }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] }),
      result.created ? 0 : prisma.message.count({ where: { chatId: result.chat.id, deletedAt: null,
        NOT: { senderId: req.user.id, senderType: req.user.userType }, readReceipts: { none: { userId: req.user.id, userType: req.user.userType } } } }),
    ]);
    const people = result.chat.participants.map(p => ({ ...users.get(chatIdentity(p)), isAdmin: !!p.isAdmin }));
    const otherParticipants = people.filter(p => chatIdentity(p) !== chatIdentity(req.user));
    const name = otherParticipants.map(p => p.name).join(', ');
    if (result.created) deferChatWork(async () => {
      await settleChatWork(result.chat.participants.map(async p => {
        req.io?.to(userRoom(p.userType, p.userId)).emit('new_chat_created', { chatId: result.chat.id });
        await cacheService.invalidateUserChats(userKey(p.userType, p.userId));
      }));
    });
    return res.status(result.created ? 201 : 200).json({ success: true, chat: {
      ...result.chat, name, participants: people, otherParticipants, participantCount: people.length,
      unreadCount, lastMessage: latest?.content, lastMessageTime: latest?.createdAt,
      lastActivityAt: latest?.createdAt ?? result.chat.createdAt, isTeamChat: false,
      isGlobalChat: false, isCommunityChat: !result.chat.shopId,
      ...(result.created && { initialPage: { id: result.chat.id, name, type: 'PERSONAL', shopId: null,
        isGlobalChat: false, participants: people, participantCount: people.length, messages: [],
        pagination: { hasMore: false, nextCursor: null, limit: 30 } } }),
    } });
  } catch (error) {
    if (error.status) return res.status(error.status).json({ error: error.message });
    securityLog.error('Direct chat creation failed', serviceError(error));
    return res.status(500).json({ error: 'Could not start this conversation.' });
  }
};

// Get chat by ID with messages
export const getChatById = async (req, res) => {
  try {
    const userId = req.user.id;
    const userType = req.user.userType;
    const { chatId } = req.params;
    const { page, limit, before, search } = messagePageQuery(req.query);

    // Check current ownership or active membership for the requested team.
    const access = await getChatAccess(req.user, chatId);
    if (!access) {
      return res.status(404).json({ success: false, message: 'Chat not found' });
    }
    if (!access.canRead) {
      return res.status(403).json({ success: false, message: 'You do not have access to this chat' });
    }


    const chat = access.chat;

    // Stable boundaries prevent concurrent new messages from shifting older
    // pages. The opaque cursor also survives deletion of its boundary message.
    const boundary = await messageCursorBoundary(before, chatId, prisma);
    const messageRows = await prisma.message.findMany({
      where: {
        chatId,
        deletedAt: null,
        NOT: await hiddenAuthors(req.user),
        ...messageSearchWhere(search),
        ...(boundary && { AND: [{ OR: [
          { createdAt: { lt: boundary.createdAt } },
          { createdAt: boundary.createdAt, id: { lt: boundary.id } },
        ] }] }),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip: before ? 0 : (page - 1) * limit,
      take: limit + 1,
      include: {
        readReceipts: true, deliveryReceipts: true
      }
    });
    const hasMore = messageRows.length > limit;
    const messages = messageRows.slice(0, limit);

    const senders = await hydrateChatPeople(messages.map(msg => ({ userId: msg.senderId, userType: msg.senderType })), prisma);
    const messagesWithSender = await Promise.all(
      messages.map(async (msg) => {
        const sender = senders.get(`${msg.senderType}:${msg.senderId}`);

        // Get shared list data if this is a LIST_SHARE message
        let sharedListData = null;
        if (msg.messageType === 'LIST_SHARE' && msg.sharedListId && req.user.shopId && (req.user.userType !== 'EMPLOYEE' || hasShopFeatureAccess(req.user, SHOP_FEATURES.LISTS))) {
          const list = await prisma.list.findUnique({
            where: { id: msg.sharedListId, shopId: req.user.shopId },
            include: {
              products: {
                include: {
                  productAtShop: {
                    include: {
                      product: true
                    }
                  }
                }
              }
            }
          });
          if (list) {
            sharedListData = {
              id: list.id,
              name: list.name,
              itemCount: list.products.length
            };
          }
        }

        return {
          id: msg.id,
          content: msg.content,
          senderId: msg.senderId,
          senderName: sender?.name || 'Unknown User',
          senderType: msg.senderType,
          messageType: msg.messageType,
          attachmentUrl: msg.attachmentUrl,
          attachmentName: msg.attachmentName,
          attachmentSize: msg.attachmentSize,
          sharedListId: msg.sharedListId,
          sharedList: sharedListData,
          timestamp: msg.createdAt,
          isOwnMessage: msg.senderId === userId && msg.senderType === userType,
          readBy: msg.readReceipts.map(r => ({ userId: r.userId, userType: r.userType, readAt: r.readAt })),
          deliveredTo: msg.deliveryReceipts.map(r => ({ userId: r.userId, userType: r.userType, deliveredAt: r.deliveredAt }))
        };
      })
    );

    const validParticipants = await chatParticipantView(chat, prisma);

    const chatData = {
      id: chat.id,
      name: access.isGlobalChat ? 'Global Chat' : chat.name || validParticipants.filter(p => chatIdentity(p) !== chatIdentity(req.user)).map(p => p.name).join(', '),
      type: chat.type,
      isGlobalChat: access.isGlobalChat,
      shopId: access.shopId,
      participants: validParticipants,
      participantCount: validParticipants.length,
      messages: messagesWithSender.reverse(), // Oldest first
      pagination: { hasMore, nextCursor: hasMore ? encodeMessageCursor(messages.at(-1)) : null, limit },
    };


    res.status(200).json({
      success: true,
      chat: chatData
    });
  } catch (error) {
    if (error.status === 400) return res.status(400).json({ success: false, message: error.message });
    securityLog.error('Chat history unavailable', serviceError(error));
    res.status(503).json(chatUnavailableResponse(error));
  }
};

// Send a message
export const sendMessage = async (req, res) => {
  try {
    const userId = req.user.id;
    const userType = req.user.userType;
    const { chatId, content, messageType = 'TEXT', attachmentUrl, attachmentName, attachmentSize, sharedListId, clientMessageId } = req.body;

    // Validation
    if (typeof content !== 'string' || content.length > 10000) return res.status(400).json({ error: 'Messages must be 1–10,000 characters.' });
    if (!chatId || !content) {
      return res.status(400).json({ success: false, message: 'Chat ID and content are required' });
    }
    if (clientMessageId !== undefined && (typeof clientMessageId !== 'string' || !clientMessageId.trim() || clientMessageId.length > 512 || !['TEXT', 'IMAGE', 'DOCUMENT', 'LIST_SHARE'].includes(messageType)
      || (['IMAGE', 'DOCUMENT'].includes(messageType) && (typeof attachmentUrl !== 'string' || !attachmentUrl)))) {
      return res.status(400).json({ error: 'A message retry identifier must be nonempty text of at most 512 characters. Attachment messages require an uploaded file.' });
    }
    const retryMessageId = clientMessageId === undefined ? null : (messageType === 'IMAGE' ? IMAGE_RETRY_PREFIX : MESSAGE_RETRY_PREFIX) + createHash('sha256')
      .update(JSON.stringify([userType, userId, chatId, clientMessageId])).digest('hex');

    // If sharing a list, verify the user owns the list
    let sharedListData = null;
    if (messageType === 'LIST_SHARE' && sharedListId) {
      let listOwnerCheck;
      if (userType === 'EMPLOYEE') {
        listOwnerCheck = { id: sharedListId, employeeId: userId };
      } else if (userType === 'ADMIN') {
        listOwnerCheck = { id: sharedListId, adminId: userId };
      } else {
        listOwnerCheck = { id: sharedListId, customerId: userId };
      }

      if (userType === 'EMPLOYEE' && !hasShopFeatureAccess(req.user, SHOP_FEATURES.LISTS)) return res.status(403).json({ error: 'List access is required to share lists' });
      const targetAccess = await getChatAccess(req.user, chatId);
      if (!targetAccess?.canRead || !targetAccess.shopId || targetAccess.shopId !== req.user.shopId) {
        return res.status(403).json({ error: 'Share shop lists in their own team chat.' });
      }
      listOwnerCheck.shopId = req.user.shopId;
      const list = await prisma.list.findFirst({
        where: listOwnerCheck,
        include: {
          products: {
            include: {
              productAtShop: {
                include: {
                  product: true,
                  shop: true
                }
              }
            }
          }
        }
      });

      if (!list) {
        return res.status(403).json({ success: false, message: 'You can only share your own lists' });
      }

      sharedListData = {
        id: list.id,
        name: list.name,
        description: list.description,
        productCount: list.products.length,
        products: list.products.slice(0, 3).map(p => ({
          name: p.productAtShop?.product?.title || 'Unknown',
          price: Number(p.productAtShop?.price) || 0
        }))
      };
    }

    const { message, replayed } = await prisma.$transaction(async tx => {
      await lockAccountForWrite(tx, req.user);
      const access = await getChatAccess(req.user, chatId, tx);
      if (!access?.canRead) throw Object.assign(new Error('You no longer have access to this chat.'), { status: 403 });
      if (access.canJoin && !access.chat.participants.some(p => p.userId === userId && p.userType === userType)) {
        // createMany uses ON CONFLICT DO NOTHING. An empty-update Prisma upsert
        // can fall back to read-then-create and race on two first-time devices.
        await tx.chatParticipant.createMany({ data: [{ chatId, userId, userType }], skipDuplicates: true });
      }
      if (await activeSuspension(req.user, tx)) throw Object.assign(new Error('Chat posting is suspended. See Chat safety for details.'), { status: 403 });
      if (retryMessageId) {
        // Serialize a first send with any retry before there is a Message row to
        // lock. The identity includes the account type, account and conversation.
        await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtextextended(${retryMessageId}, 0))`;
        await tx.$queryRaw`SELECT id FROM "Message" WHERE id = ${retryMessageId} FOR UPDATE`;
        const existing = await tx.message.findUnique({ where: { id: retryMessageId } });
        if (existing) {
          if (existing.deletedAt) throw Object.assign(new Error('This message was removed and cannot be resent with the same retry identifier.'), { status: 409 });
          if (existing.chatId !== chatId || existing.senderId !== userId || existing.senderType !== userType || existing.content !== content || existing.messageType !== messageType || existing.attachmentUrl !== (attachmentUrl ?? null) || existing.attachmentName !== (attachmentName ?? null) || existing.attachmentSize !== (attachmentSize ?? null) || existing.sharedListId !== (messageType === 'LIST_SHARE' ? sharedListId ?? null : null)) {
            throw Object.assign(new Error('This retry identifier was already used for a different message.'), { status: 409 });
          }
          return { message: existing, replayed: true };
        }
      }
      if (attachmentUrl) {
        const match = typeof attachmentUrl === 'string' && /^\/uploads\/chat\/([a-zA-Z0-9._-]+)$/.exec(attachmentUrl);
        if (match) await tx.$queryRaw`SELECT "filename" FROM "ChatUpload" WHERE "filename" = ${match[1]} FOR UPDATE`;
        const upload = match && await tx.chatUpload.findUnique({ where: { filename: match[1] } });
        if (!upload || upload.pendingDeletion || upload.uploaderId !== userId || upload.uploaderType !== userType) {
          throw Object.assign(new Error('Upload your own attachment before sharing it.'), { status: 403 });
        }
      }
    // Create message and chat activity atomically while holding upload ownership.
    const created = await tx.message.create({
      data: {
        ...(retryMessageId && { id: retryMessageId }),
        chatId,
        senderId: userId,
        senderType: userType,
        content,
        messageType,
        attachmentUrl,
        attachmentName,
        attachmentSize,
        sharedListId: messageType === 'LIST_SHARE' ? sharedListId : null
      }
    });
    await tx.chat.update({ where: { id: chatId }, data: { lastMessageAt: created.createdAt } });
    return { message: created, replayed: false };
    }, { maxWait: 15000, timeout: 60000 });

    // Authentication already loaded the current name for every account role.
    const sender = req.user;

    const formattedMessage = {
      id: message.id,
      chatId: chatId,
      content: message.content,
      senderId: message.senderId,
      senderName: sender?.name || 'Unknown User',
      senderType: message.senderType,
      messageType: message.messageType,
      attachmentUrl: message.attachmentUrl,
      attachmentName: message.attachmentName,
      attachmentSize: message.attachmentSize,
      sharedListId: message.sharedListId,
      sharedList: sharedListData,
      timestamp: message.createdAt,
      isOwnMessage: true,
      ...(clientMessageId !== undefined && { clientMessageId }),
    };

    // A lost HTTP response can be retried without another visible message, event,
    // unread count increment, or change to the conversation's activity time.
    if (replayed) return res.status(200).json({ success: true, message: formattedMessage, replayed: true });
    // Socket fan-out and durable-cache invalidation never delay a committed send.
    // Clients reconcile from REST after reconnect or a missed best-effort event.
    deferChatWork(async () => {
      const chat = await prisma.chat.findUnique({ where: { id: chatId }, include: { participants: true } });
      if (!chat) return;
      const participants = await chatParticipantRows(chat, prisma);
      await settleChatWork([
        cacheService.invalidateMessages(chatId),
        ...participants.map(p => cacheService.invalidateUserChats(userKey(p.userType, p.userId))),
        broadcastChat(req.io, chatId, 'message_received', formattedMessage, { sender: req.user, includeUserRooms: true, participants }),
      ]);
    });

    res.status(201).json({ success: true, message: formattedMessage });
  } catch (error) {
    if ([401, 403, 409].includes(error.status)) return res.status(error.status).json({ error: error.message });
    securityLog.error('Message send failed', serviceError(error));
    res.status(500).json({ success: false, message: 'Failed to send message', error: error.message });
  }
};

// Mark messages as read
export const markAsRead = async (req, res) => {
  try {
    await recordChatReceipts({ user: req.user, messageIds: req.body.messageIds, kind: 'read', io: req.io, db: prisma });

    res.status(200).json({ success: true, message: 'Messages marked as read' });
  } catch (error) {
    if ([400, 401, 403, 404].includes(error.status)) return res.status(error.status).json({ success: false, message: error.message });
    securityLog.error('Error marking messages as read:', error);
    res.status(500).json({ success: false, message: 'Failed to mark messages as read', error: error.message });
  }
};

// Delete a personal chat (only for PERSONAL chats, not GROUP)
export const deleteChat = async (req, res) => {
  try {
    const userId = req.user.id;
    const userType = req.user.userType;
    const { chatId } = req.params;

    // First, verify the chat exists and user is a participant
    const chat = await prisma.chat.findUnique({
      where: { id: chatId },
      include: {
        participants: true
      }
    });

    if (!chat) {
      return res.status(404).json({ success: false, message: 'Chat not found' });
    }

    if (!(await getChatAccess(req.user, chatId))?.canRead) return res.sendStatus(403);

    // Check if user is a participant
    const isParticipant = chat.participants.some(
      p => p.userId === userId && p.userType === userType
    );

    if (!isParticipant) {
      return res.status(403).json({ success: false, message: 'You are not a participant of this chat' });
    }

    // Only allow deletion of PERSONAL chats
    if (chat.type !== 'PERSONAL') {
      return res.status(400).json({ success: false, message: 'Only personal chats can be deleted' });
    }

    const files = await prisma.$transaction(async tx => {
      const attachments = await tx.message.findMany({ where: { chatId }, select: { attachmentUrl: true } });
      const filenames = [...new Set(attachments.map(m => attachmentFilename(m.attachmentUrl)).filter(Boolean))].sort();
      await tx.chat.delete({ where: { id: chatId } }); // messages, receipts and participants cascade atomically
      return queueUnusedAttachments(tx, filenames);
    }, { maxWait: 15000, timeout: 60000 });
    deferChatWork(async () => {
      req.io?.to(chat.participants.map(p => userRoom(p.userType, p.userId))).emit('chat_deleted', { chatId });
      await settleChatWork(files.map(filename => deleteQueuedAttachment(filename)));
    });

    res.status(200).json({ success: true, message: 'Chat deleted successfully' });
  } catch (error) {
    securityLog.error('Error deleting chat:', error);
    res.status(500).json({ success: false, message: 'Failed to delete chat', error: error.message });
  }
};

// Search verified retail owners and active retail employees across shops.
export const getAllUsers = async (req, res) => {
  try {
    const shop = await selectedChatShop(req.user, prisma);
    if (!shop) return res.status(403).json({ error: 'Select a shop you are authorized to use.' });
    const peers = await blockedPeers(req.user);
    const rows = (await retailChatRoster(prisma)).filter(p => chatIdentity(p) !== chatIdentity(req.user) && !peers.some(b => b.id === p.userId && b.userType === p.userType));
    const people = [...(await hydrateChatPeople(rows, prisma)).values()];
    const term = chatSearchTerm(req.query.search).toLocaleLowerCase();
    const users = people.filter(p => !term || (p.name || '').toLocaleLowerCase().includes(term))
      .sort((a,b) => (a.name || '').localeCompare(b.name || '') || chatIdentity(a).localeCompare(chatIdentity(b)))
      .map(p => ({ id: String(p.id), name: p.name || 'Teammate', userType: p.userType, phone: '' }));
    res.json({ success: true, users });
  } catch (error) {
    if (error.status === 400) return res.status(400).json({ error: error.message });
    securityLog.error('Shop contact lookup failed', serviceError(error));
    res.status(503).json({ error: 'Could not load retail shop contacts.' });
  }
};
// Delete a message
export const deleteMessage = async (req, res) => {
  try {
    const userId = req.user.id;
    const userType = req.user.userType;
    const { messageId } = req.params;

    // Find the message
    const message = await prisma.message.findUnique({
      where: { id: messageId },
      include: { chat: true }
    });

    if (!message) {
      return res.status(404).json({ success: false, message: 'Message not found' });
    }

    if (!(await getChatAccess(req.user, message.chatId))?.canRead) return res.sendStatus(403);

    // Check if user is the sender of the message
    if (message.senderId !== userId || message.senderType !== userType) {
      return res.status(403).json({ success: false, message: 'You can only delete your own messages' });
    }

    // Legacy URLs are not trusted paths or proof of upload ownership.
    const cleanupFilename = await prisma.$transaction(async tx => {
      if (messageId.startsWith(IMAGE_RETRY_PREFIX) || messageId.startsWith(MESSAGE_RETRY_PREFIX)) {
        // Keep only the retry identity after author deletion. Without this
        // tombstone, a delayed retry could recreate a photo using a shared upload.
        await tx.$queryRaw`SELECT id FROM "Message" WHERE id = ${messageId} FOR UPDATE`;
        await tx.message.update({ where: { id: messageId }, data: {
          deletedAt: message.deletedAt ?? new Date(), content: '', attachmentUrl: null,
          attachmentName: null, attachmentSize: null, sharedListId: null,
        } });
        await tx.messageRead.deleteMany({ where: { messageId } });
        await tx.messageDelivery.deleteMany({ where: { messageId } });
      } else {
        await tx.message.delete({ where: { id: messageId } });
      }
      const filename = attachmentFilename(message.attachmentUrl);
      if (!filename) return;
      await tx.$queryRaw`SELECT "filename" FROM "ChatUpload" WHERE "filename" = ${filename} FOR UPDATE`;
      const upload = await tx.chatUpload.findUnique({ where: { filename } });
      if (!upload || upload.uploaderId !== userId || upload.uploaderType !== userType) return;
      return await queueUnusedAttachment(tx, filename) ? filename : undefined;
    }, { maxWait: 15000, timeout: 60000 });
    if (cleanupFilename) deferChatWork(() => deleteQueuedAttachment(cleanupFilename));

    // Notify inboxes and open threads after commit without making a successfully
    // deleted message appear to fail when the realtime transport is unavailable.
    if (req.io) deferChatWork(() => broadcastChat(req.io, message.chatId, 'message_deleted', {
        messageId,
        chatId: message.chatId
      }, { sender: req.user, includeUserRooms: true }));

    res.status(200).json({ success: true, message: 'Message deleted successfully' });

  } catch (error) {
    securityLog.error('❌ deleteMessage error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to delete message',
      error: error.message
    });
  }
};
