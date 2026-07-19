/**
 * Vercel Hobby — MỘT Serverless Function duy nhất.
 * Mọi /api/* và /labels/* rewrite → /api?path=...
 * Shared code nằm ở /_lib (ngoài /api) để không bị đếm vào giới hạn 12 functions.
 */
import { handleLogin } from '../_lib/handlers/login.js';
import { handleAuthVerify } from '../_lib/handlers/authVerify.js';
import { handleShopeeCallback } from '../_lib/handlers/shopeeCallback.js';
import { handleShopeeWebhook } from '../_lib/handlers/shopeeWebhook.js';
import { handleHealthCpanel } from '../_lib/handlers/healthCpanel.js';
import { handleChannelAutoLink } from '../_lib/handlers/channelAutoLink.js';
import { handleMappingAutoLinkSingle } from '../_lib/handlers/mappingAutoLinkSingle.js';
import { handleMappingSkuIndex } from '../_lib/handlers/mappingSkuIndex.js';
import { handleProductSyncShopee } from '../_lib/handlers/productSyncShopee.js';
import { handleScanBulkUpdate } from '../_lib/handlers/scanBulkUpdate.js';
import { handleLabelProxy } from '../_lib/handlers/labels.js';
import { proxyRequestToCpanel, resolveProxyTimeoutMs } from '../_lib/cpanelProxy.js';

function resolveRoutePath(req) {
  const raw = req.query?.path;
  if (raw != null && raw !== '') {
    return (Array.isArray(raw) ? raw.join('/') : String(raw)).replace(/^\/+/, '');
  }
  const pathOnly = String(req.url || '').split('?')[0];
  const m = pathOnly.match(/^\/api\/(.+)$/);
  if (m?.[1]) return decodeURIComponent(m[1]);
  return '';
}

/**
 * Route alias — CHỈ map endpoint CŨ thật sự thiếu trên cPanel.
 * KHÔNG alias channel-products/fetch → products/sync (sai ngữ nghĩa: sync kho gốc ≠ lưu mapping DB).
 */
const ROUTE_ALIASES = {};

/** Route xử lý local trên Vercel — còn lại proxy sang cPanel. */
const LOCAL_ROUTES = {
  login: handleLogin,
  'auth/verify': handleAuthVerify,
  'shopee/callback': handleShopeeCallback,
  'auth/shopee/callback': handleShopeeCallback,
  'shopee/webhook': handleShopeeWebhook,
  'health/cpanel': handleHealthCpanel,
  // Chạy local trên Vercel — cPanel cũ trả 404 HTML cho route auto-link mới.
  'shopee/channel-products/auto-link': handleChannelAutoLink,
  'channel-products/auto-link': handleChannelAutoLink,
  'auto-link': handleChannelAutoLink,
  'mapping-products/auto-link-single': handleMappingAutoLinkSingle,
  'mapping-products/sku-index': handleMappingSkuIndex,
  'products/sync-shopee': handleProductSyncShopee,
  // cPanel cũ trả 404 cho route bulk quét — xử lý local trên Vercel.
  'orders/scan-bulk-update': handleScanBulkUpdate,
};

export default async function handler(req, res) {
  const route = resolveRoutePath(req);

  if (!route || route === 'proxy' || route === 'index') {
    return res.status(404).json({ success: false, error: 'Not found' });
  }

  // PDF vận đơn: /api?path=labels/xxx.pdf hoặc /api/labels/...
  if (route === 'labels' || route.startsWith('labels/')) {
    return handleLabelProxy(req, res, route.replace(/^labels\/?/, ''));
  }

  const local = LOCAL_ROUTES[route];
  if (local) {
    return local(req, res);
  }

  const targetRoute = ROUTE_ALIASES[route] || route;
  const timeoutMs = resolveProxyTimeoutMs(targetRoute);
  return proxyRequestToCpanel(req, res, targetRoute, { timeoutMs });
}

export const config = {
  api: { bodyParser: { sizeLimit: '50mb' } },
  maxDuration: 300,
};
