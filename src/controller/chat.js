import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

// Get all chats for a user (GLOBAL CHAT - all users can see all chats)
export const getUserChats = async (req, res) => {
  try {
    const userId = req.user.id; // From JWT middleware
    const userType = req.user.userType;

    console.log('🔍 getUserChats called for:', { userId, userType });

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
      
      console.log(`🔍 Processing chat ${chat.id} (${chat.type}): ${chat.participants.length} raw participants`);
      
      // Get ALL participants info (including current user for group chats)
      const allParticipantsInfo = await Promise.all(
        chat.participants.map(async (p) => {
          console.log(`  - Participant: userId=${p.userId}, userType=${p.userType}`);
          if (p.userType === 'CUSTOMER') {
            const customer = await prisma.customer.findUnique({
              where: { id: p.userId },
              select: { id: true, name: true, email: true }
            });
            if (customer) {
              console.log(`    ✅ Found customer: ${customer.name}`);
              return { ...customer, userType: 'CUSTOMER' };
            } else {
              console.log(`    ❌ Customer not found: ${p.userId}`);
            }
          } else if (p.userType === 'EMPLOYEE') {
            const employee = await prisma.empolyee.findUnique({
              where: { id: p.userId },
              select: { id: true, name: true, email: true }
            });
            if (employee) {
              console.log(`    ✅ Found employee: ${employee.name}`);
              return { ...employee, userType: 'EMPLOYEE' };
            } else {
              console.log(`    ❌ Employee not found: ${p.userId}`);
            }
          }
          return null;
        })
      );
      
      // Filter out null values (deleted users)
      const validParticipants = allParticipantsInfo.filter(p => p !== null);
      
      console.log(`  📊 Valid participants: ${validParticipants.length}`);
      
      // Get other participants (excluding current user)
      const otherParticipants = validParticipants.filter(
        p => !(p.id === userId && p.userType === userType)
      );

      console.log(`  📊 Other participants: ${otherParticipants.length}`);
      otherParticipants.forEach(op => console.log(`    - ${op.name} (${op.userType})`));

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

    const groupChats = formattedChats.filter(c => c.type === 'GROUP').length;
    const personalChats = formattedChats.filter(c => c.type === 'PERSONAL').length;
    console.log(`✅ Returning ${formattedChats.length} chats for user ${userId} (${groupChats} group + ${personalChats} personal chats where user is participant)`);
    formattedChats.forEach(chat => {
      console.log(`   - ${chat.name} (${chat.type}): ${chat.participantCount} participants`);
    });

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

    console.log('✅ Chat created successfully:', {
      chatId: chat.id,
      type: chat.type,
      participantCount: chat.participants.length,
      participants: chat.participants.map(p => ({ userId: p.userId, userType: p.userType }))
    });

    // Notify all participants via Socket.IO
    console.log('📢 Notifying participants about new chat:', chat.id);
    chat.participants.forEach(participant => {
      req.io.to(`user_${participant.userId}`).emit('new_chat_created', {
        chatId: chat.id,
        chatType: chat.type,
        chatName: chat.name
      });
      console.log(`  ✅ Notified user ${participant.userId} (${participant.userType})`);
    });

    res.status(201).json({ success: true, chat });
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

    res.status(200).json({
      success: true,
      chat: {
        id: chat.id,
        name: chat.name,
        type: chat.type,
        participants: validParticipants,
        participantCount: validParticipants.length,
        messages: messagesWithSender.reverse() // Oldest first
      }
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

    console.log('📩 Sending message:', { userId, userType, chatId, content, messageType });

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
        console.log('🔄 Auto-adding user to ALL Chat group...');
        participant = await prisma.chatParticipant.create({
          data: {
            chatId,
            userId: userId,
            userType: userType
          }
        });
        console.log('✅ User added to ALL Chat group');
      } else {
        console.log('❌ User is not a participant');
        return res.status(403).json({ success: false, message: 'You are not a participant of this chat' });
      }
    }

    console.log('✅ User is participant, creating message...');

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

    console.log('✅ Message created:', message.id);

    // Update chat's lastMessageAt
    await prisma.chat.update({
      where: { id: chatId },
      data: { lastMessageAt: new Date() }
    });

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
      // Get sender's socket ID
      console.log('🔍 Looking for sender socket:', { userId, userType: typeof userId });
      console.log('📊 Available sockets:', Array.from(req.userSockets?.entries() || []));
      
      const senderSocketId = req.userSockets?.get(userId);
      console.log('🎯 Found sender socket:', senderSocketId);
      
      // Get all sockets in this chat room
      const room = req.io.sockets.adapter.rooms.get(`chat_${chatId}`);
      console.log(`🏠 Sockets in room chat_${chatId}:`, room ? Array.from(room) : 'Room not found or empty');
      
      if (senderSocketId) {
        // Broadcast to room but exclude the sender using socket.to()
        req.io.to(`chat_${chatId}`).except(senderSocketId).emit('message_received', {
          ...formattedMessage,
          isOwnMessage: false // For receivers, it's not their own message
        });
        console.log('📡 Broadcasted message to chat room (excluding sender):', chatId);
        console.log('📡 Message will be sent to sockets:', room ? Array.from(room).filter(id => id !== senderSocketId) : []);
      } else {
        // Fallback: broadcast to all (frontend will filter)
        req.io.to(`chat_${chatId}`).emit('message_received', {
          ...formattedMessage,
          isOwnMessage: false
        });
        console.log('📡 Broadcasted message to chat room (sender socket not found):', chatId);
        console.log('📡 Message will be sent to all sockets in room');
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

    console.log('🗑️ deleteChat called:', { userId, userType, chatId });

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

    console.log(`✅ Successfully deleted chat ${chatId}`);

    // Notify other participants via Socket.IO
    req.io.to(`chat_${chatId}`).emit('chat_deleted', { chatId });

    res.status(200).json({ success: true, message: 'Chat deleted successfully' });
  } catch (error) {
    console.error('Error deleting chat:', error);
    res.status(500).json({ success: false, message: 'Failed to delete chat', error: error.message });
  }
};

// Get all users for starting new chats
export const getAllUsers = async (req, res) => {
  try {
    const currentUserId = req.user.id;
    const currentUserType = req.user.userType;

    console.log('🔍 getAllUsers called by:', { currentUserId, currentUserType });

    // Get all customers
    const customers = await prisma.customer.findMany({
      where: {
        NOT: {
          AND: [
            { id: currentUserId },
            { userType: 'CUSTOMER' }
          ]
        }
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
        }
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
        }
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

    console.log(`✅ Returning ${allUsers.length} users for chat contacts`);
    
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
