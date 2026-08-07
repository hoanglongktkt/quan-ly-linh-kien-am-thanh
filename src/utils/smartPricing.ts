/** Chênh lệch giá anti-spam giữa các shop/sàn — 168đ (tránh quét trùng lặp) */
export const PRICE_OFFSET = 168;

/**
 * Tính giá Shopee / Lazada / TikTok với chênh lệch cố định 168đ.
 * shopIdx: thứ tự gian hàng (0,1,2…) → base + shopIdx * 168
 * Sàn: Shopee = base, Lazada = base+168, TikTok = base+336
 */
export function applySmartPricesFromShopee(shopeePrice: number, shopIdx = 0) {
  const raw = Math.max(0, Math.round(Number(shopeePrice) || 0));
  const base = raw + Math.max(0, Math.floor(Number(shopIdx) || 0)) * PRICE_OFFSET;
  return {
    shopee: base,
    lazada: base + PRICE_OFFSET,
    tiktok: base + PRICE_OFFSET * 2,
  };
}

/** @deprecated giữ tương thích — dùng PRICE_OFFSET */
export function roundUpToHundred(price: number): number {
  const n = Math.max(0, Number(price) || 0);
  return Math.ceil(n / 100) * 100;
}

export function calcLazadaFromShopee(shopeePrice: number): number {
  return applySmartPricesFromShopee(shopeePrice).lazada;
}

export function calcTikTokFromShopee(shopeePrice: number): number {
  return applySmartPricesFromShopee(shopeePrice).tiktok;
}
