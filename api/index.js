/**
 * Vercel Hobby — MỘT Serverless Function duy nhất.
 * Mọi /api/* và /labels/* rewrite → /api?path=...
 * Shared code nằm ở /_lib (ngoài /api) để không bị đếm vào giới hạn 12 functions.
 */
import 'dotenv/config';
import { handleLogin } from '../_lib/handlers/login.js';
import { handleAuthVerify } from '../_lib/handlers/authVerify.js';
import { handleShopeeCallback } from '../_lib/handlers/shopeeCallback.js';
import { handleTiktokCallback } from '../_lib/handlers/tiktokCallback.js';
import { handleShopeeWebhook } from '../_lib/handlers/shopeeWebhook.js';
import { handleHealthCpanel } from '../_lib/handlers/healthCpanel.js';
import { handleChannelAutoLink } from '../_lib/handlers/channelAutoLink.js';
import { handleMappingAutoLinkSingle } from '../_lib/handlers/mappingAutoLinkSingle.js';
import { handleMappingSkuIndex } from '../_lib/handlers/mappingSkuIndex.js';
import { handleMappingBulkAutoLink } from '../_lib/handlers/mappingBulkAutoLink.js';
import { handleProductSyncShopee } from '../_lib/handlers/productSyncShopee.js';
import { handleShopeeProductsSync } from '../_lib/handlers/shopeeProductsSync.js';
import { handleShopeeItemPreview } from '../_lib/handlers/shopeeItemPreview.js';
import { handleProductsSearch } from '../_lib/handlers/productsSearch.js';
import { handleScanBulkUpdate } from '../_lib/handlers/scanBulkUpdate.js';
import { handleScanSave, handleScanDonHoanHuy } from '../_lib/handlers/scanSave.js';
import { handleScanBgEnqueue, handleScanBgStatus, handleScanBgAck } from '../_lib/handlers/scanBgQueue.js';
import { handleHandOverCarrier } from '../_lib/handlers/handOverCarrier.js';
import { handleConfirmReturnReceived } from '../_lib/handlers/confirmReturnReceived.js';
import { handleCleanupHandedOver } from '../_lib/handlers/cleanupHandedOver.js';
import { handleCleanupShipped } from '../_lib/handlers/cleanupShipped.js';
import { handleCleanupProcessedPickup } from '../_lib/handlers/cleanupProcessedPickup.js';
import { handleHydrateTracking } from '../_lib/handlers/hydrateTracking.js';
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
  'tiktok/callback': handleTiktokCallback,
  'shopee/webhook': handleShopeeWebhook,
  'health/cpanel': handleHealthCpanel,
  // Chạy local trên Vercel — cPanel cũ trả 404 HTML cho route auto-link mới.
  'shopee/channel-products/auto-link': handleChannelAutoLink,
  'channel-products/auto-link': handleChannelAutoLink,
  'auto-link': handleChannelAutoLink,
  'mapping-products/auto-link-single': handleMappingAutoLinkSingle,
  'mapping-products/sku-index': handleMappingSkuIndex,
  'mapping-products/bulk-auto-link': handleMappingBulkAutoLink,
  'mapping/bulk-update': handleMappingBulkAutoLink,
  'products/sync-shopee': handleProductSyncShopee,
  // Khởi tạo kho — proxy JSON-safe (Passenger HTML 500 → lỗi rõ, không crash FE).
  'shopee/products/sync': handleShopeeProductsSync,
  'shopee/products/item-preview': handleShopeeItemPreview,
  'products/shopee-item-preview': handleShopeeItemPreview,
  // Tìm SP nhập hàng — local trên Vercel (tránh cPanel cũ 404 / HTML → FE fallback local).
  'products/search': handleProductsSearch,
  // cPanel cũ trả 404 cho route bulk quét — xử lý local trên Vercel.
  'orders/scan-bulk-update': handleScanBulkUpdate,
  'orders/confirm-return-received': handleConfirmReturnReceived,
  'scan/save': handleScanSave,
  'scan/don-hoan-huy': handleScanDonHoanHuy,
  'orders/scan-bg-enqueue': handleScanBgEnqueue,
  'orders/scan-bg-status': handleScanBgStatus,
  'orders/scan-bg-ack': handleScanBgAck,
  'orders/hand-over-carrier': handleHandOverCarrier,
  'orders/hand-over-carrier/bulk': handleHandOverCarrier,
  'orders/cleanup-handed-over': handleCleanupHandedOver,
  'orders/cleanup-shipped': handleCleanupShipped,
  'cleanup-shipped': handleCleanupShipped,
  'orders/cleanup-processed-pickup': handleCleanupProcessedPickup,
  // cPanel cũ chưa có route — hydrate tracking Mongo → PATCH orders trên cPanel.
  'orders/hydrate-tracking': handleHydrateTracking,
};

export default async function handler(req, res) {
  const route = resolveRoutePath(req);

  if (!route || route === 'proxy' || route === 'index') {
    return res.status(404).json({ success: false, error: 'Not found' });
  }

  // PDF vận đơn: /api?path=labels/xxx.pdf | prints/xxx.pdf | public/labels/xxx.pdf
  if (
    route === 'labels' ||
    route.startsWith('labels/') ||
    route === 'prints' ||
    route.startsWith('prints/') ||
    route === 'public/labels' ||
    route.startsWith('public/labels/')
  ) {
    return handleLabelProxy(
      req,
      res,
      route.replace(/^(?:public\/)?(?:labels|prints)\/?/, ''),
    );
  }

  // Dynamic: POST /api/orders/:id/hand-over-carrier
  // bulk: orders/hand-over-carrier/bulk đã map LOCAL_ROUTES; tránh bắt nhầm :id=hand-over-carrier
  const handOverMatch = route.match(/^orders\/([^/]+)\/hand-over-carrier$/);
  if (handOverMatch && handOverMatch[1] !== 'hand-over-carrier') {
    return handleHandOverCarrier(req, res, decodeURIComponent(handOverMatch[1]));
  }
  if (route === 'orders/hand-over-carrier/bulk') {
    return handleHandOverCarrier(req, res, 'bulk');
  }

  const confirmReturnMatch = route.match(/^orders\/([^/]+)\/confirm-return-received$/);
  if (confirmReturnMatch) {
    return handleConfirmReturnReceived(req, res, decodeURIComponent(confirmReturnMatch[1]));
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
