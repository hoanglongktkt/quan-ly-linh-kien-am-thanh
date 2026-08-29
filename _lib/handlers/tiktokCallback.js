/**
 * Vercel — GET /api/tiktok/callback
 * Forward OAuth sang cPanel (followRedirect: false) rồi relay Location / JSON.
 */
import {
  logShopeeRequest,
  forwardToCpanel,
  resolveCpanelBackend,
} from '../shopeeCallbackUtil.js';

const LOG = '[TikTok Callback]';
const APP_FRONTEND = 'https://quanly.linhkienamthanh.net';
const IDLE_MSG = 'Callback route is active. Waiting for TikTok Shop parameters (code, shop_id)...';

function queryOne(value) {
  if (Array.isArray(value)) return String(value[0] ?? '').trim();
  return String(value ?? '').trim();
}

function wantsBrowserRedirect(req) {
  if (queryOne(req.query?.format) === 'json') return false;
  if (queryOne(req.query?.redirect) === '0') return false;
  return true;
}

function buildRedirect(success, shopId, message) {
  const base = `${APP_FRONTEND}/?tab=settings`;
  const shopQ = shopId ? `&shop_id=${encodeURIComponent(shopId)}` : '';
  if (success) return `${base}&tiktok_linked=1${shopQ}`;
  const err = message || 'Không kết nối được backend cPanel.';
  return `${base}&tiktok_linked=0${shopQ}&error=${encodeURIComponent(err)}`;
}

function relayUpstreamRedirect(res, upstream) {
  const location = upstream.headers.get('location') || upstream.headers.get('Location');
  if (!location) return false;
  res.redirect(upstream.status || 302, location);
  return true;
}

export async function handleTiktokCallback(req, res) {
  logShopeeRequest(LOG, req);

  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    return res.status(200).type('text/plain; charset=utf-8').send('OK');
  }

  if (req.method !== 'GET') {
    return res.status(405).type('text/plain; charset=utf-8').send(
      'TikTok OAuth callback accepts GET only.',
    );
  }

  const code = queryOne(req.query?.code);
  const shopId = queryOne(req.query?.shop_id) || queryOne(req.query?.open_id);

  if (!code) {
    console.log(LOG, 'Truy cập trực tiếp — thiếu code');
    return res.status(200).type('text/plain; charset=utf-8').send(IDLE_MSG);
  }

  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(req.query || {})) {
    if (v != null) qs.set(k, String(Array.isArray(v) ? v[0] : v));
  }
  const queryString = qs.toString();

  const backend = resolveCpanelBackend();
  if (!backend.ok) {
    console.error(LOG, backend.error);
    if (wantsBrowserRedirect(req)) {
      return res.redirect(302, buildRedirect(false, shopId, backend.error));
    }
    return res.status(503).json({ success: false, message: backend.error, error: 'BACKEND_CONFIG' });
  }

  console.log(LOG, 'OAuth → cPanel /api/tiktok/callback', queryString);
  const forward = await forwardToCpanel(LOG, `/api/tiktok/callback?${queryString}`, req, {
    followRedirect: false,
    timeoutMs: 60_000,
  });

  if (!forward?.ok || !forward.upstream) {
    const err = forward?.error || { message: 'fetch failed' };
    console.error(LOG, 'Forward failed', JSON.stringify(err));
    if (wantsBrowserRedirect(req)) {
      return res.redirect(
        302,
        buildRedirect(false, shopId, err.message || 'Máy chủ cPanel không phản hồi.'),
      );
    }
    return res.status(502).json({
      success: false,
      message: err.message || 'Không kết nối được backend cPanel',
      error: err.code || 'cpanel_oauth_failed',
    });
  }

  const upstream = forward.upstream;

  if (upstream.status >= 300 && upstream.status < 400 && wantsBrowserRedirect(req)) {
    if (relayUpstreamRedirect(res, upstream)) return;
  }

  const bodyText = await upstream.text();
  let data = null;
  try {
    data = JSON.parse(bodyText);
  } catch {
    data = null;
  }

  if (wantsBrowserRedirect(req)) {
    const ok = Boolean(data?.success) || (upstream.status >= 200 && upstream.status < 300 && !data);
    const msg = data?.message || data?.error || (ok ? '' : bodyText.slice(0, 200));
    return res.redirect(302, buildRedirect(ok, shopId || data?.shop_id, msg));
  }

  res.status(upstream.status || 200);
  const ct = upstream.headers.get('content-type');
  if (ct) res.setHeader('Content-Type', ct);
  return res.send(bodyText);
}
