# 🔒 Security Implementation Guide

## Overview

Hệ thống đã được nâng cấp với các security features sau:
- Password hashing với bcrypt
- Rate limiting chống brute force
- RBAC (Role-Based Access Control)
- Account locking sau nhiều lần đăng nhập sai
- Input validation
- Enhanced JWT với role & permissions

## 📋 Setup Instructions

### 1. Install Dependencies

```bash
npm install express-rate-limit bcrypt zod
```

### 2. Generate Strong Secrets

```bash
# Generate JWT Secret
node -e "console.log(require('crypto').randomBytes(64).toString('base64'))"

# Generate Admin Password
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### 3. Update Environment Variables

Cập nhật `.env` (hoặc `.env.local`) và các environment variables trên Vercel/cPanel:

```bash
# Strong JWT Secret (MUST be same on Vercel & cPanel)
JWT_SECRET="<generated-base64-string>"

# Admin credentials (change from defaults)
ADMIN_USERNAME="<unique-username>"
ADMIN_PASSWORD="<strong-password-min-16-chars>"

# Bcrypt rounds (default: 12)
BCRYPT_ROUNDS=12
```

**⚠️ CRITICAL**: JWT_SECRET phải **GIỐNG NHAU** trên Vercel và cPanel!

### 4. Create Initial Admin User in Database

```bash
node scripts/create-initial-admin.mjs
```

Follow the prompts để tạo admin user đầu tiên trong MongoDB.

**Password Requirements:**
- Minimum 16 characters
- At least 1 lowercase letter
- At least 1 uppercase letter
- At least 1 number
- At least 1 special character
- No common weak patterns (password, admin, 123456, etc.)

### 5. Update Server to Use New Security Features

Cần update `server.ts` để:
1. Import rate limiters
2. Apply rate limiting middleware
3. Use enhanced auth controller
4. Register user management routes

## 🔐 User Roles & Permissions

### Roles

| Role | Description |
|------|-------------|
| `admin` | Full system access, can manage users |
| `manager` | Can manage orders, products, but not users |
| `staff` | Basic operations only |
| `readonly` | View-only access |

### Permissions

Orders:
- `orders:read` - View orders
- `orders:create` - Create orders
- `orders:update` - Update orders
- `orders:delete` - Delete orders
- `orders:sync` - Sync with Shopee
- `orders:print` - Print labels
- `orders:ship` - Ship orders

Products:
- `products:read` - View products
- `products:create` - Create products
- `products:update` - Update products
- `products:delete` - Delete products
- `products:sync` - Sync with channels

Finance:
- `finance:read` - View financial data
- `finance:create` - Create transactions
- `finance:update` - Update transactions
- `finance:delete` - Delete transactions

System:
- `system:settings` - Manage settings
- `system:users` - Manage users (admin only)
- `system:health` - View health metrics
- `system:logs` - View system logs

## 🛡️ Security Features

### 1. Password Hashing

Passwords are hashed using bcrypt with 12 rounds (configurable).

```javascript
import { hashPassword, verifyPassword } from './utils/passwordHash.js';

// Hash password
const hash = await hashPassword('myPassword123!@#');

// Verify password
const isValid = await verifyPassword('myPassword123!@#', hash);
```

### 2. Rate Limiting

**Login Endpoint**: 5 attempts per 15 minutes per IP+username
**API Endpoints**: 100 requests per 15 minutes per IP
**System Endpoints**: 10 requests per hour
**Webhooks**: 1000 requests per minute

### 3. Account Locking

Sau 5 lần đăng nhập sai, tài khoản bị khóa 30 phút.

Admin có thể unlock bằng:
```bash
POST /api/users/:id/unlock
```

### 4. JWT Enhanced

JWT token bây giờ chứa:
```json
{
  "username": "admin",
  "role": "admin",
  "permissions": ["*"],
  "iat": 1234567890,
  "exp": 1234654290
}
```

### 5. RBAC Middleware

```javascript
import { requirePermission, requireRole, requireAdmin } from './middlewares/rbac.js';

// Require specific permission
app.get('/api/orders', authMiddleware, requirePermission('orders:read'), handler);

// Require any of multiple permissions (OR logic)
app.post('/api/orders', authMiddleware, requirePermission(['orders:create', 'orders:update']), handler);

// Require all permissions (AND logic)
app.delete('/api/orders/:id', authMiddleware, requirePermission(['orders:read', 'orders:delete'], { requireAll: true }), handler);

// Require specific role
app.get('/api/users', authMiddleware, requireAdmin, handler);
```

## 📝 User Management API

### List Users
```bash
GET /api/users
Authorization: Bearer <admin-token>
```

### Create User
```bash
POST /api/users
Authorization: Bearer <admin-token>
Content-Type: application/json

{
  "username": "staff1",
  "password": "StrongP@ssw0rd123456",
  "email": "staff1@example.com",
  "role": "staff",
  "permissions": ["orders:read", "orders:update", "products:read"]
}
```

### Update User
```bash
PATCH /api/users/:id
Authorization: Bearer <admin-token>
Content-Type: application/json

{
  "role": "manager",
  "permissions": ["orders:*", "products:*"],
  "isActive": true
}
```

### Delete User
```bash
DELETE /api/users/:id
Authorization: Bearer <admin-token>
```

### Unlock User
```bash
POST /api/users/:id/unlock
Authorization: Bearer <admin-token>
```

### Reset User Password (Admin)
```bash
POST /api/users/:id/reset-password
Authorization: Bearer <admin-token>
Content-Type: application/json

{
  "newPassword": "NewStrongP@ssw0rd123456"
}
```

### Change Own Password
```bash
POST /api/auth/change-password
Authorization: Bearer <user-token>
Content-Type: application/json

{
  "currentPassword": "OldP@ssw0rd123456",
  "newPassword": "NewStrongP@ssw0rd123456"
}
```

## 🚨 Migration from Legacy Auth

### Step 1: Create Admin in Database
```bash
node scripts/create-initial-admin.mjs
```

### Step 2: Test New Login
Login với admin user mới tạo, verify JWT có role & permissions.

### Step 3: Create Additional Users
Dùng admin account để tạo users cho staff.

### Step 4: Remove Legacy Fallback
Sau khi migrate xong, xóa legacy auth code trong `authController.enhanced.js`:

```javascript
// TODO: Remove this fallback block
if (username === expectedUsername && password === expectedPassword) {
  // ...legacy code...
}
```

## ⚠️ Security Checklist

- [ ] JWT_SECRET changed from default và đồng bộ Vercel/cPanel
- [ ] ADMIN_PASSWORD changed from "password123"
- [ ] Initial admin user created in database
- [ ] Rate limiting enabled
- [ ] System endpoint bypass removed
- [ ] All staff users created with proper roles/permissions
- [ ] Legacy auth fallback removed (after migration)
- [ ] Debug logs removed from production code
- [ ] HTTPS enforced on all endpoints
- [ ] CORS whitelist verified

## 📚 Additional Resources

- [OWASP Authentication Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html)
- [OWASP Password Storage Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html)
- [Express Rate Limit Docs](https://www.npmjs.com/package/express-rate-limit)
- [Bcrypt Best Practices](https://github.com/kelektiv/node.bcrypt.js#a-note-on-rounds)

## 🆘 Troubleshooting

### Token mismatch between Vercel & cPanel
**Symptom**: Login works but API calls fail with 401

**Fix**: Ensure JWT_SECRET is EXACTLY the same on both platforms.

### Account locked after deployment
**Symptom**: Cannot login after update

**Fix**: Run unlock script or reset login attempts directly in MongoDB:
```javascript
db.users.updateOne(
  { username: "admin" },
  { $set: { loginAttempts: 0 }, $unset: { lockUntil: 1 } }
)
```

### Rate limit errors
**Symptom**: "Too many requests" error

**Fix**: Wait for rate limit window to expire, or adjust limits in `rateLimiter.js`.

### Password strength validation fails
**Symptom**: "Password not strong enough"

**Fix**: Ensure password meets all requirements (min 16 chars, upper, lower, number, special).
