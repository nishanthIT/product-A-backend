// // import express from "express";
// // import dotenv from "dotenv";
// // import authRoutes from "./src/routes/authRoutes.js";
// // import cors from 'cors';
// // import cookieParser from 'cookie-parser';  // Add this import

// // dotenv.config();
// // const app = express();

// // // Configure CORS to allow all origins with credentials
// // app.use(cors({
// //   origin: (origin, callback) => {
// //     const allowedOrigins = ["http://localhost:8080", "http://192.168.126.1:8080"];
    
// //     if (!origin || allowedOrigins.includes(origin)) {
// //       callback(null, true);
// //     } else {
// //       callback(new Error("Not allowed by CORS"));
// //     }
// //   },
// //   credentials: true
// // }));

// // // Middleware
// // app.use(cookieParser());  // Add this middleware
// // app.use(express.json());

// // app.use("/api", authRoutes);

// // const PORT = process.env.PORT || 3000;
// // app.listen(PORT, () => {
// //   console.log(`Server is running on http://localhost:${PORT}`);
// // });


// import express from "express";
// import dotenv from "dotenv";
// import authRoutes from "./src/routes/authRoutes.js";
// import cors from 'cors';
// import cookieParser from 'cookie-parser';

// dotenv.config();
// const app = express();

// // Configure CORS with more precise settings
// app.use(cors({
//   origin: ["http://localhost:8080", "http://192.168.126.1:8080", "http://localhost:5173"], // Add your Vite dev server port (default 5173)
//   credentials: true,
//   methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
//   allowedHeaders: ['Content-Type', 'Authorization']
// }));

// // Middleware
// app.use(cookieParser());
// app.use(express.json());

// // Make auth route available
// app.use("/api", authRoutes);

// const PORT = process.env.PORT || 3000;
// app.listen(PORT, () => {
//   console.log(`Server is running on http://localhost:${PORT}`);
// });

import express from "express";
import dotenv from "dotenv";
import authRoutes from "./src/routes/authRoutes.js";
import chatRoutes from "./src/routes/chat.js";
import priceReportsRoutes from "./src/routes/priceReports.js";
import promotionsRoutes from "./src/routes/promotions.js";
import adminRoutes from "./src/routes/adminRoutes.js";
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { createServer } from 'http';
import { Server } from 'socket.io';

dotenv.config();
const app = express();
const server = createServer(app);

// Configure Socket.IO with CORS
const io = new Server(server, {
  cors: {
    origin: true,
    credentials: true,
    methods: ['GET', 'POST']
  }
});

// More permissive CORS setup for mobile app
app.use(cors({
  origin: true, // Allow any origin for development (mobile apps)
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Cookie']
}));

// Add extra header for cookies
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Credentials', 'true');
  next();
});

app.use(cookieParser());
app.use(express.json());

// Serve uploaded files
app.use('/uploads', express.static('uploads'));

// Socket.IO connection handling - Define userSockets BEFORE using it in middleware
const userSockets = new Map(); // Map userId to socketId

// Log all incoming requests
app.use((req, res, next) => {
  console.log(`📥 ${req.method} ${req.path}`, req.body || '');
  next();
});

// Make io and userSockets available to routes
app.use((req, res, next) => {
  req.io = io;
  req.userSockets = userSockets;
  next();
});

// Log all incoming requests
app.use((req, res, next) => {
  console.log('📥 Incoming Request:', {
    method: req.method,
    url: req.url,
    path: req.path,
    body: req.body
  });
  next();
});

app.use("/api", authRoutes);
app.use("/api/chat", chatRoutes);
app.use("/api/price-reports", priceReportsRoutes);
app.use("/api/promotions", promotionsRoutes);
app.use("/api/admin", adminRoutes);

io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  // Join user to their personal room (for direct messages)
  socket.on('join_user_room', (userId) => {
    // Ensure userId is stored as a number
    const userIdNum = typeof userId === 'number' ? userId : parseInt(userId);
    socket.join(`user_${userId}`);
    userSockets.set(userIdNum, socket.id); // Store socket ID with numeric key
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
  socket.on('new_message', (data) => {
    const { chatId, message } = data;
    // Broadcast to all users in this chat except sender
    socket.to(`chat_${chatId}`).emit('message_received', message);
  });

  // Handle typing indicators
  socket.on('typing_start', (data) => {
    const { chatId, userInfo } = data;
    socket.to(`chat_${chatId}`).emit('user_typing', userInfo);
  });

  socket.on('typing_stop', (data) => {
    const { chatId, userInfo } = data;
    socket.to(`chat_${chatId}`).emit('user_stopped_typing', userInfo);
  });

  // Handle disconnection
  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id);
    // Remove from userSockets map
    for (const [userId, socketId] of userSockets.entries()) {
      if (socketId === socket.id) {
        userSockets.delete(userId);
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