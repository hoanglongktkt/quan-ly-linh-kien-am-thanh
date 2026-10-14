/**
 * Temporary Auth Controller - Legacy Priority
 * Fallback to ENV credentials first, MongoDB second
 * Use this temporarily until MongoDB user is created
 */
import { signAdminToken } from "../middlewares/auth.js";
import { hashPassword, verifyPassword } from "../utils/passwordHash.js";
import User from "../models/User.js";

/**
 * POST /api/auth/login
 * Priority: ENV credentials → MongoDB user
 */
export async function login(req, res) {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({
      error: 'Username và password là bắt buộc.'
    });
  }

  try {
    // PRIORITY 1: Check ENV credentials first (legacy compatibility)
    const expectedUsername = process.env.ADMIN_USERNAME || "admin";
    const expectedPassword = process.env.ADMIN_PASSWORD;

    if (expectedPassword && username === expectedUsername && password === expectedPassword) {
      const token = signAdminToken(username, 'admin', ['*']);
      console.log(`[Auth] Legacy admin login: ${username}`);
      return res.json({
        token,
        username,
        role: 'admin',
        permissions: ['*'],
        legacy: true
      });
    }

    // PRIORITY 2: Try MongoDB user
    const user = await User.findOne({ username: username.toLowerCase().trim() });

    if (user) {
      // Check if account is locked
      if (user.isLocked) {
        const lockMinutes = Math.ceil((user.lockUntil - Date.now()) / 60000);
        return res.status(403).json({
          error: `Tài khoản đã bị khóa. Thử lại sau ${lockMinutes} phút.`
        });
      }

      // Check if account is active
      if (!user.isActive) {
        return res.status(403).json({
          error: 'Tài khoản đã bị vô hiệu hóa.'
        });
      }

      // Verify password
      const isValidPassword = await verifyPassword(password, user.password);

      if (isValidPassword) {
        await user.resetLoginAttempts();

        const token = signAdminToken(username, user.role, user.permissions);

        console.log(`[Auth] MongoDB user login: ${username} (${user.role})`);

        return res.json({
          token,
          username: user.username,
          role: user.role,
          permissions: user.permissions
        });
      } else {
        await user.incLoginAttempts();
        return res.status(401).json({
          error: 'Tên đăng nhập hoặc mật khẩu không chính xác.'
        });
      }
    }

    // No match found
    console.warn(`[Auth] Login failed: ${username}`);
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
    return res.status(401).json({ error: 'Token không hợp lệ.' });
  }

  // Try to load user from database
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
      permissions: req.user.permissions || ['*'],
      legacy: true
    });

  } catch (err) {
    console.error('[Auth] Verify error:', err);
    // Fallback to JWT payload
    res.json({
      valid: true,
      username: req.user.username,
      role: req.user.role || 'admin',
      permissions: req.user.permissions || ['*']
    });
  }
}

export default {
  login,
  verifyAuth
};
