/**
 * Realtime đơn hàng — frontend dùng short polling 10s (`/api/orders/counter` + list).
 * SSE đã gỡ: cPanel/LiteSpeed cắt mọi kết nối dài ở 45s.
 * Các hàm emit giữ nguyên chữ ký để caller (webhook/sync/scan/change stream) không phải đổi;
 * giờ chỉ ghi nhận metric cho /api/health.
 */

let lastNewOrderAt = 0;
let lastOrderUpdatedAt = 0;

/** @returns {{ pid: number, sseClients: number, lastNewOrderAt: string | null, lastOrderUpdatedAt: string | null }} */
export function getOrderRealtimeStats() {
  return {
    pid: process.pid,
    sseClients: 0,
    lastNewOrderAt: lastNewOrderAt ? new Date(lastNewOrderAt).toISOString() : null,
    lastOrderUpdatedAt: lastOrderUpdatedAt ? new Date(lastOrderUpdatedAt).toISOString() : null,
  };
}

/** @param {{ orderSn?: string, orderSns?: string[], shopId?: string, shopIds?: string[], status?: string, count?: number }} _payload */
export function emitNewOrder(_payload) {
  lastNewOrderAt = Date.now();
}

/** @param {{ orderSn?: string, orderSns?: string[], shopId?: string, shopIds?: string[], status?: string, count?: number }} _payload */
export function emitOrderUpdated(_payload) {
  lastOrderUpdatedAt = Date.now();
}
