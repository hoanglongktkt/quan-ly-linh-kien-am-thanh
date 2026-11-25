import { isShopeeInternalTrackingCode } from '../logistics/tracking.ts';

type ShipmentOrder = Record<string, any>;

export function hasShipmentWaybill(order: ShipmentOrder): boolean {
  return [order.tracking_no, order.trackingNumber, order.shopee_tracking_number,
    ...(Array.isArray(order.package_list) ? order.package_list.flatMap((p: any) =>
      [p.tracking_number, p.tracking_no, p.trackingNumber]) : [])]
    .some(value => {
      const code = String(value || '').trim();
      return Boolean(code && code !== '0' && !isShopeeInternalTrackingCode(code));
    });
}

export function canReviewShipment(order: ShipmentOrder): boolean {
  return String(order.channel || '').toLowerCase() === 'shopee' &&
    !['SHIPPED', 'TO_CONFIRM_RECEIVE', 'COMPLETED', 'CANCELLED', 'IN_CANCEL', 'TO_RETURN'].includes(
      String(order.shopee_order_status || '').toUpperCase()) &&
    !['shipping', 'completed', 'cancelled', 'return_pending', 'return_received'].includes(order.status) &&
    !order.return_sn && order.is_return !== true && order.is_handed_over !== true &&
    order.isHandedOverToCarrier !== true && order.is_handed_over_to_carrier !== true &&
    !['HANDED_OVER', 'CANCELLED_STORED', 'RETURN_RECEIVED'].includes(
      String(order.local_status || order.localStatus || order.internal_status || '').toUpperCase());
}

export function isPendingShipmentReview(order: ShipmentOrder): boolean {
  return canReviewShipment(order) && order.is_pending_shopee_check === true && !hasShipmentWaybill(order);
}

/** A rejected arrangement is never evidence that the shop prepared/printed it. */
export function markShipmentReview(order: ShipmentOrder, reason: string): boolean {
  if (!canReviewShipment(order)) return false;
  Object.assign(order, {
    status: 'pending_confirm', is_pending_shopee_check: true,
    isPrepared: false, isPrinted: false, has_tracking: hasShipmentWaybill(order),
    shopeeSyncPending: false, shopeeSyncError: reason,
  });
  return true;
}

/** Called after merging authoritative Shopee tracking, never from an optimistic UI update. */
export function reconcileShipmentReview(order: ShipmentOrder): boolean {
  if (!canReviewShipment(order) || order.is_pending_shopee_check !== true) return false;
  const ready = hasShipmentWaybill(order);
  Object.assign(order, {
    status: ready ? 'unprocessed' : 'pending_confirm',
    isPrepared: false, isPrinted: false, is_pending_shopee_check: !ready,
    shopeeSyncPending: false,
  });
  if (ready) {
    order.shopeeSyncError = '';
    if (['UNPAID', 'PENDING', 'IN_REVIEW', 'FRAUD_CHECK', 'INVOICE_PENDING'].includes(
      String(order.shopee_order_status || '').toUpperCase())) order.shopee_order_status = 'PROCESSED';
  }
  return true;
}
