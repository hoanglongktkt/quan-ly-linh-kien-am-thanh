/**
 * POST/GET orders/cleanup-shipped — Vercel proxy sang cPanel (job dọn SHIPPED 1 lần).
 */
import { buildCpanelTarget } from '../cpanelProxy.js';
import { resolveCpanelBackend } from '../cpanelBackend.js';
import { fetchWithDiagnostics } from '../fetchDiagnostics.js';

async function proxyCleanup(req, res, pathPart) {
  const method = String(req.method || 'GET').toUpperCase();
  if (method !== 'POST' && method !== 'GET') {
    return res.status(405).json({ success: false, error: 'method_not_allowed' });
  }
  const backend = resolveCpanelBackend();
  if (!backend?.url) {
    return res.status(500).json({ success: false, error: 'missing_cpanel_backend' });
  }
  const target = buildCpanelTarget(backend.url, pathPart, req.query || {});
  const headers = {
    Authorization: req.headers?.authorization || req.headers?.Authorization || '',
    'Content-Type': 'application/json',
  };
  const result = await fetchWithDiagnostics(
    '[Cleanup SHIPPED]',
    target,
    {
      method,
      headers,
      body: method === 'POST' ? JSON.stringify(req.body || {}) : undefined,
    },
    180_000,
  );
  if (!result.ok) {
    return res.status(502).json({
      success: false,
      error: result.error?.message || 'Không kết nối được backend cPanel.',
    });
  }
  const text = await result.upstream.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    return res.status(502).json({
      success: false,
      error: 'cpanel_non_json',
      preview: String(text || '').slice(0, 200),
    });
  }
  return res.status(result.upstream.status || 200).json(data);
}

export async function handleCleanupShipped(req, res) {
  return proxyCleanup(req, res, 'orders/cleanup-shipped');
}
