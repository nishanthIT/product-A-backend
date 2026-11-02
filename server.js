import { trustedProxySetting, corsConfiguration, csrfProtection, securityHeaders, requestConstraints, safeErrorHandler } from './src/middleware/httpSecurity.js';
import { securityResponseObserver, publicApiProtection } from './src/middleware/securityProtection.js';
import securityAdminRoutes from './src/routes/securityAdminRoutes.js';
import { pruneSecurityEvents, securityAuditKey } from './src/services/securityProtection.js';
import 'dotenv/config';
import { verifyServiceSchema } from './src/services/serviceReadiness.js';
import { ensureGlobalChat } from './src/services/globalChat.js';
import { startChatRetentionWorker, chatRetentionStatus, retentionConfig } from './src/services/chatRetention.js';
import { getChatStorage } from './src/services/chatStorage.js';
import { initRealtimeAdapter } from './src/realtime/redisAdapter.js';
import { drainChatWork } from './src/services/chatBroadcast.js';
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

securityAuditKey();
jwtSecret(); // Fail before accepting requests when the signing secret is missing.
const app = express();
const server = createServer(app);

// Respect reverse-proxy headers in production (protocol/host forwarding).
app.disable('x-powered-by');
app.set('trust proxy', trustedProxySetting());
app.set('query parser', 'simple');

// Dependency failures are startup errors, not a healthy HTTP server with broken auth.
try {
  await verifyServiceSchema();
  getChatStorage(); retentionConfig();
  await ensureGlobalChat();
  console.log('Session validation dependencies ready (PostgreSQL)');
  await redisService.connect();
  console.log('Cache status:', redisService.getStatus());
} catch (error) {
  console.error('Backend dependencies unavailable; startup aborted', serviceError(error));
  process.exit(1);
}

const corsOptions = corsConfiguration();
const io = new Server(server, { cors: corsOptions, maxHttpBufferSize: 1024 * 1024,
  allowRequest: (req, callback) => corsOptions.origin(req.headers.origin, (_error, allowed) => callback(null, Boolean(allowed))),
});
const realtimeAdapter = await initRealtimeAdapter(io);

// A restored environment stays closed until deletion-ledger replay and operational checks finish.
app.use(securityHeaders);
app.use(securityResponseObserver);
app.use(restoreGuard);
app.use(cors(corsOptions));

// Handle preflight requests explicitly
app.options('*', cors(corsOptions));

app.use(cookieParser());
app.use(csrfProtection());
app.use(express.json({ limit: '256kb', strict: true }));
app.use(requestConstraints);

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

app.use('/api', publicApiProtection);
app.use('/api/chat-safety', chatSafetyRoutes);
app.use(publicResources);
app.use("/api/account-deletion", accountDeletionRoutes);
app.use("/api", authRoutes);
app.use("/api/chat", chatRoutes);
app.use("/api/price-reports", priceReportsRoutes);
app.use("/api/promotions", promotionsRoutes);
app.use("/api/admin/security", securityAdminRoutes);
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

// Public liveness reveals no infrastructure, cache keys or operational metadata.
let healthAt = 0, databaseHealthy = false, healthInFlight = null;
app.get('/api/health', async (_req, res) => {
  if (Date.now() - healthAt > 5000) {
    healthInFlight ||= verifyServiceSchema().then(() => { databaseHealthy = true; }).catch(() => { databaseHealthy = false; }).finally(() => { healthAt = Date.now(); healthInFlight = null; });
    await healthInFlight;
  }
  const healthy = databaseHealthy && moderationWorkerStatus.state === 'ready';
  res.status(healthy ? 200 : 503).json({ success: healthy, status: healthy ? 'healthy' : 'unavailable' });
});
app.use(safeErrorHandler);

let stopModerationWorker;
let stopChatRetentionWorker;
const securityRetentionTimer = setInterval(() => {
  pruneSecurityEvents().catch(error => console.error('Security retention failed', serviceError(error)));
}, 3600000);
securityRetentionTimer.unref();
// Bound slow uploads/headers; upstream and database timeouts remain deployment controls.
server.requestTimeout = 60000;
server.headersTimeout = 15000;
server.keepAliveTimeout = 5000;
const PORT = process.env.PORT || 3000;
server.listen(PORT, process.env.HOST || '0.0.0.0', () => {
  console.log(`Server is running on http://localhost:${PORT}`);
  
  stopModerationWorker = startModerationWorker(io);
  stopChatRetentionWorker = startChatRetentionWorker(io);
  // Start expiry notification service
  expiryNotificationService.start();
  console.log('✅ Expiry notification service started');
});

// Allow expiry notification service to push realtime events to connected users.
expiryNotificationService.setRealtimeContext(io);

for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, async () => {
  const force = setTimeout(() => process.exit(0), 30000); force.unref();
  clearInterval(securityRetentionTimer);
  stopModerationWorker?.();
  await stopChatRetentionWorker?.();
  await drainChatWork();
  await realtimeAdapter.close();
  await redisService.disconnect();
  io.close();
  server.close(() => process.exit(0));
});
