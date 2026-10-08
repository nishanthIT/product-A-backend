// Integration-test harness. Uses a disposable Postgres given by TEST_DATABASE_URL;
// refuses to run against anything that is not a local *test* database.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const TEST_URL = process.env.TEST_DATABASE_URL;

function assertSafeTestDatabase(url) {
  if (!url) {
    throw new Error('TEST_DATABASE_URL is required, e.g. postgresql://postgres@localhost:54329/paymi_test (a disposable local database).');
  }
  const parsed = new URL(url);
  const local = ['localhost', '127.0.0.1', '::1'].includes(parsed.hostname);
  const dbName = parsed.pathname.replace('/', '');
  if (!local || !/test/i.test(dbName)) {
    throw new Error(`Refusing to run destructive tests against ${parsed.hostname}/${dbName}`);
  }
}

assertSafeTestDatabase(TEST_URL);
process.env.JWT_SECRET = 'test-secret-for-authz-tests';

// Optional TCP proxy that delays every packet, to reproduce the remote-DB latency seen in practice.
async function startLatencyProxy(targetUrl, delayMs) {
  const net = await import('node:net');
  const target = new URL(targetUrl);
  const server = net.createServer((client) => {
    const upstream = net.connect(Number(target.port || 5432), target.hostname);
    // Pooled DB connections must not keep the test process alive.
    client.unref();
    upstream.unref();
    const relay = (from, to) => from.on('data', (chunk) => setTimeout(() => to.write(chunk), delayMs));
    relay(client, upstream);
    relay(upstream, client);
    const close = () => { client.destroy(); upstream.destroy(); };
    client.on('error', close).on('close', close);
    upstream.on('error', close).on('close', close);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  server.unref();
  const proxied = new URL(targetUrl);
  proxied.hostname = '127.0.0.1';
  proxied.port = String(server.address().port);
  return proxied.toString();
}

export const DB_LATENCY_MS = Number(process.env.TEST_DB_LATENCY_MS || 0);
process.env.DATABASE_URL = DB_LATENCY_MS > 0 ? await startLatencyProxy(TEST_URL, DB_LATENCY_MS) : TEST_URL;

/** Recreates the schema from prisma/schema.prisma plus the raw-SQL-only partial index. */
export async function resetDatabase() {
  // A schema copy with the URL inlined guarantees `--force-reset` can only hit the test DB.
  const schema = fs
    .readFileSync(path.join(root, 'prisma/schema.prisma'), 'utf8')
    .replace('url      = env("DATABASE_URL")', `url      = "${TEST_URL}"`);
  if (!schema.includes(TEST_URL)) throw new Error('Could not pin the test schema URL');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paymi-schema-'));
  const schemaPath = path.join(dir, 'schema.prisma');
  fs.writeFileSync(schemaPath, schema);
  execFileSync(
    path.join(root, 'node_modules/.bin/prisma'),
    ['db', 'push', '--force-reset', '--skip-generate', '--accept-data-loss', `--schema=${schemaPath}`],
    { cwd: dir, stdio: 'pipe', env: { ...process.env, DATABASE_URL: TEST_URL } }
  );
  fs.rmSync(dir, { recursive: true, force: true });

  const prisma = await getPrisma();
  const migrationSql = fs.readFileSync(
    path.join(root, 'prisma/migrations/20261007120000_separate_company_staff_and_shop_employees/migration.sql'),
    'utf8'
  );
  const partialIndex = migrationSql.split('\n').find((l) => l.includes('one_active_per_employee'));
  await prisma.$executeRawUnsafe(partialIndex);
}

let prismaInstance;
export async function getPrisma() {
  if (!prismaInstance) {
    const { PrismaClient } = await import('@prisma/client');
    prismaInstance = new PrismaClient();
  }
  return prismaInstance;
}

/** Express app + Socket.IO mounted like server.js for the routers under test. */
export async function startApp() {
  const express = (await import('express')).default;
  const cookieParser = (await import('cookie-parser')).default;
  const http = await import('node:http');
  const { Server } = await import('socket.io');
  const [authRoutes, adminRoutes, employeeRoutes, listRoutes, shopRoutes, priceReports, chatRoutes, taskRoutes, socketServer, cacheService] = await Promise.all([
    import('../../src/routes/authRoutes.js'),
    import('../../src/routes/adminRoutes.js'),
    import('../../src/routes/employeeRoutes.js'),
    import('../../src/routes/listRoutes.js'),
    import('../../src/routes/shopRoutes.js'),
    import('../../src/routes/priceReports.js'),
    import('../../src/routes/chat.js'),
    import('../../src/routes/taskRoutes.js'),
    import('../../src/realtime/socketServer.js'),
    import('../../src/services/cacheService.js'),
  ]);

  const app = express();
  const server = http.createServer(app);
  const io = new Server(server);
  const userSockets = new Map();
  socketServer.attachSocketServer(io, { userSockets, cacheService: cacheService.default });

  app.use(cookieParser());
  app.use(express.json());
  app.use((req, _res, next) => {
    req.io = io;
    req.userSockets = userSockets;
    next();
  });
  app.use('/api', authRoutes.default);
  app.use('/api/chat', chatRoutes.default);
  app.use('/api/price-reports', priceReports.default);
  app.use('/api/admin', adminRoutes.default);
  app.use('/api/lists', listRoutes.default);
  app.use('/api/employees', employeeRoutes.default);
  app.use('/api/shop', shopRoutes.default);
  app.use('/api/tasks', taskRoutes.default);

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const base = `${origin}/api`;
  const sockets = [];

  const request = async (method, url, { token, body } = {}) => {
    const res = await fetch(`${base}${url}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(token && { Authorization: `Bearer ${token}` }),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    let data = null;
    try {
      data = await res.json();
    } catch {
      data = null;
    }
    return { status: res.status, body: data };
  };

  /** Connects a socket.io client (same library the mobile app uses) and records received events. */
  const connectSocket = async (token) => {
    const { io: ioClient } = await import(path.join(root, '../paymi_v2/node_modules/socket.io-client/build/esm-debug/index.js'));
    const socket = ioClient(origin, { auth: token ? { token } : {}, transports: ['websocket'], reconnection: false });
    socket.received = [];
    socket.onAny((event, payload) => socket.received.push({ event, payload }));
    await new Promise((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('connect_error', reject);
    });
    sockets.push(socket);
    return socket;
  };

  return {
    request,
    connectSocket,
    login: async (email, password) => {
      const res = await request('POST', '/auth/login', { body: { email, password } });
      return { ...res, token: res.body?.token };
    },
    close: async () => {
      sockets.forEach((s) => s.disconnect());
      io.close();
      await new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

/** Seeds an Admin, two customers with their own shops, and a wholesale shop. */
export async function seedBase(prisma) {
  const bcrypt = (await import('bcryptjs')).default;
  const password = await bcrypt.hash('Passw0rd!', 4);

  const wholesale = await prisma.shop.create({
    data: { name: 'Wholesale Depot', address: 'x', mobile: 'x', shopType: 'WHOLESALE' },
  });
  const admin = await prisma.admin.create({ data: { email: 'admin@company.test', password, name: 'Company Admin' } });

  const makeOwner = async (label) => {
    const chat = await prisma.chat.create({ data: { name: `${label} chat`, type: 'GROUP' } });
    const shop = await prisma.shop.create({
      data: { name: `${label} Shop`, address: 'x', mobile: 'x', shopType: 'CUSTOMER', groupChatId: chat.id },
    });
    const owner = await prisma.customer.create({
      data: {
        name: `${label} Owner`,
        email: `${label.toLowerCase()}-owner@shop.test`,
        mobile: `m-${label}`,
        password,
        shopId: shop.id,
        subscriptionStatus: 'premium',
        trialEndDate: new Date(Date.now() + 365 * 86400000),
      },
    });
    await prisma.chatParticipant.create({ data: { chatId: chat.id, userId: owner.id, userType: 'CUSTOMER', isAdmin: true } });
    return { shop, owner };
  };

  const a = await makeOwner('Alpha');
  const b = await makeOwner('Bravo');
  const product = await prisma.product.create({ data: { title: 'Test Cola 330ml', barcode: '5000000000001' } });
  await prisma.productAtShop.create({ data: { shopId: wholesale.id, productId: product.id, price: 1.25 } });

  return { password: 'Passw0rd!', passwordHash: password, admin, wholesale, a, b, product };
}

/** Creates a company staff account directly (as the company staff flow would). */
export async function createCompanyStaff(prisma, { email, passwordHash, permissions, role = 'STAFF', status = 'ACTIVE' }) {
  return prisma.empolyee.create({
    data: {
      name: email.split('@')[0],
      email,
      phoneNo: `p-${email}`,
      password: passwordHash,
      companyMembership: { create: { role, permissions, status } },
    },
  });
}
