import { listUserChats, chatParticipantView, hydrateChatPeople } from '../services/chatDirectory.js';
import { serviceError } from '../services/serviceErrors.js';
import { lockAccountForWrite } from '../services/accountWriteBarrier.js';
import { activeSuspension } from '../services/chatSafety.js';
import { blockedPeers, hiddenAuthors } from '../services/chatSafety.js';
import { hasShopFeatureAccess, SHOP_FEATURES } from '../services/accessControl.js';
import { PrismaClient } from '@prisma/client';
import fs from 'fs';
import path from 'path';
import cacheService from '../services/cacheService.js';
import { getChatAccess } from '../services/chatAccess.js';
import { userKey, userRoom } from '../services/realtime.js';

const prisma = new PrismaClient();

// List existing authorized conversations without changing any chat records.
export const getUserChats = async (req, res) => {
  try { res.status(200).json({ success: true, chats: await listUserChats(req.user, prisma) }); }
  catch (error) {
    console.error('Chat directory unavailable', serviceError(error));
    res.status(503).json({ success: false, message: 'Chat conversations are temporarily unavailable.' });
  }
};

// Create a new chat (personal or group)
export const createChat = async (req, res) => {
  try {
    const userId = req.user.id;
    const userType = req.user.userType;
    const { type, name, participantIds } = req.body; // participantIds: [{ userId, userType }]

    // Validation
    if (!type || !participantIds || participantIds.length === 0) {
      return res.status(400).json({ success: false, message: 'Chat type and participants are required' });
    }

    if (type === 'GROUP' && !name) {
      return res.status(400).json({ success: false, message: 'Group chat requires a name' });
    }

    // RESTRICTION: Employees cannot start direct chats with other employees
    // They can only chat with Admin or in group chats
    if (type === 'PERSONAL' && userType === 'EMPLOYEE') {
      const otherParticipant = participantIds[0];
      if (otherParticipant.userType === 'EMPLOYEE') {
        return res.status(403).json({
          success: false,
          message: 'Employees cannot start private chats with other employees. Please use the shop group chat.'
        });
      }
    }

    const blocked = await blockedPeers(req.user);
    if (participantIds.some(p => blocked.some(b => b.id === Number(p.userId) && b.userType === p.userType))) return res.status(403).json({ error: 'This conversation is blocked.' });

    // For personal chat, check if chat already exists
    if (type === 'PERSONAL' && participantIds.length === 1) {
      const otherUserId = typeof participantIds[0].userId === 'number'
        ? participantIds[0].userId
        : parseInt(participantIds[0].userId);

      const existingChat = await prisma.chat.findFirst({
        where: {
          type: 'PERSONAL',
          AND: [
            {
              participants: {
                some: {
                  userId: userId,
                  userType: userType
                }
              }
            },
            {
              participants: {
                some: {
                  userId: otherUserId,
                  userType: participantIds[0].userType
                }
              }
            }
          ]
        },
        include: {
          participants: true
        }
      });

      // Only return existing chat if it has participants (not deleted)
      if (existingChat && existingChat.participants.length > 0) {
        return res.status(200).json({ success: true, chat: { id: existingChat.id }, message: 'Chat already exists' });
      }
    }

    // Create the chat with participants
    const chat = await prisma.chat.create({
      data: {
        type,
        name: type === 'GROUP' ? name : null,
        participants: {
          create: [
            {
              userId: userId,
              userType: userType,
              isAdmin: type === 'GROUP' // Creator is admin for group chats
            },
            ...participantIds.map(p => ({
              userId: typeof p.userId === 'number' ? p.userId : parseInt(p.userId),
              userType: p.userType,
              isAdmin: false
            }))
          ]
        }
      },
      include: {
        participants: true
      }
    });

    // Get participant details (names, emails) for the response
    const participantsWithDetails = await Promise.all(
      chat.participants.map(async (p) => {
        let userDetails = null;
        if (p.userType === 'CUSTOMER') {
          userDetails = await prisma.customer.findUnique({
            where: { id: p.userId },
            select: { id: true, name: true }
          });
        } else if (p.userType === 'EMPLOYEE') {
          userDetails = await prisma.empolyee.findUnique({
            where: { id: p.userId },
            select: { id: true, name: true }
          });
        } else if (p.userType === 'ADMIN') {
          userDetails = await prisma.admin.findUnique({
            where: { id: p.userId },
            select: { id: true, name: true }
          });
        }
        return {
          id: p.userId.toString(),
          name: userDetails?.name || 'Unknown',

          userType: p.userType,
          isAdmin: p.isAdmin
        };
      })
    );

    // Get other participants (excluding current user)
    const otherParticipants = participantsWithDetails.filter(
      p => !(Number(p.id) === Number(userId) && p.userType === userType)
    );

    // Invalidate chat list cache for ALL participants so they get fresh data
    for (const participant of chat.participants) {
      await cacheService.invalidateUserChats(userKey(participant.userType, participant.userId));
    }

    // Notify all participants via Socket.IO
    chat.participants.forEach(participant => {
      req.io.to(userRoom(participant.userType, participant.userId)).emit('new_chat_created', {
        chatId: chat.id,
        chatType: chat.type,
        chatName: chat.name,
        participants: participantsWithDetails
      });
    });

    // Return chat with full participant details
    res.status(201).json({
      success: true,
      chat: {
        ...chat,
        participants: participantsWithDetails,
        otherParticipants: otherParticipants
      }
    });
  } catch (error) {
    console.error('Error creating chat:', error);
    res.status(500).json({ success: false, message: 'Failed to create chat', error: error.message });
  }
};

// Get chat by ID with messages
export const getChatById = async (req, res) => {
  try {
    const userId = req.user.id;
    const userType = req.user.userType;
    const { chatId } = req.params;
    const { page = 1, limit = 50 } = req.query;

    // Check current ownership or active membership for the requested team.
    const access = await getChatAccess(req.user, chatId);
    if (!access) {
      return res.status(404).json({ success: false, message: 'Chat not found' });
    }
    if (!access.canRead) {
      return res.status(403).json({ success: false, message: 'You do not have access to this chat' });
    }


    // Get chat details
    const chat = await prisma.chat.findUnique({
      where: { id: chatId },
      include: {
        participants: true
      }
    });

    // Get messages with pagination
    const skip = (parseInt(page) - 1) * parseInt(limit);
    const messages = await prisma.message.findMany({
      where: {
        chatId,
        deletedAt: null,
        NOT: await hiddenAuthors(req.user)
      },
      orderBy: {
        createdAt: 'desc'
      },
      skip,
      take: parseInt(limit),
      include: {
        readReceipts: true
      }
    });

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
          readBy: msg.readReceipts.map(r => ({ userId: r.userId, userType: r.userType, readAt: r.readAt }))
        };
      })
    );

    const validParticipants = await chatParticipantView(chat, prisma);

    const chatData = {
      id: chat.id,
      name: chat.name,
      type: chat.type,
      participants: validParticipants,
      participantCount: validParticipants.length,
      messages: messagesWithSender.reverse() // Oldest first
    };


    res.status(200).json({
      success: true,
      chat: chatData
    });
  } catch (error) {
    console.error('Error fetching chat:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch chat', error: error.message });
  }
};

// Send a message
export const sendMessage = async (req, res) => {
  try {
    const userId = req.user.id;
    const userType = req.user.userType;
    const { chatId, content, messageType = 'TEXT', attachmentUrl, attachmentName, attachmentSize, sharedListId } = req.body;

    // Validation
    if (typeof content !== 'string' || content.length > 10000) return res.status(400).json({ error: 'Messages must be 1–10,000 characters.' });
    if (!chatId || !content) {
      return res.status(400).json({ success: false, message: 'Chat ID and content are required' });
    }

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

    // Check if user is participant
    let participant = await prisma.chatParticipant.findFirst({
      where: {
        chatId,
        userId: userId,
        userType: userType
      }
    });

    // If not a participant, only the global chat or the caller's own shop group chat may be joined
    if (!participant) {
      const access = await getChatAccess(req.user, chatId);
      if (access?.canJoin) {
        participant = await prisma.chatParticipant.create({
          data: {
            chatId,
            userId: userId,
            userType: userType
          }
        });
      } else {
        return res.status(403).json({ success: false, message: 'You are not a participant of this chat' });
      }
    } else {
      // A leftover participant row (e.g. after deactivation) must not reopen a shop group chat.
      const access = await getChatAccess(req.user, chatId);
      if (!access?.canRead) {
        return res.status(403).json({ success: false, message: 'You do not have access to this chat' });
      }
    }

    const message = await prisma.$transaction(async tx => {
      await lockAccountForWrite(tx, req.user);
      if (await activeSuspension(req.user, tx)) throw Object.assign(new Error('Chat posting is suspended. See Chat safety for details.'), { status: 403 });
      if (attachmentUrl) {
        const match = typeof attachmentUrl === 'string' && /^\/uploads\/chat\/([a-zA-Z0-9._-]+)$/.exec(attachmentUrl);
        if (match) await tx.$queryRaw`SELECT "filename" FROM "ChatUpload" WHERE "filename" = ${match[1]} FOR UPDATE`;
        const upload = match && await tx.chatUpload.findUnique({ where: { filename: match[1] } });
        if (!upload || upload.uploaderId !== userId || upload.uploaderType !== userType) {
          throw Object.assign(new Error('Upload your own attachment before sharing it.'), { status: 403 });
        }
      }
    // Create message while holding the attachment ownership lock
    return tx.message.create({
      data: {
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

    });

    // Update chat's lastMessageAt
    await prisma.chat.update({
      where: { id: chatId },
      data: { lastMessageAt: new Date() }
    });

    // Invalidate cache for this chat's messages
    await cacheService.invalidateMessages(chatId);

    // Get sender info based on userType
    let sender = null;
    if (userType === 'CUSTOMER') {
      sender = await prisma.customer.findUnique({
        where: { id: userId },
        select: { id: true, name: true }
      });
    } else if (userType === 'EMPLOYEE') {
      sender = await prisma.empolyee.findUnique({
        where: { id: userId },
        select: { id: true, name: true }
      });
    }

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
      isOwnMessage: true
    };

    // Broadcast message to all users in the chat room via Socket.IO (except sender)
    if (req.io) {
      const senderSocketId = req.userSockets?.get(userKey(userType, userId));

      // Invalidate user chats cache for all participants
      const chatParticipants = await prisma.chatParticipant.findMany({
        where: { chatId },
        select: { userId: true, userType: true }
      });
      for (const p of chatParticipants) {
        await cacheService.invalidateUserChats(userKey(p.userType, p.userId));
      }

      const excludedPeers = await blockedPeers(req.user);
      const excludedRooms = excludedPeers.map(p => userRoom(p.userType, p.id));
      const messagePayload = {
        ...formattedMessage,
        isOwnMessage: false
      };

      // Broadcast to chat room (for users actively viewing this chat)
      if (senderSocketId) {
        // Broadcast to room but exclude the sender
        req.io.to(`chat_${chatId}`).except([...excludedRooms, senderSocketId]).emit('message_received', messagePayload);
      } else {
        // Fallback: broadcast to all in room (frontend will filter)
        req.io.to(`chat_${chatId}`).except(excludedRooms).emit('message_received', messagePayload);
      }

      // Background clients receive only an invalidation hint, never private message bodies.
      // They fetch through current REST authorization (including shop scope and blocks).
      for (const participant of chatParticipants) {
        if (excludedPeers.some(p => p.id === participant.userId && p.userType === participant.userType)) continue;
        req.io.to(userRoom(participant.userType, participant.userId)).emit('chats_changed');
      }
    }

    res.status(201).json({ success: true, message: formattedMessage });
  } catch (error) {
    if ([401, 403].includes(error.status)) return res.status(error.status).json({ error: error.message });
    console.error('Message send failed');
    res.status(500).json({ success: false, message: 'Failed to send message', error: error.message });
  }
};

// Mark messages as read
export const markAsRead = async (req, res) => {
  try {
    const userId = req.user.id;
    const userType = req.user.userType;
    const { messageIds } = req.body;

    if (!messageIds || !Array.isArray(messageIds)) {
      return res.status(400).json({ success: false, message: 'Message IDs array is required' });
    }

    // Create read receipts for all messages
    await Promise.all(
      messageIds.map(messageId =>
        prisma.messageRead.upsert({
          where: {
            messageId_userId_userType: {
              messageId,
              userId: userId,
              userType: userType
            }
          },
          create: {
            messageId,
            userId: userId,
            userType: userType
          },
          update: {}
        })
      )
    );

    res.status(200).json({ success: true, message: 'Messages marked as read' });
  } catch (error) {
    console.error('Error marking messages as read:', error);
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

    // Delete in correct order to respect foreign key constraints
    // 1. Delete message reads
    await prisma.messageRead.deleteMany({
      where: {
        message: {
          chatId: chatId
        }
      }
    });

    // 2. Delete messages
    await prisma.message.deleteMany({
      where: { chatId: chatId }
    });

    // 3. Delete participants
    await prisma.chatParticipant.deleteMany({
      where: { chatId: chatId }
    });

    // 4. Delete the chat
    await prisma.chat.delete({
      where: { id: chatId }
    });

    // Notify other participants via Socket.IO
    req.io.to(`chat_${chatId}`).emit('chat_deleted', { chatId });

    res.status(200).json({ success: true, message: 'Chat deleted successfully' });
  } catch (error) {
    console.error('Error deleting chat:', error);
    res.status(500).json({ success: false, message: 'Failed to delete chat', error: error.message });
  }
};

// Get all users for starting new chats (with optional search by name or email)
export const getAllUsers = async (req, res) => {
  try {
    const currentUserId = req.user.id;
    const currentUserType = req.user.userType;
    const { search } = req.query; // Get search query parameter

    // Build search filter for name and email
    const searchFilter = search ? {
      OR: [
        { name: { contains: search, mode: 'insensitive' } }
      ]
    } : {};

    let allUsers = [];

    // EMPLOYEE: shop employees see the owner of the shop they are ACTIVE in;
    // company staff additionally see customers for support chats.
    if (currentUserType === 'EMPLOYEE') {
      const shopId = req.user.shopId;
      const customerFilter = req.user.company
        ? searchFilter
        : shopId ? { supermarketOwnerships: { some: { shopId } }, ...searchFilter } : null;

      const customers = customerFilter ? await prisma.customer.findMany({
        where: customerFilter,
        select: {
          id: true,
          name: true,

          userType: true
        }
      }) : [];

      allUsers = customers.map(user => ({
        id: user.id.toString(),
        name: user.name || 'Shop Owner',
        phone: '',
        userType: 'CUSTOMER',
        isOnline: false
      }));

    } else if (currentUserType === 'ADMIN') {
      // Admin can see employees in their shop
      const admin = await prisma.admin.findUnique({
        where: { id: currentUserId },
        select: { shopId: true }
      });

      // Get employees in the same shop
      const employees = await prisma.empolyee.findMany({
        where: {
          shopId: admin?.shopId,
          ...searchFilter
        },
        select: {
          id: true,
          name: true,

          userType: true
        }
      });

      // Get other admins in the same shop
      const admins = await prisma.admin.findMany({
        where: {
          shopId: admin?.shopId,
          NOT: { id: currentUserId },
          ...searchFilter
        },
        select: {
          id: true,
          name: true,

          userType: true
        }
      });

      allUsers = [
        ...employees.map(user => ({
          id: user.id.toString(),
          name: user.name,
          phone: '',
          userType: 'EMPLOYEE',
          isOnline: false
        })),
        ...admins.map(user => ({
          id: user.id.toString(),
          name: user.name || 'Admin',
          phone: '',
          userType: 'ADMIN',
          isOnline: false
        }))
      ];

    } else {
      // CUSTOMER - only see employees from their own shop + other customers

      // First get the customer's shop
      const customer = { shopId: req.user.shopId };

      const customerShopId = customer?.shopId;

      // Other customers (for common chat)
      const customers = await prisma.customer.findMany({
        where: {
          NOT: { id: currentUserId },
          ...searchFilter
        },
        select: {
          id: true,
          name: true,

          userType: true
        }
      });

      // Employees ONLY from the customer's shop
      const employees = customerShopId ? await prisma.empolyee.findMany({
        where: {
          shopMemberships: { some: { shopId: customerShopId, status: 'ACTIVE' } },
          ...searchFilter
        },
        select: {
          id: true,
          name: true,

          userType: true
        }
      }) : [];

      const admins = await prisma.admin.findMany({
        where: searchFilter,
        select: {
          id: true,
          name: true,

          userType: true
        }
      });

      allUsers = [
        ...customers.map(user => ({
          id: user.id.toString(),
          name: user.name,
          phone: '',
          userType: 'CUSTOMER',
          isOnline: false
        })),
        ...employees.map(user => ({
          id: user.id.toString(),
          name: user.name,
          phone: '',
          userType: 'EMPLOYEE',
          isOnline: false
        })),
        ...admins.map(user => ({
          id: user.id.toString(),
          name: user.name || 'Admin',
          phone: '',
          userType: 'ADMIN',
          isOnline: false
        }))
      ];
    }

    const peers = await blockedPeers(req.user);
    allUsers = allUsers.filter(u => !peers.some(p => p.id === Number(u.id) && p.userType === u.userType));
    res.status(200).json({
      success: true,
      users: allUsers
    });

  } catch (error) {
    console.error('❌ getAllUsers error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get users',
      error: error.message
    });
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

    // Check if user is the sender of the message
    if (message.senderId !== userId || message.senderType !== userType) {
      return res.status(403).json({ success: false, message: 'You can only delete your own messages' });
    }

    // Legacy URLs are not trusted paths or proof of upload ownership.
    await prisma.$transaction(async tx => {
      await tx.message.delete({ where: { id: messageId } });
      const match = typeof message.attachmentUrl === 'string' && /^\/uploads\/chat\/([a-zA-Z0-9._-]+)$/.exec(message.attachmentUrl);
      if (!match) return;
      await tx.$queryRaw`SELECT "filename" FROM "ChatUpload" WHERE "filename" = ${match[1]} FOR UPDATE`;
      const upload = await tx.chatUpload.findUnique({ where: { filename: match[1] } });
      if (!upload || upload.uploaderId !== userId || upload.uploaderType !== userType) return;
      if (await tx.message.count({ where: { attachmentUrl: message.attachmentUrl } })) return;
      try {
        await fs.promises.unlink(path.resolve('uploads/chat', match[1])).catch(error => { if (error.code !== 'ENOENT') throw error; });
        // Future sends cannot attach a file deleted during cleanup.
        await tx.chatUpload.delete({ where: { filename: match[1] } });
      } catch {
        // Keep the ownership row for orphan-maintenance retry, without rolling back the user's message deletion.
        console.warn('Chat attachment cleanup deferred');
      }
    });

    // Broadcast deletion to chat room via Socket.IO
    if (req.io) {
      req.io.to(`chat_${message.chatId}`).emit('message_deleted', {
        messageId,
        chatId: message.chatId
      });
    }

    res.status(200).json({ success: true, message: 'Message deleted successfully' });

  } catch (error) {
    console.error('❌ deleteMessage error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to delete message',
      error: error.message
    });
  }
};
