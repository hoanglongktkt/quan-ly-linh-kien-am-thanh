import type { Order, Product } from '../types';
import { getProductChildren } from '../types';
import { findCatalogVariants } from './orderItemVariation';

type OrderLine = Record<string, unknown>;

function asRecord(value: unknown): OrderLine {
  return value && typeof value === 'object' ? (value as OrderLine) : {};
}

/** Dòng hàng của đơn — items rỗng/undefined thì trả [] (không crash). */
export function getOrderLineItems(order: Order | null | undefined): OrderLine[] {
  if (!order || typeof order !== 'object') return [];
  const raw = order as Order & { products?: unknown };
  if (Array.isArray(raw.items) && raw.items.length > 0) return raw.items as unknown as OrderLine[];
  if (Array.isArray(raw.products) && raw.products.length > 0) return raw.products as unknown as OrderLine[];
  return [];
}

/** Key giá nhập trên catalog: `importPrice` (alias: import_price, last_import_price, cost_price). */
export function readImportPrice(source: unknown): number {
  const row = asRecord(source);
  const raw = row.importPrice ?? row.import_price ?? row.last_import_price ?? row.cost_price;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return 0;
  return n;
}

function normalizeId(raw: unknown): string {
  return String(raw ?? '').trim();
}

function collectCatalogCandidates(item: OrderLine, catalogProducts: Product[]): Product[] {
  const itemId = normalizeId(item.productId);
  const sku = normalizeId(item.modelSku || item.sku).toLowerCase();
  const modelId = normalizeId(item.modelId);
  const out: Product[] = [];
  const seen = new Set<string>();
  const push = (p?: Product) => {
    if (!p) return;
    const key = normalizeId(p.id || p.shopeeModelId || p.sku);
    if (key && seen.has(key)) return;
    if (key) seen.add(key);
    out.push(p);
  };

  if (itemId) {
    for (const p of findCatalogVariants(catalogProducts, itemId)) {
      push(p);
      for (const c of getProductChildren(p)) push(c);
    }
    for (const p of catalogProducts) {
      const parentHit = p.shopeeItemId === itemId || p.id === itemId;
      if (parentHit) {
        push(p);
        for (const c of getProductChildren(p)) push(c);
      } else {
        for (const c of getProductChildren(p)) {
          if (c.shopeeItemId === itemId || c.id === itemId || c.shopeeModelId === itemId) push(c);
        }
      }
    }
  }

  if (sku || (modelId && modelId !== '0')) {
    for (const p of catalogProducts) {
      const pool = [p, ...getProductChildren(p)];
      for (const c of pool) {
        if (sku && normalizeId(c.sku).toLowerCase() === sku) push(c);
        if (modelId && modelId !== '0' && c.shopeeModelId === modelId) push(c);
      }
    }
  }

  return out;
}

/** Khớp dòng đơn → sản phẩm/SKU con trong kho tổng (theo modelId / SKU / tên phân loại). */
export function matchCatalogProduct(item: OrderLine, catalogProducts: Product[]): Product | undefined {
  if (!Array.isArray(catalogProducts) || catalogProducts.length === 0) return undefined;
  const candidates = collectCatalogCandidates(item, catalogProducts);
  if (candidates.length === 0) return undefined;

  const modelId = normalizeId(item.modelId);
  if (modelId && modelId !== '0') {
    const byModel = candidates.find((p) => p.shopeeModelId === modelId);
    if (byModel) return byModel;
  }

  const sku = normalizeId(item.modelSku || item.sku).toLowerCase();
  if (sku) {
    const bySku = candidates.find((p) => normalizeId(p.sku).toLowerCase() === sku);
    if (bySku) return bySku;
  }

  const modelName = normalizeId(item.modelName).toLowerCase();
  if (modelName) {
    const byName = candidates.filter(
      (p) =>
        normalizeId(p.modelName).toLowerCase() === modelName ||
        normalizeId(p.title).toLowerCase().endsWith(` - ${modelName}`),
    );
    if (byName.length === 1) return byName[0];
  }

  if (candidates.length === 1) return candidates[0];
  return undefined;
}

export function resolveItemImportPrice(item: unknown, catalogProducts: Product[] = []): number {
  try {
    const row = asRecord(item);
    const fromItem = readImportPrice(row);
    if (fromItem > 0) return fromItem;
    const matched = matchCatalogProduct(row, catalogProducts);
    return readImportPrice(matched);
  } catch {
    return 0;
  }
}

/**
 * Tổng giá vốn = Sum(giá_nhập × số_lượng).
 * items rỗng/undefined → 0. Thiếu giá nhập → 0. Không bao giờ NaN / throw.
 */
export function getOrderTotalImportCost(order: Order | null | undefined, catalogProducts: Product[] = []): number {
  try {
    const items = getOrderLineItems(order);
    if (items.length === 0) return 0;
    const total = items.reduce((sum, item) => {
      const qty = Math.max(0, Number(item?.quantity ?? item?.qty) || 0);
      const unit = resolveItemImportPrice(item, catalogProducts);
      const line = qty * unit;
      return sum + (Number.isFinite(line) ? line : 0);
    }, 0);
    return Number.isFinite(total) ? total : 0;
  } catch {
    return 0;
  }
}
