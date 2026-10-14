/**
 * Server.ts Patch - Security Updates Integration
 *
 * Các thay đổi cần apply vào server.ts:
 * 1. Import rate limiters
 * 2. Apply rate limiting middleware
 * 3. Use enhanced auth controller
 * 4. Register user management routes
 * 5. Remove system endpoint bypass
 */

// ============================================================
// STEP 1: Add imports at top of server.ts
// ============================================================

// After existing imports, add:
import { loginLimiter, apiLimiter, systemLimiter } from "./middlewares/rateLimiter.js";
import usersRoutesImport from "./routes/usersRoutes.js";
import { login, verifyAuth, changePassword } from "./controllers/authController.enhanced.js";

// ============================================================
// STEP 2: Apply rate limiting middleware
// ============================================================

// After app initialization and before routes:
// Global API rate limiting (optional - can be selective per route)
// app.use('/api', apiLimiter);

// ============================================================
// STEP 3: Update auth routes với rate limiting
// ============================================================

// Find existing auth routes and update:

// OLD:
// app.post('/api/auth/login', login);

// NEW:
app.post('/api/auth/login', loginLimiter, login);
app.post('/api/auth/change-password', authMiddleware, changePassword);

// ============================================================
// STEP 4: Register user management routes
// ============================================================

// Add with other route registrations:
app.use('/api/users', usersRoutesImport);

// ============================================================
// STEP 5: Protect system endpoints
// ============================================================

// Find system endpoints and add authentication + rate limiting:

// OLD:
// app.get("/api/orders/system/heal-corrupted-flags", healCorruptedFlags);

// NEW:
app.get("/api/orders/system/heal-corrupted-flags",
  authMiddleware,
  systemLimiter,
  requireAdmin,  // Require admin role
  healCorruptedFlags
);

// Apply to other system endpoints:
app.get("/api/orders/system/migrate-tracking-flag",
  authMiddleware,
  systemLimiter,
  requireAdmin,
  migrateTrackingFlag
);

app.get("/api/orders/system/delete-ghost-orders",
  authMiddleware,
  systemLimiter,
  requireAdmin,
  deleteGhostOrders
);

// ============================================================
// STEP 6: Optional - Add RBAC to existing routes
// ============================================================

// Example: Protect order management with permissions
import { requirePermission } from "./middlewares/rbac.js";

// Orders - Read
app.get('/api/orders/refresh',
  authMiddleware,
  requirePermission('orders:read'),
  refreshOrders
);

// Orders - Create/Update
app.post('/api/orders/confirm',
  authMiddleware,
  requirePermission(['orders:update', 'orders:create']),
  confirmOnlyRoute
);

// Orders - Sync (admin or manager)
app.post('/api/orders/sync',
  authMiddleware,
  requirePermission('orders:sync'),
  syncOrders
);

// Products - Read
app.get('/api/products',
  authMiddleware,
  requirePermission('products:read'),
  listProducts
);

// Products - Write
app.patch('/api/products/:id',
  authMiddleware,
  requirePermission('products:update'),
  updateProduct
);

// Finance - Read only for authorized users
app.get('/api/finance/shopee-escrow',
  authMiddleware,
  requirePermission('finance:read'),
  getShopeeEscrow
);

// Settings - Admin only
app.put('/api/settings/channels',
  authMiddleware,
  requireAdmin,
  putChannelSettings
);

// ============================================================
// NOTES:
// ============================================================
// 1. Apply rate limiting selectively to avoid impacting webhooks
// 2. Webhook endpoints should skip JWT auth but validate HMAC
// 3. Consider applying requirePermission incrementally per route
// 4. Test thoroughly after each change
// 5. Monitor rate limit metrics in production
