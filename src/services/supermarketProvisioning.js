import { createHmac, randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';

export class SupermarketError extends Error {
  constructor(message, status = 409, code = 'SUPERMARKET_REVIEW_REQUIRED') {
    super(message); this.status = status; this.code = code;
  }
}

export function registrationRequestHash(input, secret) {
  if (!secret) throw new Error('JWT_SECRET is required for registration receipts');
  // Same proof on a lost-response retry; no plaintext credential goes into the database.
  return createHmac('sha256', secret).update(JSON.stringify([
    input.email, input.name, input.password, String(input.otp).trim(),
    input.shopName, input.shopAddress, input.shopMobile,
  ])).digest('hex');
}

export function normalizeRegistration(body) {
  const clean = (value) => typeof value === 'string' ? value.trim() : '';
  const name = clean(body.name);
  const email = clean(body.email).toLowerCase();
  const password = body.password;
  if (!name || name.length > 200 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254 || typeof password !== 'string' || password.length < 6 || password.length > 1024) {
    throw new SupermarketError('Enter a valid name, email and password (at least 6 characters).', 400, 'INVALID_REGISTRATION');
  }
  if (!/^\d{6}$/.test(String(body.otp ?? '').trim())) throw new SupermarketError('Enter the six-digit verification code.', 400, 'INVALID_OTP');
  const shopName = body.shopName === undefined ? `${name}'s Shop` : clean(body.shopName);
  const shopAddress = clean(body.shopAddress);
  const shopMobile = clean(body.shopMobile);
  if (!shopName || shopName.length > 200 || shopAddress.length > 1000 || shopMobile.length > 50) {
    throw new SupermarketError('Enter a shop name and valid shop details.', 400, 'INVALID_SUPERMARKET');
  }
  return { name, email, password, otp: String(body.otp).trim(), shopName, shopAddress, shopMobile };
}

export async function findRegistrationRetry(db, requestHash, password) {
  const receipt = await db.registrationReceipt.findUnique({
    where: { requestHash }, include: { customer: { include: { shop: true } } },
  });
  if (!receipt || receipt.expiresAt <= new Date()) return null;
  if (!password || !(await bcrypt.compare(password, receipt.customer.password))) return null;
  // Receipt proves a prior successful verified registration, not arbitrary email ownership.
  return { customer: receipt.customer, shop: receipt.customer.shop, replayed: true };
}

/** Called only AFTER email OTP verification (or with the exact durable retry proof).
 * Every shop/account/chat/ownership/default/receipt write commits or rolls back together.
 */
export async function provisionRegistration(db, input, passwordHash, requestHash) {
  return db.$transaction(async (tx) => {
    // Serialize same-email registration across server processes, not just in memory.
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${input.email}, 0))::text`;
    const retry = await findRegistrationRetry(tx, requestHash, input.password);
    if (retry) return retry;
    const [customer, employee, admin] = await Promise.all([
      tx.customer.findUnique({ where: { email: input.email }, select: { id: true } }),
      tx.empolyee.findUnique({ where: { email: input.email }, select: { id: true } }),
      tx.admin.findFirst({ where: { email: input.email }, select: { id: true } }),
    ]);
    if (customer || employee || admin) throw new SupermarketError('This email is already registered. Please log in.', 409, 'ACCOUNT_EXISTS');
    const shop = await tx.shop.create({ data: {
      name: input.shopName, address: input.shopAddress, mobile: input.shopMobile, shopType: 'CUSTOMER',
    } });
    const now = new Date();
    const created = await tx.customer.create({ data: {
      name: input.name, email: input.email, password: passwordHash,
      mobile: `temp_${randomUUID()}`, subscriptionStatus: 'free',
      trialStartDate: null, trialEndDate: null, shopId: shop.id,
    } });
    await tx.supermarketOwnership.create({ data: { customerId: created.id, shopId: shop.id, source: 'REGISTRATION' } });
    const updated = await tx.customer.update({ where: { id: created.id }, data: {
      defaultSupermarketId: shop.id, defaultSupermarketVersion: 1,
    } });
    const chat = await tx.chat.create({ data: {
      name: `${shop.name} - Team Chat`, type: 'GROUP',
      participants: { create: { userId: created.id, userType: 'CUSTOMER', isAdmin: true } },
    } });
    const readyShop = await tx.shop.update({ where: { id: shop.id }, data: { groupChatId: chat.id } });
    await tx.registrationReceipt.create({ data: {
      requestHash, customerId: created.id, expiresAt: new Date(now.getTime() + 86400000),
    } });
    return { customer: updated, shop: readyShop, replayed: false };
  }, { timeout: 60000, maxWait: 15000 });
}

/** A preference never grants access. An invalid explicit selection must not fall back. */
export async function resolveSupermarketSelection(db, user, selectedId, { feature, level = 'read' } = {}) {
  if (selectedId !== undefined && (typeof selectedId !== 'string' || !selectedId)) {
    throw new SupermarketError('Invalid supermarket selection.', 400, 'INVALID_SUPERMARKET');
  }
  if (user.userType === 'CUSTOMER') {
    const customer = await db.customer.findUnique({
      where: { id: user.id }, select: { defaultSupermarketId: true, supermarketOwnerships: { include: { shop: true } } },
    });
    if (!customer) throw new SupermarketError('Account no longer exists.', 401, 'SESSION_REVOKED');
    const id = selectedId ?? customer.defaultSupermarketId;
    const ownership = customer.supermarketOwnerships.find((o) => o.shopId === id && o.shopType === 'CUSTOMER' && o.shop.shopType === 'CUSTOMER');
    if (!ownership) throw new SupermarketError('Select a verified supermarket or contact support to review this account.', selectedId === undefined ? 409 : 403, 'SUPERMARKET_ACCESS_REQUIRED');
    return { shop: ownership.shop, actor: 'OWNER', ownershipId: ownership.id };
  }
  if (user.userType === 'EMPLOYEE') {
    const membership = await db.shopEmployeeMembership.findFirst({
      where: { employeeId: user.id, shopId: selectedId ?? user.shopId ?? '__no_shop__', status: 'ACTIVE', shop: { shopType: 'CUSTOMER' } },
      include: { shop: true },
    });
    if (!membership) throw new SupermarketError('No active membership for this supermarket.', 403, 'SHOP_MEMBERSHIP_REQUIRED');
    if (feature && (!membership.permissions.includes(feature) || (level !== 'read' && !membership.permissions.includes(`${feature}.${level}`)))) {
      throw new SupermarketError('Your shop owner has not granted this feature access.', 403, 'SHOP_FEATURE_DISABLED');
    }
    return { shop: membership.shop, actor: 'EMPLOYEE', membership };
  }
  throw new SupermarketError('Customer supermarket access required.', 403, 'SUPERMARKET_ACCESS_REQUIRED');
}

/** Legacy /assign is first-shop setup, NEVER a switch or a second-shop creation route.
 * Registration now provisions the first shop atomically. Missing/ambiguous legacy
 * ownership goes to review instead of creating replacement stores at login/setup.
 */
export async function resumeInitialSupermarket(db, user, requestedShopId) {
  if (user.userType !== 'CUSTOMER') throw new SupermarketError('Shop owner access required.', 403, 'OWNER_REQUIRED');
  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Customer" WHERE id = ${user.id} FOR UPDATE`;
    const selection = await resolveSupermarketSelection(tx, user, requestedShopId);
    return selection.shop;
  }, { timeout: 60000 });
}

/** Additional shops require a verified existing owner and a durable request key. */
export async function createAdditionalSupermarket(db, user, body, requestKey) {
  if (user.userType !== 'CUSTOMER') throw new SupermarketError('Only shop owners can create supermarkets.', 403, 'OWNER_REQUIRED');
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const address = typeof body.address === 'string' ? body.address.trim() : '';
  if (!name || name.length > 200 || address.length > 1000) throw new SupermarketError('Enter a shop name (up to 200 characters).', 400, 'INVALID_SUPERMARKET');
  if (typeof requestKey !== 'string' || !/^[a-zA-Z0-9_-]{16,128}$/.test(requestKey)) throw new SupermarketError('A valid creation request key is required.', 400, 'IDEMPOTENCY_KEY_REQUIRED');
  const payloadHash = createHmac('sha256', 'paymi-supermarket-payload-v1').update(JSON.stringify([name, address])).digest('hex');
  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Customer" WHERE id = ${user.id} FOR UPDATE`;
    const receipt = await tx.supermarketCreationReceipt.findUnique({ where: { customerId_requestKey: { customerId: user.id, requestKey } }, include: { shop: true } });
    if (receipt) {
      if (receipt.payloadHash !== payloadHash) throw new SupermarketError('This request was already used with different shop details.', 409, 'IDEMPOTENCY_CONFLICT');
      await resolveSupermarketSelection(tx, user, receipt.shopId);
      return { shop: receipt.shop, replayed: true };
    }
    const ownerships = await tx.supermarketOwnership.findMany({ where: { customerId: user.id, shopType: 'CUSTOMER', shop: { shopType: 'CUSTOMER' } } });
    if (!ownerships.length) throw new SupermarketError('Your existing shop relationships need review before adding another shop. Please contact support.');
    // Unscoped history must be reviewed/backfilled before additional shops can make its origin ambiguous.
    const unresolved = await tx.list.count({ where: { shopId: null, OR: [{ customerId: user.id }, { employee: { shopMemberships: { some: { shopId: { in: ownerships.map((o) => o.shopId) } } } } }] } });
    if (unresolved) throw new SupermarketError('Some existing lists need their original shop verified. Please contact support before adding another shop.');
    const shop = await tx.shop.create({ data: { name, address, mobile: '', shopType: 'CUSTOMER' } });
    await tx.supermarketOwnership.create({ data: { customerId: user.id, shopId: shop.id, source: 'OWNER_ADDITIONAL_SHOP' } });
    const chat = await tx.chat.create({ data: { name: `${name} - Team Chat`, type: 'GROUP', participants: { create: { userId: user.id, userType: 'CUSTOMER', isAdmin: true } } } });
    const readyShop = await tx.shop.update({ where: { id: shop.id }, data: { groupChatId: chat.id } });
    await tx.supermarketCreationReceipt.create({ data: { customerId: user.id, requestKey, payloadHash, shopId: shop.id } });
    return { shop: readyShop, replayed: false };
  }, { timeout: 60000, maxWait: 15000 });
}
