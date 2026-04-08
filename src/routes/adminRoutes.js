import express from 'express';
import {
	getDashboardOverview,
	getAllCustomers,
	getSubscriptionStats,
	updateCustomerSubscription,
	processExpiredTrials,
	getListItemsSummary,
	updateGlobalCaseBarcode
} from '../controller/dashbord/admin.js';
import { isAuthenticated, isAdmin } from '../middleware/authware.js';

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

// Items in User List (deduplicated)
router.get('/list-items', isAuthenticated, isAdmin, getListItemsSummary);
router.patch('/list-items/case-barcode', isAuthenticated, isAdmin, updateGlobalCaseBarcode);

export default router;