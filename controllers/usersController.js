/**
 * User Management Controller - RBAC Administration
 * Admin-only endpoints để quản lý users
 */
import User from '../models/User.js';
import { hashPassword, validatePasswordStrength } from '../utils/passwordHash.js';

/**
 * GET /api/users
 * List all users (admin only)
 */
export async function listUsers(req, res) {
  try {
    const users = await User.find({})
      .select('-password') // Exclude password hash
      .sort({ createdAt: -1 });

    res.json({
      success: true,
      users: users.map(u => ({
        id: u._id,
        username: u.username,
        email: u.email,
        role: u.role,
        permissions: u.permissions,
        isActive: u.isActive,
        isLocked: u.isLocked,
        lastLogin: u.lastLogin,
        createdAt: u.createdAt,
        createdBy: u.createdBy
      }))
    });
  } catch (err) {
    console.error('[Users] List error:', err);
    res.status(500).json({ error: 'Lỗi lấy danh sách người dùng.' });
  }
}

/**
 * POST /api/users
 * Create new user (admin only)
 */
export async function createUser(req, res) {
  const { username, password, email, role, permissions } = req.body;

  // Validation
  if (!username || !password) {
    return res.status(400).json({
      error: 'Username và password là bắt buộc.'
    });
  }

  // Validate password strength
  const validation = validatePasswordStrength(password);
  if (!validation.valid) {
    return res.status(400).json({
      error: 'Mật khẩu không đủ mạnh.',
      details: validation.errors
    });
  }

  try {
    // Check if username already exists
    const existing = await User.findOne({ username: username.toLowerCase().trim() });
    if (existing) {
      return res.status(409).json({
        error: 'Username đã tồn tại.'
      });
    }

    // Hash password
    const hashedPassword = await hashPassword(password);

    // Create user
    const user = new User({
      username: username.toLowerCase().trim(),
      password: hashedPassword,
      email: email?.trim() || undefined,
      role: role || 'staff',
      permissions: permissions || [],
      isActive: true,
      createdBy: req.user.username
    });

    await user.save();

    console.log(`[Users] User created: ${user.username} by ${req.user.username}`);

    res.status(201).json({
      success: true,
      message: 'Tạo người dùng thành công.',
      user: {
        id: user._id,
        username: user.username,
        role: user.role,
        permissions: user.permissions
      }
    });

  } catch (err) {
    console.error('[Users] Create error:', err);
    res.status(500).json({ error: 'Lỗi tạo người dùng.' });
  }
}

/**
 * PATCH /api/users/:id
 * Update user (admin only)
 */
export async function updateUser(req, res) {
  const { id } = req.params;
  const { email, role, permissions, isActive } = req.body;

  try {
    const user = await User.findById(id);

    if (!user) {
      return res.status(404).json({ error: 'Người dùng không tồn tại.' });
    }

    // Update fields
    if (email !== undefined) user.email = email?.trim() || undefined;
    if (role !== undefined) user.role = role;
    if (permissions !== undefined) user.permissions = permissions;
    if (isActive !== undefined) user.isActive = isActive;

    await user.save();

    console.log(`[Users] User updated: ${user.username} by ${req.user.username}`);

    res.json({
      success: true,
      message: 'Cập nhật người dùng thành công.',
      user: {
        id: user._id,
        username: user.username,
        email: user.email,
        role: user.role,
        permissions: user.permissions,
        isActive: user.isActive
      }
    });

  } catch (err) {
    console.error('[Users] Update error:', err);
    res.status(500).json({ error: 'Lỗi cập nhật người dùng.' });
  }
}

/**
 * DELETE /api/users/:id
 * Delete user (admin only)
 */
export async function deleteUser(req, res) {
  const { id } = req.params;

  try {
    const user = await User.findById(id);

    if (!user) {
      return res.status(404).json({ error: 'Người dùng không tồn tại.' });
    }

    // Prevent deleting self
    if (user.username === req.user.username) {
      return res.status(400).json({
        error: 'Không thể xóa chính tài khoản của bạn.'
      });
    }

    await user.deleteOne();

    console.log(`[Users] User deleted: ${user.username} by ${req.user.username}`);

    res.json({
      success: true,
      message: 'Xóa người dùng thành công.'
    });

  } catch (err) {
    console.error('[Users] Delete error:', err);
    res.status(500).json({ error: 'Lỗi xóa người dùng.' });
  }
}

/**
 * POST /api/users/:id/unlock
 * Unlock locked account (admin only)
 */
export async function unlockUser(req, res) {
  const { id } = req.params;

  try {
    const user = await User.findById(id);

    if (!user) {
      return res.status(404).json({ error: 'Người dùng không tồn tại.' });
    }

    await user.updateOne({
      $set: { loginAttempts: 0 },
      $unset: { lockUntil: 1 }
    });

    console.log(`[Users] User unlocked: ${user.username} by ${req.user.username}`);

    res.json({
      success: true,
      message: 'Mở khóa tài khoản thành công.'
    });

  } catch (err) {
    console.error('[Users] Unlock error:', err);
    res.status(500).json({ error: 'Lỗi mở khóa tài khoản.' });
  }
}

/**
 * POST /api/users/:id/reset-password
 * Admin reset user password
 */
export async function resetUserPassword(req, res) {
  const { id } = req.params;
  const { newPassword } = req.body;

  if (!newPassword) {
    return res.status(400).json({
      error: 'New password là bắt buộc.'
    });
  }

  // Validate password strength
  const validation = validatePasswordStrength(newPassword);
  if (!validation.valid) {
    return res.status(400).json({
      error: 'Mật khẩu không đủ mạnh.',
      details: validation.errors
    });
  }

  try {
    const user = await User.findById(id);

    if (!user) {
      return res.status(404).json({ error: 'Người dùng không tồn tại.' });
    }

    // Hash and save new password
    user.password = await hashPassword(newPassword);
    await user.save();

    console.log(`[Users] Password reset for ${user.username} by ${req.user.username}`);

    res.json({
      success: true,
      message: 'Reset mật khẩu thành công.'
    });

  } catch (err) {
    console.error('[Users] Reset password error:', err);
    res.status(500).json({ error: 'Lỗi reset mật khẩu.' });
  }
}

export default {
  listUsers,
  createUser,
  updateUser,
  deleteUser,
  unlockUser,
  resetUserPassword
};
