import { buildCpanelTarget } from '../cpanelProxy.js';
import { resolveCpanelBackend } from '../cpanelBackend.js';
import { fetchWithDiagnostics } from '../fetchDiagnostics.js';

function normalizeSkuKey(sku) {
  return String(sku ?? '').trim().toLowerCase();
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

/** Exact match only — trim + toLowerCase. */
function skusExactMatch(listingSku, masterSku) {
  const a = normalizeSkuKey(listingSku);
  const b = normalizeSkuKey(masterSku);
  return a !== '' && b !== '' && a === b;
}

function buildMasterSkuIndex(products) {
  const index = new Map();
  for (const product of Array.isArray(products) ? products : []) {
    const addOne = (row) => {
      const key = normalizeSkuKey(row?.sku);
      if (key && !index.has(key)) index.set(key, row);
    };
    addOne(product);
    for (const child of getChildren(product)) addOne(child);
  }
  return index;
}

function findMasterProductBySku(masterSkuIndex, listingSku) {
  const key = normalizeSkuKey(listingSku);
  if (!key) return null;
  return masterSkuIndex.get(key) || null;
}

function resolveListingIndex(listings, body) {
  const listingId = String(body?.id || body?.listingId || '').trim();
  const channelId = String(body?.channelId || '').trim();
  const platform = String(body?.platform || '').trim().toLowerCase();

  if (listingId) {
    const byId = listings.findIndex((row) => String(row?.id || '').trim() === listingId);
    if (byId !== -1) return byId;
  }

  if (channelId) {
    return listings.findIndex((row) => {
      if (String(row?.channelId || '').trim() !== channelId) return false;
      if (!platform) return true;
      return String(row?.platform || '').trim().toLowerCase() === platform;
    });
  }

  return -1;
}

async function fetchJson(backendUrl, req, pathPart, init = {}, timeoutMs = 60000) {
  const target = buildCpanelTarget(backendUrl, pathPart, {});
  const headers = {
    Authorization: req.headers?.authorization || req.headers?.Authorization || '',
    'Content-Type': 'application/json',
    ...(init.headers || {}),
  };

  const result = await fetchWithDiagnostics('[Mapping Auto-link Single]', target, {
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
    throw new Error(data?.message || data?.error || `HTTP ${result.upstream.status}`);
  }

  return data;
}

export async function handleMappingAutoLinkSingle(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, message: 'Method Not Allowed' });
  }

  try {
    const backend = resolveCpanelBackend();
    if (!backend.ok) {
      return res.status(503).json({ success: false, message: backend.error });
    }

    try {
      const direct = await fetchJson(backend.url, req, 'mapping-products/auto-link-single', {
        method: 'POST',
        body: JSON.stringify({ id: req.body?.id }),
      });
      return res.status(200).json(direct);
    } catch (directErr) {
      const msg = String(directErr?.message || directErr || '');
      if (!msg.includes('API không tồn tại')) {
        throw directErr;
      }
    }

    const inventory = await fetchJson(backend.url, req, 'local-inventory');
    const listings = Array.isArray(inventory?.listings) ? inventory.listings : [];
    const products = Array.isArray(inventory?.products) ? inventory.products : [];

    if (listings.length === 0) {
      return res.status(200).json({ success: false, message: 'Không có dữ liệu mapping để liên kết.' });
    }

    const rowIndex = resolveListingIndex(listings, req.body || {});
    if (rowIndex === -1) {
      return res.status(404).json({ success: false, message: 'Không tìm thấy sản phẩm sàn cần liên kết.' });
    }

    const current = listings[rowIndex];
    const linkedId = String(current?.linkedProductId || current?.linkedProduct?.id || '').trim();
    if (linkedId) {
      return res.status(200).json({
        success: true,
        listing: current,
        matchedProductId: linkedId,
        message: 'Sản phẩm này đã được liên kết trước đó.',
      });
    }

    const normalizedSku = normalizeSkuKey(current?.sku);
    if (!normalizedSku) {
      return res.status(200).json({ success: false, listing: current, message: 'SKU sản phẩm sàn đang trống hoặc không hợp lệ.' });
    }

    const masterItem = findMasterProductBySku(buildMasterSkuIndex(products), current?.sku, products);
    if (!masterItem) {
      return res.status(200).json({
        success: false,
        listing: current,
        message: `Không tìm thấy SKU khớp trong Kho gốc cho "${normalizedSku}" (gốc: "${String(current?.sku || '').trim()}").`,
      });
    }

    // Micro payload tối đa: chỉ gửi đúng các field cần thiết cho sanitizeChannelListingRow.
    const nextListing = {
      id: current?.id,
      channelId: current?.channelId,
      platform: current?.platform,
      sku: current?.sku,
      title: current?.title,
      shopName: current?.shopName,
      status: 'success',
      linkedProductId: String(masterItem?.id || '').trim() || undefined,
      linkedProductTitle: String(masterItem?.title || '').trim() || undefined,
      linkedProductSku: String(masterItem?.sku || '').trim() || undefined,
      syncError: undefined,
      linkBroken: false,
    };

    const saved = await fetchJson(backend.url, req, 'mapping-products', {
      method: 'PUT',
      body: JSON.stringify({ listings: [nextListing] }),
    });

    const savedListing =
      (Array.isArray(saved?.listings) &&
        saved.listings.find((row) => String(row?.id || '').trim() === String(nextListing.id).trim())) ||
      nextListing;

    return res.status(200).json({
      success: true,
      listing: savedListing,
      matchedProductId: nextListing.linkedProductId,
      message: 'Liên kết tự động thành công.',
    });
  } catch (err) {
    console.error('[Mapping Auto-link Single]', err);
    return res.status(500).json({
      success: false,
      message: err?.message || 'Liên kết tự động thất bại',
    });
  }
}
