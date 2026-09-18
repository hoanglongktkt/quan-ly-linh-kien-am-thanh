/** Lịch sử giá bán Mini POS — không đụng giá niêm yết sàn (`sellingPrice`). */

export const POS_PRICE_HISTORY_CAP = 8;
export const POS_CUSTOMER_SKU_CAP = 80;

export function roundPosPrice(value) {
  return Math.max(0, Math.round(Number(value) || 0));
}

export function normalizePosPriceHistory(existing, cap = POS_PRICE_HISTORY_CAP) {
  if (!Array.isArray(existing)) return [];
  const out = [];
  const seen = new Set();
  const safeCap = Math.min(
    POS_PRICE_HISTORY_CAP,
    Math.max(1, Math.floor(Number(cap) || POS_PRICE_HISTORY_CAP)),
  );
  for (let i = 0; i < existing.length && out.length < safeCap; i += 1) {
    const price = roundPosPrice(existing[i]);
    if (price <= 0 || seen.has(price)) continue;
    seen.add(price);
    out.push(price);
  }
  return out;
}

export function mergePosPriceHistory(existing, newPrice, cap = POS_PRICE_HISTORY_CAP) {
  const price = roundPosPrice(newPrice);
  const safeCap = Math.min(
    POS_PRICE_HISTORY_CAP,
    Math.max(1, Math.floor(Number(cap) || POS_PRICE_HISTORY_CAP)),
  );
  if (price <= 0) return normalizePosPriceHistory(existing, safeCap);
  const next = [price];
  const seen = new Set([price]);
  const prev = normalizePosPriceHistory(existing, safeCap);
  for (let i = 0; i < prev.length && next.length < safeCap; i += 1) {
    const p = prev[i];
    if (seen.has(p)) continue;
    seen.add(p);
    next.push(p);
  }
  return next;
}

export function normalizePosSkuPrices(existing, cap = POS_CUSTOMER_SKU_CAP) {
  if (!Array.isArray(existing)) return [];
  const out = [];
  const seen = new Set();
  const safeCap = Math.min(
    POS_CUSTOMER_SKU_CAP,
    Math.max(1, Math.floor(Number(cap) || POS_CUSTOMER_SKU_CAP)),
  );
  for (let i = 0; i < existing.length && out.length < safeCap; i += 1) {
    const row = existing[i];
    const sku = String(row?.sku || "").trim();
    const price = roundPosPrice(row?.price);
    if (!sku || price <= 0 || seen.has(sku)) continue;
    seen.add(sku);
    out.push({
      sku,
      price,
      updatedAt: String(row?.updatedAt || ""),
    });
  }
  return out;
}

export function mergePosSkuPrices(existing, sku, price, cap = POS_CUSTOMER_SKU_CAP) {
  const skuNorm = String(sku || "").trim();
  const nextPrice = roundPosPrice(price);
  const safeCap = Math.min(
    POS_CUSTOMER_SKU_CAP,
    Math.max(1, Math.floor(Number(cap) || POS_CUSTOMER_SKU_CAP)),
  );
  if (!skuNorm || nextPrice <= 0) return normalizePosSkuPrices(existing, safeCap);
  const rest = [];
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
