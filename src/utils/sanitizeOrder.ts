import type { Order } from '../types';

/** Chuẩn hóa đơn từ API — tránh crash khi thiếu date/orderSn/items. */
export function sanitizeOrder(raw: Partial<Order> & Record<string, unknown>): Order {
  const orderSn = String(raw.orderSn || raw.id || '').replace(/^shopee-/i, '').trim();
  const id = String(raw.id || (orderSn ? `shopee-${orderSn}` : `order-${Date.now()}`));
  return {
    id,
    orderSn: orderSn || id,
    channel: (raw.channel as Order['channel']) || 'manual',
    shopId: raw.shopId ? String(raw.shopId) : undefined,
    shopName: raw.shopName
      ? String(raw.shopName)
      : raw.shop_name
        ? String(raw.shop_name)
        : undefined,
    customerName: String(raw.customerName || 'Khách hàng'),
    customerPhone: raw.customerPhone ? String(raw.customerPhone) : undefined,
    customerAddress: raw.customerAddress ? String(raw.customerAddress) : undefined,
    totalAmount: Number(raw.totalAmount) || 0,
    revenue: Number(raw.revenue) || Number(raw.totalAmount) || 0,
    status: (raw.status as Order['status']) || 'unprocessed',
    date: String(raw.date || new Date().toISOString()),
    items: Array.isArray(raw.items) ? raw.items : [],
    trackingNumber: raw.trackingNumber ? String(raw.trackingNumber) : undefined,
    internalTrackingCode: raw.internalTrackingCode ? String(raw.internalTrackingCode) : undefined,
    packageNumber: raw.packageNumber ? String(raw.packageNumber) : undefined,
    isPrepared: Boolean(raw.isPrepared),
    isPrinted: Boolean(raw.isPrinted),
    notes: raw.notes ? String(raw.notes) : undefined,
  };
}

export function sanitizeOrders(list: unknown): Order[] {
  if (!Array.isArray(list)) return [];
  return list.map((item) => sanitizeOrder((item || {}) as Partial<Order> & Record<string, unknown>));
}
