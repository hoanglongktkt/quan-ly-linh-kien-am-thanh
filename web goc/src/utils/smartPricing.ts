/** Làm tròn lên đến hàng trăm đồng (155,037 → 155,100) */
export function roundUpToHundred(price: number): number {
  const n = Math.max(0, Number(price) || 0);
  return Math.ceil(n / 100) * 100;
}

/** Giá Lazada = Shopee + 0.05%, làm tròn hàng trăm */
export function calcLazadaFromShopee(shopeePrice: number): number {
  const base = Math.max(0, Number(shopeePrice) || 0);
  return roundUpToHundred(base + base * 0.0005);
}

/** Giá TikTok = Shopee + 0.1%, làm tròn hàng trăm */
export function calcTikTokFromShopee(shopeePrice: number): number {
  const base = Math.max(0, Number(shopeePrice) || 0);
  return roundUpToHundred(base + base * 0.001);
}

export function applySmartPricesFromShopee(shopeePrice: number) {
  return {
    shopee: roundUpToHundred(shopeePrice),
    lazada: calcLazadaFromShopee(shopeePrice),
    tiktok: calcTikTokFromShopee(shopeePrice),
  };
}
