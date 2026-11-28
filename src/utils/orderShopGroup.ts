import type { ConnectedShop, Order } from '../types';

export type OrderShopFilterValue = 'all' | 'web' | `shop:${string}`;

export interface ShopFilterOption {
  value: OrderShopFilterValue;
  label: string;
  platform?: ConnectedShop['platform'];
}

export function getConfiguredShopId(shop: ConnectedShop): string {
  return String(shop.shopId || '').trim() || String(shop.id || '').trim();
}

function normalizedOrderShopId(order: Order): string {
  return String(order.shopId || order.shop_id || '').trim();
}

export function getOrderShopFilterOptions(shops: ConnectedShop[]): ShopFilterOption[] {
  const seen = new Set<string>();
  const options: ShopFilterOption[] = [{ value: 'all', label: 'Tất cả gian hàng' }];

  for (const shop of shops) {
    if (shop.platform !== 'shopee' || shop.connected === false) continue;
    const id = getConfiguredShopId(shop);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    options.push({
      value: `shop:${id}`,
      label: String(shop.shopName || '').trim() || `Shop ${id}`,
      platform: shop.platform,
    });
  }

  options.push({ value: 'web', label: 'Đơn trên web', platform: 'woocommerce' });
  return options;
}

export function deriveOrderShopFilterValue(
  selectedPlatform: string,
  selectedShopId: string,
): OrderShopFilterValue {
  if (selectedPlatform === 'woocommerce') return 'web';
  if (selectedShopId && selectedShopId !== 'all') return `shop:${selectedShopId}`;
  return 'all';
}

export function parseOrderShopFilterValue(
  value: string,
  shops: ConnectedShop[],
): { platform: string; shopId: string } {
  if (value === 'web') return { platform: 'woocommerce', shopId: 'all' };
  if (value === 'all') return { platform: 'all', shopId: 'all' };

  const rawId = value.startsWith('shop:') ? value.slice(5).trim() : '';
  if (!rawId) return { platform: 'all', shopId: 'all' };
  const shop = shops.find(
    (candidate) => candidate.platform === 'shopee' && getConfiguredShopId(candidate) === rawId,
  );
  return {
    platform: shop?.platform || 'shopee',
    shopId: rawId || 'all',
  };
}

export function resolveShopIdsForFetch(
  shops: ConnectedShop[],
  selectedShopId: string,
  selectedPlatform: string,
): string[] {
  if (selectedPlatform !== 'shopee' && selectedPlatform !== 'tiktok') return [];
  const selected = String(selectedShopId || '').trim();
  if (selected && selected !== 'all') return [selected];

  return [...new Set(
    shops
      .filter((shop) => shop.platform === selectedPlatform && shop.connected !== false)
      .map(getConfiguredShopId)
      .filter(Boolean),
  )].sort();
}

export function matchesOrderSelectedShop(
  order: Order,
  selectedPlatform: string,
  selectedShopId: string,
  shops: ConnectedShop[],
): boolean {
  const channel = String(order.channel || '');
  if (selectedPlatform === 'all') return true;
  if (selectedPlatform === 'woocommerce') {
    return channel === 'woocommerce' || channel === 'web';
  }
  if (channel !== selectedPlatform) return false;

  const selected = String(selectedShopId || '').trim();
  if (!selected || selected === 'all') return true;
  const orderShopId = normalizedOrderShopId(order);
  if (!orderShopId) return false;
  if (orderShopId === selected) return true;

  const configured = shops.find(
    (shop) => getConfiguredShopId(shop) === selected && shop.platform === selectedPlatform,
  );
  const configuredId = String(configured?.id || '').trim();
  return Boolean(configuredId && orderShopId === configuredId);
}
