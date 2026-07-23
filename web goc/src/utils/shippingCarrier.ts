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

const SKIP_KEYS = new Set([
  'id',
  'ordersn',
  'shopid',
  'shopname',
  'channel',
  'status',
  'date',
  'items',
  'customername',
  'customerphone',
  'customeraddress',
  'totalamount',
  'revenue',
  'isprepared',
  'isprinted',
  'notes',
]);

/**
 * Thu thập mọi chuỗi liên quan ĐVVC từ order (kể cả key lạ / nested package_list).
 * Không lấy `channel=shopee` để tránh dồn tất cả đơn Shopee vào SPX.
 */
export function collectCarrierDebugFields(
  order: Order | Record<string, unknown>,
): Record<string, unknown> {
  const o = order as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  const pick = (key: string, val: unknown) => {
    if (val == null || val === '') return;
    if (typeof val === 'string' || typeof val === 'number' || typeof val === 'boolean') {
      out[key] = val;
    }
  };

  pick('shipping_carrier', o.shipping_carrier ?? o.shippingCarrier);
  pick('checkout_shipping_carrier', o.checkout_shipping_carrier ?? o.checkoutShippingCarrier);
  pick('logistics_channel_name', o.logistics_channel_name ?? o.logisticsChannelName);
  pick('logistics_channel_id', o.logistics_channel_id ?? o.logisticsChannelId);
  pick('shipping_type', o.shipping_type ?? o.shippingType);
  pick('shipping_method', o.shipping_method ?? o.shippingMethod);
  pick('fulfillment_type', o.fulfillment_type ?? o.fulfillmentType);
  pick('ship_method', o.ship_method);
  pick('carrier', o.carrier);
  pick('trackingNumber', o.trackingNumber);
  pick('tracking_no', o.tracking_no);
  pick('packageNumber', o.packageNumber);
  pick('channel_id', o.channel_id ?? o.channelId);

  for (const [k, v] of Object.entries(o)) {
    const lk = k.toLowerCase();
    if (SKIP_KEYS.has(lk)) continue;
    if (!/carrier|ship|logistic|fulfill|express|channel_name|shipping_type|tracking/.test(lk)) {
      continue;
    }
    pick(k, v);
  }

  const pkgs = o.package_list ?? o.packageList;
  if (Array.isArray(pkgs) && pkgs[0] && typeof pkgs[0] === 'object') {
    const pkg = pkgs[0] as Record<string, unknown>;
    pick('package_list[0].shipping_carrier', pkg.shipping_carrier ?? pkg.shippingCarrier);
    pick(
      'package_list[0].checkout_shipping_carrier',
      pkg.checkout_shipping_carrier ?? pkg.checkoutShippingCarrier,
    );
    pick('package_list[0].logistics_channel_id', pkg.logistics_channel_id);
    pick('package_list[0].tracking_number', pkg.tracking_number ?? pkg.trackingNumber);
  }

  return out;
}

/**
 * Gom text ĐVVC — lowercase + bỏ dấu. Dùng chung cho filter + count.
 */
export function getOrderCarrierText(order: Order | Record<string, unknown>): string {
  const fields = collectCarrierDebugFields(order);
  const parts = Object.values(fields)
    .map((v) => String(v || '').trim())
    .filter(Boolean);
  return stripDiacritics(parts.join(' | ').toLowerCase());
}

function isInstantCarrierText(text: string): boolean {
  if (!text) return false;
  // Hỏa tốc / Instant — ưu tiên trước SPX Express
  if (text.includes('instant')) return true;
  if (text.includes('hoa toc')) return true;
  if (text.includes('spx instant')) return true;
  if (text.includes('shopee xpress instant')) return true;
  if (text.includes('grabexpress') || text.includes('grab express') || /\bgrab\b/.test(text)) {
    return true;
  }
  if (text.includes('ahamove')) return true;
  if (text.includes('bedelivery') || text.includes('be delivery')) return true;
  if (text.includes('green sm') || text.includes('greensm')) return true;
  return false;
}

function isSpxCarrierText(text: string): boolean {
  if (!text || isInstantCarrierText(text)) return false;
  // spx / shopee express / standard (Shopee VN)
  if (text.includes('spx')) return true;
  if (text.includes('shopee')) return true; // Shopee Express / Shopee Xpress / ...
  if (text.includes('standard')) return true;
  // Mã vận đơn SPXVN...
  if (text.includes('spxvn')) return true;
  return false;
}

function isGhnCarrierText(text: string): boolean {
  if (!text) return false;
  if (text.includes('giao hang nhanh') || text.includes('giaohangnhanh')) return true;
  if (text.includes('ghn')) return true;
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

  // DB cũ thường chỉ có packageNumber OFG... — chưa có shipping_carrier.
  // Đơn Shopee không có tín hiệu GHN/Instant → mặc định SPX Express (phổ biến VN).
  const channel = String((order as Order).channel || '').toLowerCase();
  const meaningful = text
    .replace(/ofg[a-z0-9]*/g, ' ')
    .replace(/0fg[a-z0-9]*/g, ' ')
    .replace(/\|/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!meaningful && channel === 'shopee') return 'spx';

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
