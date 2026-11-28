import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  getConfiguredShopId,
  getOrderShopFilterOptions,
  deriveOrderShopFilterValue,
  parseOrderShopFilterValue,
  resolveShopIdsForFetch,
  matchesOrderSelectedShop,
} from '../src/utils/orderShopGroup.ts';

const shopeeMain = {
  id: 'internal-main',
  platform: 'shopee',
  shopId: ' 200 ',
  shopName: '  Cửa hàng chính  ',
  connected: true,
};

const shopeeSecond = {
  id: 'internal-second',
  platform: 'shopee',
  shopId: '100',
  shopName: '',
  connected: true,
};

const shops = [
  shopeeMain,
  shopeeSecond,
  { ...shopeeMain, id: 'duplicate', shopName: 'Bản trùng' },
  { id: 'offline', platform: 'shopee', shopId: '300', shopName: 'Offline', connected: false },
  { id: 'woo', platform: 'woocommerce', shopId: 'ck_consumer_secret', shopName: 'Website', connected: true },
  { id: 'tik', platform: 'tiktok', shopId: '400', shopName: 'TikTok', connected: true },
  { id: '', platform: 'shopee', shopId: '   ', shopName: 'Không ID', connected: true },
];

test('getConfiguredShopId trims and prefers shopId', () => {
  assert.equal(getConfiguredShopId({ shopId: ' 123 ', id: 'internal' }), '123');
  assert.equal(getConfiguredShopId({ shopId: ' ', id: ' internal ' }), 'internal');
  assert.equal(getConfiguredShopId({ shopId: ' ', id: ' ' }), '');
});

test('getOrderShopFilterOptions uses configured names and safe scope', () => {
  const options = getOrderShopFilterOptions(shops);
  assert.deepEqual(options[0], { value: 'all', label: 'Tất cả gian hàng' });
  assert.deepEqual(options.at(-1), {
    value: 'web',
    label: 'Đơn trên web',
    platform: 'woocommerce',
  });
  assert.deepEqual(options.slice(1, -1), [
    { value: 'shop:200', label: 'Cửa hàng chính', platform: 'shopee' },
    { value: 'shop:100', label: 'Shop 100', platform: 'shopee' },
  ]);
  assert.equal(options.some((option) => option.value.includes('ck_')), false);
});

test('deriveOrderShopFilterValue maps state to select values', () => {
  assert.equal(deriveOrderShopFilterValue('all', 'all'), 'all');
  assert.equal(deriveOrderShopFilterValue('shopee', ''), 'all');
  assert.equal(deriveOrderShopFilterValue('shopee', '200'), 'shop:200');
  assert.equal(deriveOrderShopFilterValue('woocommerce', 'ck_secret'), 'web');
});

test('parseOrderShopFilterValue handles valid and invalid values', () => {
  assert.deepEqual(parseOrderShopFilterValue('all', shops), { platform: 'all', shopId: 'all' });
  assert.deepEqual(parseOrderShopFilterValue('web', shops), { platform: 'woocommerce', shopId: 'all' });
  assert.deepEqual(parseOrderShopFilterValue('shop: 200 ', shops), { platform: 'shopee', shopId: '200' });
  assert.deepEqual(parseOrderShopFilterValue('shop:', shops), { platform: 'all', shopId: 'all' });
  assert.deepEqual(parseOrderShopFilterValue('shop:   ', shops), { platform: 'all', shopId: 'all' });
  assert.deepEqual(parseOrderShopFilterValue('invalid', shops), { platform: 'all', shopId: 'all' });
  assert.deepEqual(parseOrderShopFilterValue('shop:999', shops), { platform: 'shopee', shopId: '999' });
});

test('resolveShopIdsForFetch never sends non-marketplace IDs', () => {
  assert.deepEqual(resolveShopIdsForFetch(shops, 'ck_consumer_secret', 'woocommerce'), []);
  assert.deepEqual(resolveShopIdsForFetch(shops, 'manual-id', 'manual'), []);
  assert.deepEqual(resolveShopIdsForFetch(shops, 'lazada-id', 'lazada'), []);
  assert.deepEqual(resolveShopIdsForFetch(shops, '100', 'all'), []);
});

test('resolveShopIdsForFetch returns selected or sorted connected shop IDs', () => {
  assert.deepEqual(resolveShopIdsForFetch(shops, ' 200 ', 'shopee'), ['200']);
  assert.deepEqual(resolveShopIdsForFetch(shops, 'all', 'shopee'), ['100', '200']);
  assert.deepEqual(resolveShopIdsForFetch(shops, '', 'tiktok'), ['400']);
});

test('matchesOrderSelectedShop handles channels and legacy IDs', () => {
  assert.equal(matchesOrderSelectedShop({ channel: 'shopee' }, 'all', 'all', shops), true);
  assert.equal(matchesOrderSelectedShop({ channel: 'woocommerce' }, 'woocommerce', 'all', shops), true);
  assert.equal(matchesOrderSelectedShop({ channel: 'web' }, 'woocommerce', 'all', shops), true);
  assert.equal(matchesOrderSelectedShop({ channel: 'shopee' }, 'woocommerce', 'all', shops), false);
  assert.equal(matchesOrderSelectedShop({ channel: 'manual' }, 'manual', 'all', shops), true);
  assert.equal(matchesOrderSelectedShop({ channel: 'shopee' }, 'manual', 'all', shops), false);
  assert.equal(matchesOrderSelectedShop({ channel: 'shopee' }, 'lazada', 'all', shops), false);
  assert.equal(matchesOrderSelectedShop({ channel: 'shopee', shopId: '200' }, 'shopee', '200', shops), true);
  assert.equal(matchesOrderSelectedShop({ channel: 'shopee', shop_id: '200' }, 'shopee', '200', shops), true);
  assert.equal(matchesOrderSelectedShop({ channel: 'shopee', shopId: 'internal-main' }, 'shopee', '200', shops), true);
  assert.equal(matchesOrderSelectedShop({ channel: 'shopee' }, 'shopee', '200', shops), false);
  assert.equal(matchesOrderSelectedShop({ channel: 'shopee', shopId: '100' }, 'shopee', '200', shops), false);
});
