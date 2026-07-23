import { Product } from '../types';
import { safeGetItem, safeGetJson, safeRemoveItem, safeSetItem } from './safeStorage';

/** Cache catalog cũ — chỉ dọn các key legacy, không đụng persistence mới. */
export const LEGACY_CATALOG_KEYS = ['omni_products', 'omni_channel_listings'] as const;

export const CATALOG_PURGE_FLAG = 'omni_catalog_empty_v2';

/** Persistence Local Cache Master trên trình duyệt (F5 không mất dữ liệu). */
export const INVENTORY_PRODUCTS_KEY = 'omni_inventory_products_v1';
export const INVENTORY_LISTINGS_KEY = 'omni_inventory_listings_v1';
export const INVENTORY_META_KEY = 'omni_inventory_meta_v1';

export type InventorySourceMode = 'cache' | 'server' | 'empty';

export type InventoryMeta = {
  updatedAt: string;
  source: InventorySourceMode;
  productCount: number;
  listingCount: number;
};

export function purgeLegacyCatalogCache(): void {
  for (const key of LEGACY_CATALOG_KEYS) {
    safeRemoveItem(key);
  }
}

export function loadPersistedProducts<T = Product>(): T[] {
  const rows = safeGetJson<T[]>(INVENTORY_PRODUCTS_KEY, []);
  return Array.isArray(rows) ? rows : [];
}

export function savePersistedProducts(products: unknown[]): boolean {
  if (!Array.isArray(products)) return false;
  const ok = safeSetItem(INVENTORY_PRODUCTS_KEY, JSON.stringify(products));
  if (ok) {
    const meta = loadInventoryMeta();
    saveInventoryMeta({
      ...meta,
      updatedAt: new Date().toISOString(),
      productCount: products.length,
      source: meta.source === 'empty' ? 'cache' : meta.source,
    });
  }
  return ok;
}

export function clearPersistedProducts(): void {
  safeRemoveItem(INVENTORY_PRODUCTS_KEY);
}

export function loadPersistedListings<T = any>(): T[] {
  const rows = safeGetJson<T[]>(INVENTORY_LISTINGS_KEY, []);
  return Array.isArray(rows) ? rows : [];
}

export function savePersistedListings(listings: unknown[]): boolean {
  if (!Array.isArray(listings)) return false;
  const ok = safeSetItem(INVENTORY_LISTINGS_KEY, JSON.stringify(listings));
  if (ok) {
    const meta = loadInventoryMeta();
    saveInventoryMeta({
      ...meta,
      updatedAt: new Date().toISOString(),
      listingCount: listings.length,
      source: meta.source === 'empty' ? 'cache' : meta.source,
    });
  }
  return ok;
}

export function clearPersistedListings(): void {
  safeRemoveItem(INVENTORY_LISTINGS_KEY);
}

export function loadInventoryMeta(): InventoryMeta {
  const fallback: InventoryMeta = {
    updatedAt: '',
    source: 'empty',
    productCount: 0,
    listingCount: 0,
  };
  const meta = safeGetJson<Partial<InventoryMeta>>(INVENTORY_META_KEY, fallback);
  return {
    updatedAt: String(meta.updatedAt || ''),
    source: (meta.source as InventorySourceMode) || 'empty',
    productCount: Number(meta.productCount) || 0,
    listingCount: Number(meta.listingCount) || 0,
  };
}

export function saveInventoryMeta(meta: InventoryMeta): void {
  safeSetItem(INVENTORY_META_KEY, JSON.stringify(meta));
}

/** Xóa cache trình duyệt — chỉ gọi khi user bấm "Tải dữ liệu từ sàn". */
export function clearInventoryBrowserCache(): void {
  clearPersistedProducts();
  clearPersistedListings();
  saveInventoryMeta({
    updatedAt: new Date().toISOString(),
    source: 'empty',
    productCount: 0,
    listingCount: 0,
  });
}

export function hasPersistedInventory(): boolean {
  return loadPersistedProducts().length > 0 || loadPersistedListings().length > 0;
}
