/** Lịch sử giá bán Mini POS — không đụng giá niêm yết sàn (`sellingPrice`). */

export const POS_PRICE_HISTORY_CAP = 8;
export const POS_CUSTOMER_SKU_CAP = 80;

export type PosSkuPrice = {
  sku: string;
  price: number;
  updatedAt: string;
};

export type PosPriceSource = 'customer' | 'pos_last' | 'catalog';

export type PosPriceChip = {
  price: number;
  kind: 'customer' | 'history' | 'catalog';
};

export function roundPosPrice(value: unknown): number {
  return Math.max(0, Math.round(Number(value) || 0));
}

export function normalizePosPriceHistory(
  existing: unknown,
  cap = POS_PRICE_HISTORY_CAP,
): number[] {
  if (!Array.isArray(existing)) return [];
  const out: number[] = [];
  const seen = new Set<number>();
  const safeCap = Math.min(POS_PRICE_HISTORY_CAP, Math.max(1, Math.floor(Number(cap) || POS_PRICE_HISTORY_CAP)));
  for (let i = 0; i < existing.length && out.length < safeCap; i += 1) {
    const price = roundPosPrice(existing[i]);
    if (price <= 0 || seen.has(price)) continue;
    seen.add(price);
    out.push(price);
  }
  return out;
}

export function mergePosPriceHistory(
  existing: unknown,
  newPrice: unknown,
  cap = POS_PRICE_HISTORY_CAP,
): number[] {
  const price = roundPosPrice(newPrice);
  const safeCap = Math.min(POS_PRICE_HISTORY_CAP, Math.max(1, Math.floor(Number(cap) || POS_PRICE_HISTORY_CAP)));
  if (price <= 0) return normalizePosPriceHistory(existing, safeCap);
  const next: number[] = [price];
  const seen = new Set<number>([price]);
  const prev = normalizePosPriceHistory(existing, safeCap);
  for (let i = 0; i < prev.length && next.length < safeCap; i += 1) {
    const p = prev[i];
    if (seen.has(p)) continue;
    seen.add(p);
    next.push(p);
  }
  return next;
}

export function normalizePosSkuPrices(
  existing: unknown,
  cap = POS_CUSTOMER_SKU_CAP,
): PosSkuPrice[] {
  if (!Array.isArray(existing)) return [];
  const out: PosSkuPrice[] = [];
  const seen = new Set<string>();
  const safeCap = Math.min(POS_CUSTOMER_SKU_CAP, Math.max(1, Math.floor(Number(cap) || POS_CUSTOMER_SKU_CAP)));
  for (let i = 0; i < existing.length && out.length < safeCap; i += 1) {
    const row = existing[i] as Partial<PosSkuPrice> | null;
    const sku = String(row?.sku || '').trim();
    const price = roundPosPrice(row?.price);
    if (!sku || price <= 0 || seen.has(sku)) continue;
    seen.add(sku);
    out.push({
      sku,
      price,
      updatedAt: String(row?.updatedAt || ''),
    });
  }
  return out;
}

export function mergePosSkuPrices(
  existing: unknown,
  sku: unknown,
  price: unknown,
  cap = POS_CUSTOMER_SKU_CAP,
): PosSkuPrice[] {
  const skuNorm = String(sku || '').trim();
  const nextPrice = roundPosPrice(price);
  const safeCap = Math.min(POS_CUSTOMER_SKU_CAP, Math.max(1, Math.floor(Number(cap) || POS_CUSTOMER_SKU_CAP)));
  if (!skuNorm || nextPrice <= 0) return normalizePosSkuPrices(existing, safeCap);
  const rest: PosSkuPrice[] = [];
  const prev = normalizePosSkuPrices(existing, safeCap);
  for (let i = 0; i < prev.length; i += 1) {
    if (prev[i].sku === skuNorm) continue;
    rest.push(prev[i]);
  }
  return [{ sku: skuNorm, price: nextPrice, updatedAt: new Date().toISOString() }, ...rest].slice(
    0,
    safeCap,
  );
}

export function lookupCustomerSkuPrice(existing: unknown, sku: unknown): number {
  const skuNorm = String(sku || '').trim();
  if (!skuNorm) return 0;
  const list = normalizePosSkuPrices(existing);
  for (let i = 0; i < list.length; i += 1) {
    if (list[i].sku === skuNorm) return list[i].price;
  }
  return 0;
}

export function resolvePosSellingPrice(opts: {
  customerPrice?: unknown;
  posLastSellingPrice?: unknown;
  catalogSellingPrice?: unknown;
}): { price: number; source: PosPriceSource } {
  const customerPrice = roundPosPrice(opts.customerPrice);
  if (customerPrice > 0) return { price: customerPrice, source: 'customer' };
  const posLast = roundPosPrice(opts.posLastSellingPrice);
  if (posLast > 0) return { price: posLast, source: 'pos_last' };
  return { price: roundPosPrice(opts.catalogSellingPrice), source: 'catalog' };
}

export function buildPosPriceChips(opts: {
  customerPrice?: unknown;
  posPriceHistory?: unknown;
  catalogSellingPrice?: unknown;
}): PosPriceChip[] {
  const chips: PosPriceChip[] = [];
  const seen = new Set<number>();
  const push = (value: unknown, kind: PosPriceChip['kind']) => {
    const price = roundPosPrice(value);
    if (price <= 0 || seen.has(price) || chips.length >= POS_PRICE_HISTORY_CAP) return;
    seen.add(price);
    chips.push({ price, kind });
  };
  push(opts.customerPrice, 'customer');
  const history = normalizePosPriceHistory(opts.posPriceHistory);
  for (let i = 0; i < history.length; i += 1) {
    push(history[i], 'history');
  }
  push(opts.catalogSellingPrice, 'catalog');
  return chips;
}
