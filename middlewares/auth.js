import jwt from "jsonwebtoken";
import { getJwtSecret } from "../_lib/jwtSecret.js";

export { getJwtSecret };

/**
 * Xác thực Bearer JWT.
 */
export function authMiddleware(req, res, next) {
  // ⚠️ SECURITY FIX: Removed unprotected system endpoint bypass
  // All system endpoints now require authentication

  const authHeader = req.headers.authorization;
  let token = "";
  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.slice(7);
  }
  if (!token) {
    return res.status(401).json({ error: 'Không có token xác thực.' });
  }

  try {
    const decoded = jwt.verify(token, getJwtSecret());
    req.user = decoded;
    return next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({
        error: 'Token đã hết hạn.',
        code: 'TOKEN_EXPIRED'
      });
    }
    return res.status(401).json({
      error: 'Token không hợp lệ.',
      code: 'INVALID_TOKEN'
    });
  }
}

/**
 * Đăng nhập admin — JWT stateless, không refresh token (Phase B.2: 7 ngày).
 * Enhanced: Include role and permissions in JWT payload
 */
export function signAdminToken(username, role = 'admin', permissions = ['*']) {
  const payload = {
    username,
    role,
    permissions: Array.isArray(permissions) ? permissions : ['*'],
    iat: Math.floor(Date.now() / 1000)
  };
  return jwt.sign(payload, getJwtSecret(), { expiresIn: "7d" });
}

export default authMiddleware;
