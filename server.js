import 'dotenv/config';
import { verifyServiceSchema } from './src/services/serviceReadiness.js';
import { serviceError } from './src/services/serviceErrors.js';
import { startModerationWorker, moderationWorkerStatus } from './src/services/moderation.js';
import { restoreGuard } from './src/middleware/restoreGuard.js';
import chatSafetyRoutes from './src/routes/chatSafetyRoutes.js';
import publicResources from './src/routes/publicResources.js';
import accountDeletionRoutes from './src/routes/accountDeletionRoutes.js';
import { jwtSecret } from './src/services/sessionSecurity.js';
import privateUploads from './src/middleware/privateUploads.js';
import express from "express";
import authRoutes from "./src/routes/authRoutes.js";
import chatRoutes from "./src/routes/chat.js";
import priceReportsRoutes from "./src/routes/priceReports.js";
import promotionsRoutes from "./src/routes/promotions.js";
import adminRoutes from "./src/routes/adminRoutes.js";
import listRoutes from "./src/routes/listRoutes.js";
import advertisementsRoutes from "./src/routes/advertisements.js";
import newsRoutes from "./src/routes/news.js";
import categoryRoutes from "./src/routes/categoryRoutes.js";
import employeeRoutes from "./src/routes/employeeRoutes.js";
import shopRoutes from "./src/routes/shopRoutes.js";
import expiryRoutes from "./src/routes/expiryRoutes.js";
import taskRoutes from "./src/routes/taskRoutes.js";
import fridgeRoutes from "./src/routes/fridgeRoutes.js";
import cleaningRoutes from "./src/routes/cleaningRoutes.js";
import incidentRoutes from "./src/routes/incidentRoutes.js";
import certificateRoutes from "./src/routes/certificateRoutes.js";
import ageRestrictedRecordRoutes from "./src/routes/ageRestrictedRecordRoutes.js";
import ageRestrictionRecordRoutes from "./src/routes/ageRestrictionRecordRoutes.js";
import supplierPayoutRoutes from "./src/routes/supplierPayoutRoutes.js";
import shiftSheetRoutes from "./src/routes/shiftSheetRoutes.js";
import cors from 'cors';
import wasteRoutes from './src/routes/wasteRoutes.js';
import compareRoutes from './src/routes/compareRoutes.js';
import cookieParser from 'cookie-parser';
import { createServer } from 'http';
import { Server } from 'socket.io';
import redisService from './src/services/redisService.js';
import cacheService from './src/services/cacheService.js';
import multiLayerCache from './src/services/multiLayerCache.js';
import expiryNotificationService from './src/services/expiryNotificationService.js';
import { attachSocketServer } from './src/realtime/socketServer.js';

jwtSecret(); // Fail before accepting requests when the signing secret is missing.
const app = express();
const server = createServer(app);

// Respect reverse-proxy headers in production (protocol/host forwarding).
app.set('trust proxy', 1);

// Dependency failures are startup errors, not a healthy HTTP server with broken auth.
try {
  await verifyServiceSchema();
  console.log('Session validation dependencies ready (PostgreSQL)');
  await redisService.connect();
  console.log('Cache status:', redisService.getStatus());
} catch (error) {
  console.error('Backend dependencies unavailable; startup aborted', serviceError(error));
  process.exit(1);
}

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
  allowedHeaders: ['Content-Type', 'Authorization', 'Cookie', 'X-Requested-With', 'X-Supermarket-Id', 'Idempotency-Key'],
  exposedHeaders: ['Set-Cookie'],
  optionsSuccessStatus: 204
};

// A restored environment stays closed until deletion-ledger replay and operational checks finish.
app.use(restoreGuard);
app.use(cors(corsOptions));

// Handle preflight requests explicitly
app.options('*', cors(corsOptions));

app.use(cookieParser());
app.use(express.json());

// Serve uploaded files
app.use('/uploads', privateUploads);
app.use('/api/uploads', privateUploads);
app.use('/uploads', express.static('uploads'));
app.use('/api/uploads', express.static('uploads'));
app.use('/images', express.static('images'));

// Socket.IO connection handling - Define userSockets BEFORE using it in middleware
const userSockets = new Map(); // `${userType}:${id}` -> socketId

// Socket auth and room authorization (see src/realtime/socketServer.js)
attachSocketServer(io, { userSockets, cacheService });

// Make io, userSockets and cacheService available to routes
app.use((req, res, next) => {
  req.io = io;
  req.userSockets = userSockets;
  req.cacheService = cacheService;
  next();
});

app.use('/api/chat-safety', chatSafetyRoutes);
app.use(publicResources);
app.use("/api/account-deletion", accountDeletionRoutes);
app.use("/api", authRoutes);
app.use("/api/chat", chatRoutes);
app.use("/api/price-reports", priceReportsRoutes);
app.use("/api/promotions", promotionsRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/lists", listRoutes);
app.use("/api/advertisements", advertisementsRoutes);
app.use("/api/news", newsRoutes);
app.use("/api/categories", categoryRoutes);
app.use("/api/employees", employeeRoutes);
app.use("/api/shop", shopRoutes);
app.use("/api/expiry", expiryRoutes);
app.use("/api/tasks", taskRoutes);
app.use("/api/fridges", fridgeRoutes);
app.use("/api/cleaning", cleaningRoutes);
app.use("/api/incidents", incidentRoutes);
app.use("/api/certificates", certificateRoutes);
app.use('/api/waste', wasteRoutes);
app.use('/api/age-restricted-records', ageRestrictedRecordRoutes);
app.use('/api/age-restriction-records', ageRestrictionRecordRoutes);
app.use('/api/supplier-payouts', supplierPayoutRoutes);
app.use('/api/shift-sheet', shiftSheetRoutes);
app.use('/api/products', compareRoutes);

// Global error handler
app.use((err, req, res, next) => {
  console.error('=== GLOBAL ERROR HANDLER ===');
  console.error('Error:', err.message);
  console.error('Stack:', err.stack);
  res.status(500).json({ error: 'Internal server error' });
});

// Health check endpoint with Redis status
app.get('/api/health', async (req, res) => {
  try { await verifyServiceSchema(); }
  catch (error) {
    console.error('Backend health check failed', serviceError(error));
    return res.status(503).json({ success: false, status: 'unavailable', service: error.service || 'database' });
  }
  const status = cacheService.getStatus();
  res.status(moderationWorkerStatus.state === 'ready' ? 200 : 503).json({
    success: moderationWorkerStatus.state === 'ready',
    status: moderationWorkerStatus.state === 'ready' ? 'healthy' : 'degraded',
    services: { sessions: 'ready', moderation: moderationWorkerStatus },
    timestamp: new Date().toISOString(),
    cache: status,
    inventoryCache: multiLayerCache.getStats(),
    uptime: process.uptime()
  });
});

let stopModerationWorker;
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
  
  stopModerationWorker = startModerationWorker(io);
  // Start expiry notification service
  expiryNotificationService.start();
  console.log('✅ Expiry notification service started');
});

// Allow expiry notification service to push realtime events to connected users.
expiryNotificationService.setRealtimeContext(io);

for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => {
  stopModerationWorker?.();
  void redisService.disconnect();
  io.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
});
