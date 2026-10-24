// Shared by webhook snippets and the chat UI, including previously stored messages.
export function safeChatUrl(value) {
  if (typeof value !== 'string') return '';
  try {
    const url = new URL(value.trim());
    return ['https:', 'http:'].includes(url.protocol) ? url.href : '';
  } catch { return ''; }
}

function scalar(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return typeof value === 'string' && value.trim() !== '[object Object]' ? value.trim() : '';
}

export function parseChatContent(content, messageType = '') {
  const nodes = [];
  const seen = new Set();
  function visit(value, depth = 0) {
    if (value == null || depth > 8 || nodes.length >= 250) return;
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (/^[{\[]/.test(trimmed) && trimmed.length <= 100000) {
        try { visit(JSON.parse(trimmed), depth + 1); return; } catch { /* plain text */ }
      }
      nodes.push(value);
    } else if (typeof value === 'object' && !seen.has(value)) {
      seen.add(value);
      if (Array.isArray(value)) { value.slice(0, 50).forEach(v => visit(v, depth + 1)); return; }
      nodes.push(value);
      for (const key of ['content', 'text', 'data', 'order', 'order_info', 'order_card', 'item', 'item_info', 'item_card', 'product', 'product_info', 'product_card', 'source_content', 'message', 'items', 'item_list', 'image', 'images']) {
        if (value[key] != null) visit(value[key], depth + 1);
      }
    }
  }
  visit(content);
  let orderSn = '', orderId = '', itemId = '', shopId = '', itemName = '', imageUrl = '', url = '', orderUrl = '', text = '';
  const types = new Set([String(messageType).toLowerCase()]);
  for (const node of nodes) {
    if (typeof node === 'string') { if (!text) text = scalar(node); continue; }
    for (const hint of [node.message_type, node.type]) if (scalar(hint)) types.add(scalar(hint).toLowerCase());
    if (node.item_name || node.itemName || node.product_name || node.item_info || node.product_info || node.item_card || node.product_card) types.add('product');
    if (node.order_info || node.order_card) types.add('order');
    if (node.sticker || node.sticker_id || node.sticker_package_id) types.add('sticker');
    orderSn ||= scalar(node.order_sn) || scalar(node.ordersn) || scalar(node.orderSn);
    orderId ||= scalar(node.order_id) || scalar(node.orderId);
    itemId ||= scalar(node.item_id) || scalar(node.itemId) || scalar(node.product_id);
    shopId ||= scalar(node.shop_id) || scalar(node.shopid) || scalar(node.shopId);
    itemName ||= scalar(node.item_name) || scalar(node.itemName) || scalar(node.product_name) || scalar(node.name) || scalar(node.title);
    imageUrl ||= safeChatUrl(node.image_url) || safeChatUrl(node.imageUrl) || safeChatUrl(node.thumb_url) || safeChatUrl(node.thumbnail_url) || safeChatUrl(node.image) || safeChatUrl(node.thumb);
    url ||= safeChatUrl(node.item_url) || safeChatUrl(node.product_url) || safeChatUrl(node.order_url) || safeChatUrl(node.link) || safeChatUrl(node.url);
    orderUrl ||= safeChatUrl(node.order_url);
    if (node.order_sn || node.order_id || ['order', 'order_card'].includes(scalar(node.message_type || node.type).toLowerCase())) {
      orderUrl ||= safeChatUrl(node.url) || safeChatUrl(node.link);
    }
    text ||= scalar(node.text) || scalar(node.caption) || scalar(node.description);
  }
  const hasType = (...names) => names.some(name => types.has(name));
  let kind = 'empty';
  if (orderSn || orderId || hasType('order', 'order_card')) kind = 'order';
  else if (itemId || hasType('item', 'product', 'item_card', 'product_card')) kind = 'product';
  else if (hasType('image') || imageUrl) kind = 'image';
  else if (text || url) kind = 'text';
  else if (hasType('sticker')) kind = 'sticker';
  if (kind === 'image' && !imageUrl) imageUrl = url;
  if (kind === 'order') url = orderUrl;
  if (kind === 'product' && !url && /^\d+$/.test(itemId) && /^\d+$/.test(shopId)) url = `https://shopee.vn/product/${shopId}/${itemId}`;
  const label = kind === 'order' ? `[Đơn hàng] ${orderSn || orderId}`.trim()
    : kind === 'product' ? `[Sản phẩm] ${itemName || itemId}`.trim()
    : kind === 'image' ? '[Hình ảnh]' : kind === 'sticker' ? '[Sticker]' : text || url;
  return { kind, text: label, orderSn, orderId, itemId, itemName, imageUrl, url };
}
