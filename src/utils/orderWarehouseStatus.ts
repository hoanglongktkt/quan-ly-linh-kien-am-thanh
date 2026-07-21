/**
 * SSOT — Tab "Đã giao cho ĐVVC" (trạm trung chuyển nội bộ).
 *
 * WRITE: chỉ từ Quét QR hoặc nút Bàn giao ĐVVC (lẻ/hàng loạt).
 * READ: chỉ đơn có cờ nội bộ HANDED_OVER.
 * EXIT: khi Shopee raw SHIPPED / Đang giao → gỡ cờ, rời tab.
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

function getInternalStatusRaw(
  order: Partial<Order> & Record<string, unknown>,
): string {
  return String(
    order.internal_status ??
      order.local_status ??
      order.localStatus ??
      '',
  ).toUpperCase();
}

/** Đơn đã sang Đang giao / hoàn tất trên Shopee → RỜI tab ĐVVC. */
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

/**
 * Cờ bàn giao nội bộ (không phụ thuộc status Shopee READY_TO_SHIP).
 * Hỗ trợ mọi alias: local_status / internal_status / is_handed_over_*.
 */
export function isOrderHandedOverToCarrier(
  order: Partial<Order> & Record<string, unknown>,
): boolean {
  const internal = getInternalStatusRaw(order);
  if (internal === ORDER_LOCAL_STATUS.HANDED_OVER) return true;
  if (
    isTruthyFlag(order.isHandedOverToCarrier) ||
    isTruthyFlag(order.is_handed_over_to_carrier) ||
    isTruthyFlag(order.is_handed_over_to_courier)
  ) {
    return true;
  }
  return false;
}

/** Patch ghi DB khi bàn giao ĐVVC — WRITE duy nhất. */
export function buildHandedOverWritePatch(
  now?: string,
  source: HandedOverSource = HANDED_OVER_SOURCE.MANUAL_BUTTON,
): Record<string, unknown> {
  const ts = now || new Date().toISOString();
  return {
    // Canonical
    local_status: ORDER_LOCAL_STATUS.HANDED_OVER,
    localStatus: ORDER_LOCAL_STATUS.HANDED_OVER,
    internal_status: ORDER_LOCAL_STATUS.HANDED_OVER,
    localStatusAt: ts,
    local_status_updated_at: ts,
    isHandedOverToCarrier: true,
    is_handed_over_to_carrier: true,
    // Alias theo yêu cầu nghiệp vụ
    is_handed_over_to_courier: true,
    handedOverAt: ts,
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

/** Gỡ cờ ĐVVC (exit khi Đang giao). */
export function buildClearHandedOverPatch(
  now?: string,
): Record<string, unknown> {
  const ts = now || new Date().toISOString();
  return {
    local_status: ORDER_LOCAL_STATUS.NONE,
    localStatus: ORDER_LOCAL_STATUS.NONE,
    internal_status: ORDER_LOCAL_STATUS.NONE,
    localStatusAt: ts,
    local_status_updated_at: ts,
    isHandedOverToCarrier: false,
    is_handed_over_to_carrier: false,
    is_handed_over_to_courier: false,
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
    if (isOrderHandedOverToCarrier(order)) return ORDER_LOCAL_STATUS.HANDED_OVER;
    return ORDER_LOCAL_STATUS.NONE;
  }
  const raw = getInternalStatusRaw(order);
  if (
    raw === ORDER_LOCAL_STATUS.HANDED_OVER ||
    raw === ORDER_LOCAL_STATUS.CANCELLED_STORED ||
    raw === ORDER_LOCAL_STATUS.RETURN_RECEIVED
  ) {
    return raw as OrderLocalStatus;
  }
  if (isOrderHandedOverToCarrier(order)) return ORDER_LOCAL_STATUS.HANDED_OVER;
  if (order.status === 'return_received' && !order.is_local_return_archived) {
    return ORDER_LOCAL_STATUS.RETURN_RECEIVED;
  }
  return ORDER_LOCAL_STATUS.NONE;
}

/**
 * TAB "ĐÃ GIAO CHO ĐVVC" — CHỈ cờ nội bộ (is_handed_over_* / internal_status).
 */
export function matchesHandedOverCarrierTab(
  order: Partial<Order> & Record<string, unknown>,
): boolean {
  if (!isOrderHandedOverToCarrier(order)) return false;
  if (hasLeftHandedOverCarrierTab(order)) return false;
  return true;
}
