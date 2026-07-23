/**
 * POST /api/mapping-products/bulk-auto-link
 * Gọi cPanel bulk-auto-link (Hash Map + bulkWrite). Fallback map + PUT 1 lô nếu route chưa có.
 * Chống spam 1-1 từ Frontend (NPROC AZDIGI).
 */
import { buildCpanelTarget } from '../cpanelProxy.js';
import { resolveCpanelBackend } from '../cpanelBackend.js';
import { fetchWithDiagnostics } from '../fetchDiagnostics.js';

const CHUNK_MAX = 50;

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

function buildMasterSkuIndex(products) {
  const index = new Map();
  const addOne = (row) => {
    const key = normalizeSkuKey(row?.sku);
    if (key && !index.has(key)) index.set(key, row);
  };
  for (const product of Array.isArray(products) ? products : []) {
    addOne(product);
    for (const child of getChildren(product)) addOne(child);
  }
  return index;
}

async function fetchJson(backendUrl, req, pathPart, init = {}, timeoutMs = 120000) {
  const target = buildCpanelTarget(backendUrl, pathPart, {});
  const headers = {
    Authorization: req.headers?.authorization || req.headers?.Authorization || '',
    'Content-Type': 'application/json',
    ...(init.headers || {}),
  };

  const result = await fetchWithDiagnostics('[Bulk Auto-link]', target, {
    method: init.method || 'GET',
    headers,
    body: init.body,
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
    const err = new Error(data?.message || data?.error || `HTTP ${result.upstream.status}`);
    err.status = result.upstream.status;
    throw err;
  }

  return data;
}

function resolveIds(body) {
  if (Array.isArray(body?.ids)) return body.ids;
  if (Array.isArray(body?.listingIds)) return body.listingIds;
  if (Array.isArray(body?.listings)) return body.listings.map((row) => row?.id);
  return [];
}

function isMissingRouteError(err) {
  const msg = String(err?.message || err || '');
  const status = Number(err?.status || 0);
  return (
    status === 404 ||
    msg.includes('API không tồn tại') ||
    msg.includes('HTTP 404') ||
    msg.includes('Not Found') ||
    msg.includes('Cannot POST')
  );
}

async function fallbackBulkAutoLink(backendUrl, req, ids) {
  const inventory = await fetchJson(backendUrl, req, 'local-inventory');
  const listings = Array.isArray(inventory?.listings) ? inventory.listings : [];
  const products = Array.isArray(inventory?.products) ? inventory.products : [];
  const skuIndex = buildMasterSkuIndex(products);
  const byId = new Map(
    listings
      .filter((row) => row && String(row.id || '').trim())
      .map((row) => [String(row.id).trim(), row])
  );

  const results = [];
  const toWrite = [];
  let linkedCount = 0;
  let failedCount = 0;
  let skippedCount = 0;

  for (const rawId of ids) {
    const id = String(rawId || '').trim();
    const current = byId.get(id);
    if (!current) {
      failedCount += 1;
      results.push({
        id,
        success: false,
        listing: { id, status: 'failed', syncError: 'Không tìm thấy listing trên Database.' },
        message: 'Không tìm thấy sản phẩm sàn cần liên kết.',
      });
      continue;
    }

    const linkedId = String(current?.linkedProductId || current?.linkedProduct?.id || '').trim();
    if (linkedId) {
      skippedCount += 1;
      results.push({
        id,
        success: true,
        listing: current,
        message: 'Sản phẩm này đã được liên kết trước đó.',
      });
      continue;
    }

    const key = normalizeSkuKey(current?.sku);
    const master = key ? skuIndex.get(key) : null;
    if (!master?.id) {
      failedCount += 1;
      const failed = {
        ...current,
        status: 'failed',
        syncError: key
          ? `Không tìm thấy SKU khớp trong Kho gốc: ${key}`
          : 'SKU sản phẩm sàn đang trống hoặc không hợp lệ.',
      };
      toWrite.push(failed);
      results.push({
        id,
        success: false,
        listing: failed,
        message: failed.syncError,
      });
      continue;
    }

    const linkedProductId = String(master.id).trim();
    const patched = {
      ...current,
      status: 'success',
      linkedProductId,
      linkedProductTitle: String(master.title || '').trim(),
      linkedProductSku: String(master.sku || '').trim(),
      linkedProduct: {
        id: linkedProductId,
        title: String(master.title || '').trim(),
        sku: String(master.sku || '').trim(),
      },
      syncError: undefined,
      linkBroken: false,
    };
    toWrite.push(patched);
    linkedCount += 1;
    results.push({
      id,
      success: true,
      listing: patched,
      message: 'Liên kết tự động thành công.',
    });
  }

  if (toWrite.length > 0) {
    // 1 request ghi cả lô — không gọi upsert từng dòng.
    await fetchJson(backendUrl, req, 'mapping-products', {
      method: 'PUT',
      body: JSON.stringify({ listings: toWrite }),
    });
  }

  await new Promise((resolve) => setTimeout(resolve, 200));

  return {
    success: true,
    linkedCount,
    failedCount,
    skippedCount,
    listings: results.map((r) => r.listing).filter(Boolean),
    results,
    skuIndexSize: skuIndex.size,
    masterProductCount: products.length,
    source: 'vercel-fallback',
    message:
      linkedCount > 0
        ? `Đã liên kết thành công ${linkedCount}/${ids.length} sản phẩm trong lô`
        : 'Không có sản phẩm nào liên kết thành công trong lô này',
  };
}

export async function handleMappingBulkAutoLink(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, message: 'Method Not Allowed' });
  }

  try {
    const backend = resolveCpanelBackend();
    if (!backend.ok) {
      return res.status(503).json({ success: false, message: backend.error });
    }

    const ids = resolveIds(req.body || {})
      .map((id) => String(id ?? '').trim())
      .filter(Boolean)
      .slice(0, CHUNK_MAX);

    if (ids.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Thiếu danh sách id sản phẩm sàn cần liên kết (tối đa 50/lô).',
      });
    }

    try {
      const direct = await fetchJson(backend.url, req, 'mapping-products/bulk-auto-link', {
        method: 'POST',
        body: JSON.stringify({ ids }),
      }, 120000);
      return res.status(200).json(direct);
    } catch (directErr) {
      if (!isMissingRouteError(directErr)) {
        throw directErr;
      }
      console.warn('[Bulk Auto-link] Route cPanel chưa có — dùng fallback lô an toàn.');
    }

    const fallback = await fallbackBulkAutoLink(backend.url, req, ids);
    return res.status(200).json(fallback);
  } catch (err) {
    console.error('[Bulk Auto-link]', err);
    return res.status(500).json({
      success: false,
      message: err?.message || 'Liên kết theo lô thất bại',
    });
  }
}
