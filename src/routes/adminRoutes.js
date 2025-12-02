import express from 'express';
import { getDashboardOverview, getAllCustomers, getSubscriptionStats, updateCustomerSubscription, processExpiredTrials } from '../controller/dashbord/admin.js';

const router = express.Router();

// Dashboard overview route
router.get('/dashboard', getDashboardOverview);

// Customer management routes
router.get('/customers', getAllCustomers);

// Subscription statistics
router.get('/subscription-stats', getSubscriptionStats);

// Subscription management
router.put('/customers/:customerId/subscription', updateCustomerSubscription);
router.post('/process-expired-trials', processExpiredTrials);

export default router;