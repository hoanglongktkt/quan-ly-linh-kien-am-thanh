import type { ConnectedShop, Order } from '../types';

export type OrderShopGroup = 'all' | 'audio' | 'lkat' | 'web';

const CANONICAL_SHOP_GROUP_IDS: Record<Exclude<OrderShopGroup, 'all' | 'web'>, string[]> = {
  audio: ['831052930'],
  lkat: ['4127421'],
};

function normalizedShopId(value: unknown): string {
  return String(value || '').trim();
}

function shopIdOf(shop: ConnectedShop): string {
  return normalizedShopId(shop.shopId) || normalizedShopId(shop.id);
}

function orderShopIdOf(order: Order): string {
  return normalizedShopId(order.shopId) || normalizedShopId(order.shop_id);
}

function groupNamePattern(group: Exclude<OrderShopGroup, 'all' | 'web'>): RegExp {
  // Ưu tiên LKAT để tên “Linh kiện âm thanh” không rơi nhầm vào nhóm audio.
  return group === 'lkat'
    ? /lkat|lk\s*at|linh kiện âm thanh|âm thanh|am thanh/i
    : /audio|au\s*dio/i;
}

function belongsToOtherCanonicalGroup(
  id: string,
  group: Exclude<OrderShopGroup, 'all' | 'web'>,
): boolean {
  return (Object.keys(CANONICAL_SHOP_GROUP_IDS) as Array<Exclude<OrderShopGroup, 'all' | 'web'>>)
    .filter((candidate) => candidate !== group)
    .some((candidate) => CANONICAL_SHOP_GROUP_IDS[candidate].includes(id));
}

export function matchesShopGroupName(
  shopName: unknown,
  group: Exclude<OrderShopGroup, 'all' | 'web'>,
): boolean {
  return groupNamePattern(group).test(String(shopName || '').trim());
}

function shopBelongsToGroup(shop: ConnectedShop, group: Exclude<OrderShopGroup, 'all' | 'web'>): boolean {
  const id = shopIdOf(shop);
  const canonicalIds = CANONICAL_SHOP_GROUP_IDS[group];
  if (id && canonicalIds.includes(id)) return true;
  if (id && belongsToOtherCanonicalGroup(id, group)) return false;
  return matchesShopGroupName(shop.shopName, group);
}

export function resolveShopIdsForGroup(
  shops: ConnectedShop[],
  group: Exclude<OrderShopGroup, 'all' | 'web'>,
): string[] {
  const matchedIds = shops
    .filter((shop) => shop.platform === 'shopee' && shop.connected !== false)
    .filter((shop) => shopBelongsToGroup(shop, group))
    .map(shopIdOf)
    .filter(Boolean);
  const canonicalIds = CANONICAL_SHOP_GROUP_IDS[group];
  // Khi danh sách shop chưa hydrate, vẫn giữ đúng phạm vi nhóm thay vì gửi toàn bộ shop.
  return [...new Set(matchedIds.length > 0 ? matchedIds : canonicalIds)].sort();
}

export function resolveShopIdsForFetch(
  shops: ConnectedShop[],
  selectedShopId: string,
  selectedPlatform: string,
  selectedShopGroup: OrderShopGroup = 'all',
): string[] {
  if (selectedShopId && selectedShopId !== 'all') return [String(selectedShopId)];

  if (selectedShopGroup === 'audio' || selectedShopGroup === 'lkat') {
    return resolveShopIdsForGroup(shops, selectedShopGroup);
  }

  if (
    selectedPlatform === 'all' ||
    selectedPlatform === 'manual' ||
    selectedPlatform === 'lazada'
  ) {
    return [];
  }

  const ids = shops
    .filter((shop) => shop.platform === selectedPlatform && shop.connected !== false)
    .map(shopIdOf)
    .filter(Boolean);
  return [...new Set(ids)].sort();
}

export function matchesOrderShopGroup(
  order: Order,
  group: OrderShopGroup,
  shopeeShops: ConnectedShop[],
): boolean {
  if (group === 'all') return true;
  if (group === 'web') {
    const channel = String(order.channel || '');
    return channel === 'woocommerce' || channel === 'web';
  }
  if (order.channel !== 'shopee') return false;

  const orderShopId = orderShopIdOf(order);
  const groupShopIds = new Set(resolveShopIdsForGroup(shopeeShops, group));
  if (orderShopId) return groupShopIds.has(orderShopId);

  // Fallback cho dữ liệu cũ không có ID shop ở root.
  return matchesShopGroupName(order.shopName || order.shop_name, group);
}
