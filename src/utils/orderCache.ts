import localforage from 'localforage';
import type { Order } from '../types';
import { sanitizeOrders } from './sanitizeOrder';
import { safeRemoveItem } from './safeStorage';

const ordersStore = localforage.createInstance({
  name: 'omni-app',
  storeName: 'orders',
});

const ORDERS_CACHE_KEY = 'orders_v1';

/** Cache đơn hàng trên IndexedDB (hàng trăm MB) — không dùng localStorage. */
export async function loadOrdersCache(): Promise<Order[]> {
  try {
    const raw = await ordersStore.getItem<unknown>(ORDERS_CACHE_KEY);
    return sanitizeOrders(raw);
  } catch (err) {
    console.warn('[orderCache] load failed:', err);
    return [];
  }
}

export async function saveOrdersCache(orders: Order[]): Promise<void> {
  try {
    await ordersStore.setItem(ORDERS_CACHE_KEY, orders);
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
