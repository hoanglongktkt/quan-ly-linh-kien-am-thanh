import jwt from "jsonwebtoken";
import { getJwtSecret } from "../_lib/jwtSecret.js";

export { getJwtSecret };

/**
 * Xác thực Bearer JWT — logic giữ nguyên từ server.ts (Phase 0 extract).
 */
export function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({
      success: false,
      error: "Yêu cầu cung cấp Token xác thực hợp lệ.",
      message: "Yêu cầu cung cấp Token xác thực hợp lệ.",
    });
  }
  const token = authHeader.split(" ")[1];
  try {
    const decoded = jwt.verify(token, getJwtSecret());
    req.user = decoded;
    next();
  } catch (error) {
    return res.status(401).json({
      success: false,
      error: "Phiên đăng nhập admin đã hết hạn — vui lòng đăng nhập lại.",
      message: "Phiên đăng nhập admin đã hết hạn — vui lòng đăng nhập lại.",
    });
  }
}

/** Đăng nhập admin — cùng secret/expiresIn như trước. */
export function signAdminToken(username) {
  return jwt.sign({ username }, getJwtSecret(), { expiresIn: "24h" });
}

export default authMiddleware;
