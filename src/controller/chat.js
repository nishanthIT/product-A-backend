import { PrismaClient } from '@prisma/client';
import fs from 'fs';
import path from 'path';
import cacheService from '../services/cacheService.js';

const prisma = new PrismaClient();

// Get all chats for a user (GLOBAL CHAT - all users can see all chats)
export const getUserChats = async (req, res) => {
  try {
    const userId = req.user.id; // From JWT middleware
    const userType = req.user.userType;

    // Try to get cached chats first
    const cachedChats = await cacheService.getCachedUserChats(userId);
    if (cachedChats) {
      return res.status(200).json({ success: true, chats: cachedChats });
    }

    // Get chats where user is actually a participant OR the main group chat
    const chats = await prisma.chat.findMany({
      where: {
        OR: [
          // Main group chat (accessible to everyone)
          { 
            type: 'GROUP',
            name: 'ALL Chat'
          },
          // Personal chats where user is actually a participant
          {
            type: 'PERSONAL',
            participants: {
              some: {
                userId: userId,
                userType: userType
              }
            }
          }
        ]
      },
      include: {
        participants: {
          include: {
            // We'll need to join with Customer/Employee based on userType
          }
        },
        messages: {
          orderBy: {
            createdAt: 'desc'
          },
          take: 1, // Get last message
          include: {
            readReceipts: true
          }
        }
      },
      orderBy: {
        lastMessageAt: 'desc'
      }
    });

    // Format the response
    const formattedChats = await Promise.all(chats.map(async (chat) => {
      const lastMessage = chat.messages[0];
      
      // Get ALL participants info (including current user for group chats)
      const allParticipantsInfo = await Promise.all(
        chat.participants.map(async (p) => {
          if (p.userType === 'CUSTOMER') {
            const customer = await prisma.customer.findUnique({
              where: { id: p.userId },
              select: { id: true, name: true, email: true }
            });
            if (customer) {
              return { ...customer, userType: 'CUSTOMER' };
            }
          } else if (p.userType === 'EMPLOYEE') {
            const employee = await prisma.empolyee.findUnique({
              where: { id: p.userId },
              select: { id: true, name: true, email: true }
            });
            if (employee) {
              return { ...employee, userType: 'EMPLOYEE' };
            }
          }
          return null;
        })
      );
      
      // Filter out null values (deleted users)
      const validParticipants = allParticipantsInfo.filter(p => p !== null);
      
      // Get other participants (excluding current user)
      const otherParticipants = validParticipants.filter(
        p => !(Number(p.id) === Number(userId) && p.userType === userType)
      );

      // Calculate unread count
      const unreadCount = lastMessage ? await prisma.message.count({
        where: {
          chatId: chat.id,
          NOT: {
            senderId: userId,
            senderType: userType
          },
          readReceipts: {
            none: {
              userId: userId,
              userType: userType
            }
          }
        }
      }) : 0;

      return {
        id: chat.id,
        name: chat.name || otherParticipants.map(p => p.name).join(', '),
        type: chat.type,
        lastMessage: lastMessage?.content,
        lastMessageTime: lastMessage?.createdAt,
        unreadCount,
        participants: validParticipants, // All participants including current user
        otherParticipants: otherParticipants, // Other participants only
        participantCount: validParticipants.length
      };
    }));

    // Cache the chats for this user
    await cacheService.cacheUserChats(userId, formattedChats);

    res.status(200).json({ success: true, chats: formattedChats });
  } catch (error) {
    console.error('Error fetching user chats:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch chats', error: error.message });
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
            select: { id: true, name: true, email: true }
          });
        } else if (p.userType === 'EMPLOYEE') {
          userDetails = await prisma.empolyee.findUnique({
            where: { id: p.userId },
            select: { id: true, name: true, email: true }
          });
        } else if (p.userType === 'ADMIN') {
          userDetails = await prisma.admin.findUnique({
            where: { id: p.userId },
            select: { id: true, name: true, email: true }
          });
        }
        return {
          id: p.userId.toString(),
          name: userDetails?.name || 'Unknown',
          email: userDetails?.email || '',
          userType: p.userType,
          isAdmin: p.isAdmin
        };
      })
    );

    // Get other participants (excluding current user)
    const otherParticipants = participantsWithDetails.filter(
      p => !(Number(p.id) === Number(userId) && p.userType === userType)
    );

    // Notify all participants via Socket.IO
    chat.participants.forEach(participant => {
      req.io.to(`user_${participant.userId}`).emit('new_chat_created', {
        chatId: chat.id,
        chatType: chat.type,
        chatName: chat.name
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

    // Try to get cached messages for page 1
    if (parseInt(page) === 1) {
      const cachedMessages = await cacheService.getCachedMessages(chatId);
      const cachedMeta = await cacheService.getCachedChatMetadata(chatId);
      
      if (cachedMessages && cachedMeta) {
        // Update isOwnMessage for current user
        const messagesWithOwn = cachedMessages.map(msg => ({
          ...msg,
          isOwnMessage: msg.senderId === userId && msg.senderType === userType
        }));
        return res.status(200).json({
          success: true,
          chat: {
            ...cachedMeta,
            messages: messagesWithOwn
          }
        });
      }
    }

    // GLOBAL CHAT SYSTEM: Allow everyone to view any chat
    // (Removed participant check for global access)

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
        deletedAt: null
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

    // Get sender details for each message
    const messagesWithSender = await Promise.all(
      messages.map(async (msg) => {
        let sender = null;
        if (msg.senderType === 'CUSTOMER') {
          sender = await prisma.customer.findUnique({
            where: { id: msg.senderId },
            select: { id: true, name: true }
          });
        } else if (msg.senderType === 'EMPLOYEE') {
          sender = await prisma.empolyee.findUnique({
            where: { id: msg.senderId },
            select: { id: true, name: true }
          });
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
          timestamp: msg.createdAt,
          isOwnMessage: msg.senderId === userId && msg.senderType === userType,
          readBy: msg.readReceipts.map(r => ({ userId: r.userId, userType: r.userType, readAt: r.readAt }))
        };
      })
    );

    // Get full participant details
    const participantsWithDetails = await Promise.all(
      chat.participants.map(async (p) => {
        if (p.userType === 'CUSTOMER') {
          const customer = await prisma.customer.findUnique({
            where: { id: p.userId },
            select: { id: true, name: true, email: true }
          });
          if (customer) {
            return {
              ...customer,
              userType: 'CUSTOMER',
              isAdmin: p.isAdmin
            };
          }
        } else if (p.userType === 'EMPLOYEE') {
          const employee = await prisma.empolyee.findUnique({
            where: { id: p.userId },
            select: { id: true, name: true, email: true }
          });
          if (employee) {
            return {
              ...employee,
              userType: 'EMPLOYEE',
              isAdmin: p.isAdmin
            };
          }
        }
        return null;
      })
    );

    // Filter out null values (deleted users)
    const validParticipants = participantsWithDetails.filter(p => p !== null);

    const chatData = {
      id: chat.id,
      name: chat.name,
      type: chat.type,
      participants: validParticipants,
      participantCount: validParticipants.length,
      messages: messagesWithSender.reverse() // Oldest first
    };

    // Cache the first page of messages and metadata
    if (parseInt(page) === 1) {
      await cacheService.cacheMessages(chatId, chatData.messages);
      await cacheService.cacheChatMetadata(chatId, {
        id: chat.id,
        name: chat.name,
        type: chat.type,
        participants: validParticipants,
        participantCount: validParticipants.length
      });
    }

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
    const { chatId, content, messageType = 'TEXT', attachmentUrl, attachmentName, attachmentSize } = req.body;

    // Validation
    if (!chatId || !content) {
      return res.status(400).json({ success: false, message: 'Chat ID and content are required' });
    }

    // Check if user is participant
    let participant = await prisma.chatParticipant.findFirst({
      where: {
        chatId,
        userId: userId,
        userType: userType
      }
    });

    // If not a participant, check if this is the ALL Chat group
    if (!participant) {
      // Get the chat to check if it's the main group chat
      const chat = await prisma.chat.findUnique({
        where: { id: chatId },
        select: { type: true, name: true }
      });

      // If it's the ALL Chat group, automatically add user as participant
      if (chat && chat.type === 'GROUP' && chat.name === 'ALL Chat') {
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
    }

    // Create message
    const message = await prisma.message.create({
      data: {
        chatId,
        senderId: userId,
        senderType: userType,
        content,
        messageType,
        attachmentUrl,
        attachmentName,
        attachmentSize
      }
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
      timestamp: message.createdAt,
      isOwnMessage: true
    };

    // Broadcast message to all users in the chat room via Socket.IO (except sender)
    if (req.io) {
      const senderSocketId = req.userSockets?.get(userId);
      
      // Invalidate user chats cache for all participants
      const chatParticipants = await prisma.chatParticipant.findMany({
        where: { chatId },
        select: { userId: true }
      });
      for (const p of chatParticipants) {
        await cacheService.invalidateUserChats(p.userId);
      }
      
      if (senderSocketId) {
        // Broadcast to room but exclude the sender
        req.io.to(`chat_${chatId}`).except(senderSocketId).emit('message_received', {
          ...formattedMessage,
          isOwnMessage: false
        });
      } else {
        // Fallback: broadcast to all (frontend will filter)
        req.io.to(`chat_${chatId}`).emit('message_received', {
          ...formattedMessage,
          isOwnMessage: false
        });
      }
    }

    res.status(201).json({ success: true, message: formattedMessage });
  } catch (error) {
    console.error('Error sending message:', error);
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
        { name: { contains: search, mode: 'insensitive' } },
        { email: { contains: search, mode: 'insensitive' } }
      ]
    } : {};

    // Get all customers
    const customers = await prisma.customer.findMany({
      where: {
        NOT: {
          AND: [
            { id: currentUserId },
            { userType: 'CUSTOMER' }
          ]
        },
        ...searchFilter
      },
      select: {
        id: true,
        name: true,
        email: true,
        userType: true
      }
    });

    // Get all employees
    const employees = await prisma.empolyee.findMany({
      where: {
        NOT: {
          AND: [
            { id: currentUserId },
            { userType: 'EMPLOYEE' }
          ]
        },
        ...searchFilter
      },
      select: {
        id: true,
        name: true,
        email: true,
        userType: true
      }
    });

    // Get all admins
    const admins = await prisma.admin.findMany({
      where: {
        NOT: {
          AND: [
            { id: currentUserId },
            { userType: 'ADMIN' }
          ]
        },
        ...searchFilter
      },
      select: {
        id: true,
        name: true,
        email: true,
        userType: true
      }
    });

    // Combine all users
    const allUsers = [
      ...customers.map(user => ({
        id: user.id.toString(),
        name: user.name,
        phone: user.email, // Using email as phone for display
        userType: 'CUSTOMER',
        isOnline: false
      })),
      ...employees.map(user => ({
        id: user.id.toString(),
        name: user.name,
        phone: user.email,
        userType: 'EMPLOYEE',
        isOnline: false
      })),
      ...admins.map(user => ({
        id: user.id.toString(),
        name: user.name || 'Admin',
        phone: user.email,
        userType: 'ADMIN',
        isOnline: false
      }))
    ];
    
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

    // If message has an attachment, delete the file from disk
    if (message.attachmentUrl) {
      try {
        const filePath = path.join(process.cwd(), message.attachmentUrl);
        
        if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
        }
      } catch (fileError) {
        console.error('⚠️ Error deleting attachment file:', fileError);
        // Continue with message deletion even if file deletion fails
      }
    }

    // Delete the message
    await prisma.message.delete({
      where: { id: messageId }
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