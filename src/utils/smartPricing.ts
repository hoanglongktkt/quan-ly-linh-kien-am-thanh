/** Chênh lệch giá anti-spam cố định 168đ — mọi ô giá phải unique */
export const PRICE_OFFSET = 168;

/** basePrice + globalIndex * 168 */
export function priceFromGlobalIndex(basePrice: number, globalIndex: number): number {
  const base = Math.max(0, Math.round(Number(basePrice) || 0));
  const idx = Math.max(0, Math.floor(Number(globalIndex) || 0));
  return base + idx * PRICE_OFFSET;
}

/**
 * 3 cột giá liên tiếp từ startGlobalIndex:
 * Shopee = base + start*168, Lazada = base+(start+1)*168, TikTok = base+(start+2)*168
 */
export function applySmartPricesFromShopee(shopeePrice: number, startGlobalIndex = 0) {
  const start = Math.max(0, Math.floor(Number(startGlobalIndex) || 0));
  return {
    shopee: priceFromGlobalIndex(shopeePrice, start),
    lazada: priceFromGlobalIndex(shopeePrice, start + 1),
    tiktok: priceFromGlobalIndex(shopeePrice, start + 2),
  };
}

/** Global index phẳng: shop → variant → 3 cột (Shopee/Lazada/TikTok) */
export function flatPriceGlobalIndex(shopIdx: number, variantIdx: number, variantCount: number): number {
  const s = Math.max(0, Math.floor(Number(shopIdx) || 0));
  const v = Math.max(0, Math.floor(Number(variantIdx) || 0));
  const n = Math.max(1, Math.floor(Number(variantCount) || 1));
  return s * n * 3 + v * 3;
}

/** @deprecated giữ tương thích */
export function roundUpToHundred(price: number): number {
  const n = Math.max(0, Number(price) || 0);
  return Math.ceil(n / 100) * 100;
}

export function calcLazadaFromShopee(shopeePrice: number): number {
  return applySmartPricesFromShopee(shopeePrice, 0).lazada;
}

export function calcTikTokFromShopee(shopeePrice: number): number {
  return applySmartPricesFromShopee(shopeePrice, 0).tiktok;
}
