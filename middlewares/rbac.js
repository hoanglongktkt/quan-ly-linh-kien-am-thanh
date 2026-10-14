/**
 * RBAC (Role-Based Access Control) Middleware
 */
import User from '../models/User.js';

/**
 * Check if user has required permission(s)
 * @param {string|string[]} requiredPermissions - Single permission or array of permissions (OR logic)
 * @param {object} options - { requireAll: false } = OR logic, { requireAll: true } = AND logic
 */
export function requirePermission(requiredPermissions, options = { requireAll: false }) {
  return async (req, res, next) => {
    try {
      // JWT already verified by authMiddleware, user payload in req.user
      if (!req.user || !req.user.username) {
        return res.status(401).json({ error: 'Chưa xác thực.' });
      }

      // Load full user from database to get permissions
      const user = await User.findOne({ username: req.user.username, isActive: true });

      if (!user) {
        return res.status(401).json({ error: 'Người dùng không tồn tại hoặc đã bị vô hiệu hóa.' });
      }

      // Check if account is locked
      if (user.isLocked) {
        const lockMinutes = Math.ceil((user.lockUntil - Date.now()) / 60000);
        return res.status(403).json({
          error: `Tài khoản đã bị khóa do đăng nhập sai quá nhiều lần. Thử lại sau ${lockMinutes} phút.`
        });
      }

      // Attach full user to request
      req.userModel = user;

      // Check permissions
      const permissions = Array.isArray(requiredPermissions) ? requiredPermissions : [requiredPermissions];

      if (options.requireAll) {
        // AND logic - require all permissions
        const hasAll = permissions.every(p => user.hasPermission(p));
        if (!hasAll) {
          console.warn(`[RBAC] User ${user.username} denied access: missing permissions ${permissions.join(', ')}`);
          return res.status(403).json({
            error: 'Bạn không có quyền thực hiện thao tác này.',
            requiredPermissions: permissions
          });
        }
      } else {
        // OR logic - require any permission
        const hasAny = permissions.some(p => user.hasPermission(p));
        if (!hasAny) {
          console.warn(`[RBAC] User ${user.username} denied access: missing any of ${permissions.join(', ')}`);
          return res.status(403).json({
            error: 'Bạn không có quyền thực hiện thao tác này.',
            requiredPermissions: permissions
          });
        }
      }

      next();
    } catch (err) {
      console.error('[RBAC] Permission check error:', err);
      return res.status(500).json({ error: 'Lỗi kiểm tra quyền truy cập.' });
    }
  };
}

/**
 * Check if user has specific role
 * @param {string|string[]} roles - Required role(s)
 */
export function requireRole(roles) {
  return async (req, res, next) => {
    try {
      if (!req.user || !req.user.username) {
        return res.status(401).json({ error: 'Chưa xác thực.' });
      }

      const user = await User.findOne({ username: req.user.username, isActive: true });

      if (!user) {
        return res.status(401).json({ error: 'Người dùng không tồn tại.' });
      }

      if (user.isLocked) {
        return res.status(403).json({ error: 'Tài khoản đã bị khóa.' });
      }

      const allowedRoles = Array.isArray(roles) ? roles : [roles];

      if (!allowedRoles.includes(user.role)) {
        console.warn(`[RBAC] User ${user.username} (${user.role}) denied access: requires role ${allowedRoles.join(' or ')}`);
        return res.status(403).json({
          error: 'Bạn không có quyền truy cập chức năng này.',
          requiredRole: allowedRoles
        });
      }

      req.userModel = user;
      next();
    } catch (err) {
      console.error('[RBAC] Role check error:', err);
      return res.status(500).json({ error: 'Lỗi kiểm tra vai trò.' });
    }
  };
}

/**
 * Admin-only middleware (shorthand)
 */
export const requireAdmin = requireRole('admin');

/**
 * Manager or Admin
 */
export const requireManager = requireRole(['admin', 'manager']);

export default {
  requirePermission,
  requireRole,
  requireAdmin,
  requireManager
};
