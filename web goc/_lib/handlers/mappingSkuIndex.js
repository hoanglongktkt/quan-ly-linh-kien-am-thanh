/**
 * GET /api/mapping-products/sku-index
 * Trả về danh sách { sku, id, title } từ Kho gốc để frontend dựng Hash Map.
 */
import { buildCpanelTarget } from '../cpanelProxy.js';
import { resolveCpanelBackend } from '../cpanelBackend.js';
import { fetchWithDiagnostics } from '../fetchDiagnostics.js';

function normalizeSkuKey(sku) {
  return String(sku ?? '').trim().toUpperCase();
}

function getChildren(row) {
  if (!row || typeof row !== 'object') return [];
  const buckets = [];
  if (Array.isArray(row.children)) buckets.push(...row.children);
  if (Array.isArray(row.children_models)) buckets.push(...row.children_models);
  if (Array.isArray(row.variants)) buckets.push(...row.variants);
  if (Array.isArray(row.models)) buckets.push(...row.models);
  return buckets.filter((item) => item && typeof item === 'object');
}

function buildSkuItems(products) {
  const items = [];
  const seen = new Set();

  const addOne = (row) => {
    if (!row || typeof row !== 'object') return;
    const key = normalizeSkuKey(row.sku);
    const id = row.id != null ? String(row.id).trim() : '';
    if (!key || !id || seen.has(key)) return;
    seen.add(key);
    items.push({
      sku: key,
      id,
      title: String(row.title || '').trim(),
    });
  };

  for (const product of Array.isArray(products) ? products : []) {
    addOne(product);
    for (const child of getChildren(product)) addOne(child);
  }
  return items;
}

async function fetchJson(backendUrl, req, pathPart, timeoutMs = 90000) {
  const target = buildCpanelTarget(backendUrl, pathPart, {});
  const headers = {
    Authorization: req.headers?.authorization || req.headers?.Authorization || '',
    'Content-Type': 'application/json',
  };

  const result = await fetchWithDiagnostics('[Mapping SKU Index]', target, {
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

export async function handleMappingSkuIndex(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ success: false, message: 'Method Not Allowed' });
  }

  try {
    const backend = resolveCpanelBackend();
    if (!backend.ok) {
      return res.status(503).json({ success: false, message: backend.error });
    }

    try {
      const direct = await fetchJson(backend.url, req, 'mapping-products/sku-index');
      if (direct?.success !== false && Array.isArray(direct?.items)) {
        return res.status(200).json(direct);
      }
    } catch (directErr) {
      const msg = String(directErr?.message || directErr || '');
      if (!msg.includes('API không tồn tại') && !msg.includes('404')) {
        console.warn('[Mapping SKU Index] Direct endpoint lỗi, fallback local-inventory:', msg);
      }
    }

    const inventory = await fetchJson(backend.url, req, 'local-inventory');
    const products = Array.isArray(inventory?.products) ? inventory.products : [];
    const items = buildSkuItems(products);

    return res.status(200).json({
      success: true,
      count: items.length,
      items,
      source: 'local-inventory-fallback',
    });
  } catch (err) {
    console.error('[Mapping SKU Index]', err);
    return res.status(500).json({
      success: false,
      message: err?.message || 'Không lấy được SKU index Kho gốc',
    });
  }
}
