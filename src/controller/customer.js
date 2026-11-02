import { safeLogger } from '../services/safeLogger.js';
const securityLog = safeLogger('controller/customer.js');
import { PrismaClient } from "@prisma/client";
import bcrypt from 'bcryptjs';
import { disconnectUser } from '../services/realtime.js';
const prisma = new PrismaClient();

// Admin privileges do not justify returning password hashes or recovery proofs.
const customerSelect = {
  id: true, name: true, mobile: true, email: true, userType: true, shopId: true,
  earnings: true, subscriptionStatus: true, trialStartDate: true, trialEndDate: true,
  points: true, defaultSupermarketId: true,
};
const validPassword = value => typeof value === 'string' && value.length >= 8 && Buffer.byteLength(value, 'utf8') <= 72;
const validText = (value, maximum) => typeof value === 'string' && value.trim().length > 0 && value.length <= maximum;
const validEmail = value => validText(value, 254) && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
const validId = value => /^[1-9]\d*$/.test(String(value)) && Number.isSafeInteger(Number(value));
const emailInUse = async (email, exceptId) => {
  const matches = await Promise.all([
    prisma.admin.findFirst({ where: { email: { equals: email, mode: 'insensitive' } }, select: { id: true } }),
    prisma.empolyee.findFirst({ where: { email: { equals: email, mode: 'insensitive' } }, select: { id: true } }),
    prisma.customer.findFirst({ where: { email: { equals: email, mode: 'insensitive' }, ...(exceptId && { id: { not: exceptId } }) }, select: { id: true } }),
  ]);
  return matches.some(Boolean);
};

const addCustomer = async (req, res) => {
  try {
    const { name, mobile, email, password } = req.body || {};
    if (!validText(name, 200) || !validText(mobile, 50) || !validEmail(email) || !validPassword(password)) {
      return res.status(400).json({ error: 'Enter a name, mobile, email and password of 8 characters minimum and 72 UTF-8 bytes maximum.' });
    }
    const normalizedEmail = email.trim().toLowerCase();
    if (await emailInUse(normalizedEmail)) return res.status(409).json({ error: 'An account with this email already exists.' });
    const customer = await prisma.customer.create({
      data: {
        name: name.trim(),
        mobile: mobile.trim(),
        email: normalizedEmail,
        password: await bcrypt.hash(password, 12),
      },
      select: customerSelect,
    });
    res.json(customer);
  } catch (error) {
    securityLog.error(error);
    res.status(500).json({ error: "Internal server error." });
  }
};

const updateCustomer = async (req, res) => {
  try {
    const { id, name, mobile, email, password } = req.body || {};
    if (!validId(id) || (name !== undefined && !validText(name, 200)) || (mobile !== undefined && !validText(mobile, 50))
        || (email !== undefined && !validEmail(email)) || (password !== undefined && password !== '' && !validPassword(password))) {
      return res.status(400).json({ error: 'Invalid customer details or password.' });
    }
    const normalizedEmail = email?.trim().toLowerCase();
    if (normalizedEmail && await emailInUse(normalizedEmail, Number(id))) return res.status(409).json({ error: 'An account with this email already exists.' });
    const hashedPassword = password ? await bcrypt.hash(password, 12) : null;
    const customer = await prisma.customer.update({
      where: {
        id: Number(id),
      },
      data: {
        ...(name !== undefined && { name: name.trim() }),
        ...(mobile !== undefined && { mobile: mobile.trim() }),
        ...(normalizedEmail && { email: normalizedEmail }),
        ...(hashedPassword && { password: hashedPassword, sessionVersion: { increment: 1 }, resetToken: null, resetTokenExpiry: null }),
      },
      select: customerSelect,
    });
    if (hashedPassword) disconnectUser('CUSTOMER', Number(id));
    res.json(customer);
  } catch (error) {
    securityLog.error(error);
    res.status(500).json({ error: "Internal server error." });
  }
};

const deleteCustomer = async (req, res) => {
  try {
    if (!validId(req.params.id)) return res.status(400).json({ error: 'Invalid customer ID.' });
    const id = Number(req.params.id);
    
    // First, delete all chat-related data for this customer
    // Delete message read receipts
    await prisma.messageRead.deleteMany({
      where: {
        userId: id,
        userType: 'CUSTOMER'
      }
    });
    
    // Delete messages sent by this customer
    await prisma.message.deleteMany({
      where: {
        senderId: id,
        senderType: 'CUSTOMER'
      }
    });
    
    // Delete chat participations
    await prisma.chatParticipant.deleteMany({
      where: {
        userId: id,
        userType: 'CUSTOMER'
      }
    });
    
    // Delete ProductAtShop records managed by this customer (if any)
    await prisma.productAtShop.updateMany({
      where: {
        userId: id
      },
      data: {
        userId: null
      }
    });
    
    // Now delete the customer (Lists, ListProducts, and PriceReports will cascade)
    const customer = await prisma.customer.delete({
      where: {
        id: id,
      },
      select: customerSelect,
    });
    
    securityLog.log(`✅ Customer ${id} and all related data deleted successfully`);
    res.json({ 
      success: true, 
      message: 'Customer and all related data deleted successfully',
      customer 
    });
  } catch (error) {
    securityLog.error('Error deleting customer:', error);
    res.status(500).json({ error: "Internal server error." });
  }
};

const getCustomer = async (req, res) => {
  try {
    if (!validId(req.params.id)) return res.status(400).json({ error: 'Invalid customer ID.' });
    const id = Number(req.params.id);
    const customer = await prisma.customer.findUnique({
      where: {
        id: id,
      },
      select: customerSelect,
    });

    res.json(customer);
  } catch (error) {
    securityLog.error(error);
    res.status(500).json({ error: "Internal server error." });
  }
};

export { addCustomer, updateCustomer, deleteCustomer, getCustomer };
