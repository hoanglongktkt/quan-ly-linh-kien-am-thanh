/**
 * User Model - MongoDB Schema cho RBAC
 */
import mongoose from 'mongoose';

const userSchema = new mongoose.Schema({
  username: {
    type: String,
    required: true,
    unique: true,
    trim: true,
    lowercase: true,
    minlength: 3,
    maxlength: 50
  },
  password: {
    type: String,
    required: true,
    // Bcrypt hash, không lưu plaintext
  },
  email: {
    type: String,
    trim: true,
    lowercase: true,
    sparse: true, // Allow null but unique if provided
    match: /^[^\s@]+@[^\s@]+\.[^\s@]+$/
  },
  role: {
    type: String,
    enum: ['admin', 'manager', 'staff', 'readonly'],
    default: 'staff',
    required: true
  },
  permissions: [{
    type: String,
    enum: [
      // Order permissions
      'orders:read',
      'orders:create',
      'orders:update',
      'orders:delete',
      'orders:sync',
      'orders:print',
      'orders:ship',

      // Product permissions
      'products:read',
      'products:create',
      'products:update',
      'products:delete',
      'products:sync',

      // Financial permissions
      'finance:read',
      'finance:create',
      'finance:update',
      'finance:delete',

      // System permissions
      'system:settings',
      'system:users',
      'system:health',
      'system:logs',

      // Supplier & Import
      'suppliers:read',
      'suppliers:write',
      'imports:read',
      'imports:write',

      // Customer & Chat
      'customers:read',
      'customers:write',
      'chat:read',
      'chat:write',
    ]
  }],
  isActive: {
    type: Boolean,
    default: true
  },
  lastLogin: {
    type: Date
  },
  loginAttempts: {
    type: Number,
    default: 0
  },
  lockUntil: {
    type: Date
  },
  createdBy: {
    type: String // username của admin tạo user này
  }
}, {
  timestamps: true
});

// Indexes
userSchema.index({ username: 1 });
userSchema.index({ role: 1 });
userSchema.index({ isActive: 1 });

// Virtual: Check if account is locked
userSchema.virtual('isLocked').get(function() {
  return !!(this.lockUntil && this.lockUntil > Date.now());
});

// Method: Increment login attempts
userSchema.methods.incLoginAttempts = function() {
  // Reset attempts if lock has expired
  if (this.lockUntil && this.lockUntil < Date.now()) {
    return this.updateOne({
      $set: { loginAttempts: 1 },
      $unset: { lockUntil: 1 }
    });
  }

  const updates = { $inc: { loginAttempts: 1 } };
  const maxAttempts = 5;
  const lockTime = 30 * 60 * 1000; // 30 minutes

  // Lock account after max attempts
  if (this.loginAttempts + 1 >= maxAttempts && !this.isLocked) {
    updates.$set = { lockUntil: Date.now() + lockTime };
  }

  return this.updateOne(updates);
};

// Method: Reset login attempts after successful login
userSchema.methods.resetLoginAttempts = function() {
  return this.updateOne({
    $set: { loginAttempts: 0, lastLogin: new Date() },
    $unset: { lockUntil: 1 }
  });
};

// Method: Check if user has permission
userSchema.methods.hasPermission = function(permission) {
  if (!this.isActive) return false;
  if (this.isLocked) return false;
  if (this.role === 'admin') return true; // Admin has all permissions
  return this.permissions.includes(permission);
};

// Method: Check if user has any of the permissions
userSchema.methods.hasAnyPermission = function(permissions) {
  if (!Array.isArray(permissions)) return false;
  return permissions.some(p => this.hasPermission(p));
};

export const User = mongoose.model('User', userSchema);
export default User;
