import { buildCpanelTarget } from '../cpanelProxy.js';
import { resolveCpanelBackend } from '../cpanelBackend.js';
import { fetchWithDiagnostics } from '../fetchDiagnostics.js';

async function fetchJson(backendUrl, req, pathPart, body) {
  const target = buildCpanelTarget(backendUrl, pathPart, {});
  const result = await fetchWithDiagnostics(
    '[Product Sync Shopee]',
    target,
    {
      method: 'POST',
      headers: {
        Authorization: req.headers?.authorization || req.headers?.Authorization || '',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    },
    120000,
  );

  if (!result.ok) {
    throw new Error(result.error?.message || 'Không kết nối được backend cPanel.');
  }

  const text = await result.upstream.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`Backend trả phản hồi không hợp lệ cho ${pathPart}.`);
  }

  if (!result.upstream.ok || data?.success === false) {
    const error = new Error(
      data?.error || data?.message || `HTTP ${result.upstream.status}`,
    );
    error.httpStatus = result.upstream.status;
    throw error;
  }
  return data;
}

export async function handleProductSyncShopee(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Method Not Allowed' });
  }

  try {
    const requestedIds = Array.isArray(req.body?.productIds)
      ? req.body.productIds
      : [req.body?.id || req.body?.productId];
    const productIds = [
      ...new Set(requestedIds.map((id) => String(id || '').trim()).filter(Boolean)),
    ];
    if (productIds.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Thiếu id hoặc productIds.',
      });
    }

    const backend = resolveCpanelBackend();
    if (!backend.ok) {
      return res.status(503).json({ success: false, error: backend.error });
    }

    try {
      const direct = await fetchJson(
        backend.url,
        req,
        'products/sync-shopee',
        { productIds },
      );
      return res.status(200).json({
        ...direct,
        success: true,
        message: direct?.message || 'Đồng bộ Shopee thành công!',
      });
    } catch (directError) {
      const message = String(directError?.message || '');
      const isMissingRoute =
        directError?.httpStatus === 404 ||
        message.includes('API không tồn tại') ||
        message.includes('HTTP 404');
      if (!isMissingRoute) throw directError;
    }

    // Tương thích tiến trình cPanel cũ chưa có products/sync-shopee.
    const fallback = await fetchJson(
      backend.url,
      req,
      'products/bulk-channel-sync',
      { productIds, channels: ['shopee'] },
    );
    const failedLogs = Array.isArray(fallback?.logs)
      ? fallback.logs.filter((log) => log?.success === false)
      : [];
    if (failedLogs.length > 0 || fallback?.failCount > 0) {
      throw new Error(
        failedLogs.map((log) => log?.message).filter(Boolean).join(' | ') ||
          'Shopee từ chối đồng bộ giá/tồn kho.',
      );
    }

    return res.status(200).json({
      success: true,
      message: 'Đồng bộ Shopee thành công!',
      results: fallback?.logs || [],
      fallback: true,
    });
  } catch (err) {
    console.error('[Product Sync Shopee]', err);
    return res.status(err?.httpStatus >= 400 ? err.httpStatus : 500).json({
      success: false,
      error: err?.message || 'Đồng bộ Shopee thất bại.',
    });
  }
}
