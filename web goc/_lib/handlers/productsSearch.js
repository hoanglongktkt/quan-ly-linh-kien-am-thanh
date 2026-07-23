/**
 * GET /api/products/search?q=&limit=
 * Chạy local trên Vercel — proxy cPanel trước, fallback lọc từ local-inventory (Kho gốc).
 */
import { buildCpanelTarget } from '../cpanelProxy.js';
import { resolveCpanelBackend } from '../cpanelBackend.js';
import { fetchWithDiagnostics } from '../fetchDiagnostics.js';

function getChildren(row) {
  if (!row || typeof row !== 'object') return [];
  const buckets = [];
  if (Array.isArray(row.children)) buckets.push(...row.children);
  if (Array.isArray(row.children_models)) buckets.push(...row.children_models);
  if (Array.isArray(row.variants)) buckets.push(...row.variants);
  if (Array.isArray(row.models)) buckets.push(...row.models);
  return buckets.filter((item) => item && typeof item === 'object');
}

function normalizeProduct(row, parent) {
  const id = String(row?.id || row?._id || row?.shopeeModelId || '').trim();
  if (!id) return null;
  const title = String(row?.title || row?.name || parent?.title || '').trim();
  const sku = String(row?.sku || '').trim();
  const image = row?.avatarUrl || row?.imageUrl || row?.image || parent?.avatarUrl || parent?.imageUrl || '';
  const stock = Math.max(0, Math.round(Number(row?.stock ?? row?.current_stock) || 0));
  const importPrice = Math.max(0, Math.round(Number(row?.importPrice ?? row?.last_import_price) || 0));
  // Lean fields only — không trả description HTML
  return {
    id,
    sku,
    title,
    name: title,
    image,
    imageUrl: image,
    avatarUrl: image,
    stock,
    current_stock: stock,
    importPrice,
    last_import_price: importPrice,
    modelName: row?.modelName || undefined,
    status: row?.status || 'active',
  };
}

function matchesQuery(row, qLower, extra = '') {
  if (!qLower) return true;
  const hay = [
    row?.sku,
    row?.barcode,
    row?.title,
    row?.name,
    row?.modelName,
    ...(Array.isArray(row?.tierLabels) ? row.tierLabels : []),
    extra,
  ]
    .map((v) => String(v ?? '').toLowerCase())
    .join(' ');
  return hay.includes(qLower);
}

function searchInProducts(products, query, limit = 40) {
  const q = String(query || '').trim();
  const qLower = q.toLowerCase();
  const safeLimit = Math.min(100, Math.max(1, Math.floor(Number(limit) || 40)));
  const flat = [];
  const seen = new Set();

  const push = (row) => {
    const normalized = normalizeProduct(row);
    if (!normalized || seen.has(normalized.id)) return;
    seen.add(normalized.id);
    flat.push(normalized);
  };

  for (const p of Array.isArray(products) ? products : []) {
    if (!p || typeof p !== 'object') continue;
    const children = getChildren(p);
    if (children.length > 0) {
      let childMatched = 0;
      for (const c of children) {
        if (!matchesQuery(c, qLower, `${p.title || ''} ${p.sku || ''}`)) continue;
        const merged = normalizeProduct(
          {
            ...c,
            title: c.title || c.name || p.title,
            imageUrl: c.imageUrl || c.image || p.imageUrl,
            avatarUrl: c.avatarUrl || p.avatarUrl,
            importPrice: c.importPrice ?? p.importPrice ?? 0,
          },
          p,
        );
        if (!merged) continue;
        if (seen.has(merged.id)) continue;
        seen.add(merged.id);
        flat.push(merged);
        childMatched += 1;
      }
      if (childMatched === 0 && matchesQuery(p, qLower)) push(p);
    } else if (matchesQuery(p, qLower)) {
      push(p);
    }
  }

  if (q) {
    flat.sort((a, b) => {
      const aSku = String(a.sku || '').toLowerCase();
      const bSku = String(b.sku || '').toLowerCase();
      const aExact = aSku === qLower ? 0 : aSku.includes(qLower) ? 1 : 2;
      const bExact = bSku === qLower ? 0 : bSku.includes(qLower) ? 1 : 2;
      return aExact - bExact;
    });
  }

  return flat.slice(0, safeLimit);
}

async function fetchJson(backendUrl, req, pathPart, query = {}, timeoutMs = 90000) {
  const target = buildCpanelTarget(backendUrl, pathPart, query);
  const headers = {
    Authorization: req.headers?.authorization || req.headers?.Authorization || '',
    'Content-Type': 'application/json',
  };

  const result = await fetchWithDiagnostics('[Products Search]', target, {
    method: 'GET',
    headers,
  }, timeoutMs);

  if (!result.ok) {
    throw new Error(result.error?.message || 'Không kết nối được backend cPanel.');
  }

  const text = await result.upstream.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`Backend trả phản hồi không hợp lệ cho ${pathPart}.`);
  }

  if (!result.upstream.ok) {
    throw new Error(data?.message || data?.error || `HTTP ${result.upstream.status}`);
  }

  return data;
}

export async function handleProductsSearch(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ success: false, error: 'Method Not Allowed', products: [] });
  }

  const q = String(req.query?.q ?? req.query?.query ?? '').trim();
  const limit = Number(req.query?.limit ?? 40);

  try {
    const backend = resolveCpanelBackend();
    if (!backend.ok) {
      return res.status(503).json({ success: false, error: backend.error, products: [] });
    }

    // 1) Ưu tiên endpoint search Mongo trên cPanel
    try {
      const direct = await fetchJson(backend.url, req, 'products/search', { q, limit: String(limit || 40) });
      if (direct?.success !== false && Array.isArray(direct?.products)) {
        console.log('[Products Search] cPanel OK', { q, total: direct.products.length, source: direct.source });
        return res.status(200).json({
          success: true,
          products: direct.products,
          total: direct.products.length,
          source: direct.source || 'cpanel-mongodb',
        });
      }
    } catch (directErr) {
      console.warn('[Products Search] cPanel /products/search lỗi, fallback local-inventory:', directErr?.message || directErr);
    }

    // 2) Fallback: lấy toàn bộ kho gốc từ local-inventory rồi lọc SKU/tên
    const inventory = await fetchJson(backend.url, req, 'local-inventory');
    const products = Array.isArray(inventory?.products) ? inventory.products : [];
    const filtered = searchInProducts(products, q, limit);
    console.log('[Products Search] local-inventory fallback', {
      q,
      catalogSize: products.length,
      total: filtered.length,
      sample: filtered.slice(0, 5).map((p) => ({ id: p.id, sku: p.sku, title: p.title })),
    });

    return res.status(200).json({
      success: true,
      products: filtered,
      total: filtered.length,
      source: 'local-inventory-fallback',
    });
  } catch (err) {
    console.error('[Products Search]', err);
    return res.status(500).json({
      success: false,
      error: err?.message || 'search_failed',
      products: [],
    });
  }
}
