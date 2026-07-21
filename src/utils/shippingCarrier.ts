import type { Order } from '../types';

export type ShippingCarrierFilter = 'all' | 'spx' | 'ghn' | 'instant' | 'other';

/** Bỏ dấu tiếng Việt để so khớp tên ĐVVC ổn định. */
function stripDiacritics(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D');
}

function collectCarrierBlob(order: Order | Record<string, unknown>): string {
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
    o.shipping_method,
    o.shippingMethod,
  ]
    .map((v) => String(v || '').trim())
    .filter(Boolean);

  const tn = String(o.trackingNumber || o.tracking_no || '').trim();
  if (tn) parts.push(tn);

  return stripDiacritics(parts.join(' ').toLowerCase());
}

function blobLooksInstant(blob: string): boolean {
  if (!blob) return false;
  return (
    /\binstant\b/.test(blob) ||
    blob.includes('hoa toc') ||
    blob.includes('spx instant') ||
    blob.includes('grabexpress') ||
    blob.includes('grab express') ||
    blob.includes('ahamove') ||
    blob.includes('bedelivery') ||
    blob.includes('be delivery') ||
    blob.includes('green sm') ||
    blob.includes('greensm')
  );
}

function blobLooksSpx(blob: string): boolean {
  if (!blob || blobLooksInstant(blob)) return false;
  if (blob.includes('spx')) return true;
  if (blob.includes('shopee express') || blob.includes('shopee xpress')) return true;
  if (blob.includes('shopeeexpress')) return true;
  // Mã vận đơn SPX (SPXVN...)
  if (blob.includes('spxvn') || /\bspx[a-z0-9]{6,}/.test(blob)) return true;
  return false;
}

function blobLooksGhn(blob: string): boolean {
  if (!blob) return false;
  if (blob.includes('ghn')) return true;
  if (blob.includes('giao hang nhanh') || blob.includes('giaohangnhanh')) return true;
  // Mã vận đơn GHN thường dạng GYA...
  if (/\bgya[a-z0-9]{4,}\b/.test(blob)) return true;
  return false;
}

/** Đơn Hỏa Tốc / Instant (SPX Instant, Grab, Ahamove, ...). */
export function isInstantShippingOrder(order: Order | Record<string, unknown>): boolean {
  return blobLooksInstant(collectCarrierBlob(order));
}

/**
 * Nhóm ĐVVC cho bộ lọc chip.
 * Ưu tiên: Instant → SPX → GHN → Khác.
 * Dùng nhiều field + mã vận đơn vì DB cũ thường thiếu shipping_carrier.
 */
export function getShippingCarrierGroup(
  order: Order | Record<string, unknown>,
): Exclude<ShippingCarrierFilter, 'all'> {
  const blob = collectCarrierBlob(order);
  if (blobLooksInstant(blob)) return 'instant';
  if (blobLooksSpx(blob)) return 'spx';
  if (blobLooksGhn(blob)) return 'ghn';
  return 'other';
}

/** Suy tên ĐVVC chuẩn khi thiếu shipping_carrier (heal DB / API). */
export function inferShippingCarrierLabel(order: Order | Record<string, unknown>): string | undefined {
  const existing = String(
    (order as any).shipping_carrier || (order as any).shippingCarrier || '',
  ).trim();
  if (existing) return existing;

  const group = getShippingCarrierGroup(order);
  if (group === 'spx') return 'SPX Express';
  if (group === 'ghn') return 'Giao Hàng Nhanh';
  if (group === 'instant') {
    const blob = collectCarrierBlob(order);
    if (blob.includes('grab')) return 'GrabExpress';
    if (blob.includes('ahamove')) return 'Ahamove';
    if (blob.includes('bedelivery') || blob.includes('be delivery')) return 'beDelivery';
    return 'SPX Instant';
  }
  return undefined;
}
