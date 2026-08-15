import type { AppliedSystemFee, Order } from '../types';
import { parseShopeeFees, parseCustomCostItems } from './shopeeFees';
import { inferShippingCarrierLabel } from './shippingCarrier';
import { isTruthyFlag } from './orderWarehouseStatus';

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
  const rawShopeeStatus = String(raw.shopee_order_status || '').toUpperCase();
  let status = (raw.status as Order['status']) || 'unprocessed';
  // Heal: status local stale pending_* nhưng Shopee đã đổi trạng thái → đưa về đúng tab.
  if (status === 'pending_confirm' || status === 'pending_verification') {
    const hasTracking = Boolean(
      String(raw.trackingNumber || raw.tracking_no || '').trim(),
    );
    if (rawShopeeStatus === 'CANCELLED' || rawShopeeStatus === 'IN_CANCEL') {
      status = 'cancelled';
    } else if (rawShopeeStatus === 'PROCESSED' || (hasTracking && (rawShopeeStatus === 'READY_TO_SHIP' || rawShopeeStatus === 'RETRY_SHIP'))) {
      status = 'processed';
    } else if (rawShopeeStatus === 'READY_TO_SHIP' || rawShopeeStatus === 'RETRY_SHIP') {
      status = 'unprocessed';
    } else if (rawShopeeStatus === 'SHIPPED' || rawShopeeStatus === 'TO_CONFIRM_RECEIVE') {
      status = 'shipping';
    } else if (rawShopeeStatus === 'COMPLETED') {
      status = 'completed';
    }
  }
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
    seller_voucher: raw.seller_voucher != null ? Math.max(0, Number(raw.seller_voucher) || 0) : undefined,
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
    status,
    date: String(raw.date || new Date().toISOString()),
    items: Array.isArray(raw.items) ? raw.items : [],
    // Mã hoàn trả không phải vận đơn giao đi. Dùng nó ở đây sẽ làm đơn hoàn bị
    // phân loại nhầm là đã xử lý/đang giao.
    trackingNumber: raw.trackingNumber || raw.tracking_no
      ? String(raw.trackingNumber || raw.tracking_no)
      : undefined,
    tracking_no: raw.tracking_no || raw.trackingNumber
      ? String(raw.tracking_no || raw.trackingNumber)
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
    logistics_status: (() => {
      const v = String(raw.logistics_status || raw.logisticsStatus || '').trim();
      return v || undefined;
    })(),
    return_tracking_no: raw.return_tracking_no || raw.returnTrackingNumber
      ? String(raw.return_tracking_no || raw.returnTrackingNumber).trim().toUpperCase()
      : undefined,
    returnTrackingNumber: raw.return_tracking_no || raw.returnTrackingNumber
      ? String(raw.return_tracking_no || raw.returnTrackingNumber).trim().toUpperCase()
      : undefined,
    return_sn: raw.return_sn ? String(raw.return_sn) : undefined,
    return_status: raw.return_status ? String(raw.return_status) : undefined,
    refund_amount:
      raw.refund_amount != null && Number.isFinite(Number(raw.refund_amount))
        ? Number(raw.refund_amount)
        : undefined,
    return_reason: raw.return_reason || raw.reason
      ? String(raw.return_reason || raw.reason)
      : undefined,
    text_reason: raw.text_reason ? String(raw.text_reason) : undefined,
    return_refund_request_type:
      raw.return_refund_request_type != null
        ? Number(raw.return_refund_request_type)
        : undefined,
    shopee_cancel_return_kind: (() => {
      const k = String(raw.shopee_cancel_return_kind || '').trim();
      if (k === 'refund_return' || k === 'cancelled' || k === 'failed_delivery') return k;
      return undefined;
    })(),
    sub_status: (() => {
      const s = String(raw.sub_status || '').trim().toUpperCase();
      if (s === 'RTS' || s === 'CANCELLED' || s === 'RETURN') return s;
      return undefined;
    })(),
    is_rts:
      Boolean(raw.is_rts) ||
      String(raw.sub_status || '').toUpperCase() === 'RTS' ||
      String(raw.shopee_cancel_return_kind || '') === 'failed_delivery',
    cancel_reason: raw.cancel_reason ? String(raw.cancel_reason) : undefined,
    buyer_cancel_reason: raw.buyer_cancel_reason ? String(raw.buyer_cancel_reason) : undefined,
    cancel_by: raw.cancel_by ? String(raw.cancel_by) : undefined,
    internalTrackingCode: raw.internalTrackingCode ? String(raw.internalTrackingCode) : undefined,
    packageNumber: raw.packageNumber || raw.package_number
      ? String(raw.packageNumber || raw.package_number)
      : undefined,
    is_pending_shopee_check: Boolean(raw.is_pending_shopee_check),
    isPrepared: Boolean(raw.isPrepared),
    isPrinted: isTruthyFlag(raw.isPrinted),
    hasPdf: Boolean(
      raw.hasPdf ??
        raw.readyToPrint ??
        (raw.labelUrl || raw.pdfUrl || raw.pdfFilename),
    ),
    readyToPrint: Boolean(
      raw.readyToPrint ??
        raw.hasPdf ??
        (raw.labelUrl || raw.pdfUrl || raw.pdfFilename),
    ),
    labelUrl: raw.labelUrl ? String(raw.labelUrl) : undefined,
    pdfUrl: raw.pdfUrl ? String(raw.pdfUrl) : raw.labelUrl ? String(raw.labelUrl) : undefined,
    pdfFilename: raw.pdfFilename ? String(raw.pdfFilename) : undefined,
    is_handed_over: (() => {
      const rawSt = String(raw.shopee_order_status || '').toUpperCase();
      if (
        rawSt === 'SHIPPED' ||
        rawSt === 'TO_CONFIRM_RECEIVE' ||
        rawSt === 'COMPLETED' ||
        status === 'shipping' ||
        status === 'completed'
      ) {
        return false;
      }
      return isTruthyFlag(
        raw.is_handed_over ??
          raw.isHandedOverToCarrier ??
          raw.is_handed_over_to_carrier ??
          raw.is_handed_over_to_courier,
      );
    })(),
    isHandedOverToCarrier: (() => {
      const rawSt = String(raw.shopee_order_status || '').toUpperCase();
      if (
        rawSt === 'SHIPPED' ||
        rawSt === 'TO_CONFIRM_RECEIVE' ||
        rawSt === 'COMPLETED' ||
        status === 'shipping' ||
        status === 'completed'
      ) {
        return false;
      }
      return isTruthyFlag(
        raw.is_handed_over ??
          raw.isHandedOverToCarrier ??
          raw.is_handed_over_to_carrier ??
          raw.is_handed_over_to_courier,
      );
    })(),
    is_handed_over_to_carrier: (() => {
      const rawSt = String(raw.shopee_order_status || '').toUpperCase();
      if (
        rawSt === 'SHIPPED' ||
        rawSt === 'TO_CONFIRM_RECEIVE' ||
        rawSt === 'COMPLETED' ||
        status === 'shipping' ||
        status === 'completed'
      ) {
        return false;
      }
      return isTruthyFlag(
        raw.is_handed_over ??
          raw.is_handed_over_to_carrier ??
          raw.isHandedOverToCarrier ??
          raw.is_handed_over_to_courier,
      );
    })(),
    is_handed_over_to_courier: (() => {
      const rawSt = String(raw.shopee_order_status || '').toUpperCase();
      if (
        rawSt === 'SHIPPED' ||
        rawSt === 'TO_CONFIRM_RECEIVE' ||
        rawSt === 'COMPLETED' ||
        status === 'shipping' ||
        status === 'completed'
      ) {
        return false;
      }
      return isTruthyFlag(
        raw.is_handed_over ??
          raw.is_handed_over_to_courier ??
          raw.is_handed_over_to_carrier ??
          raw.isHandedOverToCarrier,
      );
    })(),
    local_status: (() => {
      const v = String(
        raw.local_status ?? raw.localStatus ?? raw.internal_status ?? raw.scanFlag ?? '',
      ).toUpperCase();
      if (v === 'HANDED_OVER' || v === 'CANCELLED_STORED' || v === 'RETURN_RECEIVED' || v === 'NONE') {
        return v as Order['local_status'];
      }
      if (
        isTruthyFlag(raw.is_handed_over) ||
        isTruthyFlag(raw.isHandedOverToCarrier) ||
        isTruthyFlag(raw.is_handed_over_to_carrier) ||
        isTruthyFlag(raw.is_handed_over_to_courier)
      ) {
        return 'HANDED_OVER';
      }
      return undefined;
    })(),
    localStatus: (() => {
      const v = String(
        raw.localStatus ?? raw.local_status ?? raw.internal_status ?? raw.scanFlag ?? '',
      ).toUpperCase();
      if (v === 'HANDED_OVER' || v === 'CANCELLED_STORED' || v === 'RETURN_RECEIVED' || v === 'NONE') {
        return v as Order['localStatus'];
      }
      if (
        isTruthyFlag(raw.isHandedOverToCarrier) ||
        isTruthyFlag(raw.is_handed_over_to_carrier) ||
        isTruthyFlag(raw.is_handed_over_to_courier)
      ) {
        return 'HANDED_OVER';
      }
      return undefined;
    })(),
    internal_status: (() => {
      const v = String(
        raw.internal_status ?? raw.local_status ?? raw.localStatus ?? '',
      ).toUpperCase();
      if (v === 'HANDED_OVER' || v === 'CANCELLED_STORED' || v === 'RETURN_RECEIVED' || v === 'NONE') {
        return v as Order['internal_status'];
      }
      if (
        isTruthyFlag(raw.isHandedOverToCarrier) ||
        isTruthyFlag(raw.is_handed_over_to_carrier) ||
        isTruthyFlag(raw.is_handed_over_to_courier)
      ) {
        return 'HANDED_OVER';
      }
      return undefined;
    })(),
    localStatusAt: raw.localStatusAt || raw.local_status_updated_at
      ? String(raw.localStatusAt || raw.local_status_updated_at)
      : undefined,
    local_status_updated_at: raw.local_status_updated_at || raw.localStatusAt
      ? String(raw.local_status_updated_at || raw.localStatusAt)
      : undefined,
    scanFlag: (() => {
      const v = String(
        raw.scanFlag ?? raw.local_status ?? raw.localStatus ?? raw.internal_status ?? '',
      ).toUpperCase();
      return v === 'RETURN_RECEIVED' || v === 'CANCELLED_STORED' || v === 'HANDED_OVER'
        ? v
        : undefined;
    })(),
    is_local_return_archived: Boolean(raw.is_local_return_archived),
    handedOverAt: raw.handedOverAt ? String(raw.handedOverAt) : undefined,
    handed_over_source: raw.handed_over_source
      ? String(raw.handed_over_source)
      : raw.handedOverSource
        ? String(raw.handedOverSource)
        : undefined,
    handedOverSource: raw.handedOverSource
      ? String(raw.handedOverSource)
      : raw.handed_over_source
        ? String(raw.handed_over_source)
        : undefined,
    notes: raw.notes ? String(raw.notes) : undefined,
    // ── WooCommerce / Web customer info (BẮT BUỘC khôi phục) ──
    customerName: (() => {
      const v = String(
        raw.customerName || (raw as any).customer_name || '',
      ).trim();
      return v || undefined;
    })(),
    customerPhone: (() => {
      const v = String(
        raw.customerPhone || (raw as any).customer_phone || '',
      ).trim();
      return v || undefined;
    })(),
    customerEmail: (() => {
      const v = String(
        raw.customerEmail || (raw as any).customer_email || '',
      ).trim();
      return v || undefined;
    })(),
    customerAddress: (() => {
      const v = String(
        raw.customerAddress || (raw as any).customer_address || '',
      ).trim();
      return v || undefined;
    })(),
    wooOrderId: raw.wooOrderId ? String(raw.wooOrderId) : undefined,
    wooOrderNumber: raw.wooOrderNumber ? String(raw.wooOrderNumber) : undefined,
    wooStatus: raw.wooStatus ? String(raw.wooStatus) : undefined,
    billingAddress: (() => {
      if (typeof raw.billingAddress === 'string' && raw.billingAddress.trim()) {
        return raw.billingAddress.trim();
      }
      return undefined;
    })(),
    shippingAddress: (() => {
      if (typeof raw.shippingAddress === 'string' && raw.shippingAddress.trim()) {
        return raw.shippingAddress.trim();
      }
      if (raw.shippingAddress && typeof raw.shippingAddress === 'object') {
        return raw.shippingAddress as Order['shippingAddress'];
      }
      return undefined;
    })(),
    billing: (() => {
      const b = raw.billing;
      if (b && typeof b === 'object' && !Array.isArray(b)) {
        return b as Order['billing'];
      }
      return undefined;
    })(),
    shipping: (() => {
      const s = raw.shipping;
      if (s && typeof s === 'object' && !Array.isArray(s)) {
        return s as Order['shipping'];
      }
      return undefined;
    })(),
  };
}

export function sanitizeOrders(list: unknown): Order[] {
  if (!Array.isArray(list)) return [];
  return list.map((item) => sanitizeOrder((item || {}) as Partial<Order> & Record<string, unknown>));
}
