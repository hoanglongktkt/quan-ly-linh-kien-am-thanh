import mongoose from "mongoose";

/**
 * DB chưa sẵn sàng → 503 NGAY (sync).
 * Allowlist path giữ nguyên từ server.ts (Phase 0 extract).
 */
export function dbReadyMiddleware(req, res, next) {
  const pathName = String(req.path || req.originalUrl || "").split("?")[0];
  if (!pathName.startsWith("/api/")) return next();
  const allowWithoutDb =
    pathName === "/api/login" ||
    pathName.startsWith("/api/health") ||
    pathName.startsWith("/api/auth/") ||
    pathName === "/api/shopee/callback" ||
    pathName === "/api/shopee/oauth/complete" ||
    pathName === "/api/shopee/webhook" ||
    pathName.startsWith("/api/public/") ||
    pathName.startsWith("/api/shopee/ship-order") ||
    pathName === "/api/shopee/print-document" ||
    pathName === "/api/system/setup-indexes";
  if (allowWithoutDb) return next();
  if (mongoose.connection.readyState !== 1) {
    return res.status(503).json({
      success: false,
      message: "Database đang kết nối, vui lòng thử lại sau",
      error: "database_connecting",
      readyState: mongoose.connection.readyState,
    });
  }
  return next();
}

export default dbReadyMiddleware;
