/**
 * SSOT — Trạng thái kho nội bộ (Đã giao ĐVVC / hủy / hoàn).
 * WRITE (buildHandedOverWritePatch) === READ (matchesHandedOverCarrierTab).
 * Không invent chuỗi status khác cho các nút/QR/bulk.
 */
import type { Order } from '../types';

export const ORDER_LOCAL_STATUS = {
  NONE: 'NONE',
  HANDED_OVER: 'HANDED_OVER',
  CANCELLED_STORED: 'CANCELLED_STORED',
  RETURN_RECEIVED: 'RETURN_RECEIVED',
} as const;

export type OrderLocalStatus =
  (typeof ORDER_LOCAL_STATUS)[keyof typeof ORDER_LOCAL_STATUS];

/** Tab UI id — khớp OrderTab / activeSubTab. */
export const UI_TAB_HANDED_OVER_CARRIER = 'handed_over_carrier' as const;

/** Patch ghi DB khi bàn giao ĐVVC — dùng chung single / bulk / scan / PATCH fallback. */
export function buildHandedOverWritePatch(
  now: string = new Date().toISOString(),
): Record<string, unknown> {
  return {
    local_status: ORDER_LOCAL_STATUS.HANDED_OVER,
    localStatus: ORDER_LOCAL_STATUS.HANDED_OVER,
    localStatusAt: now,
    local_status_updated_at: now,
    isHandedOverToCarrier: true,
    is_handed_over_to_carrier: true,
    handedOverAt: now,
  };
}

export function applyHandedOverWrite<T extends Record<string, unknown>>(
  order: T,
  now?: string,
): T {
  return { ...order, ...buildHandedOverWritePatch(now) };
}

export function resolveOrderLocalStatus(
  order: Partial<Order> & Record<string, unknown>,
): OrderLocalStatus {
  if (order.is_local_return_archived) {
    const rawArchived = String(order.local_status ?? order.localStatus ?? '').toUpperCase();
    if (rawArchived === ORDER_LOCAL_STATUS.HANDED_OVER) {
      return ORDER_LOCAL_STATUS.HANDED_OVER;
    }
    if (order.isHandedOverToCarrier || order.is_handed_over_to_carrier) {
      return ORDER_LOCAL_STATUS.HANDED_OVER;
    }
    return ORDER_LOCAL_STATUS.NONE;
  }
  const raw = String(order.local_status ?? order.localStatus ?? '').toUpperCase();
  if (
    raw === ORDER_LOCAL_STATUS.HANDED_OVER ||
    raw === ORDER_LOCAL_STATUS.CANCELLED_STORED ||
    raw === ORDER_LOCAL_STATUS.RETURN_RECEIVED
  ) {
    return raw as OrderLocalStatus;
  }
  if (order.isHandedOverToCarrier || order.is_handed_over_to_carrier) {
    return ORDER_LOCAL_STATUS.HANDED_OVER;
  }
  if (order.status === 'return_received' && !order.is_local_return_archived) {
    return ORDER_LOCAL_STATUS.RETURN_RECEIVED;
  }
  return ORDER_LOCAL_STATUS.NONE;
}

/** Cờ đã bàn giao ĐVVC (đọc từ cùng field WRITE). */
export function isOrderHandedOverToCarrier(
  order: Partial<Order> & Record<string, unknown>,
): boolean {
  return resolveOrderLocalStatus(order) === ORDER_LOCAL_STATUS.HANDED_OVER;
}

/**
 * TAB "ĐÃ GIAO CHO ĐVVC" — READ = WRITE.
 * Nguồn duy nhất: local_status HANDED_OVER / is_handed_over_to_carrier.
 * Chỉ RỜI tab khi Shopee raw SHIPPED/COMPLETED hoặc hủy-hoàn.
 * Không loại vì order.status local = "shipping".
 */
export function matchesHandedOverCarrierTab(
  order: Partial<Order> & Record<string, unknown>,
): boolean {
  if (!isOrderHandedOverToCarrier(order)) return false;
  const raw = String(order.shopee_order_status || '').toUpperCase();
  if (raw === 'SHIPPED' || raw === 'TO_CONFIRM_RECEIVE' || raw === 'COMPLETED') {
    return false;
  }
  if (raw === 'CANCELLED' || raw === 'IN_CANCEL' || raw === 'TO_RETURN') {
    return false;
  }
  if (
    order.status === 'cancelled' ||
    order.status === 'return_pending' ||
    order.status === 'return_received' ||
    order.status === 'completed'
  ) {
    return false;
  }
  return true;
}
