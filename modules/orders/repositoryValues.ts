// Hàm thuần dùng cho repository MongoDB; không khởi tạo kết nối.
/** Parse Shopee unix (giây/ms) hoặc ISO/Date → Date hợp lệ. */
export function coerceShopeeWatermarkDate(value: unknown): Date | null {
  if (value == null || value === "") return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    const ms = value > 0 && value < 1e12 ? value * 1000 : value;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const raw = String(value).trim();
  if (!raw) return null;
  if (/^\d+(\.\d+)?$/.test(raw)) {
    const n = Number(raw);
    if (!Number.isFinite(n)) return null;
    const ms = n > 0 && n < 1e12 ? n * 1000 : n;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Mã vận đơn hợp lệ: khác undefined, null và chuỗi rỗng (sau trim).
 * Mã nội bộ Shopee 0FG không phải vận đơn — không tính là đã có mã.
 */
export function isValidTrackingNo(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  const s = String(value).trim();
  if (!s || /^0FG/i.test(s)) return false;
  return true;
}
