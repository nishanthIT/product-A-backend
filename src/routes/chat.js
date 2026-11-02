import { safeLogger } from '../services/safeLogger.js';
const securityLog = safeLogger('routes/chat.js');
import { selectedChatShop } from '../services/shopChatScope.js';
import { lockAccountForWrite } from '../services/accountWriteBarrier.js';
import { activeSuspension } from '../services/chatSafety.js';
import { requireChatPosting } from '../services/chatSafety.js';
import { PrismaClient } from '@prisma/client';
const uploadDb = new PrismaClient();
import express from 'express';
import multer from '../middleware/secureUpload.js';
import { chatAttachmentType, getChatStorage, MAX_CHAT_ATTACHMENT_BYTES } from '../services/chatStorage.js';
import { serviceError } from '../services/serviceErrors.js';
import { queueUnusedAttachment } from '../services/chatRetention.js';
import { getUserChats, createChat, getChatById, sendMessage, markAsRead, deleteChat, getAllUsers, deleteMessage } from '../controller/chat.js';
import { isAuthenticated } from '../middleware/authware.js';

const router = express.Router();

// A bounded in-memory upload avoids environment-specific temporary paths.
// Storage chooses local disk or private object storage after authorization.
const upload = multer({
  allowedTypes: ['image', 'document'],
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_CHAT_ATTACHMENT_BYTES, files: 1, fields: 5, parts: 6 },
  fileFilter: (_req, file, cb) => {
    cb(chatAttachmentType(file.originalname, file.mimetype) ? null : new Error('File type not allowed'), true);
  },
});

// All routes require authentication
router.use(isAuthenticated);

// Get all chats for logged-in user
router.get('/', getUserChats);

// Get all users for starting new chats
router.get('/users', getAllUsers);

// Create a new chat
router.post('/', requireChatPosting, createChat);

// Get specific chat with messages
router.get('/:chatId', getChatById);

// Send a message
router.post('/message', requireChatPosting, sendMessage);

// Mark messages as read
router.post('/read', markAsRead);

// Delete a message
router.delete('/message/:messageId', deleteMessage);

// Delete a personal chat
router.delete('/:chatId', deleteChat);

// Upload file for chat
router.post('/upload', requireChatPosting, async (req, res, next) => {
  try {
    if (!await selectedChatShop(req.user, uploadDb)) return res.status(403).json({ error: 'An active shop membership is required.' });
    next();
  } catch { res.status(503).json({ error: 'Could not verify shop access.' }); }
}, (req, res, next) => {
  upload.single('file')(req, res, error => {
    if (!error) return next();
    res.status(error.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({
      success: false,
      message: error.code === 'LIMIT_FILE_SIZE' ? 'Attachments must be 20 MB or smaller.' : 'Choose an image or supported document.',
    });
  });
}, async (req, res) => {
  let stored;
  try {
    if (!req.file) {
      return res.status(400).json({ 
        success: false, 
        message: 'No file uploaded' 
      });
    }

    const file = req.file;
    stored = await getChatStorage().put({
      buffer: file.buffer, originalname: file.originalname, mimetype: file.mimetype,
      onPrepared: async descriptor => {
        stored = descriptor;
        await uploadDb.$transaction(async tx => {
          await lockAccountForWrite(tx, req.user);
          if (await activeSuspension(req.user, tx)) throw Object.assign(new Error('Chat posting is suspended'), { status: 403 });
          await tx.chatUpload.create({ data: { ...descriptor, uploaderId: req.user.id, uploaderType: req.user.userType } });
        }, { maxWait: 15000, timeout: 60000 });
      },
    });
    if (stored.storageVersionId) await uploadDb.chatUpload.update({
      where: { filename: stored.filename }, data: { storageVersionId: stored.storageVersionId },
    });

    res.status(200).json({
      success: true,
      file: {
        url: stored.url,
        name: file.originalname,
        size: file.size,
        type: stored.type,
        mimetype: stored.contentType
      }
    });
  } catch (error) {
    if (stored) {
      try {
        // An interrupted PUT can finish remotely after its response is lost.
        // Keep ownership and defer cleanup beyond the request deadline instead
        // of treating an immediate missing-object response as final success.
        await uploadDb.$transaction(async tx => {
          if (stored.storageVersionId) await tx.chatUpload.updateMany({
            where: { filename: stored.filename }, data: { storageVersionId: stored.storageVersionId },
          });
          if (await queueUnusedAttachment(tx, stored.filename)) await tx.chatAttachmentDeletionJob.updateMany({
            where: { filename: stored.filename }, data: { nextAttemptAt: new Date(Date.now() + 5 * 60000) },
          });
        }, { maxWait: 15000, timeout: 60000 });
      } catch (cleanupError) {
        // Leave the ownership row for retention retry. Never log credentials,
        // temporary URLs, or private attachment names from provider errors.
        securityLog.warn('Chat upload cleanup deferred', serviceError(cleanupError));
      }
    }
    securityLog.error('Chat upload failed', serviceError(error));
    res.status(error.status || 500).json({
      success: false, 
      message: error.status ? error.message : 'Failed to upload file'
    });
  }
});

export default router;
