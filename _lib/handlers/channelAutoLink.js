/**
 * Liên kết tự động theo SKU — chạy trên Vercel, dùng API cPanel đã có sẵn
 * (GET/PUT mapping-products + GET products) khi backend chưa deploy route mới.
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

async function cpanelJson(backendUrl, path, req, method = 'GET', body) {
  const url = `${backendUrl}/api/${path.replace(/^\/+/, '')}`;
  const init = {
    method,
    headers: buildForwardHeaders(req),
  };
  if (body != null && method !== 'GET' && method !== 'HEAD') {
    init.body = typeof body === 'string' ? body : JSON.stringify(body);
  }
  const result = await fetchWithDiagnostics(`[AutoLink] ${method} ${path}`, url, init, 60_000);
  if (!result.ok) {
    const e = result.error || {};
    throw new Error(e.message || e.hint || 'Không kết nối được backend cPanel');
  }
  const text = await result.upstream.text();
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
    status: row.status === 'success' || row.status === 'failed' ? row.status : 'unlinked',
    linkedProductId: row.linkedProductId ? String(row.linkedProductId) : undefined,
    updatedAt: row.updatedAt || new Date().toISOString(),
  };
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

    const mappingData = await cpanelJson(backend.url, 'mapping-products', req, 'GET');
    const productsData = await cpanelJson(backend.url, 'products', req, 'GET');

    const listings = Array.isArray(mappingData)
      ? mappingData
      : Array.isArray(mappingData?.listings)
        ? mappingData.listings
        : Array.isArray(mappingData?.products)
          ? mappingData.products
          : [];

    const products = Array.isArray(productsData)
      ? productsData
      : Array.isArray(productsData?.products)
        ? productsData.products
        : [];

    const skuIndex = new Map();
    for (const p of products) {
      const sku = String(p.sku || '').trim().toLowerCase();
      if (sku && !skuIndex.has(sku)) skuIndex.set(sku, p);
    }

    let linkedCount = 0;
    let alreadyLinked = 0;
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
      return sanitizeListing({
        ...listing,
        status: 'success',
        linkedProductId: String(match.id),
      });
    });

    if (linkedCount > 0) {
      await cpanelJson(backend.url, 'mapping-products', req, 'PUT', { listings: updated });
    }

    const unlinkedRemaining = updated.filter((l) => l.status !== 'success' || !l.linkedProductId).length;

    return res.json({
      success: true,
      message:
        linkedCount > 0
          ? `Đã liên kết thành công ${linkedCount} sản phẩm`
          : 'Không tìm thấy SKU trùng khớp để liên kết tự động',
      linkedCount,
      alreadyLinked,
      unlinkedRemaining,
      listings: updated,
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
