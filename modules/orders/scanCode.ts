// Hàm thuần dùng cho repository MongoDB; không khởi tạo kết nối.
/** Chuẩn hóa mã súng quét: trim + UPPER — exact $eq, không regex. */
export function normalizeScannedCode(raw: unknown): string {
  return String(raw || "")
    .trim()
    .toUpperCase();
}

export function stripScannedSeparators(code: string): string {
  return String(code || "").replace(/[\s\-_#./\\|:;,]+/g, "");
}
