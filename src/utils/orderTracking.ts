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

/** Mã vận đơn thực tế để hiển thị — luôn hiện nếu DB có (kể cả đơn hủy/hoàn). */
export function getCarrierWaybillDisplay(
  order: Pick<Order, 'trackingNumber' | 'internalTrackingCode' | 'return_tracking_no'> & {
    tracking_no?: string;
  },
): string {
  const candidates = [
    order.return_tracking_no,
    order.trackingNumber,
    order.tracking_no,
  ];
  for (const c of candidates) {
    const tn = String(c || '').trim();
    if (!tn || isShopeeInternalTrackingCode(tn)) continue;
    // Không ẩn mã chỉ vì format lạ — đơn hoàn thường là SPXVN...
    return tn;
  }
  return '';
}
