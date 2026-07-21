import type { Order } from '../types';
import { resolveOrderLocalStatus } from './orderLocalStatus';
import { isShopeeInternalTrackingCode } from './orderTracking';

export function getShopeeOrderRawStatus(
  order: Partial<Order> & Record<string, unknown>,
): string {
  return String(order.shopee_order_status || '').toUpperCase();
}

/** tracking_no thực tế từ Shopee (bỏ mã nội bộ 0FG...). */
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
 * isProcessedCondition — NGUỒN SỰ THẬT DUY NHẤT cho Tab Filter + UI Badge/Nút.
 * Đã xử lý (Pickup HOẶC Drop-off) khi THỎA 1 trong các điều kiện:
 *   1) Có tracking_no thực (GHN GYA..., SPX...)
 *   2) Shopee order_status = PROCESSED (sau ship_order — cả dropoff lẫn pickup)
 *   3) local status = processed (đã xác nhận gửi hàng trên app)
 *   4) Drop-off + isPrepared (không cần pickup_time)
 * TUYỆT ĐỐI KHÔNG yêu cầu pickup_time / is_pickup.
 */
export function isProcessedCondition(
  order: Partial<Order> & Record<string, unknown>,
): boolean {
  if (hasOrderTrackingNo(order)) return true;

  const raw = getShopeeOrderRawStatus(order);
  // Sau arrange shipment (dropoff/pickup) Shopee chuyển PROCESSED — Đã xử lý ngay.
  if (raw === 'PROCESSED') return true;

  // Local đã đánh dấu sau ship_order thành công (kể cả khi sync chưa kịp tracking).
  if (order.status === 'processed') return true;

  // Drop-off: đã chuẩn bị gửi bưu cục — không phụ thuộc pickup_time.
  if (getOrderFulfillmentType(order) === 'dropoff' && Boolean(order.isPrepared)) {
    return true;
  }

  return false;
}

/** is_handed_over — cờ nội bộ user đã quẹt mã giao bưu tá. */
export function isOrderHandedOverToCarrier(
  order: Partial<Order> & Record<string, unknown>,
): boolean {
  return (
    resolveOrderLocalStatus(order) === 'HANDED_OVER' ||
    Boolean(order.isHandedOverToCarrier ?? order.is_handed_over_to_carrier)
  );
}

/** SHIPPED / TO_CONFIRM_RECEIVE → Đang giao. */
export function isShopeeShippingStatus(
  order: Partial<Order> & Record<string, unknown>,
): boolean {
  const raw = getShopeeOrderRawStatus(order);
  if (raw === 'SHIPPED' || raw === 'TO_CONFIRM_RECEIVE') return true;
  return order.status === 'shipping';
}

export function isShopeeCompletedStatus(
  order: Partial<Order> & Record<string, unknown>,
): boolean {
  if (getShopeeOrderRawStatus(order) === 'COMPLETED') return true;
  return order.status === 'completed';
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

/**
 * Giai đoạn chờ lấy hàng trên sàn (KPI Shopee):
 * READY_TO_SHIP | RETRY_SHIP | PROCESSED
 */
export function isShopeeReadyToShipStatus(
  order: Partial<Order> & Record<string, unknown>,
): boolean {
  const raw = getShopeeOrderRawStatus(order);
  if (raw === 'READY_TO_SHIP' || raw === 'RETRY_SHIP' || raw === 'PROCESSED') {
    return true;
  }
  if (isShopeeShippingStatus(order) || isShopeeCompletedStatus(order)) return false;
  if (
    raw === 'UNPAID' ||
    raw === 'PENDING' ||
    raw === 'IN_REVIEW' ||
    raw === 'FRAUD_CHECK' ||
    raw === 'CANCELLED' ||
    raw === 'IN_CANCEL' ||
    raw === 'TO_RETURN'
  ) {
    return false;
  }
  return order.status === 'unprocessed' || order.status === 'processed';
}

export function isShopeeReadyToShipLike(
  order: Partial<Order> & Record<string, unknown>,
): boolean {
  return isShopeeReadyToShipStatus(order);
}

export function isOrderConfirmedOrPrinted(
  order: Partial<Order> & Record<string, unknown>,
): boolean {
  return isProcessedCondition(order);
}

export function isOrderAwaitingCarrierPickup(order: Pick<Order, 'status'>): boolean {
  return order.status === 'processed' || order.status === 'unprocessed';
}

/**
 * UI "✓ Đã in" chỉ sáng khi ĐÃ CÓ MÃ VẬN ĐƠN + cờ isPrinted.
 */
export function isOrderPrintedEffective(
  order: Partial<Order> & Record<string, unknown>,
): boolean {
  return isProcessedCondition(order) && Boolean(order.isPrinted);
}

/**
 * UI "✓ Đã chuẩn bị" chỉ sáng khi ĐÃ CÓ MÃ VẬN ĐƠN.
 */
export function isOrderPreparedEffective(
  order: Partial<Order> & Record<string, unknown>,
): boolean {
  return isProcessedCondition(order) && Boolean(order.isPrepared);
}

/**
 * Badge status đồng nhất với Tab Filter (1:1).
 * Trả về status dùng cho nhãn UI — không phụ thuộc order.status lệch.
 */
export function resolveOrderBadgeStatus(
  order: Order,
): Order['status'] {
  if (isShopeeShippingStatus(order)) return 'shipping';
  if (isShopeeCompletedStatus(order)) return 'completed';
  if (isShopeeCancelledLikeStatus(order)) {
    if (order.status === 'return_pending' || order.status === 'return_received') {
      return order.status;
    }
    return 'cancelled';
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
  if (isShopeeReadyToShipStatus(order)) {
    // Đã bàn giao vẫn hiển thị "Đã xử lý" (đã có mã), tab ĐVVC tách riêng.
    return isProcessedCondition(order) ? 'processed' : 'unprocessed';
  }
  return order.status;
}

/**
 * TAB "ĐÃ GIAO CHO ĐVVC" — đối soát nội bộ sau QUÉT QR.
 * Nguồn duy nhất: cờ local HANDED_OVER / is_handed_over_to_carrier.
 * KHÔNG phụ thuộc order_status Shopee (READY_TO_SHIP / PROCESSED...).
 * Rời tab khi Shopee thật sự SHIPPED / COMPLETED (hoặc hủy/hoàn).
 */
export function matchesHandedOverCarrierTab(order: Order): boolean {
  if (!isOrderHandedOverToCarrier(order)) return false;
  if (isShopeeShippingStatus(order) || isShopeeCompletedStatus(order)) return false;
  if (isShopeeCancelledLikeStatus(order)) return false;
  return true;
}

/**
 * TAB "CHỜ LẤY HÀNG (ĐÃ XỬ LÝ)" — áp dụng cả Pickup và Drop-off (gửi tại bưu cục).
 * Không yêu cầu pickup_time. Chỉ cần isProcessedCondition (tracking_no | PROCESSED | ...).
 */
export function matchesProcessedPickupTab(order: Order): boolean {
  if (isShopeeShippingStatus(order) || isShopeeCompletedStatus(order)) return false;
  if (isShopeeCancelledLikeStatus(order)) return false;
  if (!isShopeeReadyToShipStatus(order)) return false;
  if (!isProcessedCondition(order)) return false;
  return !isOrderHandedOverToCarrier(order);
}

/**
 * TAB "CHỜ LẤY HÀNG (CHƯA XỬ LÝ)" — Pickup/Drop-off chưa arrange / chưa có mã.
 * Đơn PROCESSED hoặc đã có tracking_no KHÔNG được ở đây (kể cả Drop-off).
 */
export function matchesUnprocessedPickupTab(order: Order): boolean {
  if (isShopeeShippingStatus(order) || isShopeeCompletedStatus(order)) return false;
  if (isShopeeCancelledLikeStatus(order)) return false;
  if (!isShopeeReadyToShipStatus(order)) return false;
  // PROCESSED = đã ship_order (dropoff/pickup) → luôn sang Đã xử lý.
  if (getShopeeOrderRawStatus(order) === 'PROCESSED') return false;
  return !isProcessedCondition(order);
}
