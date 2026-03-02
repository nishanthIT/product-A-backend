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

    // Get user's shop group chat ID if they belong to a shop
    let shopGroupChatId = null;
    let shopId = null;
    
    if (userType === 'CUSTOMER') {
      // Customer has shopId directly on their model
      const customer = await prisma.customer.findUnique({
        where: { id: userId },
        select: { shopId: true }
      });
      shopId = customer?.shopId;
      
      if (shopId) {
        const shop = await prisma.shop.findUnique({
          where: { id: shopId },
          select: { groupChatId: true, name: true }
        });
        shopGroupChatId = shop?.groupChatId;
        
        // Auto-create shop group chat if it doesn't exist
        if (!shopGroupChatId && shop) {
          console.log('📢 Creating shop group chat for:', shop.name);
          const groupChat = await prisma.chat.create({
            data: {
              name: `${shop.name} - Team Chat`,
              type: 'GROUP',
              participants: {
                create: {
                  userId: userId,
                  userType: 'CUSTOMER',
                  isAdmin: true
                }
              }
            }
          });
          shopGroupChatId = groupChat.id;
          
          // Update shop with group chat ID
          await prisma.shop.update({
            where: { id: shopId },
            data: { groupChatId: groupChat.id }
          });
          
          // Add all existing employees to the group chat
          const employees = await prisma.empolyee.findMany({
            where: { shopId: shopId },
            select: { id: true }
          });
          
          for (const emp of employees) {
            await prisma.chatParticipant.create({
              data: {
                chatId: groupChat.id,
                userId: emp.id,
                userType: 'EMPLOYEE',
                isAdmin: false
              }
            }).catch(err => console.log('Could not add employee to group:', err.message));
          }
          
          console.log('✅ Created shop group chat:', groupChat.id);
        }
      }
    } else if (userType === 'EMPLOYEE') {
      const employee = await prisma.empolyee.findUnique({
        where: { id: userId },
        select: { shop: { select: { groupChatId: true } } }
      });
      shopGroupChatId = employee?.shop?.groupChatId;
    }

    // Build OR conditions for chat query
    const orConditions = [
      // Common/Global group chat (accessible to everyone)
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
    ];

    // Add shop group chat if user belongs to a shop
    if (shopGroupChatId) {
      orConditions.push({
        id: shopGroupChatId,
        type: 'GROUP'
      });
    }

    // Get chats where user is actually a participant OR the main group chat OR shop group chat
    const chats = await prisma.chat.findMany({
      where: {
        OR: orConditions
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

    // Invalidate chat list cache for ALL participants so they get fresh data
    for (const participant of chat.participants) {
      await cacheService.invalidateUserChats(participant.userId);
    }

    // Notify all participants via Socket.IO
    chat.participants.forEach(participant => {
      req.io.to(`user_${participant.userId}`).emit('new_chat_created', {
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

        // Get shared list data if this is a LIST_SHARE message
        let sharedListData = null;
        if (msg.messageType === 'LIST_SHARE' && msg.sharedListId) {
          const list = await prisma.list.findUnique({
            where: { id: msg.sharedListId },
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
    const { chatId, content, messageType = 'TEXT', attachmentUrl, attachmentName, attachmentSize, sharedListId } = req.body;

    // Validation
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

    // If not a participant, check if this is a shop group chat or ALL Chat
    if (!participant) {
      const chat = await prisma.chat.findUnique({
        where: { id: chatId },
        select: { type: true, name: true }
      });

      // If it's a GROUP chat, automatically add user as participant
      if (chat && chat.type === 'GROUP') {
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
        attachmentSize,
        sharedListId: messageType === 'LIST_SHARE' ? sharedListId : null
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
      sharedListId: message.sharedListId,
      sharedList: sharedListData,
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
      
      const messagePayload = {
        ...formattedMessage,
        isOwnMessage: false
      };
      
      // Broadcast to chat room (for users actively viewing this chat)
      if (senderSocketId) {
        // Broadcast to room but exclude the sender
        req.io.to(`chat_${chatId}`).except(senderSocketId).emit('message_received', messagePayload);
      } else {
        // Fallback: broadcast to all in room (frontend will filter)
        req.io.to(`chat_${chatId}`).emit('message_received', messagePayload);
      }
      
      // ALSO broadcast to each participant's user room (for users not in chat view)
      // This ensures real-time delivery even if user is on a different screen
      for (const participant of chatParticipants) {
        // Skip the sender
        if (participant.userId === userId) continue;
        
        const participantUserRoom = `user_${participant.userId}`;
        console.log(`📨 Also emitting to user room: ${participantUserRoom}`);
        req.io.to(participantUserRoom).emit('message_received', messagePayload);
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

    let allUsers = [];

    // EMPLOYEE users can only see their shop owner (CUSTOMER who created them)
    if (currentUserType === 'EMPLOYEE') {
      // Get the employee's shop and createdByCustomerId
      const employee = await prisma.empolyee.findUnique({
        where: { id: currentUserId },
        select: { shopId: true, createdByCustomerId: true }
      });

      // Get the Customer (shop owner) who owns this shop or created this employee
      const customers = await prisma.customer.findMany({
        where: {
          OR: [
            { shopId: employee?.shopId },
            { id: employee?.createdByCustomerId }
          ],
          ...searchFilter
        },
        select: {
          id: true,
          name: true,
          email: true,
          userType: true
        }
      });

      allUsers = customers.map(user => ({
        id: user.id.toString(),
        name: user.name || 'Shop Owner',
        phone: user.email,
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
          email: true,
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
          email: true,
          userType: true
        }
      });

      allUsers = [
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

    } else {
      // CUSTOMER - only see employees from their own shop + other customers
      
      // First get the customer's shop
      const customer = await prisma.customer.findUnique({
        where: { id: currentUserId },
        select: { shopId: true }
      });
      
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
          email: true,
          userType: true
        }
      });

      // Employees ONLY from the customer's shop
      const employees = customerShopId ? await prisma.empolyee.findMany({
        where: {
          shopId: customerShopId,
          ...searchFilter
        },
        select: {
          id: true,
          name: true,
          email: true,
          userType: true
        }
      }) : [];

      const admins = await prisma.admin.findMany({
        where: searchFilter,
        select: {
          id: true,
          name: true,
          email: true,
          userType: true
        }
      });

      allUsers = [
        ...customers.map(user => ({
          id: user.id.toString(),
          name: user.name,
          phone: user.email,
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
    }
    
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