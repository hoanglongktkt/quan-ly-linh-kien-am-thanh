/**
 * Vercel — proxy /api/* sang backend cPanel.
 */
import { proxyRequestToCpanel } from './lib/cpanelProxy.js';

const BLOCKED_PREFIXES = [
  'proxy',
  'shopee/callback',
  'shopee/webhook',
  'auth/shopee/callback',
  'health/cpanel',
  'shopee/orders/sync',
];

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

  const blocked =
    !pathPart ||
    BLOCKED_PREFIXES.some((p) => pathPart === p || pathPart.startsWith(`${p}/`));
  if (blocked) {
    return res.status(404).json({ error: 'Not found' });
  }

  return proxyRequestToCpanel(req, res, pathPart);
}

export const config = {
  api: { bodyParser: { sizeLimit: '10mb' } },
  maxDuration: 300,
};
