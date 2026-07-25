import localforage from 'localforage';
import type { Order } from '../types';
import { sanitizeOrders } from './sanitizeOrder';
import { safeRemoveItem } from './safeStorage';

const ordersStore = localforage.createInstance({
  name: 'omni-app',
  storeName: 'orders',
});

const ORDERS_CACHE_KEY = 'orders_v2';
const CACHE_VERSION = 2;
const MAX_DISPLAY_CACHE_AGE_MS = 5 * 60 * 1000;

type OrderCacheEnvelope = {
  version: number;
  savedAt: number;
  orders: Order[];
};

/** Cache chỉ phục vụ hiển thị ngắn hạn; không được xem là dữ liệu trạng thái chuẩn. */
export async function loadOrdersCache(): Promise<Order[]> {
  try {
    const raw = await ordersStore.getItem<unknown>(ORDERS_CACHE_KEY);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
    const cache = raw as Partial<OrderCacheEnvelope>;
    if (cache.version !== CACHE_VERSION || !Number.isFinite(cache.savedAt)) return [];
    if (Date.now() - Number(cache.savedAt) > MAX_DISPLAY_CACHE_AGE_MS) return [];
    return sanitizeOrders(cache.orders);
  } catch (err) {
    console.warn('[orderCache] load failed:', err);
    return [];
  }
}

export async function saveOrdersCache(orders: Order[]): Promise<void> {
  try {
    await ordersStore.setItem<OrderCacheEnvelope>(ORDERS_CACHE_KEY, {
      version: CACHE_VERSION,
      savedAt: Date.now(),
      orders,
    });
  } catch (err) {
    console.warn('[orderCache] save failed:', err);
  }
}

/** Xóa dữ liệu đơn hàng cũ trong localStorage (nguyên nhân crash quota). */
export function clearLegacyOrdersLocalStorage(): void {
  safeRemoveItem('omni_orders');
}

/** Xóa IndexedDB orders cache (đơn bóng ma sau khi purge server). */
export async function clearOrdersCache(): Promise<void> {
  try {
    await ordersStore.removeItem(ORDERS_CACHE_KEY);
    clearLegacyOrdersLocalStorage();
  } catch (err) {
    console.warn('[orderCache] clear failed:', err);
  }
}
