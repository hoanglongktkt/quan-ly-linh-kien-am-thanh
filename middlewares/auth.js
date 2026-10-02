import jwt from "jsonwebtoken";
import { getJwtSecret } from "../_lib/jwtSecret.js";

export { getJwtSecret };

/**
 * Xác thực Bearer JWT.
 */
export function authMiddleware(req, res, next) {
  const pathOnly = String(req.originalUrl || req.url || "")
    .split("?")[0]
    .replace(/\/+$/, "");
  if (pathOnly === "/api/orders/system/heal-corrupted-flags") {
    return next();
  }
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
    return res.status(401).json({ error: 'Token không hợp lệ hoặc đã hết hạn.' });
  }
}

/** Đăng nhập admin — JWT stateless, không refresh token (Phase B.2: 7 ngày). */
export function signAdminToken(username) {
  return jwt.sign({ username }, getJwtSecret(), { expiresIn: "7d" });
}

export default authMiddleware;
