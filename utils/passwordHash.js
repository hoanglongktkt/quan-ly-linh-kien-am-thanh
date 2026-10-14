/**
 * Password hashing utilities using bcrypt
 * Bảo mật: Không lưu plaintext passwords, chỉ hash
 */
import bcrypt from 'bcrypt';

const BCRYPT_ROUNDS = parseInt(process.env.BCRYPT_ROUNDS || '12', 10);

/**
 * Hash password với bcrypt
 * @param {string} plainPassword - Mật khẩu plaintext
 * @returns {Promise<string>} Hashed password
 */
export async function hashPassword(plainPassword) {
  if (!plainPassword || typeof plainPassword !== 'string') {
    throw new Error('Password must be a non-empty string');
  }
  return await bcrypt.hash(plainPassword, BCRYPT_ROUNDS);
}

/**
 * Verify password against hash
 * @param {string} plainPassword - Mật khẩu plaintext cần verify
 * @param {string} hashedPassword - Hashed password từ database
 * @returns {Promise<boolean>} True nếu match
 */
export async function verifyPassword(plainPassword, hashedPassword) {
  if (!plainPassword || !hashedPassword) {
    return false;
  }
  try {
    return await bcrypt.compare(plainPassword, hashedPassword);
  } catch (err) {
    console.error('[Password] Verify error:', err);
    return false;
  }
}

/**
 * Validate password strength
 * @param {string} password - Password to validate
 * @returns {{valid: boolean, errors: string[]}}
 */
export function validatePasswordStrength(password) {
  const errors = [];

  if (!password || typeof password !== 'string') {
    errors.push('Password is required');
    return { valid: false, errors };
  }

  if (password.length < 16) {
    errors.push('Password must be at least 16 characters');
  }

  if (!/[a-z]/.test(password)) {
    errors.push('Password must contain lowercase letters');
  }

  if (!/[A-Z]/.test(password)) {
    errors.push('Password must contain uppercase letters');
  }

  if (!/[0-9]/.test(password)) {
    errors.push('Password must contain numbers');
  }

  if (!/[^a-zA-Z0-9]/.test(password)) {
    errors.push('Password must contain special characters');
  }

  // Check common weak passwords
  const weakPasswords = ['password', 'admin', '123456', 'qwerty'];
  if (weakPasswords.some(weak => password.toLowerCase().includes(weak))) {
    errors.push('Password contains common weak patterns');
  }

  return {
    valid: errors.length === 0,
    errors
  };
}
