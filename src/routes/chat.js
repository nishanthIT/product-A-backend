import express from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { getUserChats, createChat, getChatById, sendMessage, markAsRead, deleteChat, getAllUsers, deleteMessage } from '../controller/chat.js';
import { isAuthenticated } from '../middleware/authware.js';

const router = express.Router();

// Configure multer for chat file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadPath = 'uploads/chat';
    if (!fs.existsSync(uploadPath)) {
      fs.mkdirSync(uploadPath, { recursive: true });
    }
    cb(null, uploadPath);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    let ext = path.extname(file.originalname);
    
    // If no extension, derive from mimetype
    if (!ext || ext === '') {
      const mimeToExt = {
        'image/jpeg': '.jpg',
        'image/jpg': '.jpg',
        'image/png': '.png',
        'image/gif': '.gif',
        'image/webp': '.webp',
        'application/pdf': '.pdf',
        'text/plain': '.txt',
      };
      ext = mimeToExt[file.mimetype] || '.bin';
    }
    
    console.log('📎 Saving file with extension:', ext, 'from mimetype:', file.mimetype);
    cb(null, 'chat-' + uniqueSuffix + ext);
  }
});

const upload = multer({
  storage,
  limits: {
    fileSize: 20 * 1024 * 1024, // 20MB limit
  },
  fileFilter: (req, file, cb) => {
    // Allow images and documents based on mimetype or extension
    const allowedMimeTypes = /image\/(jpeg|jpg|png|gif|webp)|application\/(pdf|msword|vnd\.openxmlformats|octet-stream)|text\//;
    const allowedExtensions = /jpeg|jpg|png|gif|webp|pdf|doc|docx|xls|xlsx|txt/;
    
    const extname = allowedExtensions.test(path.extname(file.originalname).toLowerCase());
    const mimetype = allowedMimeTypes.test(file.mimetype);
    
    // Allow if either extension or mimetype matches
    if (extname || mimetype) {
      return cb(null, true);
    } else {
      cb(new Error('File type not allowed. Allowed: images, PDF, Word, Excel, text files'));
    }
  }
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
router.post('/message', sendMessage);

// Mark messages as read
router.post('/read', markAsRead);

// Delete a message
router.delete('/message/:messageId', deleteMessage);

// Delete a personal chat
router.delete('/:chatId', deleteChat);

// Upload file for chat
router.post('/upload', upload.single('file'), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ 
        success: false, 
        message: 'No file uploaded' 
      });
    }

    const file = req.file;
    const fileUrl = `/uploads/chat/${file.filename}`;
    
    // Determine file type
    const ext = path.extname(file.originalname).toLowerCase();
    const imageTypes = ['.jpg', '.jpeg', '.png', '.gif', '.webp'];
    const fileType = imageTypes.includes(ext) ? 'IMAGE' : 'DOCUMENT';

    res.status(200).json({
      success: true,
      file: {
        url: fileUrl,
        name: file.originalname,
        size: file.size,
        type: fileType,
        mimetype: file.mimetype
      }
    });
  } catch (error) {
    console.error('❌ File upload error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to upload file',
      error: error.message 
    });
  }
});

export default router;
