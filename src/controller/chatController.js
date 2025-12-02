import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

// Get all chats for a user
const getUserChats = async (req, res) => {
  try {
    const { userId, userType } = req.user;

    const chats = await prisma.chat.findMany({
      where: {
        participants: {
          some: {
            userId: parseInt(userId),
            userType: userType
          }
        }
      },
      include: {
        participants: {
          include: {
            // We'll need to create a union type or use a different approach
            // For now, let's just get the basic info
          }
        },
        messages: {
          orderBy: {
            createdAt: 'desc'
          },
          take: 1 // Get last message
        },
        _count: {
          select: {
            messages: true,
            participants: true
          }
        }
      },
      orderBy: {
        updatedAt: 'desc'
      }
    });

    res.json(chats);
  } catch (error) {
    console.error('Error fetching user chats:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

// Get messages for a specific chat
const getChatMessages = async (req, res) => {
  try {
    const { chatId } = req.params;
    const { userId, userType } = req.user;
    const { page = 1, limit = 50 } = req.query;

    // Verify user is participant of this chat
    const participant = await prisma.chatParticipant.findUnique({
      where: {
        chatId_userId_userType: {
          chatId,
          userId: parseInt(userId),
          userType: userType
        }
      }
    });

    if (!participant) {
      return res.status(403).json({ error: 'Access denied to this chat' });
    }

    const messages = await prisma.message.findMany({
      where: {
        chatId
      },
      orderBy: {
        createdAt: 'desc'
      },
      skip: (page - 1) * limit,
      take: parseInt(limit)
    });

    res.json(messages.reverse()); // Return in chronological order
  } catch (error) {
    console.error('Error fetching chat messages:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

// Send a message
const sendMessage = async (req, res) => {
  try {
    const { chatId } = req.params;
    const { content } = req.body;
    const { userId, userType } = req.user;

    // Verify user is participant of this chat
    const participant = await prisma.chatParticipant.findUnique({
      where: {
        chatId_userId_userType: {
          chatId,
          userId: parseInt(userId),
          userType: userType
        }
      }
    });

    if (!participant) {
      return res.status(403).json({ error: 'Access denied to this chat' });
    }

    // Create the message
    const message = await prisma.message.create({
      data: {
        content,
        chatId,
        senderId: parseInt(userId),
        senderType: userType
      }
    });

    // Update chat's last message and updatedAt
    await prisma.chat.update({
      where: { id: chatId },
      data: {
        lastMessage: content,
        updatedAt: new Date()
      }
    });

    // Emit socket event for real-time messaging
    if (req.io) {
      req.io.to(`chat_${chatId}`).emit('message_received', message);
    }

    res.status(201).json(message);
  } catch (error) {
    console.error('Error sending message:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

// Create a new chat
const createChat = async (req, res) => {
  try {
    const { name, type, participantIds } = req.body;
    const { userId, userType } = req.user;

    // Create the chat
    const chat = await prisma.chat.create({
      data: {
        name,
        type: type || 'PERSONAL'
      }
    });

    // Add creator as participant
    await prisma.chatParticipant.create({
      data: {
        chatId: chat.id,
        userId: parseInt(userId),
        userType: userType,
        isAdmin: true
      }
    });

    // Add other participants
    if (participantIds && participantIds.length > 0) {
      const participantData = participantIds.map(participant => ({
        chatId: chat.id,
        userId: participant.userId,
        userType: participant.userType,
        isAdmin: false
      }));

      await prisma.chatParticipant.createMany({
        data: participantData
      });
    }

    // Return chat with participants
    const chatWithParticipants = await prisma.chat.findUnique({
      where: { id: chat.id },
      include: {
        participants: true,
        _count: {
          select: {
            participants: true
          }
        }
      }
    });

    res.status(201).json(chatWithParticipants);
  } catch (error) {
    console.error('Error creating chat:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

// Add participant to chat
const addParticipant = async (req, res) => {
  try {
    const { chatId } = req.params;
    const { userId: newUserId, userType: newUserType } = req.body;
    const { userId, userType } = req.user;

    // Verify current user is admin of this chat
    const currentParticipant = await prisma.chatParticipant.findUnique({
      where: {
        chatId_userId_userType: {
          chatId,
          userId: parseInt(userId),
          userType: userType
        }
      }
    });

    if (!currentParticipant || !currentParticipant.isAdmin) {
      return res.status(403).json({ error: 'Admin access required' });
    }

    // Add new participant
    const participant = await prisma.chatParticipant.create({
      data: {
        chatId,
        userId: parseInt(newUserId),
        userType: newUserType,
        isAdmin: false
      }
    });

    res.status(201).json(participant);
  } catch (error) {
    console.error('Error adding participant:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

// Remove participant from chat
const removeParticipant = async (req, res) => {
  try {
    const { chatId, participantId } = req.params;
    const { userId, userType } = req.user;

    // Verify current user is admin of this chat
    const currentParticipant = await prisma.chatParticipant.findUnique({
      where: {
        chatId_userId_userType: {
          chatId,
          userId: parseInt(userId),
          userType: userType
        }
      }
    });

    if (!currentParticipant || !currentParticipant.isAdmin) {
      return res.status(403).json({ error: 'Admin access required' });
    }

    await prisma.chatParticipant.delete({
      where: { id: participantId }
    });

    res.json({ message: 'Participant removed successfully' });
  } catch (error) {
    console.error('Error removing participant:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

// Get chat details
const getChatDetails = async (req, res) => {
  try {
    const { chatId } = req.params;
    const { userId, userType } = req.user;

    // Verify user is participant of this chat
    const participant = await prisma.chatParticipant.findUnique({
      where: {
        chatId_userId_userType: {
          chatId,
          userId: parseInt(userId),
          userType: userType
        }
      }
    });

    if (!participant) {
      return res.status(403).json({ error: 'Access denied to this chat' });
    }

    const chat = await prisma.chat.findUnique({
      where: { id: chatId },
      include: {
        participants: true,
        _count: {
          select: {
            messages: true,
            participants: true
          }
        }
      }
    });

    res.json(chat);
  } catch (error) {
    console.error('Error fetching chat details:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

export {
  getUserChats,
  getChatMessages,
  sendMessage,
  createChat,
  addParticipant,
  removeParticipant,
  getChatDetails
};