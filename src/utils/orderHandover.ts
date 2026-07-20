import type { Order } from '../types';
import { resolveOrderLocalStatus } from './orderLocalStatus';

export function getShopeeOrderRawStatus(
  order: Partial<Order> & Record<string, unknown>,
): string {
  return String(order.shopee_order_status || '').toUpperCase();
}

export function isOrderHandedOverToCarrier(order: Partial<Order> & Record<string, unknown>): boolean {
  return (
    resolveOrderLocalStatus(order) === 'HANDED_OVER' ||
    Boolean(order.isHandedOverToCarrier ?? order.is_handed_over_to_carrier)
  );
}

/** SHIPPED / TO_CONFIRM_RECEIVE → Đang giao (ưu tiên tuyệt đối từ Shopee). */
export function isShopeeShippingStatus(order: Partial<Order> & Record<string, unknown>): boolean {
  if (order.status === 'shipping') return true;
  const raw = getShopeeOrderRawStatus(order);
  return raw === 'SHIPPED' || raw === 'TO_CONFIRM_RECEIVE';
}

export function isShopeeCompletedStatus(order: Partial<Order> & Record<string, unknown>): boolean {
  if (order.status === 'completed') return true;
  return getShopeeOrderRawStatus(order) === 'COMPLETED';
}

/** READY_TO_SHIP / RETRY_SHIP / PROCESSED — còn ở giai đoạn chờ lấy hàng trên sàn. */
export function isShopeeReadyToShipLike(order: Partial<Order> & Record<string, unknown>): boolean {
  const raw = getShopeeOrderRawStatus(order);
  if (raw === 'READY_TO_SHIP' || raw === 'RETRY_SHIP' || raw === 'PROCESSED') return true;
  // Fallback khi thiếu shopee_order_status nhưng local đã map đúng tab chờ lấy.
  return order.status === 'unprocessed' || order.status === 'processed';
}

/** Đã xác nhận giao hàng (ship_order) hoặc đã in nhãn. */
export function isOrderConfirmedOrPrinted(order: Partial<Order> & Record<string, unknown>): boolean {
  const raw = getShopeeOrderRawStatus(order);
  if (raw === 'PROCESSED') return true;
  if (order.status === 'processed') return true;
  if (Boolean(order.isPrepared) || Boolean(order.isPrinted)) return true;
  const tracking = String(
    order.trackingNumber || order.tracking_no || order.shopee_tracking_number || '',
  ).trim();
  return Boolean(tracking) && tracking !== '0' && !/^0FG/i.test(tracking);
}

/** Trạng thái Shopee tương đương READY_TO_SHIP / PROCESSED — chờ bưu tá lấy hàng. */
export function isOrderAwaitingCarrierPickup(order: Pick<Order, 'status'>): boolean {
  return order.status === 'processed' || order.status === 'unprocessed';
}

/**
 * ĐÃ GIAO CHO ĐVVC — độc quyền:
 * local bàn giao = true AND Shopee chưa SHIPPED/COMPLETED.
 */
export function matchesHandedOverCarrierTab(order: Order): boolean {
  if (!isOrderHandedOverToCarrier(order)) return false;
  if (isShopeeShippingStatus(order) || isShopeeCompletedStatus(order)) return false;
  const raw = getShopeeOrderRawStatus(order);
  if (
    raw === 'CANCELLED' ||
    raw === 'IN_CANCEL' ||
    raw === 'TO_RETURN' ||
    order.status === 'cancelled' ||
    order.status === 'return_pending' ||
    order.status === 'return_received'
  ) {
    return false;
  }
  return true;
}

/**
 * CHỜ LẤY HÀNG (ĐÃ XỬ LÝ) — độc quyền:
 * READY_TO_SHIP-like AND đã xác nhận/in nhãn AND chưa bàn giao ĐVVC AND chưa SHIPPED.
 */
export function matchesProcessedPickupTab(order: Order): boolean {
  if (isShopeeShippingStatus(order) || isShopeeCompletedStatus(order)) return false;
  if (isOrderHandedOverToCarrier(order)) return false;
  if (order.status === 'pending_verification' || order.status === 'pending_confirm') return false;
  if (
    order.status === 'cancelled' ||
    order.status === 'return_pending' ||
    order.status === 'return_received'
  ) {
    return false;
  }
  const raw = getShopeeOrderRawStatus(order);
  if (raw === 'CANCELLED' || raw === 'IN_CANCEL' || raw === 'TO_RETURN') return false;
  if (!isShopeeReadyToShipLike(order)) return false;
  return isOrderConfirmedOrPrinted(order);
}

/**
 * CHỜ LẤY HÀNG (CHƯA XỬ LÝ) — độc quyền:
 * READY_TO_SHIP-like AND chưa xác nhận/in nhãn AND chưa bàn giao ĐVVC AND chưa SHIPPED.
 */
export function matchesUnprocessedPickupTab(order: Order): boolean {
  if (isShopeeShippingStatus(order) || isShopeeCompletedStatus(order)) return false;
  if (isOrderHandedOverToCarrier(order)) return false;
  if (order.status === 'pending_verification' || order.status === 'pending_confirm') return false;
  if (
    order.status === 'cancelled' ||
    order.status === 'return_pending' ||
    order.status === 'return_received'
  ) {
    return false;
  }
  const raw = getShopeeOrderRawStatus(order);
  if (raw === 'CANCELLED' || raw === 'IN_CANCEL' || raw === 'TO_RETURN') return false;
  if (raw === 'UNPAID' || raw === 'PENDING' || raw === 'IN_REVIEW' || raw === 'FRAUD_CHECK') {
    return false;
  }
  if (!isShopeeReadyToShipLike(order)) return false;
  // Mutually exclusive với tab Đã xử lý
  if (isOrderConfirmedOrPrinted(order)) return false;
  return true;
}
