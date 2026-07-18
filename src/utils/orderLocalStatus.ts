import type { Order } from '../types';

/** Cờ trạng thái nội bộ kho — KHÔNG đồng bộ lên Shopee. */
export type OrderLocalStatus =
  | 'NONE'
  | 'HANDED_OVER'
  | 'CANCELLED_STORED'
  | 'RETURN_RECEIVED';

export function resolveOrderLocalStatus(
  order: Partial<Order> & Record<string, unknown>,
): OrderLocalStatus {
  if (order.is_local_return_archived) {
    // Đã archive khỏi tab đối soát — không còn CANCELLED_STORED/RETURN_RECEIVED active.
    const rawArchived = String(order.local_status ?? order.localStatus ?? '').toUpperCase();
    if (rawArchived === 'HANDED_OVER') return 'HANDED_OVER';
    if (order.isHandedOverToCarrier || order.is_handed_over_to_carrier) return 'HANDED_OVER';
    return 'NONE';
  }
  const raw = String(order.local_status ?? order.localStatus ?? '').toUpperCase();
  if (raw === 'HANDED_OVER' || raw === 'CANCELLED_STORED' || raw === 'RETURN_RECEIVED') {
    return raw;
  }
  // Backward compat: cờ bàn giao cũ
  if (order.isHandedOverToCarrier || order.is_handed_over_to_carrier) {
    return 'HANDED_OVER';
  }
  if (order.status === 'return_received' && !order.is_local_return_archived) {
    return 'RETURN_RECEIVED';
  }
  return 'NONE';
}

/** Tab "Đã nhận đơn hủy, đơn hoàn" — chỉ đơn còn active trong 14 ngày. */
export function matchesReceivedCancelReturnTab(
  order: Partial<Order> & Record<string, unknown>,
): boolean {
  if (order.is_local_return_archived) return false;
  const local = resolveOrderLocalStatus(order);
  return local === 'RETURN_RECEIVED' || local === 'CANCELLED_STORED';
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
  return local === 'HANDED_OVER' || local === 'CANCELLED_STORED' || local === 'RETURN_RECEIVED';
}

export function getScanProcessedReason(
  order: Partial<Order> & Record<string, unknown>,
): string {
  const local = resolveOrderLocalStatus(order);
  if (local === 'HANDED_OVER') return 'Đơn đã được quét/bàn giao ĐVVC trước đó';
  if (local === 'CANCELLED_STORED') return 'Đơn hủy đã được phân loại trước đó';
  if (local === 'RETURN_RECEIVED') return 'Đơn đã nhận hàng hoàn trước đó';
  return 'Đơn đã được xử lý trước đó';
}
