/**
 * Phân loại Hủy / RTS / Return theo Shopee Open API v2.
 *
 * Docs:
 * - get_order_list order_status=CANCELLED gồm CẢ đơn hủy thường VÀ giao thất bại.
 * - RTS (Giao hàng không thành công) = CANCELLED + logistics/cancel_reason giao thất bại.
 * - Return/Refund = get_return_list (return_sn) / order_status=TO_RETURN.
 */

export type ShopeeCancelReturnKind = 'refund_return' | 'cancelled' | 'failed_delivery';

/** logistics_status outbound — giao thất bại / mất hàng / COD bị từ chối. */
export const SHOPEE_RTS_LOGISTICS_STATUSES = [
  'LOGISTICS_DELIVERY_FAILED',
  'LOGISTICS_LOST',
  'LOGISTICS_COD_REJECTED',
] as const;

/**
 * cancel_reason / buyer_cancel_reason từ get_order_detail.
 * Khớp Data Definition "Cancel reason": Failed Delivery, Undeliverable Area,
 * Parcel is Lost, COD Rejected.
 */
const RTS_CANCEL_REASON_RE =
  /FAILED[_\s-]?DELIVERY|UNDELIVERABLE|PARCEL[_\s-]?LOST|PARCEL\s+IS\s+LOST|COD[_\s-]?REJECTED|COD[_\s-]?NOT[_\s-]?SUPPORTED/;

export type ShopeeCancelReturnInput = {
  shopee_order_status?: string;
  status?: string;
  return_sn?: string;
  return_status?: string;
  logistics_status?: string;
  cancel_reason?: string;
  buyer_cancel_reason?: string;
  cancel_by?: string;
  sub_status?: string;
  shopee_cancel_return_kind?: string;
  local_status?: string;
  localStatus?: string;
  return_refund_request_type?: number;
};

export function isShopeeRtsLogistics(logisticsStatus?: string): boolean {
  const s = String(logisticsStatus || '').toUpperCase();
  if (!s) return false;
  if (s.includes('POST_RETURN') || s.includes('REVERSE')) return false;
  return (
    s.includes('LOGISTICS_DELIVERY_FAILED') ||
    s.includes('LOGISTICS_LOST') ||
    s.includes('LOGISTICS_COD_REJECTED') ||
    (s.includes('DELIVERY_FAILED') && !s.includes('PICKUP'))
  );
}

export function isShopeeRtsCancelReason(...reasons: Array<string | undefined>): boolean {
  const blob = reasons.filter(Boolean).join(' ').toUpperCase();
  if (!blob) return false;
  return RTS_CANCEL_REASON_RE.test(blob);
}

export function isShopeeReturnRefundOrder(order: ShopeeCancelReturnInput): boolean {
  const raw = String(order.shopee_order_status || '').toUpperCase();
  const local = String(order.local_status || order.localStatus || '').toUpperCase();
  if (String(order.return_sn || '').trim()) return true;
  if (raw === 'TO_RETURN') return true;
  if (local === 'RETURN_RECEIVED') return true;
  const rs = String(order.return_status || '').toUpperCase();
  if (
    rs &&
    /REQUESTED|PROCESSING|ACCEPTED|COMPLETED|JUDGING|SELLER_DISPUTE|CLOSED|REFUND_PAID/.test(rs)
  ) {
    return true;
  }
  if (
    (order.status === 'return_pending' || order.status === 'return_received') &&
    !isShopeeRtsFailedDelivery(order)
  ) {
    return true;
  }
  return false;
}

export function isShopeeRtsFailedDelivery(order: ShopeeCancelReturnInput): boolean {
  if (String(order.sub_status || '').toUpperCase() === 'RTS') return true;
  if (isShopeeRtsLogistics(order.logistics_status)) return true;
  if (isShopeeRtsCancelReason(order.cancel_reason, order.buyer_cancel_reason)) return true;
  return false;
}

/**
 * Ưu tiên: Return/Refund → RTS → Đơn Hủy.
 * Không tin kind cũ trước — tránh RTS bị gán nhầm cancelled.
 */
export function classifyShopeeCancelReturnKind(
  order: ShopeeCancelReturnInput,
): ShopeeCancelReturnKind | null {
  if (isShopeeReturnRefundOrder(order)) return 'refund_return';
  if (isShopeeRtsFailedDelivery(order)) return 'failed_delivery';

  const raw = String(order.shopee_order_status || '').toUpperCase();
  const local = String(order.local_status || order.localStatus || '').toUpperCase();
  if (raw === 'CANCELLED' || raw === 'IN_CANCEL' || order.status === 'cancelled') {
    return 'cancelled';
  }
  if (local === 'CANCELLED_STORED') return 'cancelled';

  const stored = String(order.shopee_cancel_return_kind || '').trim();
  if (stored === 'refund_return' || stored === 'cancelled' || stored === 'failed_delivery') {
    return stored;
  }
  return null;
}

export function resolveShopeeSubStatus(
  kind: ShopeeCancelReturnKind | null,
): 'RTS' | 'CANCELLED' | 'RETURN' | undefined {
  if (kind === 'failed_delivery') return 'RTS';
  if (kind === 'cancelled') return 'CANCELLED';
  if (kind === 'refund_return') return 'RETURN';
  return undefined;
}
