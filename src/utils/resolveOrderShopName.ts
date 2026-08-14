import type { ConnectedShop, Order } from '../types';

const GENERIC_SHOPEE_SHOP_LABELS = new Set(['shopee shop', 'gian hàng']);

/** Chốt ID → tên: không lấy tên shop kia từ channel_settings đảo AuDIO↔LKAT. */
const CANONICAL_SHOPEE_SHOP_NAMES: Record<string, string> = {
  '4127421': 'LKAT',
  '831052930': 'AuDIO',
};

const OTHER_SHOP_NAME_HINTS: Record<string, string[]> = {
  '4127421': ['audio', 'au dio', 'lk audio'],
  '831052930': ['âm thanh', 'am thanh', 'lkat', 'lk at', 'linh kiện âm thanh'],
};

/** Tên shop mặc định từ OAuth/sync — không dùng để hiển thị nếu có shop đã kết nối. */
export function isGenericShopeeShopLabel(name?: string): boolean {
  const label = String(name || '').trim();
  if (!label) return true;
  if (GENERIC_SHOPEE_SHOP_LABELS.has(label.toLowerCase())) return true;
  if (/^shopee\s+\d+$/i.test(label)) return true;
  return false;
}

function looksLikeOtherShopName(shopId: string, name: string): boolean {
  const n = name.trim().toLowerCase();
  if (!n) return false;
  const hints = OTHER_SHOP_NAME_HINTS[shopId] || [];
  return hints.some((h) => n === h || n.includes(h));
}

export function resolveOrderShopDisplayName(order: Order, shops: ConnectedShop[]): string {
  const sid = String(order.shopId || '').trim();
  const canonical = sid ? CANONICAL_SHOPEE_SHOP_NAMES[sid] : undefined;

  if (sid && shops.length > 0) {
    const match = shops.find(
      (s) => String(s.shopId || '') === sid || String(s.id || '') === sid,
    );
    const configured = match?.shopName?.trim();
    if (
      configured &&
      !isGenericShopeeShopLabel(configured) &&
      !looksLikeOtherShopName(sid, configured)
    ) {
      return configured;
    }
  }

  if (canonical) return canonical;

  const cached = order.shopName?.trim();
  if (cached && !isGenericShopeeShopLabel(cached) && !looksLikeOtherShopName(sid, cached)) {
    return cached;
  }

  if (sid) return canonical || `Shop ${sid}`;
  return 'Gian hàng';
}
