import { PrismaClient } from '@prisma/client';
import cron from 'node-cron';
import nodemailer from 'nodemailer';

const prisma = new PrismaClient();

/**
 * Expiry Notification Service
 * 
 * This service runs a daily cron job to check for products that are about to expire
 * and sends notifications based on the category reminder settings.
 * 
 * Each expiry category has reminderDays (e.g., [10, 7, 3]) which specify how many
 * days before expiry to send notifications.
 */

class ExpiryNotificationService {
  constructor() {
    this.cronJob = null;
    this.io = null;
    this.transporter = null;
  }

  /**
   * Inject Socket.IO instance so notifications can be pushed to connected clients.
   */
  setRealtimeContext(io) {
    this.io = io;
  }

  /**
   * Lazily initialize SMTP transporter from env configuration.
   */
  getTransporter() {
    if (this.transporter) return this.transporter;

    const emailUser = (process.env.EMAIL_USER || '').trim();
    const emailPass = (process.env.EMAIL_PASS || '').replace(/\s+/g, '');

    if (!emailUser || !emailPass) {
      console.warn('[Expiry Notification] EMAIL_USER/EMAIL_PASS not configured. Email notifications are disabled.');
      return null;
    }

    const smtpHost = process.env.SMTP_HOST;
    const smtpPort = parseInt(process.env.SMTP_PORT || '0', 10);
    const smtpSecure = String(process.env.SMTP_SECURE || 'false').toLowerCase() === 'true';

    if (smtpHost && smtpPort > 0) {
      this.transporter = nodemailer.createTransport({
        host: smtpHost,
        port: smtpPort,
        secure: smtpSecure,
        auth: {
          user: emailUser,
          pass: emailPass,
        },
      });
      return this.transporter;
    }

    this.transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: emailUser,
        pass: emailPass,
      },
    });

    return this.transporter;
  }

  /**
   * Get all users in a shop that should receive expiry alerts.
   */
  async getShopRecipients(shopId) {
    const [admins, customers, employees] = await Promise.all([
      prisma.admin.findMany({
        where: { shopId },
        select: { id: true, email: true, name: true },
      }),
      prisma.customer.findMany({
        where: { shopId },
        select: { id: true, email: true, name: true },
      }),
      prisma.empolyee.findMany({
        where: { shopId },
        select: { id: true, email: true, name: true },
      }),
    ]);

    const recipients = [];

    for (const admin of admins) {
      recipients.push({ userId: admin.id, userType: 'ADMIN', name: admin.name || 'Admin', email: admin.email });
    }
    for (const customer of customers) {
      recipients.push({ userId: customer.id, userType: 'CUSTOMER', name: customer.name || 'Customer', email: customer.email });
    }
    for (const employee of employees) {
      recipients.push({ userId: employee.id, userType: 'EMPLOYEE', name: employee.name || 'Employee', email: employee.email });
    }

    return recipients;
  }

  /**
   * Push real-time expiry event to connected users.
   */
  async sendRealtimeNotification(recipients, notification) {
    if (!this.io) {
      console.warn('[Expiry Notification] Socket context not set. Real-time notifications skipped.');
      return 0;
    }

    let pushed = 0;

    for (const recipient of recipients) {
      if (!recipient.userId) continue;
      this.io.to(`user_${recipient.userId}`).emit('expiry_notification', {
        ...notification,
        recipientUserType: recipient.userType,
      });
      pushed += 1;
    }

    return pushed;
  }

  /**
   * Send expiry emails to all unique recipient emails.
   */
  async sendEmailNotifications(recipients, notification) {
    const transporter = this.getTransporter();
    if (!transporter) return 0;

    const uniqueEmails = [...new Set(recipients.map((r) => (r.email || '').trim().toLowerCase()).filter(Boolean))];
    if (uniqueEmails.length === 0) return 0;

    const from = process.env.EMAIL_FROM || process.env.EMAIL_USER;

    const emailJobs = uniqueEmails.map((email) =>
      transporter.sendMail({
        from,
        to: email,
        subject: `[Expiry Alert] ${notification.data.productName} expires in ${notification.data.daysUntilExpiry} day(s)`,
        text: [
          `Shop: ${notification.data.shopName}`,
          `Product: ${notification.data.productName}`,
          `Expiry Date: ${new Date(notification.data.expiryDate).toDateString()}`,
          `Days Until Expiry: ${notification.data.daysUntilExpiry}`,
          `Quantity: ${notification.data.quantity}`,
          `Category: ${notification.data.categoryName || 'Default'}`,
          '',
          notification.message,
        ].join('\n'),
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 680px; margin: 0 auto; padding: 20px; color: #1f2937;">
            <h2 style="margin: 0 0 8px 0; color: #0f172a;">Product Expiry Reminder</h2>
            <p style="margin: 0 0 18px 0; color: #475569;">${notification.message}</p>
            <table style="width: 100%; border-collapse: collapse; background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; overflow: hidden;">
              <tr><td style="padding: 10px; border-bottom: 1px solid #e2e8f0;"><strong>Shop</strong></td><td style="padding: 10px; border-bottom: 1px solid #e2e8f0;">${notification.data.shopName}</td></tr>
              <tr><td style="padding: 10px; border-bottom: 1px solid #e2e8f0;"><strong>Product</strong></td><td style="padding: 10px; border-bottom: 1px solid #e2e8f0;">${notification.data.productName}</td></tr>
              <tr><td style="padding: 10px; border-bottom: 1px solid #e2e8f0;"><strong>Expiry Date</strong></td><td style="padding: 10px; border-bottom: 1px solid #e2e8f0;">${new Date(notification.data.expiryDate).toDateString()}</td></tr>
              <tr><td style="padding: 10px; border-bottom: 1px solid #e2e8f0;"><strong>Days Until Expiry</strong></td><td style="padding: 10px; border-bottom: 1px solid #e2e8f0;">${notification.data.daysUntilExpiry}</td></tr>
              <tr><td style="padding: 10px; border-bottom: 1px solid #e2e8f0;"><strong>Quantity</strong></td><td style="padding: 10px; border-bottom: 1px solid #e2e8f0;">${notification.data.quantity}</td></tr>
              <tr><td style="padding: 10px;"><strong>Category</strong></td><td style="padding: 10px;">${notification.data.categoryName || 'Default'}</td></tr>
            </table>
            <p style="margin-top: 16px; color: #64748b; font-size: 13px;">This is an automated expiry reminder from Paymi.</p>
          </div>
        `,
      })
    );

    const results = await Promise.allSettled(emailJobs);
    const successCount = results.filter((r) => r.status === 'fulfilled').length;
    const failedCount = results.length - successCount;

    if (failedCount > 0) {
      console.warn(`[Expiry Notification] ${failedCount} expiry email(s) failed.`);
    }

    return successCount;
  }

  /**
   * Start the cron job that runs daily at 9:00 AM
   */
  start() {
    // Run every day at 9:00 AM
    this.cronJob = cron.schedule('0 9 * * *', async () => {
      console.log('[Expiry Notification] Running daily expiry check...');
      await this.checkAndNotify();
    });

    console.log('[Expiry Notification Service] Started - Running daily at 9:00 AM');
  }

  /**
   * Stop the cron job
   */
  stop() {
    if (this.cronJob) {
      this.cronJob.stop();
      console.log('[Expiry Notification Service] Stopped');
    }
  }

  /**
   * Main function to check products and send notifications
   */
  async checkAndNotify() {
    try {
      const now = new Date();
      now.setHours(0, 0, 0, 0); // Start of today

      // Get all active expiry products that are not disposed
      const expiryProducts = await prisma.expiryProduct.findMany({
        where: {
          isDisposed: false,
          expiryDate: {
            gte: now // Only products that haven't expired yet
          }
        },
        include: {
          product: {
            select: {
              id: true,
              title: true,
              barcode: true
            }
          },
          category: {
            select: {
              id: true,
              name: true,
              reminderDays: true,
              isActive: true
            }
          },
          shop: {
            select: {
              id: true,
              name: true,
              shopType: true
            }
          }
        }
      });

      console.log(`[Expiry Notification] Checking ${expiryProducts.length} products...`);

      let notificationsSent = 0;

      for (const expiryProduct of expiryProducts) {
        // Calculate days until expiry
        const expiryDate = new Date(expiryProduct.expiryDate);
        expiryDate.setHours(0, 0, 0, 0);
        const daysUntilExpiry = Math.ceil((expiryDate - now) / (1000 * 60 * 60 * 24));

        // Get reminder days from category or use default
        let reminderDays = [10, 7, 3]; // Default reminder days
        if (expiryProduct.category && expiryProduct.category.isActive) {
          reminderDays = expiryProduct.category.reminderDays || reminderDays;
        }

        // Check if we should send a notification today
        if (reminderDays.includes(daysUntilExpiry)) {
          // Check if notification was already sent for this reminder day
          const notificationsSentData = expiryProduct.notificationsSent 
            ? (typeof expiryProduct.notificationsSent === 'string' 
                ? JSON.parse(expiryProduct.notificationsSent) 
                : expiryProduct.notificationsSent)
            : {};

          const notificationKey = `${daysUntilExpiry}`;

          if (!notificationsSentData[notificationKey]) {
            // Send notification
            await this.sendNotification(expiryProduct, daysUntilExpiry);

            // Mark notification as sent
            notificationsSentData[notificationKey] = true;

            await prisma.expiryProduct.update({
              where: { id: expiryProduct.id },
              data: {
                notificationsSent: notificationsSentData
              }
            });

            notificationsSent++;
            console.log(
              `[Expiry Notification] Sent notification for "${expiryProduct.product.title}" ` +
              `(${daysUntilExpiry} days) in shop "${expiryProduct.shop.name}"`
            );
          }
        }
      }

      console.log(`[Expiry Notification] Check complete. ${notificationsSent} notification(s) sent.`);
    } catch (error) {
      console.error('[Expiry Notification] Error during check:', error);
    }
  }

  /**
   * Send a notification (placeholder - implement with your notification system)
   * 
   * @param {Object} expiryProduct - The expiry product object
   * @param {number} daysUntilExpiry - Days until the product expires
   */
  async sendNotification(expiryProduct, daysUntilExpiry) {
    const recipients = await this.getShopRecipients(expiryProduct.shopId);
    if (!recipients.length) {
      console.warn(`[Expiry Notification] No recipients found for shop ${expiryProduct.shopId}.`);
      return;
    }

    const notification = {
      type: 'EXPIRY_REMINDER',
      shopId: expiryProduct.shopId,
      productId: expiryProduct.productId,
      expiryProductId: expiryProduct.id,
      title: 'Product Expiry Reminder',
      message: `${expiryProduct.product.title} will expire in ${daysUntilExpiry} day(s)`,
      priority: daysUntilExpiry <= 3 ? 'HIGH' : 'MEDIUM',
      data: {
        shopName: expiryProduct.shop?.name || 'Shop',
        productName: expiryProduct.product.title,
        productBarcode: expiryProduct.product.barcode,
        expiryDate: expiryProduct.expiryDate,
        daysUntilExpiry,
        quantity: expiryProduct.quantity,
        batchNumber: expiryProduct.batchNumber,
        categoryName: expiryProduct.category?.name
      }
    };

    const [pushCount, emailCount] = await Promise.all([
      this.sendRealtimeNotification(recipients, notification),
      this.sendEmailNotifications(recipients, notification),
    ]);

    console.log(
      `[Expiry Notification] Delivered for "${expiryProduct.product.title}": ` +
      `${pushCount} realtime, ${emailCount} email`
    );
  }

  /**
   * Manual trigger for testing (can be called from an API endpoint)
   */
  async triggerManually() {
    console.log('[Expiry Notification] Manual trigger initiated...');
    await this.checkAndNotify();
  }
}

// Export singleton instance
const expiryNotificationService = new ExpiryNotificationService();
export default expiryNotificationService;
