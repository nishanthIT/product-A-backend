import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

/**
 * Middleware to check if customer has active subscription
 */
export const checkSubscriptionStatus = async (req, res, next) => {
  try {
    // Only check for customer requests
    if (!req.user || req.user.userType !== 'CUSTOMER') {
      return next();
    }

    const customer = await prisma.customer.findUnique({
      where: { id: req.user.id },
      select: {
        subscriptionStatus: true,
        trialEndDate: true,
        trialStartDate: true
      }
    });

    if (!customer) {
      return res.status(404).json({ error: 'Customer not found' });
    }

    const now = new Date();
    let isSubscriptionActive = false;
    let subscriptionInfo = {
      status: customer.subscriptionStatus,
      isActive: false,
      message: 'Subscription expired'
    };

    // Check subscription status
    switch (customer.subscriptionStatus) {
      case 'free_trial':
        if (customer.trialEndDate && new Date(customer.trialEndDate) > now) {
          isSubscriptionActive = true;
          const daysRemaining = Math.ceil((new Date(customer.trialEndDate) - now) / (1000 * 60 * 60 * 24));
          subscriptionInfo = {
            status: 'free_trial',
            isActive: true,
            daysRemaining,
            message: `Free trial active - ${daysRemaining} days remaining`
          };
        } else {
          // Auto-update expired trial
          await prisma.customer.update({
            where: { id: req.user.id },
            data: { subscriptionStatus: 'trial_expired' }
          });
          subscriptionInfo.status = 'trial_expired';
        }
        break;
      
      case 'premium':
      case 'pro':
        isSubscriptionActive = true;
        subscriptionInfo = {
          status: customer.subscriptionStatus,
          isActive: true,
          message: 'Premium subscription active'
        };
        break;
      
      case 'trial_expired':
      case 'cancelled':
      default:
        isSubscriptionActive = false;
        subscriptionInfo = {
          status: customer.subscriptionStatus,
          isActive: false,
          message: 'Please upgrade to continue using premium features'
        };
        break;
    }

    // Add subscription info to request
    req.subscriptionInfo = subscriptionInfo;

    // Allow access for active subscriptions
    if (isSubscriptionActive) {
      return next();
    }

    // For expired subscriptions, return subscription required response
    return res.status(402).json({
      error: 'Subscription required',
      subscriptionInfo,
      upgradeUrl: '/upgrade',
      message: 'Your trial has expired. Please upgrade to continue using premium features.'
    });

  } catch (error) {
    console.error('Subscription check error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

/**
 * Middleware for routes that require active subscription (strict)
 */
export const requireActiveSubscription = async (req, res, next) => {
  await checkSubscriptionStatus(req, res, next);
};

/**
 * Middleware for routes that allow limited access (soft check)
 */
export const softSubscriptionCheck = async (req, res, next) => {
  try {
    await checkSubscriptionStatus(req, res, () => {
      // Continue regardless of subscription status, but add info
      next();
    });
  } catch (error) {
    // If subscription check fails, continue anyway but log error
    console.error('Soft subscription check error:', error);
    next();
  }
};