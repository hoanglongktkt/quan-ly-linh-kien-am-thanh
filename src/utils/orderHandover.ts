import type { Order } from '../types';
import { isShopeeInternalTrackingCode } from './orderTracking';
import {
  isOrderHandedOverToCarrier,
  matchesHandedOverCarrierTab,
  hasLeftHandedOverCarrierTab,
  isTruthyFlag,
} from './orderWarehouseStatus';

export {
  isOrderHandedOverToCarrier,
  matchesHandedOverCarrierTab,
  buildHandedOverWritePatch,
  applyHandedOverWrite,
  applyClearHandedOver,
  buildClearHandedOverPatch,
  hasLeftHandedOverCarrierTab,
  ORDER_LOCAL_STATUS,
  HANDED_OVER_SOURCE,
  UI_TAB_HANDED_OVER_CARRIER,
} from './orderWarehouseStatus';
export type { HandedOverSource } from './orderWarehouseStatus';

/**
 * STATE MACHINE — Tab filter (SSOT, không giao thoa):
 *
 *  Đơn chưa xử lý     = TO_SHIP AND chưa xử lý AND is_handed_over ≠ true
 *  Chờ lấy (Đã xử lý) = TO_SHIP AND đã xử lý AND is_handed_over ≠ true
 *  Đã giao ĐVVC       = TO_SHIP AND is_handed_over = true  (CẤM SHIPPED)
 *  Đang giao          = SHIPPED | TO_CONFIRM_RECEIVE
 *                       — loại COMPLETED / CANCELLED / TO_RETURN / RTS
 */

export function getShopeeOrderRawStatus(
  order: Partial<Order> & Record<string, unknown>,
): string {
  return String(order.shopee_order_status || order.order_status || '').toUpperCase();
}

/**
 * tracking_no outbound theo order_sn — ưu tiên mã đi (tracking_no).
 * Không dùng return_tracking_no (mã hoàn) để quyết định tab Đã xử lý.
 */
export function getOrderTrackingNo(
  order: Partial<Order> & Record<string, unknown>,
): string {
  const candidates = [
    order.trackingNumber,
    order.tracking_no,
    order.shopee_tracking_number,
  ];
  for (const c of candidates) {
    const tn = String(c || '').trim();
    if (!tn || tn === '0' || isShopeeInternalTrackingCode(tn)) continue;
    return tn;
  }
  return '';
}

export function hasOrderTrackingNo(
  order: Partial<Order> & Record<string, unknown>,
): boolean {
  return Boolean(getOrderTrackingNo(order));
}

/** pickup | dropoff — không phụ thuộc pickup_time. */
export function getOrderFulfillmentType(
  order: Partial<Order> & Record<string, unknown>,
): 'pickup' | 'dropoff' | '' {
  const raw = String(
    order.fulfillment_type ||
      order.ship_method ||
      order.shipping_method ||
      order.fulfillmentType ||
      '',
  )
    .trim()
    .toLowerCase();
  if (raw === 'dropoff' || raw === 'drop_off' || raw === 'drop-off') return 'dropoff';
  if (raw === 'pickup' || raw === 'pick_up' || raw === 'pick-up') return 'pickup';
  return '';
}

/**
 * isProcessedCondition — chỉ phân nhánh Chưa xử lý / Đã xử lý
 * trong pool READY_TO_SHIP (không quyết định tab Đang giao).
 * READY_TO_SHIP/RETRY chưa có mã VĐ → luôn Chưa xử lý (không tin status local lệch).
 */
export function isProcessedCondition(
  order: Partial<Order> & Record<string, unknown>,
): boolean {
  if (hasOrderTrackingNo(order)) return true;

  const raw = getShopeeOrderRawStatus(order);
  if (raw === 'PROCESSED') return true;

  // Raw vẫn RTS/RETRY chưa có tracking → chưa xử lý (bỏ qua status local stale).
  if (raw === 'READY_TO_SHIP' || raw === 'RETRY_SHIP') {
    if (getOrderFulfillmentType(order) === 'dropoff' && Boolean(order.isPrepared)) {
      return true;
    }
    return false;
  }

  if (order.status === 'processed') return true;

  if (getOrderFulfillmentType(order) === 'dropoff' && Boolean(order.isPrepared)) {
    return true;
  }

  return false;
}

export function isShopeeCompletedStatus(
  order: Partial<Order> & Record<string, unknown>,
): boolean {
  return getShopeeOrderRawStatus(order) === 'COMPLETED' || order.status === 'completed';
}

export function isShopeeCancelledLikeStatus(
  order: Partial<Order> & Record<string, unknown>,
): boolean {
  const raw = getShopeeOrderRawStatus(order);
  if (raw === 'CANCELLED' || raw === 'IN_CANCEL' || raw === 'TO_RETURN') return true;
  return (
    order.status === 'cancelled' ||
    order.status === 'return_pending' ||
    order.status === 'return_received'
  );
}

/** Terminal / thoát pool chờ lấy hàng — raw SHIPPED hoặc local shipping. */
export function isShopeeShippingStatus(
  order: Partial<Order> & Record<string, unknown>,
): boolean {
  if (isShopeeCompletedStatus(order)) return false;
  if (isShopeeCancelledLikeStatus(order)) return false;
  if (order.is_rts === true) return false;
  if (String(order.sub_status || '').toUpperCase() === 'RTS') return false;
  if (String(order.shopee_cancel_return_kind || '') === 'failed_delivery') return false;
  const raw = getShopeeOrderRawStatus(order);
  // BẮT BUỘC: SHIPPED từ Shopee → tab Đang giao (bỏ qua is_handed_over).
  if (raw === 'SHIPPED' || raw === 'TO_CONFIRM_RECEIVE') return true;
  if (order.status === 'shipping') return true;
  return false;
}

/**
 * READY_TO_SHIP-like — CHỈ raw Shopee.
 * Không fallback local status (tránh SHIPPED/thiếu raw lọt vào Chờ lấy hàng).
 */
export function isShopeeReadyToShipStatus(
  order: Partial<Order> & Record<string, unknown>,
): boolean {
  const raw = getShopeeOrderRawStatus(order);
  return raw === 'READY_TO_SHIP' || raw === 'RETRY_SHIP' || raw === 'PROCESSED';
}

export function isShopeeReadyToShipLike(
  order: Partial<Order> & Record<string, unknown>,
): boolean {
  return isShopeeReadyToShipStatus(order);
}

/** Gate chung: còn trong giai đoạn chờ lấy trên sàn (raw = SSOT). */
function isPickupPoolOrder(order: Partial<Order> & Record<string, unknown>): boolean {
  if (isShopeeShippingStatus(order)) return false;
  if (isShopeeCompletedStatus(order)) return false;
  if (isShopeeCancelledLikeStatus(order)) return false;
  if (isShopeeReadyToShipStatus(order)) return true;
  // Fallback khi thiếu shopee_order_status (doc cũ / merge lệch) nhưng local vẫn chờ lấy hàng.
  const status = String(order.status || '');
  return status === 'unprocessed' || status === 'processed';
}

export function isOrderConfirmedOrPrinted(
  order: Partial<Order> & Record<string, unknown>,
): boolean {
  return isProcessedCondition(order);
}

export function isOrderAwaitingCarrierPickup(order: Pick<Order, 'status'>): boolean {
  return order.status === 'processed' || order.status === 'unprocessed';
}

export function isOrderPrintedEffective(
  order: Partial<Order> & Record<string, unknown>,
): boolean {
  // SSOT: cờ isPrinted trong MongoDB — không phụ thuộc processed/Shopee live.
  return isTruthyFlag(order.isPrinted);
}

export function isOrderPreparedEffective(
  order: Partial<Order> & Record<string, unknown>,
): boolean {
  return isProcessedCondition(order) && Boolean(order.isPrepared);
}

/**
 * Badge status = Tab Filter (1:1) theo State Machine.
 */
export function resolveOrderBadgeStatus(order: Order): Order['status'] {
  if (isShopeeShippingStatus(order)) return 'shipping';
  if (isShopeeCompletedStatus(order) || order.status === 'completed') return 'completed';
  if (isShopeeCancelledLikeStatus(order)) {
    if (order.status === 'return_pending' || order.status === 'return_received') {
      return order.status;
    }
    return 'cancelled';
  }
  // Pool chờ lấy hàng TRƯỚC — tránh status local stale pending_confirm + PROCESSED/mã VĐ.
  if (isPickupPoolOrder(order)) {
    return isProcessedCondition(order) ? 'processed' : 'unprocessed';
  }
  const raw = getShopeeOrderRawStatus(order);
  if (
    raw === 'UNPAID' ||
    raw === 'PENDING' ||
    raw === 'IN_REVIEW' ||
    raw === 'FRAUD_CHECK' ||
    order.status === 'pending_confirm' ||
    order.status === 'pending_verification'
  ) {
    return 'pending_confirm';
  }
  return order.status;
}

/**
 * TAB "ĐANG GIAO" — chỉ SHIPPED / TO_CONFIRM_RECEIVE.
 * Loại tuyệt đối COMPLETED / CANCELLED / TO_RETURN / RTS.
 */
export function matchesShippingTab(order: Order): boolean {
  return isShopeeShippingStatus(order);
}

/**
 * TAB "CHỜ LẤY HÀNG (ĐÃ XỬ LÝ)" —
 * TO_SHIP + đã xử lý + is_handed_over ≠ true.
 * Loại trừ tuyệt đối Đã giao ĐVVC và Đang giao (SHIPPED).
 */
export function matchesProcessedPickupTab(order: Order): boolean {
  if (isShopeeShippingStatus(order)) return false;
  if (isOrderHandedOverToCarrier(order)) return false;
  if (!isPickupPoolOrder(order)) return false;
  return isProcessedCondition(order);
}

/**
 * TAB "ĐƠN CHƯA XỬ LÝ" (trước: Chờ lấy hàng — Chưa xử lý):
 * - Raw READY_TO_SHIP | RETRY_SHIP (không PROCESSED) — kể cả khi chưa có mã VĐ
 * - HOẶC local status=unprocessed khi thiếu raw
 * - AND chưa bàn giao ĐVVC / chưa isPrepared(dropoff)
 */
export function matchesUnprocessedPickupTab(order: Order): boolean {
  if (isShopeeShippingStatus(order)) return false;
  if (isOrderHandedOverToCarrier(order)) return false;
  if (!isPickupPoolOrder(order)) return false;
  const raw = getShopeeOrderRawStatus(order);
  if (raw === 'PROCESSED') return false;
  if (isProcessedCondition(order)) return false;
  // Chuẩn Shopee: READY_TO_SHIP | RETRY_SHIP = Chờ lấy hàng (Chưa xử lý)
  if (raw === 'READY_TO_SHIP' || raw === 'RETRY_SHIP') return true;
  if (!raw && order.status === 'unprocessed') return true;
  if (order.status === 'unprocessed') return true;
  return false;
}

/**
 * Đủ điều kiện BÀN GIAO ĐVVC (QR / nút).
 */
export function isEligibleForHandOverToCarrier(order: Order): boolean {
  if (isOrderHandedOverToCarrier(order)) return false;
  if (hasLeftHandedOverCarrierTab(order)) return false;
  if (!isPickupPoolOrder(order)) return false;
  if (!isProcessedCondition(order)) return false;
  if (!hasOrderTrackingNo(order)) return false;
  return true;
}

export function getHandOverIneligibleReason(order: Order): string {
  if (isOrderHandedOverToCarrier(order)) {
    return 'Đơn đã có cờ bàn giao ĐVVC nội bộ';
  }
  if (hasLeftHandedOverCarrierTab(order)) {
    return `Đơn đã Đang giao/hoàn tất/hủy (status=${order.status}, shopee=${order.shopee_order_status || '-'})`;
  }
  if (!isPickupPoolOrder(order)) {
    return `Không còn chờ lấy hàng (status=${order.status}, shopee=${order.shopee_order_status || '-'})`;
  }
  if (!isProcessedCondition(order)) {
    return 'Chưa đủ điều kiện Đã xử lý (thiếu PROCESSED/mã VĐ)';
  }
  if (!hasOrderTrackingNo(order)) {
    return 'Chưa có mã vận đơn outbound (trackingNumber/tracking_no)';
  }
  return '';
}
