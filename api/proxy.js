/**
 * Vercel — proxy /api/* sang backend cPanel (gọi qua vercel.json rewrite).
 * Rewrite: /api/:path* → /api/proxy?path=:path*
 */
const BACKEND = 'https://quanly.linhkienamthanh.net';

const HOP_HEADERS = new Set([
  'host',
  'connection',
  'content-length',
  'transfer-encoding',
  'keep-alive',
  'upgrade',
]);

function resolvePathPart(req) {
  const raw = req.query.path;
  if (raw != null && raw !== '') {
    return Array.isArray(raw) ? raw.join('/') : String(raw);
  }
  const urlPath = String(req.url || '').split('?')[0];
  const m = urlPath.match(/^\/api\/proxy\/?(.*)$/);
  return m?.[1] ? decodeURIComponent(m[1]) : '';
}

export default async function handler(req, res) {
  const pathPart = resolvePathPart(req);

  if (!pathPart || pathPart === 'proxy' || pathPart.startsWith('shopee/callback')) {
    return res.status(404).json({ error: 'Not found' });
  }

  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(req.query)) {
    if (key === 'path') continue;
    if (Array.isArray(value)) value.forEach((v) => qs.append(key, String(v)));
    else if (value != null) qs.append(key, String(value));
  }
  const query = qs.toString();
  const target = `${BACKEND}/api/${pathPart}${query ? `?${query}` : ''}`;

  const headers = {};
  for (const [key, value] of Object.entries(req.headers)) {
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

  try {
    const upstream = await fetch(target, {
      method: req.method,
      headers,
      body,
    });

    const text = await upstream.text();
    res.status(upstream.status);
    upstream.headers.forEach((value, key) => {
      if (!HOP_HEADERS.has(key.toLowerCase())) {
        res.setHeader(key, value);
      }
    });
    return res.send(text);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return res.status(502).json({ error: 'Không kết nối được backend', detail: message });
  }
}

export const config = {
  api: {
    bodyParser: {
      sizeLimit: '10mb',
    },
  },
};
