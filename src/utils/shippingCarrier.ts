import type { Order } from '../types';

export type ShippingCarrierFilter = 'all' | 'spx' | 'ghn' | 'instant' | 'other';

/** Bỏ dấu tiếng Việt để so khớp ổn định (Hỏa Tốc → hoa toc). */
function stripDiacritics(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D');
}

/**
 * Gom mọi field tên ĐVVC / kênh giao từ order (Shopee v2 + fallback mã VĐ).
 * Ưu tiên shipping_carrier — đúng field API get_order_detail.
 */
export function getOrderCarrierText(order: Order | Record<string, unknown>): string {
  const o = order as Record<string, unknown>;
  const parts = [
    o.shipping_carrier,
    o.shippingCarrier,
    o.checkout_shipping_carrier,
    o.checkoutShippingCarrier,
    o.logistics_channel_name,
    o.logisticsChannelName,
    o.shipping_type,
    o.shippingType,
  ]
    .map((v) => String(v || '').trim())
    .filter(Boolean);

  // Fallback: mã vận đơn SPXVN... / GHN... khi DB cũ thiếu shipping_carrier
  const tn = String(o.trackingNumber || o.tracking_no || '').trim();
  if (tn) parts.push(tn);

  return stripDiacritics(parts.join(' | ').toLowerCase());
}

function isInstantCarrierText(text: string): boolean {
  if (!text) return false;
  return (
    text.includes('instant') ||
    text.includes('hoa toc') ||
    text.includes('shopee xpress instant') ||
    text.includes('spx instant') ||
    text.includes('grabexpress') ||
    text.includes('grab express') ||
    /\bgrab\b/.test(text) ||
    text.includes('ahamove') ||
    text.includes('bedelivery') ||
    text.includes('be delivery') ||
    text.includes('green sm') ||
    text.includes('greensm')
  );
}

function isSpxCarrierText(text: string): boolean {
  if (!text || isInstantCarrierText(text)) return false;
  if (text.includes('spx')) return true;
  if (text.includes('shopee express')) return true;
  if (text.includes('shopee xpress')) return true;
  if (text.includes('shopeeexpress')) return true;
  // Mã vận đơn SPX
  if (text.includes('spxvn')) return true;
  return false;
}

function isGhnCarrierText(text: string): boolean {
  if (!text) return false;
  if (text.includes('giao hang nhanh')) return true;
  if (text.includes('giaohangnhanh')) return true;
  if (/\bghn\b/.test(text) || text.includes('ghn ')) return true;
  if (text.includes('| ghn') || text.startsWith('ghn')) return true;
  // Mã vận đơn GHN (GYA...)
  if (/\bgya[a-z0-9]{4,}\b/.test(text)) return true;
  return false;
}

/** Đơn Hỏa Tốc / Instant — kiểm tra trước các nhóm khác. */
export function isInstantShippingOrder(order: Order | Record<string, unknown>): boolean {
  return isInstantCarrierText(getOrderCarrierText(order));
}

/**
 * Phân loại ĐVVC — DÙNG CHUNG cho filter danh sách + badge count.
 * Thứ tự: Instant → SPX Express → GHN → ĐVVC Khác.
 */
export function getShippingCarrierGroup(
  order: Order | Record<string, unknown>,
): Exclude<ShippingCarrierFilter, 'all'> {
  const text = getOrderCarrierText(order);
  if (isInstantCarrierText(text)) return 'instant';
  if (isSpxCarrierText(text)) return 'spx';
  if (isGhnCarrierText(text)) return 'ghn';
  return 'other';
}

/** true khi order thuộc nhóm filter đang chọn (all = luôn true). */
export function orderMatchesShippingCarrierFilter(
  order: Order | Record<string, unknown>,
  filter: ShippingCarrierFilter,
): boolean {
  if (filter === 'all') return true;
  return getShippingCarrierGroup(order) === filter;
}

/** Suy nhãn ĐVVC chuẩn khi thiếu shipping_carrier (heal DB / API). */
export function inferShippingCarrierLabel(
  order: Order | Record<string, unknown>,
): string | undefined {
  const existing = String(
    (order as any).shipping_carrier || (order as any).shippingCarrier || '',
  ).trim();
  if (existing) return existing;

  const group = getShippingCarrierGroup(order);
  if (group === 'spx') return 'SPX Express';
  if (group === 'ghn') return 'Giao Hàng Nhanh';
  if (group === 'instant') {
    const text = getOrderCarrierText(order);
    if (text.includes('grab')) return 'GrabExpress';
    if (text.includes('ahamove')) return 'Ahamove';
    if (text.includes('bedelivery') || text.includes('be delivery')) return 'beDelivery';
    return 'SPX Instant';
  }
  return undefined;
}
