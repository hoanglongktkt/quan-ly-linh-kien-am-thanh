/**
 * Vercel — single catch-all API router (Hobby plan ≤12 functions).
 */
import { handleLogin } from './lib/handlers/login.js';
import { handleAuthVerify } from './lib/handlers/authVerify.js';
import { handleShopeeCallback } from './lib/handlers/shopeeCallback.js';
import { handleShopeeWebhook } from './lib/handlers/shopeeWebhook.js';
import { handleHealthCpanel } from './lib/handlers/healthCpanel.js';
import { proxyRequestToCpanel, resolveProxyTimeoutMs } from './lib/cpanelProxy.js';

function resolveRoutePath(req) {
  const raw = req.query?.path;
  if (raw == null || raw === '') return '';
  return Array.isArray(raw) ? raw.join('/') : String(raw);
}

const LOCAL_ROUTES = {
  login: handleLogin,
  'auth/verify': handleAuthVerify,
  'shopee/callback': handleShopeeCallback,
  'auth/shopee/callback': handleShopeeCallback,
  'shopee/webhook': handleShopeeWebhook,
  'health/cpanel': handleHealthCpanel,
};

export default async function handler(req, res) {
  const route = resolveRoutePath(req).replace(/^\/+/, '');

  if (!route || route === 'proxy') {
    return res.status(404).json({ error: 'Not found' });
  }

  const local = LOCAL_ROUTES[route];
  if (local) {
    return local(req, res);
  }

  const timeoutMs = resolveProxyTimeoutMs(route);
  return proxyRequestToCpanel(req, res, route, { timeoutMs });
}

export const config = {
  api: { bodyParser: { sizeLimit: '10mb' } },
  maxDuration: 300,
};
