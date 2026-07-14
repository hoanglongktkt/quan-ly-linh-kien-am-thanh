/**
 * Liên kết tự động theo SKU — chạy trên Vercel (không phụ thuộc route mới trên cPanel).
 * Dùng API cPanel đã có: GET mapping-products, GET products (phân trang), PUT mapping-products, POST products/bulk-save.
 */
import { resolveCpanelBackend } from '../cpanelBackend.js';
import { fetchWithDiagnostics } from '../fetchDiagnostics.js';

const HOP_HEADERS = new Set([
  'host',
  'connection',
  'content-length',
  'transfer-encoding',
  'keep-alive',
  'upgrade',
]);

const PAGE_SIZE = 50;
const BULK_SAVE_CHUNK = 80;

function buildForwardHeaders(req) {
  const headers = {
    'User-Agent': 'OmniSales-Vercel-AutoLink/1.0',
    'Content-Type': 'application/json',
  };
  for (const [key, value] of Object.entries(req.headers || {})) {
    if (HOP_HEADERS.has(key.toLowerCase())) continue;
    if (value != null) headers[key] = value;
  }
  return headers;
}

async function cpanelJson(backendUrl, path, req, method = 'GET', body, timeoutMs = 90_000) {
  const url = `${backendUrl}/api/${path.replace(/^\/+/, '')}`;
  const init = {
    method,
    headers: buildForwardHeaders(req),
  };
  if (body != null && method !== 'GET' && method !== 'HEAD') {
    init.body = typeof body === 'string' ? body : JSON.stringify(body);
  }
  const result = await fetchWithDiagnostics(`[AutoLink] ${method} ${path}`, url, init, timeoutMs);
  if (!result.ok) {
    const e = result.error || {};
    throw new Error(e.message || e.hint || 'Không kết nối được backend cPanel');
  }
  const text = await result.upstream.text();
  const trimmed = String(text || '').trimStart();
  if (trimmed.startsWith('<') || trimmed.startsWith('<!DOCTYPE')) {
    throw new Error(
      `Backend trả về HTTP ${result.upstream.status} (HTML) cho /api/${path} — endpoint có thể chưa deploy hoặc proxy lỗi.`
    );
  }
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`Backend trả về HTTP ${result.upstream.status} (không phải JSON): ${text.slice(0, 120)}`);
  }
  if (!result.upstream.ok) {
    throw new Error(data.message || data.error || `HTTP ${result.upstream.status}`);
  }
  return data;
}

function sanitizeListing(row) {
  return {
    id: String(row.id || `cl-${row.platform}-${row.channelId}`),
    title: String(row.title || ''),
    sku: String(row.sku || ''),
    imageUrl: row.imageUrl || undefined,
    channelId: String(row.channelId || ''),
    platform: row.platform || 'shopee',
    shopName: String(row.shopName || ''),
    shopId: row.shopId ? String(row.shopId) : undefined,
    modelId: row.modelId != null ? String(row.modelId) : undefined,
    itemId: row.itemId != null ? String(row.itemId) : undefined,
    status: row.status === 'success' || row.status === 'failed' ? row.status : 'unlinked',
    linkedProductId: row.linkedProductId ? String(row.linkedProductId) : undefined,
    updatedAt: row.updatedAt || new Date().toISOString(),
  };
}

function flattenProducts(products) {
  const out = [];
  for (const p of products || []) {
    const children = Array.isArray(p.children)
      ? p.children
      : Array.isArray(p.children_models)
        ? p.children_models
        : [];
    if (children.length > 0) {
      for (const c of children) out.push(c);
    } else {
      out.push(p);
    }
  }
  return out;
}

function parseShopeeIds(channelId, modelHint, itemHint) {
  const cid = String(channelId || '').trim();
  if (cid.includes(':')) {
    const [left, right] = cid.split(':');
    const itemId = (String(left).match(/(\d{6,})/) || [])[1] || left;
    const modelId = (String(right).match(/(\d+)/) || [])[1] || right;
    return { itemId, modelId };
  }
  const itemId =
    (String(itemHint || '').match(/(\d{6,})/) || [])[1] ||
    (cid.match(/(\d{6,})/) || [])[1] ||
    cid ||
    undefined;
  const modelId = modelHint != null ? String(modelHint) : undefined;
  return { itemId, modelId };
}

/** Tải TOÀN BỘ kho gốc qua phân trang — tránh chỉ lấy trang 1. */
async function fetchAllMasterProducts(backendUrl, req) {
  const all = [];
  let page = 1;
  let totalPages = 1;

  while (page <= totalPages && page <= 400) {
    const data = await cpanelJson(
      backendUrl,
      `products?page=${page}&pageSize=${PAGE_SIZE}`,
      req,
      'GET',
      undefined,
      60_000
    );
    const batch = Array.isArray(data.products) ? data.products : [];
    all.push(...batch);
    totalPages = Math.max(1, Number(data.totalPages) || 1);
    if (!data.hasMore && batch.length < PAGE_SIZE) break;
    if (batch.length === 0) break;
    page += 1;
  }

  return all;
}

export async function handleChannelAutoLink(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, message: 'Method Not Allowed' });
  }

  try {
    const backend = resolveCpanelBackend();
    if (!backend.ok) {
      return res.status(503).json({ success: false, message: backend.error });
    }

    const [mappingData, products] = await Promise.all([
      cpanelJson(backend.url, 'mapping-products', req, 'GET'),
      fetchAllMasterProducts(backend.url, req),
    ]);

    const listings = Array.isArray(mappingData)
      ? mappingData
      : Array.isArray(mappingData?.listings)
        ? mappingData.listings
        : Array.isArray(mappingData?.products)
          ? mappingData.products
          : [];

    const flat = flattenProducts(products);
    const skuIndex = new Map();
    for (const p of flat) {
      const sku = String(p.sku || '').trim().toLowerCase();
      if (sku && !skuIndex.has(sku)) skuIndex.set(sku, p);
    }

    let linkedCount = 0;
    let alreadyLinked = 0;
    const productPatches = [];
    const patchedIds = new Set();

    const updated = listings.map((listing) => {
      if (listing.status === 'success' && listing.linkedProductId) {
        alreadyLinked += 1;
        return sanitizeListing(listing);
      }
      const sku = String(listing.sku || '').trim().toLowerCase();
      if (!sku) return sanitizeListing(listing);
      const match = skuIndex.get(sku);
      if (!match) return sanitizeListing(listing);

      linkedCount += 1;
      const next = sanitizeListing({
        ...listing,
        status: 'success',
        linkedProductId: String(match.id),
      });

      if ((listing.platform || 'shopee') === 'shopee' && !patchedIds.has(String(match.id))) {
        const { itemId, modelId } = parseShopeeIds(listing.channelId, listing.modelId, listing.itemId);
        const channels = Array.isArray(match.channels) ? [...match.channels] : [];
        if (!channels.includes('shopee')) channels.push('shopee');
        productPatches.push({
          id: String(match.id),
          channels,
          shopeeId: modelId ? `${itemId}:${modelId}` : String(itemId || listing.channelId),
          shopeeItemId: itemId ? String(itemId) : String(listing.channelId),
          ...(modelId ? { shopeeModelId: String(modelId) } : {}),
        });
        patchedIds.add(String(match.id));
      }

      return next;
    });

    if (linkedCount > 0) {
      await cpanelJson(backend.url, 'mapping-products', req, 'PUT', { listings: updated }, 180_000);

      for (let i = 0; i < productPatches.length; i += BULK_SAVE_CHUNK) {
        const chunk = productPatches.slice(i, i + BULK_SAVE_CHUNK);
        await cpanelJson(backend.url, 'products/bulk-save', req, 'POST', { updates: chunk }, 120_000);
      }
    }

    const unlinkedRemaining = updated.filter((l) => l.status !== 'success' || !l.linkedProductId).length;
    const data = {
      linkedCount,
      alreadyLinked,
      unlinkedRemaining,
      listings: updated,
      masterProductCount: products.length,
      flatSkuCount: skuIndex.size,
    };

    return res.status(200).json({
      success: true,
      data,
      message:
        linkedCount > 0
          ? `Đã liên kết thành công ${linkedCount} sản phẩm`
          : 'Không tìm thấy SKU trùng khớp để liên kết tự động',
      ...data,
    });
  } catch (err) {
    console.error('[AutoLink]', err);
    return res.status(500).json({
      success: false,
      message: err?.message || 'Liên kết tự động thất bại',
      details: String(err),
    });
  }
}
