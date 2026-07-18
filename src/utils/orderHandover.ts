import type { Order } from '../types';

export function isOrderHandedOverToCarrier(order: Partial<Order> & Record<string, unknown>): boolean {
  return Boolean(order.isHandedOverToCarrier ?? order.is_handed_over_to_carrier);
}

/** Trạng thái Shopee tương đương READY_TO_SHIP / PROCESSED — chờ bưu tá lấy hàng. */
export function isOrderAwaitingCarrierPickup(order: Pick<Order, 'status'>): boolean {
  return order.status === 'processed' || order.status === 'unprocessed';
}

export function matchesHandedOverCarrierTab(order: Order): boolean {
  return isOrderHandedOverToCarrier(order) && isOrderAwaitingCarrierPickup(order);
}

export function matchesProcessedPickupTab(order: Order): boolean {
  return order.status === 'processed' && !isOrderHandedOverToCarrier(order);
}
