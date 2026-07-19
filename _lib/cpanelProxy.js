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
  'shopee/orders/sync/job',
  'orders/pull',
  'orders/pull/status',
  'shopee/products/sync',
  'shopee/channel-products/fetch',
  'shopee/channel-products/auto-link',
  'shopee/force-sync',
  'shopee/products/sync-item-variants',
  'products/bulk-save',
  'products/bulk-channel-sync',
  'catalog/wipe-all',
  'shopee/ship-order',
  'shopee/print-document',
  'settings/shop-connection-status',
];

const RETRYABLE_ERROR_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'AbortError',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET',
  'ENOTFOUND',
]);

export function resolveProxyTimeoutMs(pathPart) {
  const p = String(pathPart || '').replace(/^\/+/, '');
  if (LONG_RUNNING_PREFIXES.some((prefix) => p === prefix || p.startsWith(`${prefix}/`))) {
    return 240_000;
  }
  return 60_000;
}

async function fetchBackendWithRetry(label, url, init, timeoutMs, maxAttempts = 3) {
  let lastResult = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    lastResult = await fetchWithDiagnostics(`${label}#${attempt}`, url, init, timeoutMs);
    if (lastResult.ok) return lastResult;
    const code = lastResult.error?.code;
    const retryable = code && RETRYABLE_ERROR_CODES.has(String(code));
    if (!retryable || attempt >= maxAttempts) return lastResult;
    await new Promise((resolve) => setTimeout(resolve, 400 * attempt));
  }
  return lastResult;
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

  const headers = {
    'User-Agent': 'OmniSales-Vercel-Proxy/1.0 (+https://quanly.linhkienamthanh.net)',
    'X-Proxy-Source': 'vercel',
  };
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
  const result = await fetchBackendWithRetry('[API Proxy]', target, {
    method: req.method,
    headers,
    body,
  }, timeoutMs);

  if (result.ok) {
    const upstream = result.upstream;
    const text = await upstream.text();
    const trimmed = String(text || '').trimStart();
    const isHtml =
      trimmed.startsWith('<!DOCTYPE') ||
      trimmed.startsWith('<html') ||
      trimmed.includes('503 Service Unavailable') ||
      trimmed.includes('502 Bad Gateway');
    const isServerError = upstream.status >= 500;

    if (isHtml || (isServerError && !trimmed.startsWith('{'))) {
      return res.status(isServerError ? upstream.status : 502).json({
        success: false,
        error: upstream.status === 503 ? 'backend_unavailable' : 'invalid_cpanel_response',
        message: `Backend trả về HTTP ${upstream.status} (không phải JSON hợp lệ)`,
        httpStatus: upstream.status,
        cpanelBackendUrl: backend.url,
        latencyMs: result.latencyMs,
      });
    }

    res.status(upstream.status);
    upstream.headers.forEach((value, key) => {
      if (!HOP_HEADERS.has(key.toLowerCase())) res.setHeader(key, value);
    });
    return res.send(text);
  }

  const e = result.error;
  return res.status(502).json({
    success: false,
    error: 'Không kết nối được backend cPanel',
    message: e?.message || e?.hint || 'Không kết nối được backend API',
    detail: e?.message || 'fetch failed',
    errorCode: e?.code || null,
    hint: e?.hint || null,
    causeMessage: e?.causeMessage || null,
    cpanelBackendUrl: backend.url,
    latencyMs: result.latencyMs,
    timeoutMs,
  });
}
