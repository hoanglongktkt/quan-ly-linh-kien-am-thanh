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
    totalAmount: Number(raw.totalAmount) || 0,
    revenue: Number(raw.revenue) || Number(raw.totalAmount) || 0,
    withholdingCitTax: Math.max(0, Number(raw.withholdingCitTax ?? raw.withholding_cit_tax) || 0),
    withholding_cit_tax: Math.max(0, Number(raw.withholding_cit_tax ?? raw.withholdingCitTax) || 0),
    escrowAmount: raw.escrowAmount != null ? Number(raw.escrowAmount) : undefined,
    partialCancel: Boolean(raw.partialCancel),
    canPartialCancel: raw.canPartialCancel != null ? Boolean(raw.canPartialCancel) : undefined,
    status: (raw.status as Order['status']) || 'unprocessed',
    date: String(raw.date || new Date().toISOString()),
    items: Array.isArray(raw.items) ? raw.items : [],
    trackingNumber: raw.trackingNumber ? String(raw.trackingNumber) : undefined,
    internalTrackingCode: raw.internalTrackingCode ? String(raw.internalTrackingCode) : undefined,
    packageNumber: raw.packageNumber ? String(raw.packageNumber) : undefined,
    isPrepared: Boolean(raw.isPrepared),
    isPrinted: Boolean(raw.isPrinted),
    isHandedOverToCarrier: Boolean(raw.isHandedOverToCarrier ?? raw.is_handed_over_to_carrier),
    is_handed_over_to_carrier: Boolean(raw.is_handed_over_to_carrier ?? raw.isHandedOverToCarrier),
    notes: raw.notes ? String(raw.notes) : undefined,
  };
}

export function sanitizeOrders(list: unknown): Order[] {
  if (!Array.isArray(list)) return [];
  return list.map((item) => sanitizeOrder((item || {}) as Partial<Order> & Record<string, unknown>));
}
