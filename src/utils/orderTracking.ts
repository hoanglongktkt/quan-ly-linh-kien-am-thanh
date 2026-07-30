import type { Order } from '../types';

/** Shopee sorting / first-mile code on AWB (0FG...) — không hiển thị trên UI. */
export function isShopeeInternalTrackingCode(code: unknown): boolean {
  return /^0FG/i.test(String(code || '').trim());
}

/** Carrier tracking on shipping label (SPXVN..., GHN GYAGLRYW..., ...). */
export function isCarrierTrackingCode(code: unknown): boolean {
  const k = String(code || '').trim().toUpperCase();
  if (!k || isShopeeInternalTrackingCode(k)) return false;
  if (/^(SPX(VN)?|GHN|GHTK|JNT|JT|NINJA|VTP|VNPOST|LEX|NJV|GRB|BEST|NINJAVAN)/.test(k)) return true;
  // GHN / J&T thường trả mã alphanumeric 6–20 ký tự không có prefix cố định (VD: GYAGLRYW)
  if (/^[A-Z0-9][A-Z0-9\-]{5,19}$/.test(k)) return true;
  return false;
}

/**
 * Mã vận đơn hiển thị — ưu tiên outbound (tracking_no / trackingNumber).
 * return_tracking_no / scan_code / note scan:… chỉ fallback khi thiếu mã đi.
 */
export function getCarrierWaybillDisplay(
  order: Pick<Order, 'trackingNumber' | 'internalTrackingCode' | 'return_tracking_no'> & {
    tracking_no?: string;
    scan_code?: string;
    note?: string;
    orderSn?: string;
  },
): string {
  const note = String(order.note || '').trim();
  const fromNote = note.startsWith('scan:') ? note.slice(5).trim() : '';
  const candidates = [
    order.trackingNumber,
    order.tracking_no,
    order.return_tracking_no,
    order.scan_code,
    fromNote,
  ];
  const orderSn = String(order.orderSn || '').trim();
  for (const c of candidates) {
    const tn = String(c || '').trim();
    if (!tn || isShopeeInternalTrackingCode(tn)) continue;
    if (orderSn && tn === orderSn) continue;
    return tn;
  }
  return '';
}
