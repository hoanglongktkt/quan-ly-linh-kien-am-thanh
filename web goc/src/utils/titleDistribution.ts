export interface ShopLike {
  id: string;
  name?: string;
  shopName?: string;
  platform: string;
}

/** Phân phối 3 tiêu đề: Shop Shopee A → T1, Shopee B → T2, Lazada/TikTok/còn lại → T3 */
export function distributeTitlesToShops(
  titles: string[],
  shops: ShopLike[]
): Record<string, string> {
  const t1 = (titles[0] || '').slice(0, 120);
  const t2 = (titles[1] || t1).slice(0, 120);
  const t3 = (titles[2] || t2).slice(0, 120);
  const shopee = shops.filter((s) => s.platform === 'shopee');
  const others = shops.filter((s) => s.platform !== 'shopee');
  const result: Record<string, string> = {};

  shopee.forEach((shop, idx) => {
    result[shop.id] = idx === 0 ? t1 : idx === 1 ? t2 : t3;
  });
  others.forEach((shop) => {
    result[shop.id] = t3;
  });

  return result;
}

export function parseAiTitleLines(raw: string): string[] {
  return raw
    .split('\n')
    .map((line) => line.replace(/^-\s*/, '').replace(/^\d+[\.\)]\s*/, '').trim())
    .filter((line) => line.length > 5)
    .map((line) => line.slice(0, 120))
    .slice(0, 3);
}

export function fallbackTitles(baseTitle: string): string[] {
  const b = baseTitle.slice(0, 80);
  return [
    `[Chính Hãng] ${b} - Cao Cấp Tốt Nhất`.slice(0, 120),
    `${b} [Sẵn Kho Sỉ] Đóng Gói Kỹ Lưỡng`.slice(0, 120),
    `${b} [FreeShip] Bảo Hành Uy Tín 12 Tháng`.slice(0, 120),
  ];
}
