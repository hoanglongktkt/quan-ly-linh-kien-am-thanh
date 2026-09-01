import jwt from "jsonwebtoken";
import { getJwtSecret } from "../_lib/jwtSecret.js";

export { getJwtSecret };

/**
 * Xác thực Bearer JWT.
 */
export function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;
  let token = "";
  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.slice(7);
  } else {
    const pathOnly = String(req.originalUrl || req.path || "").split("?")[0];
    const isLiveSse = req.method === "GET" && pathOnly.endsWith("/orders/live");
    if (isLiveSse) token = String(req.query?.token || "").trim();
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
