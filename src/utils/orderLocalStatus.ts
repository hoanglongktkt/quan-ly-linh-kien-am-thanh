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

/** Đơn đã được quét/phân loại nội bộ trước đó — chặn quét trùng. */
export function isOrderAlreadyScanProcessed(
  order: Partial<Order> & Record<string, unknown>,
): boolean {
  const local = resolveOrderLocalStatus(order);
  return (
    local === ORDER_LOCAL_STATUS.HANDED_OVER ||
    local === ORDER_LOCAL_STATUS.CANCELLED_STORED ||
    local === ORDER_LOCAL_STATUS.RETURN_RECEIVED
  );
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
