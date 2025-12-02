import express from 'express';
import { getUserChats, createChat, getChatById, sendMessage, markAsRead, deleteChat, getAllUsers } from '../controller/chat.js';
import { isAuthenticated } from '../middleware/authware.js';

const router = express.Router();

// Logging middleware for all chat routes
router.use((req, res, next) => {
  console.log('🔵 Chat Route Hit:', {
    method: req.method,
    path: req.path,
    fullUrl: req.originalUrl,
    body: req.body,
    hasUser: !!req.user
  });
  next();
});

// All routes require authentication
router.use(isAuthenticated);

// Get all chats for logged-in user
router.get('/', getUserChats);

// Get all users for starting new chats
router.get('/users', getAllUsers);

// Create a new chat
router.post('/', createChat);

// Get specific chat with messages
router.get('/:chatId', getChatById);

// Send a message
router.post('/message', (req, res, next) => {
  console.log('💬 POST /message route hit:', req.body);
  next();
}, sendMessage);

// Mark messages as read
router.post('/read', markAsRead);

// Delete a personal chat
router.delete('/:chatId', deleteChat);

export default router;
