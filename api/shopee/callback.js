/**
 * Vercel Serverless — Shopee Live Callback / Push / OAuth redirect
 * URL đăng ký Shopee: https://<domain>/api/shopee/callback
 * Alias: /api/auth/shopee/callback
 *
 * Shopee Push verification (POST): bắt buộc HTTP 2xx + body RỖNG (không JSON).
 * Không yêu cầu JWT — Shopee gọi trực tiếp.
 */
import {
  logShopeeRequest,
  respondShopeeOk,
  forwardToCpanel,
  cpanelBackendBase,
} from '../lib/shopeeCallbackUtil.js';

const HOP_HEADERS = new Set([
  'host',
  'connection',
  'content-length',
  'transfer-encoding',
  'keep-alive',
  'upgrade',
]);

export default async function handler(req, res) {
  logShopeeRequest('Callback', req);

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
      forwardToCpanel(`/api/shopee/webhook${q ? `?${q}` : ''}`, req).catch(() => {});
    });
    return;
  }

  if (req.method === 'GET') {
    const code = req.query?.code;
    const shopId = req.query?.shop_id;

    if (!code && !shopId) {
      console.log('[Shopee Callback] GET verification probe — 200 empty');
      return respondShopeeOk(res);
    }

    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(req.query || {})) {
      if (v != null) qs.set(k, String(v));
    }
    const path = `/api/shopee/callback?${qs.toString()}`;

    if (!cpanelBackendBase()) {
      console.error('[Shopee Callback] OAuth GET nhưng thiếu CPANEL_BACKEND_URL');
      res.status(503);
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      return res.end(
        'CPANEL_BACKEND_URL chưa cấu hình trên Vercel. Không thể hoàn tất OAuth.',
      );
    }

    const upstream = await forwardToCpanel(path, req, { followRedirect: false });
    if (!upstream) {
      res.status(502);
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      return res.end('Không kết nối được backend cPanel.');
    }

    res.status(upstream.status);
    upstream.headers.forEach((value, key) => {
      if (!HOP_HEADERS.has(key.toLowerCase())) res.setHeader(key, value);
    });
    const buf = Buffer.from(await upstream.arrayBuffer());
    return res.end(buf);
  }

  res.setHeader('Allow', 'GET, POST, OPTIONS');
  res.status(405);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  return res.end(JSON.stringify({ error: 'Method not allowed' }));
}

export const config = {
  api: {
    bodyParser: {
      sizeLimit: '4mb',
    },
  },
};
