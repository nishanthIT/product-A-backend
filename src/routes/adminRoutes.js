import express from 'express';
import {
	getDashboardOverview,
	getAllCustomers,
	getSubscriptionStats,
	updateCustomerSubscription,
	deleteCustomerWithRelatedData,
	processExpiredTrials,
	getListItemsSummary,
	updateGlobalCaseBarcode,
	updateListItemDetails,
	getEmployeeListItemUpdates
} from '../controller/dashbord/admin.js';
import { isAuthenticated, isAdmin, isEmployee } from '../middleware/authware.js';

const router = express.Router();

// Dashboard overview route
router.get('/dashboard', getDashboardOverview);

// Customer management routes
router.get('/customers', getAllCustomers);
router.delete('/customers/:customerId', deleteCustomerWithRelatedData);

// Subscription statistics
router.get('/subscription-stats', getSubscriptionStats);

// Subscription management
router.put('/customers/:customerId/subscription', updateCustomerSubscription);
router.post('/process-expired-trials', processExpiredTrials);

// Items in User List (deduplicated)
router.get('/list-items', isAuthenticated, isEmployee, getListItemsSummary);
router.patch('/list-items/case-barcode', isAuthenticated, isEmployee, updateGlobalCaseBarcode);
router.patch('/list-items', isAuthenticated, isEmployee, updateListItemDetails);
router.get('/employees/:employeeId/list-item-updates', isAuthenticated, isAdmin, getEmployeeListItemUpdates);

export default router;