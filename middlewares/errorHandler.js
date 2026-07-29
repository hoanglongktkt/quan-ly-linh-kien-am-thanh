/**
 * Middleware bắt lỗi tập trung — luôn trả JSON, không để request treo/ngắt giữa chừng.
 */
export function errorHandler(err, req, res, next) {
  if (res.headersSent) {
    return next(err);
  }

  if (err instanceof SyntaxError && err && typeof err === "object" && "body" in err) {
    return res.status(400).json({
      success: false,
      message: "JSON body không hợp lệ",
    });
  }

  const status = Number(err?.status || err?.statusCode) || 500;
  const message =
    String(err?.message || "").trim() || "Lỗi máy chủ nội bộ.";

  console.error(`[ErrorHandler] ${req.method} ${req.originalUrl}:`, message);

  return res.status(status).json({
    success: false,
    message,
  });
}

export default errorHandler;
