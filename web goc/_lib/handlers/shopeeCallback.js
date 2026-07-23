import {
  logShopeeRequest,
  respondShopeeOk,
  forwardToCpanel,
  resolveCpanelBackend,
} from '../shopeeCallbackUtil.js';

const LOG = '[Shopee Callback]';
const APP_FRONTEND = 'https://quanly.linhkienamthanh.net';
const IDLE_MSG = 'Callback route is active. Waiting for Shopee parameters (code, shop_id)...';

function queryOne(value) {
  if (Array.isArray(value)) return String(value[0] ?? '').trim();
  return String(value ?? '').trim();
}

function wantsBrowserRedirect(req) {
  if (queryOne(req.query?.format) === 'json') return false;
  if (queryOne(req.query?.redirect) === '0') return false;
  return true;
}

function isHtmlBody(text) {
  const t = String(text || '').trimStart();
  return (
    t.startsWith('<!DOCTYPE') ||
    t.startsWith('<html') ||
    t.includes('503 Service Unavailable') ||
    t.includes('502 Bad Gateway')
  );
}

function buildOAuthErrorRedirect(oauthShopId, message) {
  const errMsg = message || 'Không kết nối được backend cPanel. Vui lòng Restart Node.js App trên cPanel rồi OAuth lại.';
  return `${APP_FRONTEND}/?shopee_linked=0&shop_id=${encodeURIComponent(oauthShopId)}&error=${encodeURIComponent(errMsg)}`;
}

function buildOAuthSuccessRedirect(oauthShopId, data, expectedShop) {
  const savedQuery = encodeURIComponent((data.saved_shop_ids || []).join(','));
  const expectedQuery = expectedShop ? `&expected_shop=${encodeURIComponent(expectedShop)}` : '';
  return `${APP_FRONTEND}/?shopee_linked=1&shop_id=${encodeURIComponent(oauthShopId)}&saved_shops=${savedQuery}${expectedQuery}`;
}

async function forwardOAuthWithRetry(req, paths, timeoutMs = 90_000) {
  let last = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    for (const path of paths) {
      const forward = await forwardToCpanel(LOG, path, req, {
        followRedirect: false,
        timeoutMs,
      });
      last = forward;
      if (forward.ok && forward.upstream) {
        const status = forward.upstream.status;
        if (status >= 300 && status < 400) return forward;
        const preview = await forward.upstream.clone().text();
        if (!isHtmlBody(preview) && status < 500) return forward;
        console.warn(LOG, `Attempt ${attempt} path ${path} → HTTP ${status}, retry...`);
      } else {
        console.warn(LOG, `Attempt ${attempt} path ${path} failed`, forward.error?.message || 'fetch failed');
      }
    }
    if (attempt < 3) {
      await new Promise((r) => setTimeout(r, 800 * attempt));
    }
  }
  return last;
}

function relayUpstreamRedirect(res, upstream) {
  const location = upstream.headers.get('location') || upstream.headers.get('Location');
  if (!location) return false;
  res.redirect(upstream.status || 302, location);
  return true;
}

export async function handleShopeeCallback(req, res) {
  logShopeeRequest(LOG, req);

  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    return res.status(200).type('text/plain; charset=utf-8').send('OK');
  }

  if (req.method === 'POST') {
    // Push webhook từ Shopee — luôn 200 JSON để Console không báo lỗi.
    try {
      if (!res.headersSent) {
        res.status(200).json({ success: true });
      }
    } catch {
      try {
        res.status(200).type('text/plain; charset=utf-8').send('success');
      } catch {
        /* ignore */
      }
    }

    setImmediate(() => {
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries(req.query || {})) {
        if (Array.isArray(v)) v.forEach((x) => qs.append(k, String(x)));
        else if (v != null) qs.append(k, String(v));
      }
      const q = qs.toString();
      const suffix = q ? `?${q}` : '';
      forwardToCpanel(LOG, `/api/auth/shopee/callback${suffix}`, req)
        .then((r) => {
          if (r?.ok && r.upstream && r.upstream.status < 500) return r;
          return forwardToCpanel(LOG, `/api/shopee/webhook${suffix}`, req);
        })
        .catch(() => {
          forwardToCpanel(LOG, `/api/shopee/webhook${suffix}`, req).catch(() => {});
        });
    });
    return;
  }

  if (req.method === 'GET') {
    const code = queryOne(req.query?.code);
    const shopId = queryOne(req.query?.shop_id);
    const mainAccountId = queryOne(req.query?.main_account_id);
    const oauthShopId = shopId || mainAccountId || '';

    if (!code && !shopId && !mainAccountId) {
      console.log(LOG, 'Truy cập trực tiếp — thiếu code/shop_id');
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
        return res.redirect(302, buildOAuthErrorRedirect(oauthShopId, backend.error));
      }
      return res.status(503).json({ success: false, message: backend.error, error: 'BACKEND_CONFIG' });
    }

    const paths = [
      `/api/shopee/callback?${queryString}`,
      `/api/shopee/oauth/complete?${queryString}`,
    ];
    console.log(LOG, 'OAuth → cPanel (callback + oauth/complete fallback)', queryString);

    const forward = await forwardOAuthWithRetry(req, paths);

    if (!forward?.ok || !forward.upstream) {
      const err = forward?.error || { message: 'fetch failed' };
      console.error(LOG, 'OAuth complete failed after retries', JSON.stringify(err));
      if (wantsBrowserRedirect(req)) {
        return res.redirect(
          302,
          buildOAuthErrorRedirect(oauthShopId, err.message || 'Máy chủ cPanel không phản hồi (503). Restart Node.js App rồi thử lại.'),
        );
      }
      return res.status(502).json({
        success: false,
        message: err.message || 'Không kết nối được backend cPanel',
        error: err.code || 'cpanel_oauth_failed',
        cpanelBackendUrl: forward?.cpanelBackendUrl || backend.url,
      });
    }

    const upstream = forward.upstream;

    if (upstream.status >= 300 && upstream.status < 400 && wantsBrowserRedirect(req)) {
      if (relayUpstreamRedirect(res, upstream)) return;
    }

    const bodyText = await upstream.text();
    console.log(
      LOG,
      'OAuth complete response',
      JSON.stringify({ status: upstream.status, target: forward.target, bodyPreview: bodyText.slice(0, 300) }),
    );

    if (isHtmlBody(bodyText) || upstream.status >= 500) {
      const msg = 'Máy chủ cPanel trả 503 — Restart Node.js App trên cPanel, rồi bấm OAuth lại.';
      if (wantsBrowserRedirect(req)) {
        return res.redirect(302, buildOAuthErrorRedirect(oauthShopId, msg));
      }
      return res.status(503).json({
        success: false,
        message: msg,
        error: 'backend_unavailable',
        httpStatus: upstream.status,
      });
    }

    let data;
    try {
      data = JSON.parse(bodyText);
    } catch {
      console.error(LOG, 'OAuth complete — invalid JSON from cPanel', bodyText.slice(0, 500));
      if (wantsBrowserRedirect(req)) {
        return res.redirect(
          302,
          buildOAuthErrorRedirect(oauthShopId, 'Backend cPanel trả dữ liệu lỗi. Restart Node.js App và OAuth lại.'),
        );
      }
      return res.status(502).json({
        success: false,
        message: 'Backend cPanel trả về dữ liệu không phải JSON',
        error: 'invalid_cpanel_response',
      });
    }

    const resolvedShopId = String(data.oauth_shop_id || shopId || '');
    const expectedShop = queryOne(req.query?.expected_shop) || String(data.expected_shop_id || '');

    if (wantsBrowserRedirect(req)) {
      if (data.success) {
        return res.redirect(302, buildOAuthSuccessRedirect(resolvedShopId, data, expectedShop));
      }
      const errMsg = data.message || data.error || 'token_exchange_failed';
      return res.redirect(302, buildOAuthErrorRedirect(resolvedShopId, errMsg));
    }

    return res.status(data.success ? 200 : upstream.status >= 400 ? upstream.status : 400).json({
      ...data,
      oauth_shop_id: resolvedShopId,
      message:
        data.message ||
        (data.success
          ? `OAuth thành công cho shop ${resolvedShopId}.`
          : data.error || 'OAuth thất bại'),
      frontend_url: APP_FRONTEND,
    });
  }

  res.setHeader('Allow', 'GET, POST, OPTIONS');
  return res.status(405).type('text/plain; charset=utf-8').send('Method not allowed. Use GET or POST.');
}
