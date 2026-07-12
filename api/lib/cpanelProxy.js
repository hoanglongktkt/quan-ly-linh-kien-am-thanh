/**
 * Forward request từ Vercel serverless sang backend cPanel.
 */
import { resolveCpanelBackend } from './cpanelBackend.js';
import { fetchWithDiagnostics } from './fetchDiagnostics.js';

const HOP_HEADERS = new Set([
  'host',
  'connection',
  'content-length',
  'transfer-encoding',
  'keep-alive',
  'upgrade',
]);

/** API đồng bộ Shopee / bulk — thường > 20s. */
const LONG_RUNNING_PREFIXES = [
  'shopee/orders/sync',
  'orders/pull',
  'shopee/products/sync',
  'shopee/force-sync',
  'shopee/products/sync-item-variants',
  'products/bulk-save',
  'products/bulk-channel-sync',
  'catalog/wipe-all',
];

export function resolveProxyTimeoutMs(pathPart) {
  const p = String(pathPart || '').replace(/^\/+/, '');
  if (LONG_RUNNING_PREFIXES.some((prefix) => p === prefix || p.startsWith(`${prefix}/`))) {
    return 120_000;
  }
  return 45_000;
}

export function buildCpanelTarget(backendUrl, pathPart, queryWithoutPath) {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(queryWithoutPath || {})) {
    if (key === 'path') continue;
    if (Array.isArray(value)) value.forEach((v) => qs.append(key, String(v)));
    else if (value != null) qs.append(key, String(value));
  }
  const query = qs.toString();
  const normalized = String(pathPart || '').replace(/^\/+/, '');
  return `${backendUrl}/api/${normalized}${query ? `?${query}` : ''}`;
}

export async function proxyRequestToCpanel(req, res, pathPart, opts = {}) {
  const backend = resolveCpanelBackend();
  const timeoutMs = opts.timeoutMs ?? resolveProxyTimeoutMs(pathPart);

  if (!backend.ok) {
    console.error('[API Proxy]', backend.error);
    return res.status(503).json({
      error: backend.error,
      errorCode: 'BACKEND_CONFIG',
      hint: 'Vercel → Settings → Environment Variables → CPANEL_BACKEND_URL=https://api.linhkienamthanh.net',
    });
  }

  const target = buildCpanelTarget(backend.url, pathPart, req.query);

  const headers = {};
  for (const [key, value] of Object.entries(req.headers || {})) {
    if (HOP_HEADERS.has(key.toLowerCase())) continue;
    if (value != null) headers[key] = value;
  }

  let body;
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    if (req.body != null && req.body !== '') {
      body = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
      if (!headers['content-type'] && !headers['Content-Type']) {
        headers['Content-Type'] = 'application/json';
      }
    }
  }

  console.log('[API Proxy]', req.method, target, `(timeout=${timeoutMs}ms)`);
  const result = await fetchWithDiagnostics('[API Proxy]', target, {
    method: req.method,
    headers,
    body,
  }, timeoutMs);

  if (!result.ok) {
    const e = result.error;
    return res.status(502).json({
      error: 'Không kết nối được backend cPanel',
      detail: e?.message || 'fetch failed',
      errorCode: e?.code || null,
      hint: e?.hint || null,
      causeMessage: e?.causeMessage || null,
      cpanelBackendUrl: backend.url,
      latencyMs: result.latencyMs,
      timeoutMs,
    });
  }

  const upstream = result.upstream;
  const text = await upstream.text();
  res.status(upstream.status);
  upstream.headers.forEach((value, key) => {
    if (!HOP_HEADERS.has(key.toLowerCase())) res.setHeader(key, value);
  });
  return res.send(text);
}
