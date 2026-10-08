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
import {
	getCustomerEmployees,
	getListForAdmin,
	getAccessReviews,
	getAssignableShops,
	resolveAccessReview
} from '../controller/dashbord/customerEmployees.js';
import { grantCompanyAccess, updateEmployee } from '../controller/employee.js';
import { isAuthenticated, isAdmin, requireCompanyPermission } from '../middleware/authware.js';
import { COMPANY_PERMISSIONS as P } from '../services/accessControl.js';

// Company administration API. Every route requires an explicit company permission;
// shop owners and shop employees never hold one.
const router = express.Router();
router.use(isAuthenticated);

// Dashboard overview route
router.get('/dashboard', requireCompanyPermission(P.CUSTOMERS_VIEW), getDashboardOverview);

// Customer management routes
router.get('/customers', requireCompanyPermission(P.CUSTOMERS_VIEW), getAllCustomers);
router.delete('/customers/:customerId', requireCompanyPermission(P.CUSTOMERS_MANAGE), deleteCustomerWithRelatedData);

// Customers → Customer details → Employees (shop employees of that customer's shop)
router.get('/customers/:customerId/employees', requireCompanyPermission(P.CUSTOMERS_VIEW), getCustomerEmployees);
router.get('/lists/:listId', requireCompanyPermission(P.CUSTOMERS_VIEW), getListForAdmin);

// Subscription statistics
router.get('/subscription-stats', requireCompanyPermission(P.CUSTOMERS_VIEW), getSubscriptionStats);

// Subscription management
router.put('/customers/:customerId/subscription', requireCompanyPermission(P.CUSTOMERS_MANAGE), updateCustomerSubscription);
router.post('/process-expired-trials', requireCompanyPermission(P.CUSTOMERS_MANAGE), processExpiredTrials);

// Items in User List (deduplicated)
router.get('/list-items', requireCompanyPermission(P.LIST_ITEMS_MANAGE), getListItemsSummary);
router.patch('/list-items/case-barcode', requireCompanyPermission(P.LIST_ITEMS_MANAGE), updateGlobalCaseBarcode);
router.patch('/list-items', requireCompanyPermission(P.LIST_ITEMS_MANAGE), updateListItemDetails);
router.get('/employees/:employeeId/list-item-updates', isAdmin, getEmployeeListItemUpdates);

// Company Staff management
router.post('/staff/grant', requireCompanyPermission(P.STAFF_MANAGE), grantCompanyAccess);
router.patch('/staff/:id/status', requireCompanyPermission(P.STAFF_MANAGE), updateEmployee);

// Employee records flagged by the access migration (company super-admin only)
router.get('/access-reviews', isAdmin, getAccessReviews);
router.get('/access-reviews/assignable-shops', isAdmin, getAssignableShops);
router.post('/access-reviews/:id/resolve', isAdmin, resolveAccessReview);

export default router;