import express from "express";
import dotenv from "dotenv";
import authRoutes from "./src/routes/authRoutes.js";
import chatRoutes from "./src/routes/chat.js";
import priceReportsRoutes from "./src/routes/priceReports.js";
import promotionsRoutes from "./src/routes/promotions.js";
import adminRoutes from "./src/routes/adminRoutes.js";
import listRoutes from "./src/routes/listRoutes.js";
import advertisementsRoutes from "./src/routes/advertisements.js";
import newsRoutes from "./src/routes/news.js";
import categoryRoutes from "./src/routes/categoryRoutes.js";
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { createServer } from 'http';
import { Server } from 'socket.io';
import redisService from './src/services/redisService.js';
import cacheService from './src/services/cacheService.js';

dotenv.config();
const app = express();
const server = createServer(app);

// Initialize Redis connection
(async () => {
  const connected = await redisService.connect();
  console.log(`📊 Redis Status:`, redisService.getStatus());
})();

// Configure Socket.IO with CORS - Allow all origins
const io = new Server(server, {
  cors: {
    origin: true,
    credentials: true,
    methods: ['GET', 'POST']
  }
});

// CORS configuration - Allow all origins
const corsOptions = {
  origin: true,
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Cookie', 'X-Requested-With'],
  exposedHeaders: ['Set-Cookie'],
  optionsSuccessStatus: 204
};

app.use(cors(corsOptions));

// Handle preflight requests explicitly
app.options('*', cors(corsOptions));

app.use(cookieParser());
app.use(express.json());

// Serve uploaded files
app.use('/uploads', express.static('uploads'));
app.use('/images', express.static('images'));

// Socket.IO connection handling - Define userSockets BEFORE using it in middleware
const userSockets = new Map(); // Map userId to socketId

// Make io, userSockets and cacheService available to routes
app.use((req, res, next) => {
  req.io = io;
  req.userSockets = userSockets;
  req.cacheService = cacheService;
  next();
});

app.use("/api", authRoutes);
app.use("/api/chat", chatRoutes);
app.use("/api/price-reports", priceReportsRoutes);
app.use("/api/promotions", promotionsRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/lists", listRoutes);
app.use("/api/advertisements", advertisementsRoutes);
app.use("/api/news", newsRoutes);
app.use("/api/categories", categoryRoutes);

// Global error handler
app.use((err, req, res, next) => {
  console.error('=== GLOBAL ERROR HANDLER ===');
  console.error('Error:', err.message);
  console.error('Stack:', err.stack);
  res.status(500).json({ error: err.message || 'Internal server error' });
});

// Health check endpoint with Redis status
app.get('/api/health', (req, res) => {
  const status = cacheService.getStatus();
  res.json({
    success: true,
    status: 'healthy',
    timestamp: new Date().toISOString(),
    cache: status,
    uptime: process.uptime()
  });
});

io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  // Join user to their personal room (for direct messages)
  socket.on('join_user_room', async (userId) => {
    // Ensure userId is stored as a number
    const userIdNum = typeof userId === 'number' ? userId : parseInt(userId);
    socket.join(`user_${userId}`);
    userSockets.set(userIdNum, socket.id); // Store socket ID with numeric key
    
    // Cache online status in Redis
    await cacheService.setUserOnline(userIdNum, socket.id);
    
    console.log(`✅ User ${userIdNum} joined their personal room (Socket: ${socket.id})`);
    console.log('📊 Current userSockets map:', Array.from(userSockets.entries()));
    console.log(`🏠 User ${userIdNum} is now in rooms:`, Array.from(socket.rooms));
  });

  // Join specific chat room
  socket.on('join_chat', (chatId) => {
    socket.join(`chat_${chatId}`);
    console.log(`✅ Socket ${socket.id} joined chat room: chat_${chatId}`);
    console.log(`🏠 This socket is now in rooms:`, Array.from(socket.rooms));
    
    // Log which user this socket belongs to
    for (const [userId, socketId] of userSockets.entries()) {
      if (socketId === socket.id) {
        console.log(`👤 This is user ${userId}'s socket`);
        break;
      }
    }
  });

  // Leave chat room
  socket.on('leave_chat', (chatId) => {
    socket.leave(`chat_${chatId}`);
    console.log(`User left chat ${chatId}`);
  });

  // Handle new message broadcasting
  socket.on('new_message', async (data) => {
    const { chatId, message } = data;
    // Add message to cache
    await cacheService.addMessageToCache(chatId, message);
    // Broadcast to all users in this chat except sender
    socket.to(`chat_${chatId}`).emit('message_received', message);
  });

  // Handle typing indicators
  socket.on('typing_start', async (data) => {
    const { chatId, userInfo } = data;
    await cacheService.setTyping(userInfo.id || userInfo.userId, chatId);
    socket.to(`chat_${chatId}`).emit('user_typing', userInfo);
  });

  socket.on('typing_stop', async (data) => {
    const { chatId, userInfo } = data;
    await cacheService.clearTyping(userInfo.id || userInfo.userId, chatId);
    socket.to(`chat_${chatId}`).emit('user_stopped_typing', userInfo);
  });

  // Handle disconnection
  socket.on('disconnect', async () => {
    console.log('User disconnected:', socket.id);
    // Remove from userSockets map and cache
    for (const [userId, socketId] of userSockets.entries()) {
      if (socketId === socket.id) {
        userSockets.delete(userId);
        await cacheService.setUserOffline(userId);
        console.log(`Removed user ${userId} from socket map`);
        break;
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});