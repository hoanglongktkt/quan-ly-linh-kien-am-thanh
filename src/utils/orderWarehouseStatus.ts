/**
 * SSOT — Tab "Đã giao cho ĐVVC" (trạm trung chuyển nội bộ).
 *
 * WRITE: chỉ từ Quét QR hoặc nút Bàn giao ĐVVC (lẻ/hàng loạt).
 * READ: chỉ đơn có local_status = HANDED_OVER (không map từ Shopee SHIPPED).
 * EXIT: khi Shopee/sync xác nhận Đang giao (SHIPPED / shipping) → gỡ cờ, rời tab.
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

export const UI_TAB_HANDED_OVER_CARRIER = 'handed_over_carrier' as const;

/** Nguồn kích hoạt bàn giao — chỉ manual/qr, không sync Shopee. */
export const HANDED_OVER_SOURCE = {
  QR_SCAN: 'qr_scan',
  MANUAL_BUTTON: 'manual_button',
} as const;

export type HandedOverSource =
  (typeof HANDED_OVER_SOURCE)[keyof typeof HANDED_OVER_SOURCE];

export function isTruthyFlag(value: unknown): boolean {
  if (value === true || value === 1) return true;
  if (typeof value === 'string') {
    const s = value.trim().toLowerCase();
    return s === 'true' || s === '1' || s === 'yes';
  }
  return false;
}

function getShopeeRaw(order: Partial<Order> & Record<string, unknown>): string {
  return String(order.shopee_order_status || '').toUpperCase();
}

/** Đơn đã sang Đang giao / hoàn tất trên Shopee hoặc local → phải RỜI tab ĐVVC. */
export function hasLeftHandedOverCarrierTab(
  order: Partial<Order> & Record<string, unknown>,
): boolean {
  const raw = getShopeeRaw(order);
  if (raw === 'SHIPPED' || raw === 'TO_CONFIRM_RECEIVE' || raw === 'COMPLETED') {
    return true;
  }
  if (order.status === 'shipping' || order.status === 'completed') {
    return true;
  }
  if (raw === 'CANCELLED' || raw === 'IN_CANCEL' || raw === 'TO_RETURN') {
    return true;
  }
  if (
    order.status === 'cancelled' ||
    order.status === 'return_pending' ||
    order.status === 'return_received'
  ) {
    return true;
  }
  return false;
}

/** Patch ghi DB khi bàn giao ĐVVC — WRITE duy nhất. */
export function buildHandedOverWritePatch(
  now: string = new Date().toISOString(),
  source: HandedOverSource = HANDED_OVER_SOURCE.MANUAL_BUTTON,
): Record<string, unknown> {
  return {
    local_status: ORDER_LOCAL_STATUS.HANDED_OVER,
    localStatus: ORDER_LOCAL_STATUS.HANDED_OVER,
    localStatusAt: now,
    local_status_updated_at: now,
    isHandedOverToCarrier: true,
    is_handed_over_to_carrier: true,
    handedOverAt: now,
    handed_over_source: source,
    handedOverSource: source,
  };
}

export function applyHandedOverWrite<T extends Record<string, unknown>>(
  order: T,
  now?: string,
  source?: HandedOverSource,
): T {
  return { ...order, ...buildHandedOverWritePatch(now, source) };
}

/** Gỡ cờ ĐVVC (exit khi Đang giao / dọn dữ liệu sai). */
export function buildClearHandedOverPatch(
  now: string = new Date().toISOString(),
): Record<string, unknown> {
  return {
    local_status: ORDER_LOCAL_STATUS.NONE,
    localStatus: ORDER_LOCAL_STATUS.NONE,
    localStatusAt: now,
    local_status_updated_at: now,
    isHandedOverToCarrier: false,
    is_handed_over_to_carrier: false,
    handed_over_source: null,
    handedOverSource: null,
  };
}

export function applyClearHandedOver<T extends Record<string, unknown>>(order: T): T {
  return { ...order, ...buildClearHandedOverPatch() };
}

export function resolveOrderLocalStatus(
  order: Partial<Order> & Record<string, unknown>,
): OrderLocalStatus {
  if (order.is_local_return_archived) {
    const rawArchived = String(order.local_status ?? order.localStatus ?? '').toUpperCase();
    if (rawArchived === ORDER_LOCAL_STATUS.HANDED_OVER) {
      return ORDER_LOCAL_STATUS.HANDED_OVER;
    }
    if (
      isTruthyFlag(order.isHandedOverToCarrier) ||
      isTruthyFlag(order.is_handed_over_to_carrier)
    ) {
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
  if (
    isTruthyFlag(order.isHandedOverToCarrier) ||
    isTruthyFlag(order.is_handed_over_to_carrier)
  ) {
    return ORDER_LOCAL_STATUS.HANDED_OVER;
  }
  if (order.status === 'return_received' && !order.is_local_return_archived) {
    return ORDER_LOCAL_STATUS.RETURN_RECEIVED;
  }
  return ORDER_LOCAL_STATUS.NONE;
}

export function isOrderHandedOverToCarrier(
  order: Partial<Order> & Record<string, unknown>,
): boolean {
  return resolveOrderLocalStatus(order) === ORDER_LOCAL_STATUS.HANDED_OVER;
}

/**
 * TAB "ĐÃ GIAO CHO ĐVVC" — CHỈ cờ nội bộ HANDED_OVER từ QR/nút.
 * Không map đơn SHIPPED/Đang giao từ Shopee vào tab này.
 */
export function matchesHandedOverCarrierTab(
  order: Partial<Order> & Record<string, unknown>,
): boolean {
  if (!isOrderHandedOverToCarrier(order)) return false;
  if (hasLeftHandedOverCarrierTab(order)) return false;
  return true;
}
