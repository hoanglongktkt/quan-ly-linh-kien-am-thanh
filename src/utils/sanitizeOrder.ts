import type { AppliedSystemFee, Order } from '../types';
import { parseShopeeFees, parseCustomCostItems } from './shopeeFees';
import { inferShippingCarrierLabel } from './shippingCarrier';
import { isTruthyFlag } from './orderWarehouseStatus';
import { isUnshippedShopeeCancel, classifyShopeeCancelReturnKind } from './shopeeCancelReturnClassify';

/** Parse create_time (unix s/ms) / ISO / Date — không crash khi null. */
export function parseOrderTimeMs(raw: unknown): number {
  if (raw == null || raw === '') return 0;
  if (raw instanceof Date) {
    const t = raw.getTime();
    return Number.isFinite(t) ? t : 0;
  }
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    if (raw <= 0) return 0;
    return raw < 1e12 ? Math.floor(raw * 1000) : Math.floor(raw);
  }
  const s = String(raw).trim();
  if (!s) return 0;
  if (/^\d+(\.\d+)?$/.test(s)) {
    const n = Number(s);
    if (!Number.isFinite(n) || n <= 0) return 0;
    return n < 1e12 ? Math.floor(n * 1000) : Math.floor(n);
  }
  const parsed = Date.parse(s);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Thời gian tạo đơn — ưu tiên create_time Shopee, fallback date/createdAt. */
export function orderCreatedAtMs(order: unknown): number {
  if (!order || typeof order !== 'object') return 0;
  const row = order as Record<string, unknown>;
  const nested =
    row.data && typeof row.data === 'object' && !Array.isArray(row.data)
      ? (row.data as Record<string, unknown>)
      : {};
  const candidates = [
    row.create_time,
    row.createTime,
    nested.create_time,
    nested.createTime,
    row.created_at,
    row.createdAt,
    nested.created_at,
    nested.createdAt,
    row.date,
    nested.date,
    row.update_time,
    nested.update_time,
  ];
  for (let i = 0; i < candidates.length; i += 1) {
    const t = parseOrderTimeMs(candidates[i]);
    if (t > 0) return t;
  }
  return 0;
}

/** Trộn đa shop: sort mới nhất → cũ nhất TRƯỚC setOrders. */
export function sortOrdersByCreatedAtDesc(list: Order[]): Order[] {
  return list.slice().sort((a, b) => {
    const diff = orderCreatedAtMs(b) - orderCreatedAtMs(a);
    if (diff !== 0) return diff;
    return String(b.orderSn || b.id || '').localeCompare(String(a.orderSn || a.id || ''));
  });
}

/** Chuẩn hóa đơn từ API — tránh crash khi thiếu date/orderSn/items. */
export function sanitizeOrder(raw: Partial<Order> & Record<string, unknown>): Order {
  const orderSn = String(raw.orderSn || raw.order_sn || raw.id || '')
    .replace(/^shopee-/i, '')
    .trim();
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
    channel: ((): Order['channel'] => {
      const ch = String(raw.channel || '').trim().toLowerCase();
      if (ch === 'shopee' || ch === 'tiktok' || ch === 'woocommerce' || ch === 'manual') {
        return ch;
      }
      // Refresh $project có thể chỉ còn root channel / shopee_order_status — không default 'manual'.
      if (raw.shopee_order_status || raw.shopId || raw.shop_id) return 'shopee';
      return 'manual';
    })(),
    shopId: raw.shopId
      ? String(raw.shopId)
      : raw.shop_id
        ? String(raw.shop_id)
        : undefined,
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
    date: (() => {
      const ms = orderCreatedAtMs(raw);
      if (ms > 0) return new Date(ms).toISOString();
      return String(raw.date || '').trim();
    })(),
    items: Array.isArray(raw.items) && raw.items.length > 0
      ? raw.items
      : (() => {
          const list = (raw as any).item_list;
          if (!Array.isArray(list) || list.length === 0) return [];
          return list.map((it: any) => ({
            productId: String(it?.item_id ?? it?.productId ?? ''),
            productTitle: String(it?.item_name ?? it?.productTitle ?? it?.name ?? ''),
            productImage: String(
              it?.image_info?.image_url ?? it?.productImage ?? it?.image_url ?? '',
            ).trim() || undefined,
            quantity: Math.max(0, Number(it?.model_quantity_purchased ?? it?.quantity) || 0),
            price: Number(it?.model_discounted_price ?? it?.item_price ?? it?.price) || 0,
            originalPrice: Number(it?.model_original_price ?? it?.originalPrice) || undefined,
            modelId: it?.model_id != null ? String(it.model_id) : undefined,
            modelSku: it?.model_sku != null ? String(it.model_sku) : undefined,
            modelName: it?.model_name != null ? String(it.model_name) : undefined,
          }));
        })(),
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
    return_sn:
      raw.return_sn && !isUnshippedShopeeCancel(raw)
        ? String(raw.return_sn)
        : undefined,
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
      const classified = classifyShopeeCancelReturnKind(raw as any);
      if (classified) return classified;
      const k = String(raw.shopee_cancel_return_kind || '').trim();
      if (k === 'refund_return' || k === 'cancelled' || k === 'failed_delivery') return k;
      return undefined;
    })(),
    sub_status: (() => {
      const classified = classifyShopeeCancelReturnKind(raw as any);
      if (classified === 'failed_delivery') return 'RTS';
      if (classified === 'cancelled') return 'CANCELLED';
      if (classified === 'refund_return') return 'RETURN';
      const s = String(raw.sub_status || '').trim().toUpperCase();
      if (s === 'RTS' || s === 'CANCELLED' || s === 'RETURN') return s;
      return undefined;
    })(),
    is_rts: classifyShopeeCancelReturnKind(raw as any) === 'failed_delivery',
    is_return:
      classifyShopeeCancelReturnKind(raw as any) === 'refund_return' &&
      !isUnshippedShopeeCancel(raw),
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
        (raw as any).waybill_url ??
        (raw.labelUrl || raw.pdfUrl || raw.pdfFilename),
    ),
    readyToPrint: Boolean(
      raw.readyToPrint ??
        raw.hasPdf ??
        (raw as any).waybill_url ??
        (raw.labelUrl || raw.pdfUrl || raw.pdfFilename),
    ),
    labelUrl: raw.labelUrl
      ? String(raw.labelUrl)
      : (raw as any).waybill_url
        ? String((raw as any).waybill_url)
        : undefined,
    pdfUrl: raw.pdfUrl
      ? String(raw.pdfUrl)
      : raw.labelUrl
        ? String(raw.labelUrl)
        : (raw as any).waybill_url
          ? String((raw as any).waybill_url)
          : undefined,
    pdfFilename: raw.pdfFilename ? String(raw.pdfFilename) : undefined,
    waybill_url: (() => {
      const v = String(
        (raw as any).waybill_url || raw.labelUrl || raw.pdfUrl || '',
      ).trim();
      return v || undefined;
    })(),
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
      const addr = (raw as any).recipient_address;
      const v = String(
        raw.customerName ||
          (raw as any).customer_name ||
          (raw as any).buyer_username ||
          addr?.name ||
          addr?.recipient_name ||
          '',
      ).trim();
      return v || undefined;
    })(),
    customerPhone: (() => {
      const addr = (raw as any).recipient_address;
      const v = String(
        raw.customerPhone ||
          (raw as any).customer_phone ||
          addr?.phone ||
          addr?.phone_number ||
          '',
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
      const addr = (raw as any).recipient_address;
      const fromAddr = addr
        ? [addr.full_address, addr.address, addr.district, addr.city, addr.state]
            .map((p) => String(p || '').trim())
            .filter(Boolean)
            .join(', ')
        : '';
      const v = String(
        raw.customerAddress || (raw as any).customer_address || fromAddr || '',
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
