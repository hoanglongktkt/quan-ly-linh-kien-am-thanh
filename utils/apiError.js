/** Trích lỗi từ fetch/axios — ưu tiên error.response.data từ Shopee. */
export function extractHttpClientError(err) {
  const anyErr = err;
  const shopeeData = anyErr?.response?.data;
  const message =
    shopeeData?.message ||
    shopeeData?.error ||
    (err instanceof Error ? err.message : String(err)) ||
    "Lỗi máy chủ nội bộ";
  const details = shopeeData
    ? JSON.stringify(shopeeData)
    : err instanceof Error
      ? err.toString()
      : String(err);
  return { message, details, shopeeDetail: shopeeData };
}

/** Luôn trả JSON lỗi — không để response treo hoặc crash process. */
export function sendApiErrorJson(res, err, status = 500) {
  if (res.headersSent) return;
  const { message, details, shopeeDetail } = extractHttpClientError(err);
  return res.status(status).json({
    success: false,
    error: message || "Internal Server Error",
    message,
    details,
    ...(shopeeDetail ? { shopee: shopeeDetail } : {}),
  });
}

export function sendStrictApiErrorJson(res, err) {
  const message =
    err && typeof err === "object" && "message" in err && typeof err.message === "string"
      ? err.message
      : "Internal Server Error";
  return res.status(500).json({ success: false, error: message || "Internal Server Error" });
}
