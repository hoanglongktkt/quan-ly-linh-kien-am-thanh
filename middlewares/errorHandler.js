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

  // Timeout / abort từ client hoặc middleware — trả 504 thay vì để socket treo.
  if (err?.name === "AbortError" || err?.code === "ETIMEDOUT" || /timeout/i.test(String(err?.message || ""))) {
    return res.status(504).json({
      success: false,
      message: String(err?.message || "").trim() || "Request timeout.",
      error: "gateway_timeout",
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

/**
 * Bọc async controller — rejection luôn đi qua next(err), tránh request treo không res/next.
 */
export function asyncHandler(fn) {
  return function asyncRouteWrapper(req, res, next) {
    Promise.resolve(fn(req, res, next)).catch((err) => {
      if (res.headersSent) {
        console.error(`[AsyncHandler] late error ${req.method} ${req.originalUrl}:`, err?.message || err);
        return;
      }
      next(err);
    });
  };
}

export default errorHandler;
