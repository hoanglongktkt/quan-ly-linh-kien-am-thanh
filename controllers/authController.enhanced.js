/**
 * Enhanced Authentication Controller với Security Features:
 * - Password hashing với bcrypt
 * - Login attempts tracking
 * - Account locking
 * - RBAC support
 */
import { signAdminToken } from "../middlewares/auth.js";
import { hashPassword, verifyPassword, validatePasswordStrength } from "../utils/passwordHash.js";
import User from "../models/User.js";

/**
 * POST /api/auth/login
 * Enhanced với rate limiting, password hashing, và account locking
 */
export async function login(req, res) {
  const { username, password } = req.body;

  // Input validation
  if (!username || !password) {
    return res.status(400).json({
      error: 'Username và password là bắt buộc.'
    });
  }

  try {
    // Try to find user in database first (RBAC system)
    const user = await User.findOne({ username: username.toLowerCase().trim() });

    if (user) {
      // Check if account is locked
      if (user.isLocked) {
        const lockMinutes = Math.ceil((user.lockUntil - Date.now()) / 60000);
        console.warn(`[Auth] Login attempt on locked account: ${username}`);
        return res.status(403).json({
          error: `Tài khoản đã bị khóa do đăng nhập sai quá nhiều lần. Thử lại sau ${lockMinutes} phút.`
        });
      }

      // Check if account is active
      if (!user.isActive) {
        console.warn(`[Auth] Login attempt on inactive account: ${username}`);
        return res.status(403).json({
          error: 'Tài khoản đã bị vô hiệu hóa.'
        });
      }

      // Verify password
      const isValidPassword = await verifyPassword(password, user.password);

      if (isValidPassword) {
        // Successful login
        await user.resetLoginAttempts();

        const token = signAdminToken(username, user.role, user.permissions);

        console.log(`[Auth] Login successful: ${username} (${user.role})`);

        return res.json({
          token,
          username: user.username,
          role: user.role,
          permissions: user.permissions
        });
      } else {
        // Invalid password - increment attempts
        await user.incLoginAttempts();
        console.warn(`[Auth] Invalid password for user: ${username}`);

        return res.status(401).json({
          error: 'Tên đăng nhập hoặc mật khẩu không chính xác.'
        });
      }
    }

    // Fallback: Check legacy admin credentials from environment
    // TODO: Remove after migrating all admins to database
    const expectedUsername = process.env.ADMIN_USERNAME || "admin";
    const expectedPassword = process.env.ADMIN_PASSWORD;

    if (!expectedPassword || expectedPassword === 'password123' || expectedPassword === 'CHANGE_ME_MINIMUM_16_CHARACTERS') {
      console.error('[Auth] CRITICAL: ADMIN_PASSWORD not set or using default weak password!');
      return res.status(503).json({
        error: 'Cấu hình bảo mật chưa hoàn tất. Liên hệ quản trị viên.'
      });
    }

    if (username === expectedUsername && password === expectedPassword) {
      const token = signAdminToken(username, 'admin', ['*']);
      console.warn(`[Auth] Legacy admin login (migrate to database): ${username}`);
      return res.json({
        token,
        username,
        role: 'admin',
        legacy: true
      });
    }

    // No match found
    console.warn(`[Auth] Login failed for non-existent user: ${username}`);
    return res.status(401).json({
      error: "Tên đăng nhập hoặc mật khẩu không chính xác."
    });

  } catch (err) {
    console.error('[Auth] Login error:', err);
    return res.status(500).json({
      error: 'Lỗi đăng nhập. Vui lòng thử lại.'
    });
  }
}

/**
 * GET /api/auth/verify
 */
export async function verifyAuth(req, res) {
  if (!req.user || !req.user.username) {
    return res.status(401).json({ error: 'Token không hợp lệ hoặc đã hết hạn.' });
  }

  // Load full user from database to get latest status
  try {
    const user = await User.findOne({ username: req.user.username });

    if (user) {
      if (!user.isActive) {
        return res.status(403).json({ error: 'Tài khoản đã bị vô hiệu hóa.' });
      }

      if (user.isLocked) {
        return res.status(403).json({ error: 'Tài khoản đã bị khóa.' });
      }

      return res.json({
        valid: true,
        username: user.username,
        role: user.role,
        permissions: user.permissions
      });
    }

    // Legacy admin fallback
    res.json({
      valid: true,
      username: req.user.username,
      role: req.user.role || 'admin',
      legacy: true
    });

  } catch (err) {
    console.error('[Auth] Verify error:', err);
    res.json({
      valid: true,
      username: req.user.username,
      role: req.user.role || 'admin'
    });
  }
}

/**
 * POST /api/auth/change-password
 * Change password for current user
 */
export async function changePassword(req, res) {
  if (!req.user || !req.user.username) {
    return res.status(401).json({ error: 'Chưa xác thực.' });
  }

  const { currentPassword, newPassword } = req.body;

  if (!currentPassword || !newPassword) {
    return res.status(400).json({
      error: 'Current password và new password là bắt buộc.'
    });
  }

  try {
    const user = await User.findOne({ username: req.user.username });

    if (!user) {
      return res.status(404).json({ error: 'Người dùng không tồn tại.' });
    }

    // Verify current password
    const isValid = await verifyPassword(currentPassword, user.password);

    if (!isValid) {
      console.warn(`[Auth] Change password failed: invalid current password for ${user.username}`);
      return res.status(401).json({
        error: 'Mật khẩu hiện tại không chính xác.'
      });
    }

    // Validate new password strength
    const validation = validatePasswordStrength(newPassword);

    if (!validation.valid) {
      return res.status(400).json({
        error: 'Mật khẩu mới không đủ mạnh.',
        details: validation.errors
      });
    }

    // Hash and save new password
    user.password = await hashPassword(newPassword);
    await user.save();

    console.log(`[Auth] Password changed successfully for user: ${user.username}`);

    res.json({
      success: true,
      message: 'Đổi mật khẩu thành công.'
    });

  } catch (err) {
    console.error('[Auth] Change password error:', err);
    res.status(500).json({
      error: 'Lỗi đổi mật khẩu.'
    });
  }
}

export default {
  login,
  verifyAuth,
  changePassword
};
