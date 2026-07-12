import type { Order } from '../types';

/** Shopee sorting / first-mile code on AWB (0FG...) — không hiển thị trên UI. */
export function isShopeeInternalTrackingCode(code: unknown): boolean {
  return /^0FG/i.test(String(code || '').trim());
}

/** Carrier tracking on shipping label (SPXVN..., GHN..., ...). */
export function isCarrierTrackingCode(code: unknown): boolean {
  const k = String(code || '').trim().toUpperCase();
  if (!k || isShopeeInternalTrackingCode(k)) return false;
  return /^(SPX(VN)?|GHN|GHTK|JNT|JT|NINJA|VTP|VNPOST|LEX|NJV|GRB|MY|SG|TH|ID|PH)/.test(k);
}

/** Mã vận đơn thực tế để hiển thị trên danh sách — chỉ carrier, không bao giờ 0FG. */
export function getCarrierWaybillDisplay(order: Pick<Order, 'trackingNumber' | 'internalTrackingCode'>): string {
  const tn = String(order.trackingNumber || '').trim();
  if (!tn || isShopeeInternalTrackingCode(tn)) return '';
  if (isCarrierTrackingCode(tn)) return tn;
  return '';
}
