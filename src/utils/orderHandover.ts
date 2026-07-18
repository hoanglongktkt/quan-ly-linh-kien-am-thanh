import type { Order } from '../types';
import { resolveOrderLocalStatus } from './orderLocalStatus';

export function isOrderHandedOverToCarrier(order: Partial<Order> & Record<string, unknown>): boolean {
  return (
    resolveOrderLocalStatus(order) === 'HANDED_OVER' ||
    Boolean(order.isHandedOverToCarrier ?? order.is_handed_over_to_carrier)
  );
}

/** Trạng thái Shopee tương đương READY_TO_SHIP / PROCESSED — chờ bưu tá lấy hàng. */
export function isOrderAwaitingCarrierPickup(order: Pick<Order, 'status'>): boolean {
  return order.status === 'processed' || order.status === 'unprocessed';
}

export function matchesHandedOverCarrierTab(order: Order): boolean {
  // Tab Đã bàn giao: ưu tiên cờ nội bộ local_status / is_handed_over.
  if (!isOrderHandedOverToCarrier(order)) return false;
  // Vẫn chờ lấy hàng trên sàn, hoặc đã gắn HANDED_OVER nội bộ.
  return isOrderAwaitingCarrierPickup(order) || resolveOrderLocalStatus(order) === 'HANDED_OVER';
}

export function matchesProcessedPickupTab(order: Order): boolean {
  if (order.is_pending_shopee_check || order.status === 'pending_verification') return false;
  return order.status === 'processed' && !isOrderHandedOverToCarrier(order);
}
