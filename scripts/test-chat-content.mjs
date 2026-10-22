import test from 'node:test';
import assert from 'node:assert/strict';
import { parseChatContent, safeChatUrl } from '../utils/chatContent.js';

test('reads product cards inside serialized and nested content, including old text wrappers', () => {
  const parsed = parseChatContent({ type: 'text', text: JSON.stringify({
    message_type: 'item', content: { item_info: { item_id: '123456789012345678', shop_id: '456', item_name: 'Mạch âm thanh', image_url: 'https://example.com/item.jpg' } },
  }) });
  assert.equal(parsed.kind, 'product');
  assert.equal(parsed.itemName, 'Mạch âm thanh');
  assert.equal(parsed.url, 'https://shopee.vn/product/456/123456789012345678');
  assert.equal(parsed.imageUrl, 'https://example.com/item.jpg');
  assert.equal(parsed.text, '[Sản phẩm] Mạch âm thanh');
});

test('order cards keep priority over the products and images they contain', () => {
  const parsed = parseChatContent({ message_type: 'order', content: JSON.stringify({ order_info: {
    order_sn: '261022ABC', order_url: 'https://shopee.vn/order/123',
    item_list: [{ item_id: 123, item_name: 'Sản phẩm', image_url: 'https://example.com/item.jpg' }],
  } }) });
  assert.equal(parsed.kind, 'order');
  assert.equal(parsed.orderSn, '261022ABC');
  assert.equal(parsed.url, 'https://shopee.vn/order/123');
  assert.equal(parsed.text, '[Đơn hàng] 261022ABC');
});

test('supports order IDs, direct links and ordinary text without inventing order links', () => {
  assert.equal(parseChatContent({ order_id: '987' }).orderId, '987');
  assert.equal(parseChatContent({ type: 'order' }).url, '');
  assert.equal(parseChatContent({ type: 'order', content: { item_list: [{ item_url: 'https://shopee.vn/product/1/2' }] } }).url, '');
  assert.equal(parseChatContent({ item_name: 'Mạch âm thanh' }).kind, 'product');
  assert.equal(parseChatContent({ content: { url: 'https://shopee.vn/product/1/2' } }).text, 'https://shopee.vn/product/1/2');
  assert.equal(parseChatContent({ text: 'Bạn còn hàng không?' }).text, 'Bạn còn hàng không?');
});

test('preserves image and sticker messages and rejects unsafe links', () => {
  assert.equal(parseChatContent({ type: 'image', content: { url: 'https://example.com/photo.jpg' } }).imageUrl, 'https://example.com/photo.jpg');
  assert.equal(parseChatContent({ type: 'sticker' }).kind, 'sticker');
  assert.equal(parseChatContent({ sticker_id: '123' }).kind, 'sticker');
  assert.equal(safeChatUrl('javascript:alert(1)'), '');
  assert.equal(parseChatContent({ type: 'item', item_url: 'javascript:alert(1)' }).url, '');
  const circular = {}; circular.content = circular;
  assert.doesNotThrow(() => parseChatContent(circular));
});
