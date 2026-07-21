import type { AppliedSystemFee, Order } from '../types';
import { parseShopeeFees, parseCustomCostItems } from './shopeeFees';
import { inferShippingCarrierLabel } from './shippingCarrier';

/** Chuẩn hóa đơn từ API — tránh crash khi thiếu date/orderSn/items. */
export function sanitizeOrder(raw: Partial<Order> & Record<string, unknown>): Order {
  const orderSn = String(raw.orderSn || raw.id || '').replace(/^shopee-/i, '').trim();
  const id = String(raw.id || (orderSn ? `shopee-${orderSn}` : `order-${Date.now()}`));
  const shippingCarrierRaw = String(raw.shipping_carrier || raw.shippingCarrier || '').trim();
  const checkoutCarrierRaw = String(
    raw.checkout_shipping_carrier || raw.checkoutShippingCarrier || '',
  ).trim();
  const shippingTypeRaw = String(raw.shipping_type || raw.shippingType || '').trim();
  const logisticsChannelId = Number(raw.logistics_channel_id ?? raw.logisticsChannelId);
  const draftForInfer = {
    ...raw,
    shipping_carrier: shippingCarrierRaw || undefined,
    checkout_shipping_carrier: checkoutCarrierRaw || undefined,
    shipping_type: shippingTypeRaw || undefined,
    trackingNumber: raw.trackingNumber || raw.tracking_no,
    tracking_no: raw.tracking_no || raw.trackingNumber,
  };
  const inferredCarrier = shippingCarrierRaw || inferShippingCarrierLabel(draftForInfer) || '';
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
    item_amount: raw.item_amount != null ? Number(raw.item_amount) : undefined,
    revenue: Number(raw.revenue) || 0,
    custom_costs: raw.custom_costs != null ? Math.max(0, Number(raw.custom_costs) || 0) : undefined,
    custom_cost_items: parseCustomCostItems(raw.custom_cost_items ?? raw.customCostItems),
    escrow_synced: raw.escrow_synced != null ? Boolean(raw.escrow_synced) : undefined,
    finance_source: raw.finance_source as Order['finance_source'],
    withholdingCitTax: Math.max(0, Number(raw.withholdingCitTax ?? raw.withholding_cit_tax) || 0),
    withholding_cit_tax: Math.max(0, Number(raw.withholding_cit_tax ?? raw.withholdingCitTax) || 0),
    escrowAmount: raw.escrowAmount != null ? Number(raw.escrowAmount) : undefined,
    shopee_fees: parseShopeeFees(raw.shopee_fees ?? raw.shopeeFees),
    estimated_fee_items: Array.isArray(raw.estimated_fee_items)
      ? raw.estimated_fee_items
          .map((item): AppliedSystemFee | null => {
            const row = (item || {}) as Record<string, unknown>;
            const amount = Math.max(0, Number(row.amount) || 0);
            const name = String(row.name || '').trim();
            if (!name) return null;
            return {
              id: String(row.id || name),
              name,
              amount,
              calculationType: row.calculationType === 'percentage' ? 'percentage' : 'fixed',
              value: Math.max(0, Number(row.value) || 0),
            };
          })
          .filter((item): item is AppliedSystemFee => item !== null)
      : undefined,
    partialCancel: Boolean(raw.partialCancel),
    canPartialCancel: raw.canPartialCancel != null ? Boolean(raw.canPartialCancel) : undefined,
    shopee_order_status: raw.shopee_order_status ? String(raw.shopee_order_status) : undefined,
    status: (raw.status as Order['status']) || 'unprocessed',
    date: String(raw.date || new Date().toISOString()),
    items: Array.isArray(raw.items) ? raw.items : [],
    trackingNumber: raw.trackingNumber || raw.tracking_no || raw.return_tracking_no
      ? String(raw.trackingNumber || raw.tracking_no || raw.return_tracking_no)
      : undefined,
    tracking_no: raw.tracking_no || raw.trackingNumber || raw.return_tracking_no
      ? String(raw.tracking_no || raw.trackingNumber || raw.return_tracking_no)
      : undefined,
    fulfillment_type: (() => {
      const v = String(
        raw.fulfillment_type || raw.ship_method || raw.shipping_method || raw.fulfillmentType || '',
      )
        .trim()
        .toLowerCase();
      if (v === 'dropoff' || v === 'drop_off' || v === 'drop-off') return 'dropoff';
      if (v === 'pickup' || v === 'pick_up' || v === 'pick-up') return 'pickup';
      return v || undefined;
    })(),
    ship_method: (() => {
      const v = String(raw.ship_method || raw.fulfillment_type || raw.shipping_method || '')
        .trim()
        .toLowerCase();
      if (v === 'dropoff' || v === 'drop_off' || v === 'drop-off') return 'dropoff';
      if (v === 'pickup' || v === 'pick_up' || v === 'pick-up') return 'pickup';
      return undefined;
    })(),
    shipping_carrier: inferredCarrier || undefined,
    checkout_shipping_carrier: checkoutCarrierRaw || undefined,
    logistics_channel_id:
      Number.isFinite(logisticsChannelId) && logisticsChannelId > 0
        ? logisticsChannelId
        : undefined,
    shipping_type: shippingTypeRaw || undefined,
    return_tracking_no: raw.return_tracking_no
      ? String(raw.return_tracking_no)
      : undefined,
    return_sn: raw.return_sn ? String(raw.return_sn) : undefined,
    return_status: raw.return_status ? String(raw.return_status) : undefined,
    return_refund_request_type:
      raw.return_refund_request_type != null
        ? Number(raw.return_refund_request_type)
        : undefined,
    shopee_cancel_return_kind: (() => {
      const k = String(raw.shopee_cancel_return_kind || '').trim();
      if (k === 'refund_return' || k === 'cancelled' || k === 'failed_delivery') return k;
      return undefined;
    })(),
    internalTrackingCode: raw.internalTrackingCode ? String(raw.internalTrackingCode) : undefined,
    packageNumber: raw.packageNumber ? String(raw.packageNumber) : undefined,
    is_pending_shopee_check: Boolean(raw.is_pending_shopee_check),
    isPrepared: Boolean(raw.isPrepared),
    isPrinted: Boolean(raw.isPrinted),
    isHandedOverToCarrier: Boolean(raw.isHandedOverToCarrier ?? raw.is_handed_over_to_carrier),
    is_handed_over_to_carrier: Boolean(raw.is_handed_over_to_carrier ?? raw.isHandedOverToCarrier),
    local_status: (() => {
      const v = String(raw.local_status ?? raw.localStatus ?? '').toUpperCase();
      if (v === 'HANDED_OVER' || v === 'CANCELLED_STORED' || v === 'RETURN_RECEIVED' || v === 'NONE') {
        return v as Order['local_status'];
      }
      if (raw.isHandedOverToCarrier || raw.is_handed_over_to_carrier) return 'HANDED_OVER';
      if (raw.status === 'return_received') return 'RETURN_RECEIVED';
      return undefined;
    })(),
    localStatus: (() => {
      const v = String(raw.localStatus ?? raw.local_status ?? '').toUpperCase();
      if (v === 'HANDED_OVER' || v === 'CANCELLED_STORED' || v === 'RETURN_RECEIVED' || v === 'NONE') {
        return v as Order['localStatus'];
      }
      if (raw.isHandedOverToCarrier || raw.is_handed_over_to_carrier) return 'HANDED_OVER';
      if (raw.status === 'return_received') return 'RETURN_RECEIVED';
      return undefined;
    })(),
    localStatusAt: raw.localStatusAt || raw.local_status_updated_at
      ? String(raw.localStatusAt || raw.local_status_updated_at)
      : undefined,
    local_status_updated_at: raw.local_status_updated_at || raw.localStatusAt
      ? String(raw.local_status_updated_at || raw.localStatusAt)
      : undefined,
    is_local_return_archived: Boolean(raw.is_local_return_archived),
    handedOverAt: raw.handedOverAt ? String(raw.handedOverAt) : undefined,
    notes: raw.notes ? String(raw.notes) : undefined,
  };
}

export function sanitizeOrders(list: unknown): Order[] {
  if (!Array.isArray(list)) return [];
  return list.map((item) => sanitizeOrder((item || {}) as Partial<Order> & Record<string, unknown>));
}
