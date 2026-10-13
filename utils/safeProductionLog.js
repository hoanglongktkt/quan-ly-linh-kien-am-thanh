/** Chỉ ghi mã lỗi trong production; không đưa response, payload hay token vào log. */
export function safeError(error) {
  const code = String(error?.code || error?.name || "operation_failed");
  return code.replace(/[^a-zA-Z0-9_.-]/g, "").slice(0, 100) || "operation_failed";
}

/** Chỉ giữ metadata được phép; không log token dù chỉ một phần ký tự. */
export function safeTokenMetadata(record) {
  return {
    shop_id: record?.shop_id ?? null,
    hasAccessToken: Boolean(record?.access_token),
    hasRefreshToken: Boolean(record?.refresh_token),
    expire_in: record?.expire_in ?? null,
    error: record?.error ? "token_api_error" : null,
  };
}
