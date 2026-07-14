import type { ConnectedShop, Order } from '../types';

const GENERIC_SHOPEE_SHOP_LABELS = new Set(['shopee shop', 'gian hàng']);

/** Tên shop mặc định từ OAuth/sync — không dùng để hiển thị nếu có shop đã kết nối. */
export function isGenericShopeeShopLabel(name?: string): boolean {
  const label = String(name || '').trim();
  if (!label) return true;
  if (GENERIC_SHOPEE_SHOP_LABELS.has(label.toLowerCase())) return true;
  if (/^shopee\s+\d+$/i.test(label)) return true;
  return false;
}

export function resolveOrderShopDisplayName(order: Order, shops: ConnectedShop[]): string {
  const sid = order.shopId?.trim();

  if (sid && shops.length > 0) {
    const match = shops.find((s) => s.shopId === sid || s.id === sid);
    const configured = match?.shopName?.trim();
    if (configured && !isGenericShopeeShopLabel(configured)) {
      return configured;
    }
  }

  const cached = order.shopName?.trim();
  if (cached && !isGenericShopeeShopLabel(cached)) {
    return cached;
  }

  if (sid) return `Shop ${sid}`;
  return 'Gian hàng';
}
