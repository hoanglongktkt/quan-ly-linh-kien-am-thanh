/**
 * Phân loại Hủy / RTS / Return theo Shopee Open API v2.
 *
 * - Đơn Hủy = status CANCELLED, không return_sn, bất chấp tracking_no.
 * - RTS = CHỈ khi ĐVVC xác nhận giao thất bại (logistics / cancel_reason).
 * - Return/Refund = có return_sn từ get_return_list (kể cả đơn đã CANCELLED).
 *   Refund tiền khi hủy chưa giao ≠ Trả hàng hoàn tiền.
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
  is_rts?: boolean;
  is_return?: boolean;
  shopee_cancel_return_kind?: string;
  local_status?: string;
  localStatus?: string;
  return_refund_request_type?: number;
  return_tracking_no?: string;
  returnTrackingNumber?: string;
  tracking_no?: string;
  trackingNumber?: string;
};

export function hasShopeeReturnSn(order: ShopeeCancelReturnInput): boolean {
  return Boolean(String(order.return_sn || '').trim());
}

export function isShopeeCancelledStatus(order: ShopeeCancelReturnInput): boolean {
  const raw = String(order.shopee_order_status || '').toUpperCase();
  const st = String(order.status || '').toUpperCase();
  return raw === 'CANCELLED' || raw === 'IN_CANCEL' || st === 'CANCELLED';
}

/** Mã vận đơn chiều đi hợp lệ — không rỗng, không mã nội bộ 0FG. */
export function hasValidOutboundTracking(order: ShopeeCancelReturnInput): boolean {
  const tn = String(order.tracking_no || order.trackingNumber || '').trim();
  if (!tn || tn.length < 6) return false;
  if (/^0FG/i.test(tn)) return false;
  return true;
}

/** Đơn hủy chưa giao — leftover return_sn / mã hoàn ≠ Trả hàng Hoàn tiền. */
export function isUnshippedShopeeCancel(order: ShopeeCancelReturnInput): boolean {
  if (!isShopeeCancelledStatus(order)) return false;
  if (hasValidOutboundTracking(order)) return false;
  if (hasCarrierRtsEvidence(order)) return false;
  const raw = String(order.shopee_order_status || '').toUpperCase();
  if (raw === 'TO_RETURN' || raw === 'SHIPPED' || raw === 'TO_CONFIRM_RECEIVE' || raw === 'COMPLETED') {
    return false;
  }
  const st = String(order.status || '').toLowerCase();
  if (st === 'shipping' || st === 'completed' || st === 'return_pending' || st === 'return_received') {
    return false;
  }
  const logistics = String(order.logistics_status || '').toUpperCase();
  if (
    logistics &&
    /SHIPPED|PICKUP_DONE|IN_TRANSIT|DELIVERY_DONE|LOGISTICS_DELIVERY/.test(logistics) &&
    !/FAILED|LOST|RETURN|REVERSE|REQUEST_CANCELED|REQUEST_CANCELLED/.test(logistics)
  ) {
    return false;
  }
  return true;
}

export function isShopeeRtsLogistics(logisticsStatus?: string): boolean {
  const s = String(logisticsStatus || '').toUpperCase();
  if (!s) return false;
  if (s.includes('POST_RETURN') || s.includes('REVERSE')) return false;
  if (s.includes('REQUEST_CANCELED') || s.includes('REQUEST_CANCELLED')) return false;
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

/** RTS thép: chỉ log/trạng thái ĐVVC — CẤM suy từ tracking_no hay flag cũ. */
export function hasCarrierRtsEvidence(order: ShopeeCancelReturnInput): boolean {
  if (isShopeeRtsLogistics(order.logistics_status)) return true;
  if (isShopeeRtsCancelReason(order.cancel_reason, order.buyer_cancel_reason)) return true;
  return false;
}

export function isShopeeRtsFailedDelivery(order: ShopeeCancelReturnInput): boolean {
  return hasCarrierRtsEvidence(order);
}

/**
 * Return/Refund: CHỈ đơn từ get_return_list — BẮT BUỘC return_sn.
 * CANCELLED + return_sn (đơn hoàn đã chốt) vẫn là Trả hàng Hoàn tiền.
 */
export function isShopeeReturnRefundOrder(order: ShopeeCancelReturnInput): boolean {
  if (isUnshippedShopeeCancel(order)) return false;
  if (!hasShopeeReturnSn(order)) return false;
  return true;
}

/** get_return_list không overlay lên đơn Hủy chưa giao (refund tiền khi hủy ≠ trả hàng). */
export function shouldApplyShopeeReturnOverlay(
  existing?: ShopeeCancelReturnInput | null,
): boolean {
  if (!existing) return true;
  if (isUnshippedShopeeCancel(existing)) return false;
  return true;
}

/**
 * Thép: Return (có return_sn từ get_return_list) → RTS (ĐVVC) → Đơn Hủy.
 * Seller Center: đơn trong Trả hàng Hoàn tiền không bị đẩy sang RTS.
 */
export function classifyShopeeCancelReturnKind(
  order: ShopeeCancelReturnInput,
): ShopeeCancelReturnKind | null {
  if (isShopeeReturnRefundOrder(order)) return 'refund_return';
  if (hasCarrierRtsEvidence(order)) return 'failed_delivery';
  if (isShopeeCancelledStatus(order)) return 'cancelled';
  const local = String(order.local_status || order.localStatus || '').toUpperCase();
  if (local === 'CANCELLED_STORED') return 'cancelled';

  const stored = String(order.shopee_cancel_return_kind || '').trim();
  if (stored === 'refund_return' && !hasShopeeReturnSn(order)) return 'cancelled';
  if (stored === 'cancelled') return 'cancelled';
  if (stored === 'failed_delivery' && hasCarrierRtsEvidence(order)) return 'failed_delivery';
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

/** Đơn hủy thuần — ẩn cụm "Đang hoàn về". */
export function isPureUnshippedCancel(order: ShopeeCancelReturnInput): boolean {
  return classifyShopeeCancelReturnKind(order) === 'cancelled';
}

/**
 * Chỉ RTS / Trả hàng Hoàn tiền mới hiện nút kho "Xác nhận đã nhận hoàn".
 * Đơn Hủy (dù có mã VĐ) → false.
 */
export function shouldShowWarehouseReturnActions(order: ShopeeCancelReturnInput): boolean {
  const kind = classifyShopeeCancelReturnKind(order);
  if (kind === 'cancelled') return false;
  if (kind === 'failed_delivery' || kind === 'refund_return') return true;
  const raw = String(order.shopee_order_status || '').toUpperCase();
  if (raw === 'TO_RETURN') return true;
  const st = String(order.status || '').toLowerCase();
  if (st === 'return_pending' || st === 'return_received') return true;
  if (hasShopeeReturnSn(order) && !isUnshippedShopeeCancel(order) && !hasCarrierRtsEvidence(order)) {
    return true;
  }
  return false;
}

/** Đơn đã hủy mà không có mã VĐ — không được hiện "Đang chờ Shopee cấp mã". */
export function shouldShowAwaitingShopeeTracking(order: ShopeeCancelReturnInput & { channel?: string }): boolean {
  if (String(order.channel || '') === 'woocommerce') return false;
  if (isShopeeCancelledStatus(order)) return false;
  if (classifyShopeeCancelReturnKind(order) === 'cancelled') return false;
  return true;
}
