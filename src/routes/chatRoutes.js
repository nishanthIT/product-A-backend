import express from 'express';
import {
  getUserChats,
  getChatMessages,
  sendMessage,
  createChat,
  addParticipant,
  removeParticipant,
  getChatDetails
} from '../controller/chatController.js';
import { isAuthenticated } from '../middleware/authware.js';

const router = express.Router();

// Apply authentication middleware to all routes
router.use(isAuthenticated);

// Get all chats for the authenticated user
router.get('/', getUserChats);

// Create a new chat
router.post('/', createChat);

// Get specific chat details
router.get('/:chatId', getChatDetails);

// Get messages for a specific chat
router.get('/:chatId/messages', getChatMessages);

// Send a message to a specific chat
router.post('/:chatId/messages', sendMessage);

// Add participant to a chat
router.post('/:chatId/participants', addParticipant);

// Remove participant from a chat
router.delete('/:chatId/participants/:participantId', removeParticipant);

export default router;