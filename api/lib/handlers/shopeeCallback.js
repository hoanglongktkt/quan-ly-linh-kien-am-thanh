import {
  logShopeeRequest,
  respondShopeeOk,
  forwardToCpanel,
  resolveCpanelBackend,
  respondCallbackError,
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

export async function handleShopeeCallback(req, res) {
  logShopeeRequest(LOG, req);

  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    return res.status(200).type('text/plain; charset=utf-8').send('OK');
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
    const code = queryOne(req.query?.code);
    const shopId = queryOne(req.query?.shop_id);
    const mainAccountId = queryOne(req.query?.main_account_id);

    if (!code && !shopId && !mainAccountId) {
      console.log(LOG, 'Truy cập trực tiếp — thiếu code/shop_id');
      return res.status(200).type('text/plain; charset=utf-8').send(IDLE_MSG);
    }

    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(req.query || {})) {
      if (v != null) qs.set(k, String(Array.isArray(v) ? v[0] : v));
    }
    const path = `/api/shopee/oauth/complete?${qs.toString()}`;

    const backend = resolveCpanelBackend();
    if (!backend.ok) {
      console.error(LOG, backend.error);
      return respondCallbackError(res, 503, {
        message: backend.error,
        errorCode: 'BACKEND_CONFIG',
        cpanelBackendUrl: process.env.CPANEL_BACKEND_URL ? '(set but invalid)' : '(MISSING)',
        hint: 'Set CPANEL_BACKEND_URL trên Vercel → https://api.linhkienamthanh.net',
      });
    }

    console.log(LOG, 'OAuth → cPanel JSON complete', path);

    const forward = await forwardToCpanel(LOG, path, req, {
      followRedirect: false,
      timeoutMs: 60000,
    });

    if (!forward.ok || !forward.upstream) {
      const err = forward.error || { message: 'fetch failed' };
      console.error(
        LOG,
        'OAuth complete failed',
        JSON.stringify({ target: forward.target, cpanelBackendUrl: forward.cpanelBackendUrl, ...err }),
      );
      return res.status(502).json({
        success: false,
        message: err.message || 'Không kết nối được backend cPanel',
        error: err.code || 'cpanel_oauth_failed',
        cpanelBackendUrl: forward.cpanelBackendUrl || backend.url,
      });
    }

    const upstream = forward.upstream;
    const bodyText = await upstream.text();
    console.log(
      LOG,
      'OAuth complete response',
      JSON.stringify({ status: upstream.status, bodyPreview: bodyText.slice(0, 800) }),
    );

    let data;
    try {
      data = JSON.parse(bodyText);
    } catch {
      console.error(LOG, 'OAuth complete — invalid JSON from cPanel', bodyText.slice(0, 500));
      return res.status(502).json({
        success: false,
        message: 'Backend cPanel trả về dữ liệu không phải JSON',
        error: 'invalid_cpanel_response',
        bodyPreview: bodyText.slice(0, 500),
      });
    }

    const oauthShopId = String(data.oauth_shop_id || shopId || '');
    const expectedShop = queryOne(req.query?.expected_shop) || String(data.expected_shop_id || '');

    if (wantsBrowserRedirect(req)) {
      if (data.success) {
        const savedQuery = encodeURIComponent((data.saved_shop_ids || []).join(','));
        const expectedQuery = expectedShop ? `&expected_shop=${encodeURIComponent(expectedShop)}` : '';
        return res.redirect(
          302,
          `${APP_FRONTEND}/?shopee_linked=1&shop_id=${encodeURIComponent(oauthShopId)}&saved_shops=${savedQuery}${expectedQuery}`,
        );
      }
      const errMsg = data.message || data.error || 'token_exchange_failed';
      return res.redirect(
        302,
        `${APP_FRONTEND}/?shopee_linked=0&shop_id=${encodeURIComponent(oauthShopId)}&error=${encodeURIComponent(errMsg)}`,
      );
    }

    return res.status(data.success ? 200 : upstream.status >= 400 ? upstream.status : 400).json({
      ...data,
      oauth_shop_id: oauthShopId,
      message:
        data.message ||
        (data.success
          ? `OAuth thành công cho shop ${oauthShopId}.`
          : data.error || 'OAuth thất bại'),
      frontend_url: APP_FRONTEND,
      hint: wantsBrowserRedirect(req)
        ? null
        : 'Thêm ?format=json hoặc ?redirect=0 để xem JSON debug thay vì chuyển về app.',
    });
  }

  res.setHeader('Allow', 'GET, POST, OPTIONS');
  return res.status(405).type('text/plain; charset=utf-8').send('Method not allowed. Use GET or POST.');
}
