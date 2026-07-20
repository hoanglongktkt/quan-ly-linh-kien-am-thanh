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
  // Fallback khi thiếu shopee_order_status
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

/** @deprecated dùng isShopeeReadyToShipStatus */
export function isShopeeReadyToShipLike(
  order: Partial<Order> & Record<string, unknown>,
): boolean {
  return isShopeeReadyToShipStatus(order);
}

/** @deprecated dùng hasOrderTrackingNo */
export function isOrderConfirmedOrPrinted(
  order: Partial<Order> & Record<string, unknown>,
): boolean {
  return hasOrderTrackingNo(order);
}

export function isOrderAwaitingCarrierPickup(order: Pick<Order, 'status'>): boolean {
  return order.status === 'processed' || order.status === 'unprocessed';
}

/**
 * TAB "ĐÃ GIAO CHO ĐVVC" (KPI — chốt chặn):
 * shopee READY_TO_SHIP-like AND tracking_no có dữ liệu AND is_handed_over === true
 * Đơn chưa có mã vận đơn tuyệt đối KHÔNG được vào tab này.
 */
export function matchesHandedOverCarrierTab(order: Order): boolean {
  if (isShopeeShippingStatus(order) || isShopeeCompletedStatus(order)) return false;
  if (!isShopeeReadyToShipStatus(order)) return false;
  if (!hasOrderTrackingNo(order)) return false;
  return isOrderHandedOverToCarrier(order);
}

/**
 * TAB "CHỜ LẤY HÀNG (ĐÃ XỬ LÝ)":
 * READY_TO_SHIP-like AND tracking_no có dữ liệu AND is_handed_over === false
 */
export function matchesProcessedPickupTab(order: Order): boolean {
  if (isShopeeShippingStatus(order) || isShopeeCompletedStatus(order)) return false;
  if (!isShopeeReadyToShipStatus(order)) return false;
  if (!hasOrderTrackingNo(order)) return false;
  return !isOrderHandedOverToCarrier(order);
}

/**
 * TAB "CHỜ LẤY HÀNG (CHƯA XỬ LÝ)":
 * READY_TO_SHIP-like AND tracking_no null/empty
 * (Chưa chuẩn bị hàng — kể cả nếu cờ bàn giao bị set sai vẫn ở đây)
 */
export function matchesUnprocessedPickupTab(order: Order): boolean {
  if (isShopeeShippingStatus(order) || isShopeeCompletedStatus(order)) return false;
  if (!isShopeeReadyToShipStatus(order)) return false;
  return !hasOrderTrackingNo(order);
}
