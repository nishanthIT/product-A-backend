# Security endpoint inventory

Updated 29 October 2026. Static declarations plus child router mounts; source references are authoritative for dynamic routes. Global public-IP protection, request bounds, trusted-origin/CSRF checks and response headers apply at the server boundary. Authentication reloads memberships and installs account/session/resource controls. No subscription paywall is introduced: this release intentionally remains free.

| Method | Endpoint | Access / sensitivity | Resource and extraction risk | Source |
|---|---|---|---|---|
| POST | `/api/account-deletion/request-with-password` | Public recovery/deletion proof; high sensitivity | High; password/proof quotas | `accountDeletionRoutes.js:12` |
| POST | `/api/account-deletion/request` | Authenticated; tenant/resource scope | Medium; bounded requests | `accountDeletionRoutes.js:27` |
| POST | `/api/account-deletion/status` | Public recovery/deletion proof; high sensitivity | High; password/proof quotas | `accountDeletionRoutes.js:37` |
| GET | `/api/account-deletion/queue` | Company permission or Admin, per route; high | High; catalogue/directory or administrative operation | `accountDeletionRoutes.js:45` |
| GET | `/api/admin/dashboard` | Company permission or Admin, per route; high | High; private directory and administrative writes | `adminRoutes.js:33` |
| GET | `/api/admin/customers` | Company permission or Admin, per route; high | High; private directory and administrative writes | `adminRoutes.js:36` |
| DELETE | `/api/admin/customers/:customerId` | Company permission or Admin, per route; high | High; private directory and administrative writes | `adminRoutes.js:37` |
| GET | `/api/admin/customers/:customerId/employees` | Company permission or Admin, per route; high | High; private directory and administrative writes | `adminRoutes.js:40` |
| GET | `/api/admin/lists/:listId` | Company permission or Admin, per route; high | High; private directory and administrative writes | `adminRoutes.js:41` |
| GET | `/api/admin/subscription-stats` | Company permission or Admin, per route; high | High; private directory and administrative writes | `adminRoutes.js:44` |
| PUT | `/api/admin/customers/:customerId/subscription` | Company permission or Admin, per route; high | High; private directory and administrative writes | `adminRoutes.js:47` |
| POST | `/api/admin/process-expired-trials` | Company permission or Admin, per route; high | High; private directory and administrative writes | `adminRoutes.js:48` |
| GET | `/api/admin/list-items` | Company permission or Admin, per route; high | High; private directory and administrative writes | `adminRoutes.js:51` |
| PATCH | `/api/admin/list-items/case-barcode` | Company permission or Admin, per route; high | High; private directory and administrative writes | `adminRoutes.js:52` |
| PATCH | `/api/admin/list-items` | Company permission or Admin, per route; high | High; private directory and administrative writes | `adminRoutes.js:53` |
| GET | `/api/admin/employees/:employeeId/list-item-updates` | Company permission or Admin, per route; high | High; private directory and administrative writes | `adminRoutes.js:54` |
| POST | `/api/admin/staff/grant` | Company permission or Admin, per route; high | High; private directory and administrative writes | `adminRoutes.js:57` |
| PATCH | `/api/admin/staff/:id/status` | Company permission or Admin, per route; high | High; private directory and administrative writes | `adminRoutes.js:58` |
| GET | `/api/admin/access-reviews` | Company permission or Admin, per route; high | High; private directory and administrative writes | `adminRoutes.js:61` |
| GET | `/api/admin/access-reviews/assignable-shops` | Company permission or Admin, per route; high | High; private directory and administrative writes | `adminRoutes.js:62` |
| POST | `/api/admin/access-reviews/:id/resolve` | Company permission or Admin, per route; high | High; private directory and administrative writes | `adminRoutes.js:63` |
| GET | `/api/admin/supermarkets` | Company permission or Admin, per route; high | High; private directory and administrative writes | `adminSupermarketRoutes.js:11` |
| GET | `/api/admin/supermarkets/:id` | Company permission or Admin, per route; high | High; private directory and administrative writes | `adminSupermarketRoutes.js:33` |
| GET | `/api/advertisements` | Public active marketing; all/drafts require Admin | Medium; pages capped at100, shared-IP quota | `advertisements.js:79` |
| POST | `/api/advertisements` | Company permission or Admin, per route; high | High; authenticated bounded content-validated uploads or writes | `advertisements.js:98` |
| PUT | `/api/advertisements/:id` | Company permission or Admin, per route; high | High; authenticated bounded content-validated uploads or writes | `advertisements.js:126` |
| DELETE | `/api/advertisements/:id` | Company permission or Admin, per route; high | High; authenticated bounded content-validated uploads or writes | `advertisements.js:154` |
| GET | `/api/age-restricted-records` | Authenticated; tenant/resource scope | Medium; bounded requests | `ageRestrictedRecordRoutes.js:48` |
| POST | `/api/age-restricted-records` | Authenticated; tenant/resource scope | Medium; bounded requests | `ageRestrictedRecordRoutes.js:131` |
| GET | `/api/age-restriction-records/categories` | Authenticated; tenant/resource scope | Medium; bounded requests | `ageRestrictionRecordRoutes.js:145` |
| GET | `/api/age-restriction-records/products` | Authenticated; tenant/resource scope | High; catalogue/price extraction budgets and size bounds | `ageRestrictionRecordRoutes.js:165` |
| GET | `/api/age-restriction-records` | Authenticated; tenant/resource scope | Medium; bounded requests | `ageRestrictionRecordRoutes.js:189` |
| POST | `/api/age-restriction-records` | Authenticated; tenant/resource scope | High; authenticated bounded content-validated uploads or writes | `ageRestrictionRecordRoutes.js:227` |
| PUT | `/api/age-restriction-records/:id` | Authenticated; tenant/resource scope | High; authenticated bounded content-validated uploads or writes | `ageRestrictionRecordRoutes.js:276` |
| DELETE | `/api/age-restriction-records/:id` | Authenticated; tenant/resource scope | High; authenticated bounded content-validated uploads or writes | `ageRestrictionRecordRoutes.js:341` |
| POST | `/api/auth/login` | Public authentication flow; high sensitivity | High; password/mail/OTP quotas | `authRoutes.js:130` |
| POST | `/api/auth/register/send-otp` | Public authentication flow; high sensitivity | High; password/mail/OTP quotas | `authRoutes.js:131` |
| POST | `/api/auth/register` | Public authentication flow; high sensitivity | High; password/mail/OTP quotas | `authRoutes.js:132` |
| GET | `/api/auth/me` | Authenticated; tenant/resource scope | Medium; bounded requests | `authRoutes.js:133` |
| POST | `/api/auth/logout` | Public authentication flow; high sensitivity | High; password/mail/OTP quotas | `authRoutes.js:134` |
| POST | `/api/auth/extend-trial` | Authenticated; tenant/resource scope | Medium; bounded requests | `authRoutes.js:135` |
| POST | `/api/auth/forgot-password` | Public authentication flow; high sensitivity | High; password/mail/OTP quotas | `authRoutes.js:136` |
| POST | `/api/auth/reset-password` | Public authentication flow; high sensitivity | High; password/mail/OTP quotas | `authRoutes.js:137` |
| GET | `/api/image/:barcode` | Public product artwork only | Medium; safe barcode paths, fixed extensions | `authRoutes.js:139` |
| GET | `/api/filterProducts` | Company permission or Admin, per route; high | High; catalogue/price extraction budgets and size bounds | `authRoutes.js:147` |
| GET | `/api/productFilters` | Company permission or Admin, per route; high | High; catalogue/price extraction budgets and size bounds | `authRoutes.js:148` |
| POST | `/api/addProduct` | Company permission or Admin, per route; high | High; catalogue/price extraction budgets and size bounds | `authRoutes.js:151` |
| PUT | `/api/editProduct/:id` | Company permission or Admin, per route; high | High; catalogue/price extraction budgets and size bounds | `authRoutes.js:152` |
| GET | `/api/getProductByBarcode/:barcode` | Company permission or Admin, per route; high | High; catalogue/price extraction budgets and size bounds | `authRoutes.js:153` |
| GET | `/api/getProductById/:id` | Company permission or Admin, per route; high | High; catalogue/price extraction budgets and size bounds | `authRoutes.js:154` |
| DELETE | `/api/deleteProduct/:id` | Company permission or Admin, per route; high | High; catalogue/price extraction budgets and size bounds | `authRoutes.js:155` |
| GET | `/api/products/barcode/:barcode` | Authenticated; tenant/resource scope | High; catalogue/price extraction budgets and size bounds | `authRoutes.js:158` |
| GET | `/api/products/search` | Authenticated; tenant/resource scope | High; catalogue/price extraction budgets and size bounds | `authRoutes.js:159` |
| POST | `/api/products/quick-add` | Authenticated; tenant/resource scope | High; catalogue/price extraction budgets and size bounds | `authRoutes.js:160` |
| GET | `/api/products/pending-submissions` | Company permission or Admin, per route; high | High; catalogue/price extraction budgets and size bounds | `authRoutes.js:161` |
| PUT | `/api/products/pending-submissions/:id/approve` | Company permission or Admin, per route; high | High; catalogue/price extraction budgets and size bounds | `authRoutes.js:162` |
| GET | `/api/products/:id/pack-options` | Authenticated; tenant/resource scope | High; catalogue/price extraction budgets and size bounds | `authRoutes.js:163` |
| GET | `/api/products/:id/price-tiers` | Authenticated; tenant/resource scope | High; catalogue/price extraction budgets and size bounds | `authRoutes.js:164` |
| GET | `/api/products/:id` | Authenticated; tenant/resource scope | High; catalogue/price extraction budgets and size bounds | `authRoutes.js:165` |
| POST | `/api/addShop` | Company permission or Admin, per route; high | High; catalogue/directory or administrative operation | `authRoutes.js:169` |
| PUT | `/api/editShop/:id` | Company permission or Admin, per route; high | High; catalogue/directory or administrative operation | `authRoutes.js:170` |
| GET | `/api/getAllshop` | Company permission or Admin, per route; high | High; catalogue/directory or administrative operation | `authRoutes.js:171` |
| GET | `/api/getshop/:id` | Company permission or Admin, per route; high | High; catalogue/directory or administrative operation | `authRoutes.js:172` |
| DELETE | `/api/shops/:id` | Company permission or Admin, per route; high | High; catalogue/directory or administrative operation | `authRoutes.js:173` |
| POST | `/api/addProductAtShop` | Authenticated; tenant/resource scope | High; catalogue/price extraction budgets and size bounds | `authRoutes.js:185` |
| POST | `/api/addProductAtShopifExistAtProduct` | Company permission or Admin, per route; high | High; catalogue/price extraction budgets and size bounds | `authRoutes.js:209` |
| GET | `/api/shop/:shopId/products` | Company permission or Admin, per route; high | High; catalogue/price extraction budgets and size bounds | `authRoutes.js:227` |
| GET | `/api/shop/:shopId/product-ids` | Company permission or Admin, per route; high | High; catalogue/price extraction budgets and size bounds | `authRoutes.js:230` |
| GET | `/api/shop/:shopId/filters` | Company permission or Admin, per route; high | High; catalogue/directory or administrative operation | `authRoutes.js:233` |
| POST | `/api/shop/transfer-products` | Company permission or Admin, per route; high | High; catalogue/price extraction budgets and size bounds | `authRoutes.js:236` |
| PUT | `/api/shop/:shopId/updateProductPrice` | Company permission or Admin, per route; high | High; catalogue/price extraction budgets and size bounds | `authRoutes.js:239` |
| GET | `/api/shop/:shopId/product/:productId/price-tiers` | Company permission or Admin, per route; high | High; catalogue/price extraction budgets and size bounds | `authRoutes.js:242` |
| PUT | `/api/shop/:shopId/product/:productId/price-tiers` | Company permission or Admin, per route; high | High; catalogue/price extraction budgets and size bounds | `authRoutes.js:243` |
| GET | `/api/shop/:shopId/searchProducts` | Company permission or Admin, per route; high | High; catalogue/price extraction budgets and size bounds | `authRoutes.js:246` |
| DELETE | `/api/shop/:shopId/product` | Company permission or Admin, per route; high | High; catalogue/price extraction budgets and size bounds | `authRoutes.js:249` |
| PUT | `/api/shop/:shopId/product/:productId/stock` | Company permission or Admin, per route; high | High; catalogue/price extraction budgets and size bounds | `authRoutes.js:252` |
| GET | `/api/product-promotions/:shopId/:productId` | Company permission or Admin, per route; high | High; catalogue/price extraction budgets and size bounds | `authRoutes.js:326` |
| POST | `/api/product-promotions/:shopId/:productId` | Company permission or Admin, per route; high | High; authenticated bounded content-validated uploads or writes | `authRoutes.js:375` |
| DELETE | `/api/product-promotions/:promotionId` | Company permission or Admin, per route; high | High; authenticated bounded content-validated uploads or writes | `authRoutes.js:430` |
| POST | `/api/product-promotions/:shopId/:productId/apply` | Company permission or Admin, per route; high | High; authenticated bounded content-validated uploads or writes | `authRoutes.js:461` |
| GET | `/api/employee/dashboard-data` | Authenticated; tenant/resource scope | Medium; bounded requests | `authRoutes.js:492` |
| GET | `/api/employee/list-item-updates` | Authenticated; tenant/resource scope | Medium; bounded requests | `authRoutes.js:493` |
| GET | `/api/admin/dashboard/overview` | Company permission or Admin, per route; high | High; catalogue/directory or administrative operation | `authRoutes.js:494` |
| POST | `/api/addEmployee` | Company permission or Admin, per route; high | High; catalogue/directory or administrative operation | `authRoutes.js:499` |
| PUT | `/api/updateEmployee/:id` | Company permission or Admin, per route; high | High; catalogue/directory or administrative operation | `authRoutes.js:500` |
| DELETE | `/api/deleteEmployee/:id` | Company permission or Admin, per route; high | High; catalogue/directory or administrative operation | `authRoutes.js:501` |
| GET | `/api/getEmployee/:id` | Company permission or Admin, per route; high | High; catalogue/directory or administrative operation | `authRoutes.js:502` |
| POST | `/api/addCustomer` | Company permission or Admin, per route; high | High; catalogue/directory or administrative operation | `authRoutes.js:505` |
| PUT | `/api/updateCustomer` | Company permission or Admin, per route; high | High; catalogue/directory or administrative operation | `authRoutes.js:506` |
| DELETE | `/api/deleteCustomer/:id` | Company permission or Admin, per route; high | High; catalogue/directory or administrative operation | `authRoutes.js:507` |
| GET | `/api/getCustomer/:id` | Company permission or Admin, per route; high | High; catalogue/directory or administrative operation | `authRoutes.js:508` |
| GET | `/api/getallemploy` | Company permission or Admin, per route; high | High; catalogue/directory or administrative operation | `authRoutes.js:509` |
| GET | `/api/getHourlyProductAdds/:employeeId` | Company permission or Admin, per route; high | High; catalogue/price extraction budgets and size bounds | `authRoutes.js:512` |
| GET | `/api/lists` | Authenticated; tenant/resource scope | Medium; bounded requests | `authRoutes.js:517` |
| POST | `/api/lists` | Authenticated; tenant/resource scope | Medium; bounded requests | `authRoutes.js:518` |
| POST | `/api/lists/addProduct` | Authenticated; tenant/resource scope | High; catalogue/price extraction budgets and size bounds | `authRoutes.js:519` |
| DELETE | `/api/lists/removeProduct` | Authenticated; tenant/resource scope | High; catalogue/price extraction budgets and size bounds | `authRoutes.js:520` |
| GET | `/api/lists/:listId/lowest-prices` | Authenticated; tenant/resource scope | High; catalogue/price extraction budgets and size bounds | `authRoutes.js:521` |
| PUT | `/api/lists/:listId/rename` | Authenticated; tenant/resource scope | Medium; bounded requests | `authRoutes.js:523` |
| DELETE | `/api/lists/:listId/untrack` | Authenticated; tenant/resource scope | Medium; bounded requests | `authRoutes.js:524` |
| DELETE | `/api/lists/:listId` | Authenticated; tenant/resource scope | Medium; bounded requests | `authRoutes.js:525` |
| POST | `/api/shop/:shopId/bundle-promotions` | Company permission or Admin, per route; high | High; authenticated bounded content-validated uploads or writes | `authRoutes.js:529` |
| GET | `/api/shop/:shopId/bundle-promotions` | Company permission or Admin, per route; high | High; catalogue/directory or administrative operation | `authRoutes.js:530` |
| GET | `/api/bundle-promotions/:promotionId` | Company permission or Admin, per route; high | High; catalogue/directory or administrative operation | `authRoutes.js:531` |
| PUT | `/api/bundle-promotions/:promotionId` | Company permission or Admin, per route; high | High; authenticated bounded content-validated uploads or writes | `authRoutes.js:532` |
| DELETE | `/api/bundle-promotions/:promotionId` | Company permission or Admin, per route; high | High; authenticated bounded content-validated uploads or writes | `authRoutes.js:533` |
| GET | `/api/shop/:shopId/product/:productId/bundle-offers` | Authenticated; tenant/resource scope | High; catalogue/price extraction budgets and size bounds | `authRoutes.js:536` |
| POST | `/api/shop/:shopId/check-cart-offers` | Authenticated; tenant/resource scope | Medium; bounded requests | `authRoutes.js:537` |
| GET | `/api/categories` | Authenticated; tenant/resource scope | Medium; bounded requests | `categoryRoutes.js:16` |
| GET | `/api/categories/search` | Authenticated; tenant/resource scope | Medium; bounded requests | `categoryRoutes.js:17` |
| GET | `/api/categories/product-categories` | Authenticated; tenant/resource scope | High; catalogue/price extraction budgets and size bounds | `categoryRoutes.js:18` |
| POST | `/api/categories` | Authenticated; tenant/resource scope | Medium; bounded requests | `categoryRoutes.js:21` |
| PUT | `/api/categories/:id` | Company permission or Admin, per route; high | High; catalogue/directory or administrative operation | `categoryRoutes.js:24` |
| DELETE | `/api/categories/:id` | Company permission or Admin, per route; high | High; catalogue/directory or administrative operation | `categoryRoutes.js:25` |
| POST | `/api/categories/seed` | Company permission or Admin, per route; high | High; catalogue/directory or administrative operation | `categoryRoutes.js:26` |
| GET | `/api/certificates` | Authenticated; tenant/resource scope | Medium; bounded requests | `certificateRoutes.js:229` |
| GET | `/api/certificates/alerts` | Authenticated; tenant/resource scope | Medium; bounded requests | `certificateRoutes.js:272` |
| GET | `/api/certificates/:id` | Authenticated; tenant/resource scope | Medium; bounded requests | `certificateRoutes.js:298` |
| GET | `/api/certificates/:id/image` | Authenticated; tenant/resource scope | Medium; bounded requests | `certificateRoutes.js:329` |
| POST | `/api/certificates` | Authenticated; tenant/resource scope | High; authenticated bounded content-validated uploads or writes | `certificateRoutes.js:367` |
| PUT | `/api/certificates/:id` | Authenticated; tenant/resource scope | High; authenticated bounded content-validated uploads or writes | `certificateRoutes.js:436` |
| DELETE | `/api/certificates/:id` | Authenticated; tenant/resource scope | High; authenticated bounded content-validated uploads or writes | `certificateRoutes.js:514` |
| GET | `/api/chat` | Authenticated; tenant/resource scope | Medium; bounded requests | `chat.js:34` |
| GET | `/api/chat/users` | Authenticated; tenant/resource scope | Medium; bounded requests | `chat.js:37` |
| POST | `/api/chat` | Authenticated; tenant/resource scope | Medium; bounded requests | `chat.js:40` |
| GET | `/api/chat/:chatId` | Authenticated; tenant/resource scope | Medium; bounded requests | `chat.js:43` |
| POST | `/api/chat/message` | Authenticated; tenant/resource scope | Medium; bounded requests | `chat.js:46` |
| POST | `/api/chat/read` | Authenticated; tenant/resource scope | Medium; bounded requests | `chat.js:49` |
| DELETE | `/api/chat/message/:messageId` | Authenticated; tenant/resource scope | Medium; bounded requests | `chat.js:52` |
| DELETE | `/api/chat/:chatId` | Authenticated; tenant/resource scope | Medium; bounded requests | `chat.js:55` |
| POST | `/api/chat/upload` | Authenticated; tenant/resource scope | High; authenticated bounded content-validated uploads or writes | `chat.js:58` |
| GET | `/api/chat-safety` | Authenticated; tenant/resource scope | Medium; bounded requests | `chatSafetyRoutes.js:16` |
| POST | `/api/chat-safety/accept` | Authenticated; tenant/resource scope | Medium; bounded requests | `chatSafetyRoutes.js:22` |
| POST | `/api/chat-safety/report` | Authenticated; tenant/resource scope | Medium; bounded requests | `chatSafetyRoutes.js:23` |
| POST | `/api/chat-safety/block` | Authenticated; tenant/resource scope | Medium; bounded requests | `chatSafetyRoutes.js:52` |
| DELETE | `/api/chat-safety/block/:id` | Authenticated; tenant/resource scope | Medium; bounded requests | `chatSafetyRoutes.js:65` |
| GET | `/api/cleaning/areas` | Authenticated; tenant/resource scope | Medium; bounded requests | `cleaningRoutes.js:28` |
| POST | `/api/cleaning/areas` | Authenticated; tenant/resource scope | Medium; bounded requests | `cleaningRoutes.js:57` |
| POST | `/api/cleaning/areas/bulk` | Authenticated; tenant/resource scope | Medium; bounded requests | `cleaningRoutes.js:91` |
| PUT | `/api/cleaning/areas/:id` | Authenticated; tenant/resource scope | Medium; bounded requests | `cleaningRoutes.js:131` |
| DELETE | `/api/cleaning/areas/:id` | Authenticated; tenant/resource scope | Medium; bounded requests | `cleaningRoutes.js:173` |
| GET | `/api/cleaning/today` | Authenticated; tenant/resource scope | Medium; bounded requests | `cleaningRoutes.js:206` |
| POST | `/api/cleaning/complete/:areaId` | Authenticated; tenant/resource scope | Medium; bounded requests | `cleaningRoutes.js:284` |
| GET | `/api/cleaning/history` | Authenticated; tenant/resource scope | Medium; bounded requests | `cleaningRoutes.js:365` |
| DELETE | `/api/cleaning/undo/:areaId` | Authenticated; tenant/resource scope | Medium; bounded requests | `cleaningRoutes.js:446` |
| GET | `/api/products/:id/compare` | Authenticated; tenant/resource scope | High; catalogue/price extraction budgets and size bounds | `compareRoutes.js:132` |
| GET | `/api/employees` | Authenticated; tenant/resource scope | Medium; bounded requests | `employeeRoutes.js:209` |
| GET | `/api/employees/assignable` | Authenticated; tenant/resource scope | Medium; bounded requests | `employeeRoutes.js:242` |
| POST | `/api/employees/assign` | Authenticated; tenant/resource scope | Medium; bounded requests | `employeeRoutes.js:252` |
| POST | `/api/employees` | Authenticated; tenant/resource scope | Medium; bounded requests | `employeeRoutes.js:281` |
| PUT | `/api/employees/:id` | Authenticated; tenant/resource scope | Medium; bounded requests | `employeeRoutes.js:364` |
| PATCH | `/api/employees/:id/status` | Authenticated; tenant/resource scope | Medium; bounded requests | `employeeRoutes.js:437` |
| DELETE | `/api/employees/:id` | Authenticated; tenant/resource scope | Medium; bounded requests | `employeeRoutes.js:468` |
| GET | `/api/employees/:id/lists` | Authenticated; tenant/resource scope | Medium; bounded requests | `employeeRoutes.js:485` |
| GET | `/api/expiry` | Authenticated; tenant/resource scope | Medium; bounded requests | `expiryRoutes.js:21` |
| POST | `/api/expiry` | Authenticated; tenant/resource scope | Medium; bounded requests | `expiryRoutes.js:153` |
| PUT | `/api/expiry/:id` | Authenticated; tenant/resource scope | Medium; bounded requests | `expiryRoutes.js:248` |
| DELETE | `/api/expiry/:id` | Authenticated; tenant/resource scope | Medium; bounded requests | `expiryRoutes.js:325` |
| GET | `/api/expiry/notifications` | Authenticated; tenant/resource scope | Medium; bounded requests | `expiryRoutes.js:359` |
| GET | `/api/expiry/search-product` | Authenticated; tenant/resource scope | High; catalogue/price extraction budgets and size bounds | `expiryRoutes.js:459` |
| POST | `/api/expiry/trigger-notifications` | Authenticated; tenant/resource scope | Medium; bounded requests | `expiryRoutes.js:504` |
| GET | `/api/expiry/categories` | Authenticated; tenant/resource scope | Medium; bounded requests | `expiryRoutes.js:529` |
| POST | `/api/expiry/categories` | Authenticated; tenant/resource scope | Medium; bounded requests | `expiryRoutes.js:567` |
| PUT | `/api/expiry/categories/:id` | Authenticated; tenant/resource scope | Medium; bounded requests | `expiryRoutes.js:622` |
| DELETE | `/api/expiry/categories/:id` | Authenticated; tenant/resource scope | Medium; bounded requests | `expiryRoutes.js:686` |
| GET | `/api/fridges` | Authenticated; tenant/resource scope | Medium; bounded requests | `fridgeRoutes.js:65` |
| POST | `/api/fridges` | Authenticated; tenant/resource scope | Medium; bounded requests | `fridgeRoutes.js:116` |
| PUT | `/api/fridges/:id` | Authenticated; tenant/resource scope | Medium; bounded requests | `fridgeRoutes.js:192` |
| DELETE | `/api/fridges/:id` | Authenticated; tenant/resource scope | Medium; bounded requests | `fridgeRoutes.js:300` |
| GET | `/api/fridges/:id/logs` | Authenticated; tenant/resource scope | Medium; bounded requests | `fridgeRoutes.js:333` |
| POST | `/api/fridges/:id/logs` | Authenticated; tenant/resource scope | Medium; bounded requests | `fridgeRoutes.js:435` |
| GET | `/api/fridges/all-logs` | Authenticated; tenant/resource scope | Medium; bounded requests | `fridgeRoutes.js:571` |
| GET | `/api/fridges/today-status` | Authenticated; tenant/resource scope | Medium; bounded requests | `fridgeRoutes.js:733` |
| GET | `/api/incidents` | Authenticated; tenant/resource scope | Medium; bounded requests | `incidentRoutes.js:99` |
| POST | `/api/incidents` | Authenticated; tenant/resource scope | High; authenticated bounded content-validated uploads or writes | `incidentRoutes.js:163` |
| PUT | `/api/incidents/:id` | Authenticated; tenant/resource scope | High; authenticated bounded content-validated uploads or writes | `incidentRoutes.js:223` |
| DELETE | `/api/incidents/:id` | Authenticated; tenant/resource scope | High; authenticated bounded content-validated uploads or writes | `incidentRoutes.js:305` |
| GET | `/api/lists` | Authenticated; tenant/resource scope | Medium; bounded requests | `listRoutes.js:39` |
| GET | `/api/lists/shop/all` | Authenticated; tenant/resource scope | Medium; bounded requests | `listRoutes.js:125` |
| GET | `/api/lists/out-of-stock` | Authenticated; tenant/resource scope | Medium; bounded requests | `listRoutes.js:174` |
| GET | `/api/lists/:id` | Authenticated; tenant/resource scope | Medium; bounded requests | `listRoutes.js:180` |
| POST | `/api/lists` | Authenticated; tenant/resource scope | Medium; bounded requests | `listRoutes.js:293` |
| POST | `/api/lists/addProduct` | Authenticated; tenant/resource scope | High; catalogue/price extraction budgets and size bounds | `listRoutes.js:362` |
| PUT | `/api/lists/updateQuantity` | Authenticated; tenant/resource scope | Medium; bounded requests | `listRoutes.js:475` |
| PUT | `/api/lists/togglePurchased` | Authenticated; tenant/resource scope | Medium; bounded requests | `listRoutes.js:587` |
| PUT | `/api/lists/toggleUrgent` | Authenticated; tenant/resource scope | Medium; bounded requests | `listRoutes.js:717` |
| PUT | `/api/lists/changeShop` | Authenticated; tenant/resource scope | Medium; bounded requests | `listRoutes.js:808` |
| PUT | `/api/lists/moveToList` | Authenticated; tenant/resource scope | Medium; bounded requests | `listRoutes.js:1017` |
| PUT | `/api/lists/markOutOfStock` | Authenticated; tenant/resource scope | Medium; bounded requests | `listRoutes.js:1053` |
| DELETE | `/api/lists/removeProduct` | Authenticated; tenant/resource scope | High; catalogue/price extraction budgets and size bounds | `listRoutes.js:1072` |
| DELETE | `/api/lists/:id` | Authenticated; tenant/resource scope | Medium; bounded requests | `listRoutes.js:1129` |
| GET | `/api/lists/:id/lowest-prices` | Authenticated; tenant/resource scope | High; catalogue/price extraction budgets and size bounds | `listRoutes.js:1170` |
| POST | `/api/lists/check-bundle-before-add` | Authenticated; tenant/resource scope | Medium; bounded requests | `listRoutes.js:1235` |
| GET | `/api/lists/bundle-offers/:productAtShopId` | Authenticated; tenant/resource scope | High; catalogue/price extraction budgets and size bounds | `listRoutes.js:1453` |
| POST | `/api/lists/claim-bundle` | Authenticated; tenant/resource scope | Medium; bounded requests | `listRoutes.js:1559` |
| GET | `/api/chat-safety/reports` | Admin only; private moderation evidence | High; destructive/admin operations | `moderationRoutes.js:13` |
| GET | `/api/chat-safety/reports/:id` | Admin only; private moderation evidence | High; destructive/admin operations | `moderationRoutes.js:39` |
| GET | `/api/chat-safety/reports/:id/attachment` | Admin only; private moderation evidence | High; destructive/admin operations | `moderationRoutes.js:57` |
| POST | `/api/chat-safety/reports/:id/status` | Admin only; private moderation evidence | High; destructive/admin operations | `moderationRoutes.js:64` |
| POST | `/api/chat-safety/reports/:id/notes` | Admin only; private moderation evidence | High; destructive/admin operations | `moderationRoutes.js:76` |
| POST | `/api/chat-safety/reports/:id/resolve` | Admin only; private moderation evidence | High; destructive/admin operations | `moderationRoutes.js:82` |
| GET | `/api/chat-safety/suspensions` | Admin only; private moderation evidence | High; destructive/admin operations | `moderationRoutes.js:94` |
| POST | `/api/chat-safety/reports/:id/suspension` | Admin only; private moderation evidence | High; destructive/admin operations | `moderationRoutes.js:95` |
| POST | `/api/chat-safety/messages/:id/remove` | Admin only; private moderation evidence | High; destructive/admin operations | `moderationRoutes.js:131` |
| POST | `/api/chat-safety/reports/:id/delete-user-messages` | Admin only; private moderation evidence | High; destructive/admin operations | `moderationRoutes.js:141` |
| GET | `/api/chat-safety/deletion-jobs` | Admin only; private moderation evidence | High; destructive/admin operations | `moderationRoutes.js:154` |
| GET | `/api/news` | Public active marketing; all/drafts require Admin | Medium; pages capped at100, shared-IP quota | `news.js:79` |
| GET | `/api/news/:id` | Public active marketing; all/drafts require Admin | Medium; pages capped at100, shared-IP quota | `news.js:101` |
| POST | `/api/news` | Company permission or Admin, per route; high | High; authenticated bounded content-validated uploads or writes | `news.js:125` |
| PUT | `/api/news/:id` | Company permission or Admin, per route; high | High; authenticated bounded content-validated uploads or writes | `news.js:157` |
| DELETE | `/api/news/:id` | Company permission or Admin, per route; high | High; authenticated bounded content-validated uploads or writes | `news.js:186` |
| GET | `/api/price-reports` | Authenticated; tenant/resource scope | Medium; bounded requests | `priceReports.js:89` |
| POST | `/api/price-reports` | Authenticated; tenant/resource scope | Medium; bounded requests | `priceReports.js:117` |
| GET | `/api/price-reports/admin/pending` | Authenticated; tenant/resource scope | Medium; bounded requests | `priceReports.js:198` |
| PUT | `/api/price-reports/admin/:reportId/approve` | Authenticated; tenant/resource scope | Medium; bounded requests | `priceReports.js:251` |
| POST | `/api/price-reports/admin/approve/:reportId` | Authenticated; tenant/resource scope | Medium; bounded requests | `priceReports.js:252` |
| PUT | `/api/price-reports/admin/:reportId/reject` | Authenticated; tenant/resource scope | Medium; bounded requests | `priceReports.js:253` |
| POST | `/api/price-reports/admin/reject/:reportId` | Authenticated; tenant/resource scope | Medium; bounded requests | `priceReports.js:254` |
| GET | `/api/price-reports/product/:productId/shop/:shopId/price` | Authenticated; tenant/resource scope | High; catalogue/price extraction budgets and size bounds | `priceReports.js:257` |
| GET | `/api/price-reports/products/search` | Authenticated; tenant/resource scope | High; catalogue/price extraction budgets and size bounds | `priceReports.js:298` |
| GET | `/api/price-reports/products/:productId/shops/search` | Authenticated; tenant/resource scope | High; catalogue/price extraction budgets and size bounds | `priceReports.js:328` |
| GET | `/api/price-reports/products/:productId/shops` | Authenticated; tenant/resource scope | High; catalogue/price extraction budgets and size bounds | `priceReports.js:407` |
| GET | `/api/price-reports/admin/all` | Authenticated; tenant/resource scope | Medium; bounded requests | `priceReports.js:440` |
| GET | `/api/promotions/public` | Public selected marketing offers | Medium; capped100 offers, shared-IP quota | `promotions.js:108` |
| GET | `/api/promotions` | Authenticated; tenant/resource scope | Medium; bounded requests | `promotions.js:129` |
| GET | `/api/promotions/:id` | Authenticated; tenant/resource scope | Medium; bounded requests | `promotions.js:223` |
| POST | `/api/promotions` | Company permission or Admin, per route; high | High; authenticated bounded content-validated uploads or writes | `promotions.js:275` |
| PUT | `/api/promotions/:id/toggle` | Company permission or Admin, per route; high | High; authenticated bounded content-validated uploads or writes | `promotions.js:394` |
| PUT | `/api/promotions/:id` | Company permission or Admin, per route; high | High; authenticated bounded content-validated uploads or writes | `promotions.js:432` |
| DELETE | `/api/promotions/:id` | Company permission or Admin, per route; high | High; authenticated bounded content-validated uploads or writes | `promotions.js:496` |
| GET | `/account-deletion` | Public static support/deletion instructions | Low; static files | `publicResources.js:14` |
| GET | `/support` | Public static support/deletion instructions | Low; static files | `publicResources.js:15` |
| POST | `/api/admin/security/reauth` | Admin only; reauthentication for mutations; critical | High; bounded event pages, policy and action controls | `securityAdminRoutes.js:34` |
| GET | `/api/admin/security/overview` | Admin only; reauthentication for mutations; critical | High; bounded event pages, policy and action controls | `securityAdminRoutes.js:57` |
| GET | `/api/admin/security/events` | Admin only; reauthentication for mutations; critical | High; bounded event pages, policy and action controls | `securityAdminRoutes.js:71` |
| GET | `/api/admin/security/events/:id` | Admin only; reauthentication for mutations; critical | High; bounded event pages, policy and action controls | `securityAdminRoutes.js:84` |
| GET | `/api/admin/security/audit/integrity` | Admin only; reauthentication for mutations; critical | High; bounded event pages, policy and action controls | `securityAdminRoutes.js:102` |
| GET | `/api/admin/security/policy` | Admin only; reauthentication for mutations; critical | High; bounded event pages, policy and action controls | `securityAdminRoutes.js:103` |
| PATCH | `/api/admin/security/policy` | Admin only; reauthentication for mutations; critical | High; bounded event pages, policy and action controls | `securityAdminRoutes.js:104` |
| POST | `/api/admin/security/restrictions` | Admin only; reauthentication for mutations; critical | High; bounded event pages, policy and action controls | `securityAdminRoutes.js:116` |
| POST | `/api/admin/security/restrictions/:id/lift` | Admin only; reauthentication for mutations; critical | High; bounded event pages, policy and action controls | `securityAdminRoutes.js:149` |
| PATCH | `/api/admin/security/restrictions/:id` | Admin only; reauthentication for mutations; critical | High; bounded event pages, policy and action controls | `securityAdminRoutes.js:150` |
| POST | `/api/admin/security/accounts/:subjectKey/revoke-sessions` | Admin only; reauthentication for mutations; critical | High; bounded event pages, policy and action controls | `securityAdminRoutes.js:152` |
| PATCH | `/api/admin/security/events/:id` | Admin only; reauthentication for mutations; critical | High; bounded event pages, policy and action controls | `securityAdminRoutes.js:165` |
| POST | `/api/admin/security/events/:id/notes` | Admin only; reauthentication for mutations; critical | High; bounded event pages, policy and action controls | `securityAdminRoutes.js:175` |
| POST | `/api/admin/security/exceptions` | Admin only; reauthentication for mutations; critical | High; bounded event pages, policy and action controls | `securityAdminRoutes.js:183` |
| POST | `/api/admin/security/exceptions/:id/lift` | Admin only; reauthentication for mutations; critical | High; bounded event pages, policy and action controls | `securityAdminRoutes.js:193` |
| GET | `/api/shift-sheet` | Authenticated; tenant/resource scope | Medium; bounded requests | `shiftSheetRoutes.js:33` |
| POST | `/api/shift-sheet` | Authenticated; tenant/resource scope | Medium; bounded requests | `shiftSheetRoutes.js:69` |
| PUT | `/api/shift-sheet/:id` | Authenticated; tenant/resource scope | Medium; bounded requests | `shiftSheetRoutes.js:116` |
| DELETE | `/api/shift-sheet/:id` | Authenticated; tenant/resource scope | Medium; bounded requests | `shiftSheetRoutes.js:175` |
| GET | `/api/shop/my-shop` | Authenticated; tenant/resource scope | Medium; bounded requests | `shopRoutes.js:33` |
| POST | `/api/shop/assign` | Authenticated; tenant/resource scope | Medium; bounded requests | `shopRoutes.js:60` |
| GET | `/api/shop/group-chat` | Authenticated; tenant/resource scope | Medium; bounded requests | `shopRoutes.js:73` |
| GET | `/api/shop/employees` | Authenticated; tenant/resource scope | Medium; bounded requests | `shopRoutes.js:132` |
| GET | `/api/shop/all-lists` | Authenticated; tenant/resource scope | Medium; bounded requests | `shopRoutes.js:177` |
| POST | `/api/shop/copy-list/:listId` | Authenticated; tenant/resource scope | Medium; bounded requests | `shopRoutes.js:232` |
| POST | `/api/shop/employee-copy-list/:listId` | Authenticated; tenant/resource scope | Medium; bounded requests | `shopRoutes.js:311` |
| GET | `/api/shop/available` | Authenticated; tenant/resource scope | Medium; bounded requests | `shopRoutes.js:392` |
| GET | `/api/shop/supermarkets` | Authenticated; tenant/resource scope | Medium; bounded requests | `supermarketRoutes.js:11` |
| POST | `/api/shop/supermarkets` | Authenticated; tenant/resource scope | Medium; bounded requests | `supermarketRoutes.js:30` |
| PUT | `/api/shop/supermarkets/:id/default` | Authenticated; tenant/resource scope | Medium; bounded requests | `supermarketRoutes.js:36` |
| GET | `/api/supplier-payouts` | Authenticated; tenant/resource scope | Medium; bounded requests | `supplierPayoutRoutes.js:68` |
| POST | `/api/supplier-payouts` | Authenticated; tenant/resource scope | Medium; bounded requests | `supplierPayoutRoutes.js:121` |
| PUT | `/api/supplier-payouts/:id` | Authenticated; tenant/resource scope | Medium; bounded requests | `supplierPayoutRoutes.js:171` |
| DELETE | `/api/supplier-payouts/:id` | Authenticated; tenant/resource scope | Medium; bounded requests | `supplierPayoutRoutes.js:234` |
| GET | `/api/tasks` | Authenticated; tenant/resource scope | Medium; bounded requests | `taskRoutes.js:31` |
| POST | `/api/tasks` | Authenticated; tenant/resource scope | Medium; bounded requests | `taskRoutes.js:104` |
| PUT | `/api/tasks/:id` | Authenticated; tenant/resource scope | Medium; bounded requests | `taskRoutes.js:218` |
| DELETE | `/api/tasks/:id` | Authenticated; tenant/resource scope | Medium; bounded requests | `taskRoutes.js:303` |
| GET | `/api/tasks/my-tasks` | Authenticated; tenant/resource scope | Medium; bounded requests | `taskRoutes.js:336` |
| PUT | `/api/tasks/start/:assignmentId` | Authenticated; tenant/resource scope | Medium; bounded requests | `taskRoutes.js:384` |
| PUT | `/api/tasks/complete/:assignmentId` | Authenticated; tenant/resource scope | Medium; bounded requests | `taskRoutes.js:463` |
| GET | `/api/waste` | Authenticated; tenant/resource scope | Medium; bounded requests | `wasteRoutes.js:17` |
| POST | `/api/waste` | Authenticated; tenant/resource scope | Medium; bounded requests | `wasteRoutes.js:48` |

275 literal route declarations listed. Dynamic security list routes (`restrictions`, `exceptions`, `audit`) and restriction lift/extend registration are Admin-only with the same reauthentication guard. SQL-backed audit verification is `/api/admin/security/audit/integrity`. Socket.IO is separate: signed session/cookie authentication, per-connection/event quotas, membership checks, session expiry and restricted private rooms.

Public static paths: `/images`, product/marketing uploads, `/support`, `/account-deletion`, `/release-resources`, and minimal `/api/health`. Private chat/incident/age-record/certificate attachments are intercepted by authorization before static serving. Dormant files such as `productPromotions.js` are not mounted by the server.

Limitations: this inventory is static and does not replace a live route crawl. Existing shop-history/list queries without cursor APIs retain their business shape and are bounded at request/concurrency/response delivery; complete query-level pagination for those historic workflows remains outstanding.
