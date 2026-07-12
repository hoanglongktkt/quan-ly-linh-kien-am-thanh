import { cpanelBackendBase, resolveCpanelBackend } from './cpanelBackend.js';
import { fetchWithDiagnostics } from './fetchDiagnostics.js';

/** Log đầy đủ headers + body — prefix cố định [Shopee Callback] hoặc [Shopee Webhook]. */
export function logShopeeRequest(prefix, req) {
  const headers = {};
  for (const [key, value] of Object.entries(req.headers || {})) {
    headers[key] = value;
  }

  let body = req.body;
  if (body != null && typeof body === 'object') {
    try {
      body = JSON.parse(JSON.stringify(body));
    } catch {
      body = String(body);
    }
  }

  const backend = resolveCpanelBackend();
  console.log(
    prefix,
    JSON.stringify({
      at: new Date().toISOString(),
      method: req.method,
      url: req.url,
      query: req.query || {},
      headers,
      body,
      cpanelBackendUrl: backend.url || null,
      cpanelBackendConfigured: backend.ok,
      cpanelBackendError: backend.error,
    }),
  );
}

export { cpanelBackendBase, resolveCpanelBackend };

/** Shopee Push verification: 2xx + body RỖNG (không JSON). */
export function respondShopeeOk(res) {
  res.status(200);
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  return res.end();
}

const HOP_HEADERS = new Set([
  'host',
  'connection',
  'content-length',
  'transfer-encoding',
  'keep-alive',
  'upgrade',
]);

/**
 * Chuyển tiếp sang cPanel — OAuth GET hoặc webhook POST.
 * @param {string} logPrefix - [Shopee Callback] hoặc [Shopee Webhook]
 */
export async function forwardToCpanel(logPrefix, pathWithQuery, req, opts = {}) {
  const backend = resolveCpanelBackend();
  if (!backend.ok) {
    console.error(logPrefix, 'Forward skipped:', backend.error);
    return null;
  }

  const target = `${backend.url}${pathWithQuery}`;
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

  console.log(logPrefix, 'Forward →', req.method, target);
  const result = await fetchWithDiagnostics(logPrefix, target, {
    method: req.method,
    headers,
    body,
    redirect: opts.followRedirect === false ? 'manual' : 'follow',
  }, opts.timeoutMs || 15000);

  if (!result.ok) {
    return null;
  }

  const upstream = result.upstream;
  const preview = await upstream.clone().text();
  console.log(
    logPrefix,
    'Forward response',
    JSON.stringify({
      target,
      status: upstream.status,
      latencyMs: result.latencyMs,
      bodyPreview: preview.slice(0, 500),
    }),
  );
  return upstream;
}
