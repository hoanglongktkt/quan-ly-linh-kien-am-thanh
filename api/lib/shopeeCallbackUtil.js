/**
 * Log chi tiết request Shopee — hiện trên Vercel → Project → Logs / Functions.
 */
export function logShopeeRequest(label, req) {
  const meta = {
    at: new Date().toISOString(),
    method: req.method,
    url: req.url,
    query: req.query || {},
    headers: {
      host: req.headers.host,
      'user-agent': req.headers['user-agent'],
      'content-type': req.headers['content-type'],
      authorization: req.headers.authorization ? '(present)' : '(none)',
      'x-shopee-signature': req.headers['x-shopee-signature'] ? '(present)' : '(none)',
    },
    body: req.body ?? null,
    cpanelBackend: process.env.CPANEL_BACKEND_URL ? '(set)' : '(MISSING)',
  };
  console.log(`[Shopee ${label}]`, JSON.stringify(meta));
}

export function cpanelBackendBase() {
  return String(process.env.CPANEL_BACKEND_URL || '').replace(/\/$/, '');
}

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

/** Chuyển tiếp sang cPanel (OAuth GET hoặc webhook POST) — không chặn response Shopee. */
export async function forwardToCpanel(pathWithQuery, req, opts = {}) {
  const base = cpanelBackendBase();
  if (!base) {
    console.warn('[Shopee Forward] CPANEL_BACKEND_URL chưa set — bỏ qua forward tới cPanel.');
    return null;
  }

  const target = `${base}${pathWithQuery}`;
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

  console.log('[Shopee Forward]', req.method, target);
  try {
    const upstream = await fetch(target, {
      method: req.method,
      headers,
      body,
      redirect: opts.followRedirect === false ? 'manual' : 'follow',
    });
    console.log('[Shopee Forward] Response', upstream.status, target);
    return upstream;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[Shopee Forward] FAILED', target, message);
    return null;
  }
}
