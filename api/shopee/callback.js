/**
 * Vercel — Shopee Live Callback / OAuth redirect
 * URL: https://<domain>/api/shopee/callback
 *
 * Biến môi trường: CPANEL_BACKEND_URL (VD: https://api.linhkienamthanh.net)
 * Không dùng APP_URL, BACKEND_URL hay NEXT_PUBLIC_*.
 */
import {
  logShopeeRequest,
  respondShopeeOk,
  forwardToCpanel,
  resolveCpanelBackend,
  respondCallbackError,
} from '../lib/shopeeCallbackUtil.js';

const LOG = '[Shopee Callback]';

const HOP_HEADERS = new Set([
  'host',
  'connection',
  'content-length',
  'transfer-encoding',
  'keep-alive',
  'upgrade',
]);

export default async function handler(req, res) {
  logShopeeRequest(LOG, req);

  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    return respondShopeeOk(res);
  }

  if (req.method === 'POST') {
    respondShopeeOk(res);

    setImmediate(() => {
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries(req.query || {})) {
        if (Array.isArray(v)) v.forEach((x) => qs.append(k, String(x)));
        else if (v != null) qs.append(k, String(v));
      }
      const q = qs.toString();
      forwardToCpanel(LOG, `/api/shopee/webhook${q ? `?${q}` : ''}`, req).catch(() => {});
    });
    return;
  }

  if (req.method === 'GET') {
    const code = req.query?.code;
    const shopId = req.query?.shop_id;

    if (!code && !shopId) {
      console.log(LOG, 'GET verification probe — 200 empty');
      return respondShopeeOk(res);
    }

    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(req.query || {})) {
      if (v != null) qs.set(k, String(v));
    }
    const path = `/api/shopee/callback?${qs.toString()}`;

    const backend = resolveCpanelBackend();
    if (!backend.ok) {
      console.error(LOG, backend.error);
      return respondCallbackError(res, 503, {
        message: backend.error,
        errorCode: 'BACKEND_CONFIG',
        cpanelBackendUrl: process.env.CPANEL_BACKEND_URL ? '(set but invalid)' : '(MISSING)',
        hint: 'Set CPANEL_BACKEND_URL trên Vercel → subdomain cPanel (https://api.linhkienamthanh.net).',
      });
    }

    const forward = await forwardToCpanel(LOG, path, req, { followRedirect: false });

    if (!forward.ok || !forward.upstream) {
      const err = forward.error || { message: 'fetch failed' };
      console.error(
        LOG,
        'Forward failed',
        JSON.stringify({ target: forward.target, cpanelBackendUrl: forward.cpanelBackendUrl, ...err }),
      );
      return respondCallbackError(res, 502, {
        message: err.message || 'Không kết nối được backend cPanel',
        errorCode: err.code || err.causeCode || null,
        causeMessage: err.causeMessage || null,
        hint: err.hint || null,
        targetUrl: forward.target,
        cpanelBackendUrl: forward.cpanelBackendUrl || backend.url,
        latencyMs: forward.latencyMs,
        errorChain: err.chain || null,
      });
    }

    const upstream = forward.upstream;
    res.status(upstream.status);
    upstream.headers.forEach((value, key) => {
      if (!HOP_HEADERS.has(key.toLowerCase())) res.setHeader(key, value);
    });
    const buf = Buffer.from(await upstream.arrayBuffer());
    return res.end(buf);
  }

  res.setHeader('Allow', 'GET, POST, OPTIONS');
  res.status(405).end();
}

export const config = {
  api: { bodyParser: { sizeLimit: '4mb' } },
};
