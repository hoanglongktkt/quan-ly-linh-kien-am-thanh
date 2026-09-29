import localforage from 'localforage';
import type { Product } from '../types';
import { getProductChildren } from '../types';
import { safeGetItem, safeRemoveItem, safeSetItem } from './safeStorage';

/** Key đúng yêu cầu SWR — đọc đồng bộ lúc mở app để có hàng trong < 0.1s. */
export const CACHED_PRODUCTS_KEY = 'cachedProducts';

const CACHE_VERSION = 1;
/** Một trang vận hành + vài lần "Tải thêm". Đủ bán tại quầy, không nhồi hàng nghìn SP vào localStorage. */
const MAX_CACHED_PRODUCTS = 80;
const MAX_LOCAL_JSON_CHARS = 2_400_000;

const productsStore = localforage.createInstance({
  name: 'omni-app',
  storeName: 'products',
});

export type CachedProductsMeta = {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  hasMore: boolean;
};

export type CachedProductsSnapshot = {
  products: Product[];
  meta: CachedProductsMeta;
  savedAt: number;
};

type CacheEnvelope = {
  v: number;
  savedAt: number;
  products: Product[];
  meta: CachedProductsMeta;
};

export const EMPTY_PRODUCTS_META: CachedProductsMeta = {
  page: 1,
  pageSize: 50,
  total: 0,
  totalPages: 1,
  hasMore: false,
};

function normalizeMeta(raw: Partial<CachedProductsMeta> | null | undefined): CachedProductsMeta {
  return {
    page: Math.max(1, Number(raw?.page) || 1),
    pageSize: Math.max(1, Number(raw?.pageSize) || 50),
    total: Math.max(0, Number(raw?.total) || 0),
    totalPages: Math.max(1, Number(raw?.totalPages) || 1),
    hasMore: !!raw?.hasMore,
  };
}

function slimProduct(product: Product): Product {
  const next: Product = { ...product, description: '' };
  if (typeof next.imageUrl === 'string' && next.imageUrl.startsWith('data:')) {
    delete next.imageUrl;
  }
  if (typeof next.avatarUrl === 'string' && next.avatarUrl.startsWith('data:')) {
    delete next.avatarUrl;
  }
  const children = getProductChildren(product).map(slimProduct);
  if (children.length > 0) next.children = children;
  delete next.children_models;
  return next;
}

function sanitizeProducts(raw: unknown): Product[] {
  if (!Array.isArray(raw)) return [];
  const out: Product[] = [];
  for (const row of raw) {
    if (!row || typeof row !== 'object') continue;
    const id = String((row as Product).id || '').trim();
    if (!id) continue;
    out.push(slimProduct({ ...(row as Product), id }));
    if (out.length >= MAX_CACHED_PRODUCTS) break;
  }
  return out;
}

function parseSnapshot(raw: unknown): CachedProductsSnapshot | null {
  if (Array.isArray(raw)) {
    const products = sanitizeProducts(raw);
    if (products.length === 0) return null;
    return {
      products,
      meta: { ...EMPTY_PRODUCTS_META, total: products.length, pageSize: products.length },
      savedAt: 0,
    };
  }
  if (!raw || typeof raw !== 'object') return null;
  const envelope = raw as Partial<CacheEnvelope>;
  if (envelope.v != null && envelope.v !== CACHE_VERSION) return null;
  const products = sanitizeProducts(envelope.products);
  if (products.length === 0) return null;
  return {
    products,
    meta: normalizeMeta(envelope.meta),
    savedAt: Number(envelope.savedAt) || 0,
  };
}

/** Đọc đồng bộ — gọi trong useState initializer để paint ngay, không chờ mạng. */
export function loadCachedProductsSync(): CachedProductsSnapshot | null {
  try {
    const raw = safeGetItem(CACHED_PRODUCTS_KEY);
    if (!raw) return null;
    return parseSnapshot(JSON.parse(raw));
  } catch (err) {
    console.warn('[productCache] localStorage read failed:', err);
    return null;
  }
}

/** Fallback khi localStorage đầy — IndexedDB đọc bất đồng bộ sau frame đầu. */
export async function loadCachedProductsIdb(): Promise<CachedProductsSnapshot | null> {
  try {
    const raw = await productsStore.getItem<unknown>(CACHED_PRODUCTS_KEY);
    return parseSnapshot(raw);
  } catch (err) {
    console.warn('[productCache] IndexedDB read failed:', err);
    return null;
  }
}

function buildEnvelope(products: Product[], meta: CachedProductsMeta): CacheEnvelope {
  return {
    v: CACHE_VERSION,
    savedAt: Date.now(),
    products: sanitizeProducts(products),
    meta: normalizeMeta({
      ...meta,
      total: Math.max(Number(meta.total) || 0, products.length),
    }),
  };
}

export function saveCachedProducts(products: Product[], meta: CachedProductsMeta): void {
  if (!Array.isArray(products) || products.length === 0) return;
  let envelope = buildEnvelope(products, meta);
  if (envelope.products.length === 0) return;

  let payload = '';
  try {
    payload = JSON.stringify(envelope);
    while (payload.length > MAX_LOCAL_JSON_CHARS && envelope.products.length > 8) {
      envelope = {
        ...envelope,
        products: envelope.products.slice(0, Math.ceil(envelope.products.length / 2)),
      };
      payload = JSON.stringify(envelope);
    }
    safeSetItem(CACHED_PRODUCTS_KEY, payload);
  } catch (err) {
    console.warn('[productCache] localStorage save failed:', err);
  }

  void productsStore.setItem(CACHED_PRODUCTS_KEY, envelope).catch((err) => {
    console.warn('[productCache] IndexedDB save failed:', err);
  });
}

export function clearCachedProducts(): void {
  safeRemoveItem(CACHED_PRODUCTS_KEY);
  void productsStore.removeItem(CACHED_PRODUCTS_KEY).catch(() => {});
}
