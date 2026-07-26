/**
 * POST /api/shopee/products/sync — proxy sang cPanel, luôn trả JSON
 * (tránh HTML 500 từ Passenger bị FE hiểu thành invalid_cpanel_response).
 */
import { buildCpanelTarget } from '../cpanelProxy.js';
import { resolveCpanelBackend } from '../cpanelBackend.js';
import { fetchWithDiagnostics } from '../fetchDiagnostics.js';

export async function handleShopeeProductsSync(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Method Not Allowed' });
  }

  const backend = resolveCpanelBackend();
  if (!backend.ok) {
    return res.status(503).json({
      success: false,
      error: backend.error,
      message: backend.error || 'Chưa cấu hình CPANEL_BACKEND_URL',
    });
  }

  const target = buildCpanelTarget(backend.url, 'shopee/products/sync', {});
  const result = await fetchWithDiagnostics(
    '[Shopee Products Sync]',
    target,
    {
      method: 'POST',
      headers: {
        Authorization: req.headers?.authorization || req.headers?.Authorization || '',
        'Content-Type': 'application/json',
        'X-Proxy-Source': 'vercel-shopee-products-sync',
      },
      body: JSON.stringify(req.body || {}),
    },
    240_000,
  );

  if (!result.ok) {
    return res.status(502).json({
      success: false,
      error: 'backend_unreachable',
      message: result.error?.message || 'Không kết nối được backend cPanel',
      detail: result.error?.code || null,
    });
  }

  const text = await result.upstream.text();
  const trimmed = String(text || '').trimStart();
  let data = null;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    return res.status(result.upstream.status >= 500 ? result.upstream.status : 502).json({
      success: false,
      error: 'invalid_cpanel_response',
      message: `Backend trả về HTTP ${result.upstream.status} (không phải JSON hợp lệ)`,
      httpStatus: result.upstream.status,
      snippet: trimmed.slice(0, 180),
    });
  }

  return res.status(result.upstream.status || 200).json(data);
}
