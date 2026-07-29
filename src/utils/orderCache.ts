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
/** Giữ cache lâu để mở app mobile hiện ngay dữ liệu cũ (SWR), API cập nhật ngầm sau. */
const MAX_DISPLAY_CACHE_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/** Chỉ lưu tối đa N đơn mới nhất — nhẹ máy, đủ hiện màn hình chính. */
const MAX_CACHED_ORDERS = 100;

type OrderCacheEnvelope = {
  version: number;
  savedAt: number;
  orders: Order[];
};

/** Cache hiển thị tức thì (stale-while-revalidate); không phải nguồn trạng thái chuẩn. */
export async function loadOrdersCache(): Promise<Order[]> {
  try {
    const raw = await ordersStore.getItem<unknown>(ORDERS_CACHE_KEY);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
    const cache = raw as Partial<OrderCacheEnvelope>;
    if (cache.version !== CACHE_VERSION || !Number.isFinite(cache.savedAt)) return [];
    if (Date.now() - Number(cache.savedAt) > MAX_DISPLAY_CACHE_AGE_MS) return [];
    return sanitizeOrders(cache.orders).slice(0, MAX_CACHED_ORDERS);
  } catch (err) {
    console.warn('[orderCache] load failed:', err);
    return [];
  }
}

export async function saveOrdersCache(orders: Order[]): Promise<void> {
  try {
    const trimmed = sanitizeOrders(orders).slice(0, MAX_CACHED_ORDERS);
    await ordersStore.setItem<OrderCacheEnvelope>(ORDERS_CACHE_KEY, {
      version: CACHE_VERSION,
      savedAt: Date.now(),
      orders: trimmed,
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
