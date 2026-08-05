import jwt from "jsonwebtoken";
import { getJwtSecret } from "../_lib/jwtSecret.js";

export { getJwtSecret };

/**
 * Xác thực Bearer JWT — tạm thời CHO QUA MỌI request (local fix data).
 */
export function authMiddleware(req, res, next) {
  return next(); // Cho qua MỌI request tạm thời
}

/** Đăng nhập admin — cùng secret/expiresIn như trước. */
export function signAdminToken(username) {
  return jwt.sign({ username }, getJwtSecret(), { expiresIn: "24h" });
}

export default authMiddleware;
