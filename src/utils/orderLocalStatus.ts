import type { Order } from '../types';
import {
  ORDER_LOCAL_STATUS,
  resolveOrderLocalStatus,
  type OrderLocalStatus,
} from './orderWarehouseStatus';

export type { OrderLocalStatus };
export {
  ORDER_LOCAL_STATUS,
  resolveOrderLocalStatus,
  isOrderHandedOverToCarrier,
  matchesHandedOverCarrierTab,
  buildHandedOverWritePatch,
  applyHandedOverWrite,
  applyClearHandedOver,
  hasLeftHandedOverCarrierTab,
  UI_TAB_HANDED_OVER_CARRIER,
  HANDED_OVER_SOURCE,
} from './orderWarehouseStatus';

/** Tab "Đã nhận đơn hủy, đơn hoàn" — chỉ đơn còn active trong 14 ngày. */
export function matchesReceivedCancelReturnTab(
  order: Partial<Order> & Record<string, unknown>,
): boolean {
  if (order.is_local_return_archived) return false;
  const local = resolveOrderLocalStatus(order);
  return (
    local === ORDER_LOCAL_STATUS.RETURN_RECEIVED ||
    local === ORDER_LOCAL_STATUS.CANCELLED_STORED
  );
}

export function resolveLocalStatusUpdatedAt(
  order: Partial<Order> & Record<string, unknown>,
): string | undefined {
  const raw = order.local_status_updated_at || order.localStatusAt;
  return raw ? String(raw) : undefined;
}

/** Đơn sàn đã chuyển hủy/hoàn — cho phép quét lại dù từng HANDED_OVER. */
export function isScanCancelOrReturnLikeOrder(
  order: Partial<Order> & Record<string, unknown>,
): boolean {
  const raw = String(order.shopee_order_status || '').toUpperCase();
  if (raw === 'CANCELLED' || raw === 'IN_CANCEL' || raw === 'TO_RETURN') return true;
  const kind = String(order.shopee_cancel_return_kind || '');
  if (kind === 'refund_return' || kind === 'cancelled' || kind === 'failed_delivery') {
    return true;
  }
  const logistics = String(
    (order as { logistics_status?: string }).logistics_status || '',
  ).toUpperCase();
  if (
    /DELIVERY_FAILED|FAILED_DELIVERY|LOGISTICS_DELIVERY_FAILED|UNDELIVERABLE|PICKUP_FAILED|LOST/.test(
      logistics,
    )
  ) {
    return true;
  }
  if (order.return_sn) return true;
  const status = String(order.status || '');
  return (
    status === 'cancelled' ||
    status === 'return_pending' ||
    status === 'return_received'
  );
}

/**
 * Đơn đã được quét/phân loại nội bộ trước đó — chặn quét trùng.
 * Ngoại lệ: HANDED_OVER + đơn đã hủy/hoàn trên sàn → cho quét vào bucket hủy/hoàn.
 */
export function isOrderAlreadyScanProcessed(
  order: Partial<Order> & Record<string, unknown>,
): boolean {
  const local = resolveOrderLocalStatus(order);
  if (
    local === ORDER_LOCAL_STATUS.CANCELLED_STORED ||
    local === ORDER_LOCAL_STATUS.RETURN_RECEIVED
  ) {
    return true;
  }
  if (local === ORDER_LOCAL_STATUS.HANDED_OVER) {
    if (isScanCancelOrReturnLikeOrder(order)) return false;
    return true;
  }
  return false;
}

export function getScanProcessedReason(
  order: Partial<Order> & Record<string, unknown>,
): string {
  const local = resolveOrderLocalStatus(order);
  if (local === ORDER_LOCAL_STATUS.HANDED_OVER) {
    return 'Đơn đã được quét/bàn giao ĐVVC trước đó';
  }
  if (local === ORDER_LOCAL_STATUS.CANCELLED_STORED) {
    return 'Đơn hủy đã được phân loại trước đó';
  }
  if (local === ORDER_LOCAL_STATUS.RETURN_RECEIVED) {
    return 'Đơn đã nhận hàng hoàn trước đó';
  }
  return 'Đơn đã được xử lý trước đó';
}
