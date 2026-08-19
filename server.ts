import express from "express";
import path from "path";
import fs from "fs";
import crypto from "crypto";
import dotenv from "dotenv";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { PDFDocument } from "pdf-lib";
import { scheduleAutoIncrementalOrdersSync, scheduleHandedOverStatusReconcile, scheduleShopeeReturnRequestsSync, scheduleReadyToShipBackfill, scheduleLabelPdfCleanup } from "./cron/index.js";
import {
  initOrderSyncService,
  registerLabelPdfDownloader,
  enqueueLabelPdfDownload,
} from "./services/orderSync/index.js";
import { createShopeeWebhookRouter } from "./src/webhooks/shopeeWebhookHandler.ts";
import { enrichOrdersFromCatalog } from "./src/utils/orderItemVariation.ts";
import { inferShippingCarrierLabel } from "./src/utils/shippingCarrier.ts";
import {
  advanceShopeeOrderListCursor,
  extractShopeeOrderListRows,
  parseShopeeOrderListPagination,
} from "./src/utils/shopeeOrderListPagination.ts";
import {
  classifyShopeeCancelReturnKind,
  isUnshippedShopeeCancel,
  resolveShopeeSubStatus,
  shouldApplyShopeeReturnOverlay,
  stripCancelledReturnOnDelivered,
} from "./src/utils/shopeeCancelReturnClassify.ts";
import {
  ORDER_LOCAL_STATUS,
  applyHandedOverWrite,
  buildClearHandedOverPatch,
  buildHandedOverWritePatch,
  buildDefaultInternalFlagsPatch,
  matchesHandedOverCarrierTab,
  hasLeftHandedOverCarrierTab,
  resolveOrderLocalStatus as resolveOrderLocalStatusShared,
  isOrderHandedOverToCarrier as isOrderHandedOverShared,
  HANDED_OVER_SOURCE,
} from "./src/utils/orderWarehouseStatus.ts";
import {
  isEligibleForHandOverToCarrier as isEligibleForHandOverShared,
  matchesProcessedPickupTab as matchesProcessedPickupTabShared,
  matchesUnprocessedPickupTab as matchesUnprocessedPickupTabShared,
  matchesShippingTab as matchesShippingTabShared,
  getHandOverIneligibleReason as getHandOverIneligibleReasonShared,
  hasOrderTrackingNo as hasOrderTrackingNoShared,
} from "./src/utils/orderHandover.ts";
import {
  getCachedShopeeAddressList,
  setCachedShopeeAddressList,
} from "./src/services/redis.ts";
import scanRoutesImport from "./routes/scanRoutes.js";
import authRoutesImport from "./routes/authRoutes.js";
import healthRoutesImport from "./routes/healthRoutes.js";
import vietnamAddressRoutesImport from "./routes/vietnamAddressRoutes.js";
import suppliersRoutesImport from "./routes/suppliersRoutes.js";
import expensesRoutesImport from "./routes/expensesRoutes.js";
import importsRoutesImport from "./routes/importsRoutes.js";
import settingsRoutesImport from "./routes/settingsRoutes.js";
import aiRoutesImport from "./routes/aiRoutes.js";
import dashboardRoutesImport from "./routes/dashboardRoutes.js";
import errorHandler from "./middlewares/errorHandler.js";
import { authMiddleware } from "./middlewares/auth.js";
import corsMiddleware from "./middlewares/cors.js";
import dbReadyMiddleware from "./middlewares/dbReady.js";
import { saveScanOrders, listDonHoanHuy, initScanController } from "./controllers/scanController.js";
import {
  enqueueScanBg,
  getScanBgStatus,
  ackScanBg,
} from "./controllers/scanBgController.js";
import {
  initScanBulkController,
  scanBulkUpdate,
} from "./controllers/scanBulkController.js";
import { initScanBgQueue } from "./services/scanBgQueue.js";
import { login, verifyAuth } from "./controllers/authController.js";
import {
  initHealthController,
  getHealth,
  getPublicConfig,
  postClientLog,
  getClientLog,
} from "./controllers/healthController.js";
import {
  getProvinces,
  getDistricts,
  getWards,
} from "./controllers/vietnamAddressController.js";
import {
  listSuppliers,
  createSupplier,
  updateSupplier,
  deleteSupplier,
  clearAllSuppliers,
} from "./controllers/suppliersController.js";
import {
  listExpenses,
  createExpense,
  deleteExpense,
  clearAllExpenses,
} from "./controllers/expensesController.js";
import {
  initImportsController,
  listImports,
  getImportHistory,
  getImportProductContext,
  createImport,
  clearAllImports,
  saveImports,
} from "./controllers/importsController.js";
import {
  initSettingsController,
  getChannelSettings,
  putChannelSettings,
  getGeminiStatus,
  updateGeminiKey,
  testGeminiKey,
  postShopConnectionStatus,
} from "./controllers/settingsController.js";
import {
  geminiOptimize,
  parseAddress,
  generateDescription,
  ensureGeminiClientFromEnv,
} from "./controllers/aiController.js";
import {
  initDashboardController,
  getDashboard,
} from "./controllers/dashboardController.js";
import productsRoutesImport from "./routes/productsRoutes.js";
import mappingRoutesImport from "./routes/mappingRoutes.js";
import ordersRoutesImport from "./routes/ordersRoutes.js";
import shopeeAuthRoutesImport from "./routes/shopeeAuthRoutes.js";
import shopeeOrdersRoutesImport from "./routes/shopeeOrdersRoutes.js";
import shopeeProductsRoutesImport from "./routes/shopeeProductsRoutes.js";
import shopeeShipRoutesImport from "./routes/shopeeShipRoutes.js";
import shopeePrintRoutesImport from "./routes/shopeePrintRoutes.js";
import inventoryRoutesImport from "./routes/inventoryRoutes.js";
import autoLinkRoutesImport from "./routes/autoLinkRoutes.js";
import apiSystemRoutesImport from "./routes/apiSystemRoutes.js";
import labelsRoutesImport, { initLabelsRoutes } from "./routes/labelsRoutes.js";
import {
  initOrdersService,
  loadOrders,
  saveOrders,
  loadOrdersForApi,
  loadOrdersForShipScoped,
  persistOrdersToDatabase,
  persistChangedOrdersPatch,
  queueOrdersJsonMirror,
  queueOrdersJsonMirrorFromMongo,
  hydrateTrackingFromMongoToJson,
  mirrorTrackingFieldsForRead,
  rebuildOrderLookupIndex,
  getOrderLookupIndex,
  normalizeOrderIndexKey,
  findOrderRecord,
  resolveOrdersFromRequest,
  findOrderByScanLookup,
  handOverOrderToCarrierByIndex,
  purgeHandedOverGarbageOrdersOnce,
  purgeClosedOrdersByRetention,
  archiveStaleReceivedCancelReturnOrders,
} from "./services/orders.js";
import {
  initOrdersController,
  invalidateOrdersRefreshCache,
  refreshOrders,
  queryOrders,
  getOrderCounts,
  getOrderEvents,
  getSyncJobById,
  listOrders,
  cleanupHandedOver,
  cleanupShipped,
  getCleanupShippedStatus,
  recalculateOrderCounts,
  cleanupClosedRetention,
  cleanupMongoTemp,
  ensureMongoTtl,
  cleanupLabelPdfs,
  cleanupProcessedPickup,
  lookupOrder,
  cleanupMockOrders,
  hydrateTracking,
  enrichTracking,
  triggerFixStuckOrders as triggerFixStuckOrdersRoute,
  patchOrder,
  deleteOrder,
  handOverCarrierById,
  handOverCarrierByCode,
  handOverCarrierBulk,
  healHandedOver,
  createManualOrder,
  resetPrintStatus,
  updatePrintStatus,
  markPrinted,
} from "./controllers/ordersController.js";
import {
  initStockSyncQueue,
  resolveProductWithShopeeMapping,
} from "./services/stockSyncQueue.js";
import {
  initProductsController,
  listProducts,
  searchProducts,
  handleProductSyncShopee,
  createProduct,
  getLocalInventory,
  refreshLocalInventory,
  replaceProducts,
  patchProduct,
  inventoryBalance,
  syncStock,
  bulkSaveProducts,
  deleteProduct,
  clearAllProducts,
  handleInventoryClearAll,
  bulkUpdateProducts,
  bulkChannelSync,
} from "./controllers/productsController.js";
import {
  initMappingController,
  handleMappingProductsGet,
  handleMappingProductsUpsert,
  handleMappingProductsHeal,
  handleBatchAutoLink,
  handleSingleAutoLink,
  handleBulkAutoLinkByIds,
  handleMappingSkuIndex,
  handleMappingPurgeBroken,
} from "./controllers/mappingController.js";
import {
  extractHttpClientError,
  sendApiErrorJson,
  sendStrictApiErrorJson,
} from "./utils/apiError.js";
import {
  sleep,
  delay,
  yieldEventLoop,
  mapWithConcurrency,
  runInBatches,
  withOperationTimeout,
} from "./utils/concurrency.js";
import { tryAcquireHeavyJob, releaseHeavyJob, resetHeavyJob } from "./utils/heavyJob.js";
import {
  initShopeeAuth,
  bootShopeeAuth,
  ensureDataDirs,
  saveOAuthAudit,
  loadLastOAuthAudit,
  loadShopeeTokens,
  saveShopeeTokens,
  normalizeShopIdKey,
  normalizeTokenStore,
  shouldOAuthRedirectToFrontend,
  buildOAuthFrontendRedirectUrl,
  completeShopeeOAuthFlow,
  buildShopeeAuthPartnerUrl,
  saveShopeeTokenForShop,
  listShopeeOAuthShopIds,
  listShopeeSyncShopIds,
  listAuthorizedShopeeShopIds,
  resolveShopeeShopIdsForSync,
  getAccessTokenForShop,
  ensureShopeeLinkedShopTokenKeys,
  propagateShopeeTokenToLinkedShops,
  shopeeSign,
  ShopeeRefreshTokenExpiredError,
  isShopeeInvalidTokenError,
  isShopeeConfigValid,
  getShopeeAccessTokenForApi,
  verifyShopeeShopToken,
  resolveShopeeApiShopId,
  getValidShopeeAccessToken,
  withShopeeAccessTokenRetry,
  refreshShopeeAccessTokenLocked,
  resolveShopeeTokenShopId,
  getShopeeUnauthorizedShopMessage,
  describeShopeeTokenFailure,
  getShopeeTokenRecord,
  resolveShopeeTokenConnectionStatus,
  SHOPEE_CALLBACK_URL,
  SHOPEE_WEBHOOK_URL,
  SHOPEE_CALLBACK_IDLE_MSG,
  SHOPEE_ENV,
  SHOPEE_HOST,
  SHOPEE_PARTNER_ID,
  SHOPEE_PARTNER_KEY,
  SHOPEE_TOKENS_PATH,
  SHOPEE_REAUTH_REQUIRED_MESSAGE,
} from "./services/shopee/auth.js";
import {
  fetchWithTimeout,
  shopeeFetchJsonWithRetry,
  shopeePostJsonWithRetry,
  runInShopeeBatches,
  shopeeSyncDelay,
  shopeeApiErrorResult,
  formatShopeeApiError,
  humanizeShopeeErrorMessage,
  isShopeeRateLimited,
  snapshotShopeeRetryTelemetry,
  diffShopeeRetryTelemetry,
  shopeeExponentialBackoffMs,
  SHOPEE_API_MAX_RETRY,
  SHOPEE_HTTP_TIMEOUT_MS,
  SHOPEE_TLS_MIN_VERSION,
  SHOPEE_TLS_MAX_VERSION,
} from "./services/shopee/client.js";
import {
  parseShopeeJson,
  toShopeeId,
  toShopeeIdNumber,
  isValidShopeeId,
  stringifyShopeeIdsDeep,
  toShopeeSn,
  extractReturnRequestCode,
  normalizeShopeeReturnDetail,
} from "./services/shopee/jsonBig.js";
import { shopeeAxiosGet, shopeeAxiosPost } from "./services/shopee/axiosClient.js";
import {
  getOrSyncShopeeCategories,
  isShopeeInvalidCategoryError,
  SHOPEE_INVALID_CATEGORY_CODE,
  SHOPEE_INVALID_CATEGORY_USER_MSG,
  toShopeeCategoryIdInt,
  validateShopeeLeafCategoryId,
} from "./services/shopee/categories.js";
import {
  initShopeeAuthController,
  oauthComplete,
  oauthCallback,
  webhookProbe,
  listOauthShops,
  getAuthUrl,
} from "./controllers/shopeeAuthController.js";
import {
  initShopeeOrdersController,
  pullOrders,
  syncOrders,
  quickSyncOrders,
  syncShopee,
  getDiagnostics,
  debugReturnByOrder,
  syncFromShop,
} from "./controllers/shopeeOrdersController.js";
import {
  initWooCommerceOrdersController,
  syncWooCommerceOrders,
  testWooCommerceConnectionHandler,
  updateWooCommerceOrderStatus,
} from "./controllers/wooCommerceOrdersController.js";
import {
  publishProductToWooCommerce,
  updateWooProductStockPrice,
  resolveWooCredentials,
} from "./services/wooCommerce.js";
import {
  initShopeeProductsController,
  syncProducts,
  syncItemVariants,
  previewItemVariants,
} from "./controllers/shopeeProductsController.js";
import {
  initShopeeShipController,
  shipOrder,
  shipOrderBulk,
  shipOrderBulkAsync,
  getShipOrderJob,
  getShipOrderJobs,
  fastProcessOrders,
} from "./controllers/shopeeShipController.js";
import {
  initShopeePrintController,
  printDocument,
  printDocumentAsync,
  getPrintDocumentJob,
  getPrintDocumentJobs,
} from "./controllers/shopeePrintController.js";
import {
  initShopeeWebhookController,
  processShopeeWebhookPayload,
} from "./controllers/shopeeWebhookController.js";

import { PDF_DIR, resolveAppRoot, resolveAppBaseUrl } from "./utils/appPaths.js";
/** ESM/CJS interop — luôn lấy Router thật (tránh default double-wrap). */
function asRouter(mod: any) {
  if (mod && typeof mod.use === "function") return mod;
  if (mod?.default && typeof mod.default.use === "function") return mod.default;
  if (mod?.router && typeof mod.router.use === "function") return mod.router;
  if (mod?.default?.default && typeof mod.default.default.use === "function") {
    return mod.default.default;
  }
  return mod;
}
const scanRoutes = asRouter(scanRoutesImport);
const authRoutes = asRouter(authRoutesImport);
const healthRoutes = asRouter(healthRoutesImport);
const vietnamAddressRoutes = asRouter(vietnamAddressRoutesImport);
const suppliersRoutes = asRouter(suppliersRoutesImport);
const expensesRoutes = asRouter(expensesRoutesImport);
const importsRoutes = asRouter(importsRoutesImport);
const settingsRoutes = asRouter(settingsRoutesImport);
const aiRoutes = asRouter(aiRoutesImport);
const dashboardRoutes = asRouter(dashboardRoutesImport);
const productsRoutes = asRouter(productsRoutesImport);
const mappingRoutes = asRouter(mappingRoutesImport);
const ordersRoutes = asRouter(ordersRoutesImport);
const shopeeAuthRoutes = asRouter(shopeeAuthRoutesImport);
const shopeeOrdersRoutes = asRouter(shopeeOrdersRoutesImport);
const shopeeProductsRoutes = asRouter(shopeeProductsRoutesImport);
const shopeeShipRoutes = asRouter(shopeeShipRoutesImport);
const shopeePrintRoutes = asRouter(shopeePrintRoutesImport);
const inventoryRoutes = asRouter(inventoryRoutesImport);
const autoLinkRoutes = asRouter(autoLinkRoutesImport);
const apiSystemRoutes = asRouter(apiSystemRoutesImport);
const labelsRoutes = asRouter(labelsRoutesImport);
import {
  initMongo,
  loadProductsFromStore,
  loadProductsPageFromStore,
  loadProductByIdFromStore,
  loadProductsByIdsFromStore,
  searchProductsFromStore,
  applyImportStockAndPriceToStore,
  applyImportStockAndPriceToMainWarehouse,
  saveProductsToStoreAsync,
  upsertProductsToStoreAsync,
  deleteProductsByIdsFromStore,
  loadChannelListingsFromStore,
  saveChannelListingsToStoreAsync,
  upsertChannelListingToStore,
  bulkUpsertChannelListingsToStore,
  buildLocalInventoryCacheFromStore,
  countProducts,
  countChannelListings,
  seedStoreFromArrays,
  flushDbWrites,
  reloadCachesFromDb,
  isMongoReady,
  getMongoUriMasked,
  isProductsDiskMode,
  getProductsDiskPath,
  setProductsDiskAppRoot,
  inheritShopeeLinkFromParent,
  bulkUpsertOrdersToStore,
  bulkUpdateShippedOrdersBySn,
  markOrderHandedOverInStore,
  markOrderLocalStatusInStore,
  markOrdersPrintedInStore,
  markOrdersHasPdfInStore,
  updateOrderPendingShopeeCheckInStore,
  updateOrderTrackingInStore,
  updateReturnTrackingOnlyInStore,
  clearCancelledDeliveredReturnInStore,
  updateOrderPackageNumberInStore,
  forceUpdateOrderShopIdInStore,
  forceUpdateOrderShopIdByCodeInStore,
  deleteOrdersFromStore,
  deleteHandedOverOrdersFromStore,
  clearHandedOverFlagsForShippedOrders,
  markOrdersCancelledAsShopeeNotFoundInStore,
  findWrongShopCancelledCandidatesFromStore,
  findCancelledEmptyItemsFromStore,
  patchOrderItemsOnlyInStore,
  loadAllHandedOverShopeeOrdersFromStore,
  loadStuckShippedOrderKeysFromStore,
  bulkHealTerminalStatusesFromShopee,
  recalculateOrderTabCountsFromStore,
  deleteClosedOrdersByRetention,
  loadOrdersFromStore,
  findOrderByScanCodeInStore,
  findOrdersByScanCodesInStore,
  loadShopeeTrackingEnrichCandidatesFromStore,
  loadGhnBackfillCandidatesFromStore,
  bulkSetTrackingNumbersInStore,
  loadCancelReturnMissingTrackingFromStore,
  loadReturnTrackingPendingFromStore,
  loadMissingReturnTrackingBackfillFromStore,
  queryOrdersPageFromStore,
  orderTabFilter,
  reclassifyCancelReturnsInStore,
  createSyncJob,
  finishSyncJob,
  getSyncJob,
  loadOrderEvents,
  purgeMongoTempCollections,
  ensureRetentionTtlIndexes,
  upsertDonHoanHuy,
  upsertDonHoanHuyBatch,
  markOrdersScanFlagsBatch,
  loadDonHoanHuyAsOrders,
  mergeDonHoanHuyIntoOrders,
  existsDonHoanHuy,
  existsDonHoanHuyMany,
  describeMongoWriteError,
  isMongoConnectionError,
  recoverMongoConnection,
  mirrorTopLevelTrackingIntoData,
  getDashboardStatsFromStore,
  getLowStockProductsFromStore,
  type LocalInventoryCache,
} from "./src/db/mongoStore.ts";
import { pushReturnAlert } from "./services/returnAlertQueue.js";
import {
  getReturnAlerts,
  ackReturnAlertsApi,
} from "./controllers/returnAlertController.js";

/** Hard Crash Catcher — ghi file để xem trên cPanel khi Passenger kill process. */
function writeCpanelCrashLog(kind: string, err: unknown): void {
  try {
    const stack =
      err instanceof Error
        ? err.stack || err.message
        : typeof err === "string"
          ? err
          : JSON.stringify(err);
    const line = `${kind}: ${stack}\n---\n${new Date().toISOString()}\n`;
    const targets = [
      path.join(process.cwd(), "cpanel_error_log.txt"),
      typeof __dirname !== "undefined" ? path.join(__dirname, "cpanel_error_log.txt") : "",
    ].filter(Boolean);
    for (const file of targets) {
      try {
        fs.writeFileSync(file, line);
      } catch {
        /* ignore */
      }
    }
    console.error(line);
  } catch {
    /* ignore */
  }
}
process.on("uncaughtException", (err) => {
  try {
    console.error("[Background Sync Error]:", err instanceof Error ? err.message : String(err));
    writeCpanelCrashLog("Exception", err);
  } catch {
    /* never rethrow */
  }
});
process.on("unhandledRejection", (err) => {
  try {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[Background Sync Error]:", msg);
    writeCpanelCrashLog("Rejection", err);
  } catch {
    /* never rethrow — Unhandled Rejection không được làm sập process */
  }
});

const APP_ROOT = resolveAppRoot();
const isCpanelPassengerRuntime = Boolean(
  String(
    process.env.PASSENGER_APP_ROOT ||
      process.env.PASSENGER_APP_ENV ||
      process.env.CPANEL_APP_NAME ||
      process.env.CPANEL_RUNTIME ||
      "",
  ).trim(),
);
const isDevelopmentRuntime = process.env.NODE_ENV !== "production" && !isCpanelPassengerRuntime;

if (isCpanelPassengerRuntime) {
  console.log(`[Boot] runtime=cpanel-production pid=${process.pid}; static dist only, dev middleware disabled.`);
}

// Load .env — ưu tiên APP_ROOT (cPanel/Passenger), rồi cwd, rồi mặc định dotenv.
const dotenvCandidates = [
  path.join(APP_ROOT, ".env"),
  path.join(process.cwd(), ".env"),
  path.resolve(".env"),
];
for (const envPath of dotenvCandidates) {
  if (fs.existsSync(envPath)) {
    const loaded = dotenv.config({ path: envPath });
    if (loaded.error) {
      console.error(`[Config] dotenv lỗi khi đọc ${envPath}:`, loaded.error.message);
    } else {
      console.log(`[Config] dotenv loaded: ${envPath}`);
    }
  }
}
dotenv.config(); // fallback: process.cwd()/.env nếu còn biến thiếu
console.log(
  `[Config] APP_ROOT=${APP_ROOT} cwd=${process.cwd()} | MONGODB_URI=${process.env.MONGODB_URI || process.env.MONGO_URL ? "set" : "MISSING"}`
);
setProductsDiskAppRoot(APP_ROOT);
initShopeeAuth({ syncOAuthShopsToChannelSettings, logOAuthSaveError });
bootShopeeAuth();
console.log(
  `[Products] storage=${isProductsDiskMode() ? "disk" : "mongo"} path=${getProductsDiskPath()}`,
);

/** Ghi crash log thêm vào APP_ROOT (cPanel app root). */
function writeCpanelCrashLogToAppRoot(kind: string, err: unknown): void {
  try {
    const stack =
      err instanceof Error
        ? err.stack || err.message
        : typeof err === "string"
          ? err
          : JSON.stringify(err);
    fs.writeFileSync(
      path.join(APP_ROOT, "cpanel_error_log.txt"),
      `${kind}: ${stack}\n---\n${new Date().toISOString()}\n`
    );
  } catch {
    /* ignore */
  }
}
process.on("uncaughtException", (err) => {
  try {
    console.error("[Background Sync Error]:", err instanceof Error ? err.message : String(err));
    writeCpanelCrashLogToAppRoot("Exception", err);
  } catch {
    /* never rethrow */
  }
});
process.on("unhandledRejection", (err) => {
  try {
    console.error("[Background Sync Error]:", err instanceof Error ? err.message : String(err));
    writeCpanelCrashLogToAppRoot("Rejection", err);
  } catch {
    /* never rethrow */
  }
});
/** Legacy /prints — chỉ dọn file rỗng cũ, KHÔNG còn dùng để lưu/phục vụ PDF. */
const WAYBILLS_DIR = path.join(APP_ROOT, "storage", "waybills");
const LEGACY_PUBLIC_PRINTS_DIR = path.join(APP_ROOT, "public", "prints");
const WAYBILL_FILE_RE = /\.(pdf|zip|html)$/i;

/**
 * PDF vận đơn: RAM + đĩa tại storage/labels/ (ổn định, writable).
 * URL chuẩn phục vụ FE: /api/public/labels/:filename — tuyệt đối KHÔNG dùng /prints/.
 */
/** Disk TTL 7 ngày; RAM TTL 60 phút (đủ cho phiên in). PDF không lưu Mongo. */
const LABEL_DISK_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const LABEL_RAM_TTL_MS = 60 * 60 * 1000;
const labelMemCache = new Map<string, { buf: Buffer; expires: number; contentType?: string }>();
const LABEL_MEM_MAX_ENTRIES = 48;
const LABEL_MEM_MAX_BYTES = 96 * 1024 * 1024;

function ensureLabelsDir(): void {
  try {
    if (!fs.existsSync(PDF_DIR)) fs.mkdirSync(PDF_DIR, { recursive: true });
  } catch (err) {
    console.error("[Labels] Không tạo được thư mục storage/labels:", err);
  }
}

function assertLabelsDirWritable(): void {
  ensureLabelsDir();
  const probe = path.join(PDF_DIR, `.write_probe_${process.pid}`);
  try {
    fs.writeFileSync(probe, "ok");
    fs.unlinkSync(probe);
  } catch (err) {
    console.error("[Labels] Không ghi được thư mục storage/labels:", err);
    throw err instanceof Error ? err : new Error(String(err));
  }
}

function safeLabelFilename(raw: string): string | null {
  const base = path.basename(String(raw || "").trim());
  if (!base || base.includes("..") || !/\.pdf$/i.test(base)) return null;
  return base;
}

function buildCachedLabelFilename(orderSns: string[]): string {
  const safe = orderSns
    .map((sn) => String(sn || "").replace(/[^a-zA-Z0-9_-]/g, ""))
    .filter(Boolean);
  if (safe.length <= 1) return `order_${safe[0] || "unknown"}.pdf`;
  const digest = crypto.createHash("sha1").update([...safe].sort().join("|")).digest("hex").slice(0, 12);
  return `orders_${safe.length}_${digest}.pdf`;
}

function getValidLabelDiskFile(filename: string): { safe: string; filePath: string; size: number } | null {
  const safe = safeLabelFilename(filename);
  if (!safe) return null;
  const filePath = path.join(PDF_DIR, safe);
  try {
    if (!fs.existsSync(filePath)) return null;
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size <= 0) return null;
    const fd = fs.openSync(filePath, "r");
    try {
      const magic = Buffer.allocUnsafe(4);
      if (fs.readSync(fd, magic, 0, 4, 0) !== 4 || magic.toString() !== "%PDF") return null;
    } finally {
      fs.closeSync(fd);
    }
    return { safe, filePath, size: stat.size };
  } catch {
    return null;
  }
}

async function getValidLabelDiskFileAsync(
  filename: string,
): Promise<{ safe: string; filePath: string; size: number } | null> {
  const safe = safeLabelFilename(filename);
  if (!safe) return null;
  const filePath = path.join(PDF_DIR, safe);
  let handle: fs.promises.FileHandle | undefined;
  try {
    const stat = await fs.promises.stat(filePath);
    if (!stat.isFile() || stat.size <= 0) return null;
    handle = await fs.promises.open(filePath, "r");
    const magic = Buffer.allocUnsafe(4);
    const { bytesRead } = await handle.read(magic, 0, 4, 0);
    if (bytesRead !== 4 || magic.toString() !== "%PDF") return null;
    return { safe, filePath, size: stat.size };
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
}

function isPdfBuffer(buffer: Buffer, contentType?: string): boolean {
  if (!buffer || buffer.length < 5) return false;
  if (buffer.subarray(0, 4).toString() === "%PDF") return true;
  // Chỉ tin contentType khi buffer đã có magic PDF — tránh chấp nhận JSON/HTML.
  return false;
}

function getLabelMemTotalBytes(): number {
  let total = 0;
  for (const val of labelMemCache.values()) total += val.buf.length;
  return total;
}

function evictLabelMemIfNeeded(): void {
  while (
    labelMemCache.size > 0 &&
    (labelMemCache.size >= LABEL_MEM_MAX_ENTRIES || getLabelMemTotalBytes() >= LABEL_MEM_MAX_BYTES)
  ) {
    let oldestKey: string | null = null;
    let oldestExp = Infinity;
    for (const [key, val] of labelMemCache) {
      if (val.expires < oldestExp) {
        oldestExp = val.expires;
        oldestKey = key;
      }
    }
    if (!oldestKey) break;
    labelMemCache.delete(oldestKey);
    console.log(
      `[Labels] Evict RAM ${oldestKey} (entries=${labelMemCache.size}, bytes≈${getLabelMemTotalBytes()})`,
    );
  }
}

/** Xóa file PDF cũ của cùng mã đơn trước khi ghi file mới. */
function removeExistingLabelFilesForOrderSns(orderSns: string[]): number {
  ensureLabelsDir();
  const sns = [...new Set(orderSns.map((s) => String(s || "").replace(/[^a-zA-Z0-9_-]/g, "")).filter(Boolean))];
  if (sns.length === 0) return 0;
  let deleted = 0;
  try {
    for (const name of fs.readdirSync(PDF_DIR)) {
      if (!/\.pdf$/i.test(name)) continue;
      const hit = sns.some(
        (sn) =>
          name === `${sn}.pdf` ||
          name === `order_${sn}.pdf` ||
          name.startsWith(`${sn}_`) ||
          name.startsWith(`order_${sn}_`),
      );
      if (!hit) continue;
      try {
        fs.unlinkSync(path.join(PDF_DIR, name));
        labelMemCache.delete(name);
        deleted += 1;
      } catch {
        /* ignore per-file */
      }
    }
  } catch (err) {
    console.warn("[Labels] Không quét được thư mục để ghi đè:", err);
  }
  return deleted;
}

/**
 * Lưu PDF vào RAM trước (phục vụ FE ngay), ghi đĩa nền — tránh chặn I/O cPanel.
 * Từ chối buffer rỗng / không phải PDF.
 */
function putLabelMem(filename: string, buffer: Buffer, contentType?: string): string {
  const safe = safeLabelFilename(filename);
  if (!safe) throw new Error(`Tên file vận đơn không hợp lệ: ${filename}`);
  console.log(`[Labels] Bắt đầu lưu PDF: ${safe}, size=${buffer?.length || 0}, type=${contentType || ""}`);
  if (!buffer || !Buffer.isBuffer(buffer) || buffer.length === 0) {
    console.error(`[Labels] TỪ CHỐI ghi file rỗng: ${filename}, type=${contentType || ""}`);
    throw new Error("Buffer PDF rỗng — không ghi file và không trả URL.");
  }
  if (buffer.length < 64) {
    console.error(
      `[Labels] Buffer quá nhỏ (${buffer.length} bytes), head=${buffer.subarray(0, Math.min(20, buffer.length)).toString("hex")}`,
    );
    throw new Error(`Buffer PDF không hợp lệ (chỉ ${buffer.length} bytes).`);
  }
  if (!isPdfBuffer(buffer, contentType)) {
    console.error(
      `[Labels] Không phải PDF: ${filename}, size=${buffer.length}, head=${buffer.subarray(0, 20).toString("hex")}`,
    );
    throw new Error("Dữ liệu vận đơn từ Shopee không phải PDF hợp lệ.");
  }

  try {
    evictLabelMemIfNeeded();

    const snMatch =
      safe.match(/^order_([A-Za-z0-9_-]+?)(?:_gop_\d+)?(?:_\d+)?\.pdf$/i) ||
      safe.match(/^([A-Za-z0-9_-]+?)(?:_gop_\d+_don)?\.pdf$/i);
    if (snMatch?.[1]) removeExistingLabelFilesForOrderSns([snMatch[1]]);

    // RAM first — FE lấy /api/public/labels từ cache ngay, không chờ disk.
    labelMemCache.set(safe, {
      buf: buffer,
      expires: Date.now() + LABEL_RAM_TTL_MS,
      contentType: "application/pdf",
    });

    const dest = path.join(PDF_DIR, safe);
    console.log(`[Labels] Đường dẫn lưu file dự kiến: ${dest}`);
    setImmediate(() => {
      ensureLabelsDir();
      void fs.promises
        .writeFile(dest, buffer)
        .then(() => {
          console.log(`[Labels] Kết quả: OK — Disk ${safe} (${buffer.length} bytes) → ${dest}`);
        })
        .catch((err: any) => {
          console.warn(`[Labels] Ghi đĩa nền thất bại ${safe}:`, err?.message || err);
        });
    });

    console.log(`[Labels] Kết quả: OK — RAM ${safe} (${buffer.length} bytes)`);
    return safe;
  } catch (err: any) {
    console.error(`[Labels] Kết quả: Lỗi — ${err?.message || err}`);
    throw err;
  }
}

function getLabelMem(filename: string): { buf: Buffer; contentType?: string } | null {
  const safe = safeLabelFilename(filename);
  if (!safe) return null;

  const ram = labelMemCache.get(safe);
  if (ram) {
    if (ram.expires < Date.now() || !ram.buf?.length || !isPdfBuffer(ram.buf)) {
      labelMemCache.delete(safe);
    } else {
      return { buf: ram.buf, contentType: ram.contentType || "application/pdf" };
    }
  }

  const filePath = path.join(PDF_DIR, safe);
  try {
    if (!fs.existsSync(filePath)) return null;
    const st = fs.statSync(filePath);
    if (!st.isFile() || st.size <= 0) {
      console.warn(`[Labels] Bỏ qua file rỗng trên đĩa: ${filePath}`);
      try {
        fs.unlinkSync(filePath);
      } catch {
        /* ignore */
      }
      return null;
    }
    const buf = fs.readFileSync(filePath);
    if (!buf.length || !isPdfBuffer(buf)) return null;
    labelMemCache.set(safe, {
      buf,
      expires: Date.now() + LABEL_RAM_TTL_MS,
      contentType: "application/pdf",
    });
    return { buf, contentType: "application/pdf" };
  } catch (err: any) {
    console.warn(`[Labels] Đọc đĩa lỗi ${safe}:`, err?.message || err);
    return null;
  }
}

function hasLabelMem(filename: string): boolean {
  if (getValidLabelDiskFile(filename)) return true;
  const safe = safeLabelFilename(filename);
  const ram = safe ? labelMemCache.get(safe) : null;
  return Boolean(ram && ram.expires >= Date.now() && ram.buf.length > 0 && isPdfBuffer(ram.buf));
}

/** Xác minh file sẵn sàng trước khi trả URL cho FE — tuyệt đối không trả URL file rỗng. */
function assertLabelFileReady(filename: string): { safe: string; size: number } {
  const safe = safeLabelFilename(filename);
  if (!safe) throw new Error(`Tên file vận đơn không hợp lệ: ${filename}`);
  const disk = getValidLabelDiskFile(safe);
  if (disk) return { safe: disk.safe, size: disk.size };
  const hit = getLabelMem(safe);
  if (!hit || !hit.buf.length) {
    throw new Error(`File vận đơn không tồn tại hoặc rỗng: ${safe}`);
  }
  if (!isPdfBuffer(hit.buf)) {
    throw new Error(`File vận đơn không phải PDF hợp lệ: ${safe}`);
  }
  const diskPath = path.join(PDF_DIR, safe);
  if (fs.existsSync(diskPath)) {
    const st = fs.statSync(diskPath);
    if (st.size <= 0) {
      throw new Error(`File vận đơn trên đĩa rỗng (0 bytes): ${diskPath}`);
    }
  }
  return { safe, size: hit.buf.length };
}

/** Dọn PDF trong storage/labels/ > 7 ngày + RAM hết hạn. (PDF không lưu MongoDB.) */
function cleanupExpiredLabelFiles(): number {
  let deleted = 0;
  const now = Date.now();
  for (const [key, val] of labelMemCache) {
    if (val.expires < now) {
      labelMemCache.delete(key);
      deleted += 1;
    }
  }
  try {
    ensureLabelsDir();
    const cutoff = now - LABEL_DISK_TTL_MS;
    for (const name of fs.readdirSync(PDF_DIR)) {
      if (!WAYBILL_FILE_RE.test(name)) continue;
      const full = path.join(PDF_DIR, name);
      try {
        const st = fs.statSync(full);
        if (st.size <= 0 || st.mtimeMs < cutoff) {
          fs.unlinkSync(full);
          labelMemCache.delete(name);
          deleted += 1;
        }
      } catch {
        /* ignore per-file */
      }
    }
  } catch (err) {
    console.warn("[Labels Cleanup] lỗi quét thư mục:", err);
  }
  if (deleted > 0) {
    console.log(`[Labels Cleanup] Đã xóa ${deleted} mục hết hạn/rỗng.`);
  }
  return deleted;
}

/** Alias tương thích. */
function purgeExpiredLabelMem(): number {
  return cleanupExpiredLabelFiles();
}
function cleanupExpiredPrintFiles(): number {
  return cleanupExpiredLabelFiles();
}
function ensurePrintsDir(): void {
  ensureLabelsDir();
}

/** Xóa file rỗng / PDF cũ trong public/prints (legacy — tránh Apache phục vụ 0 bytes). */
function wipeLegacyPublicPrints(): number {
  let deleted = 0;
  for (const dir of [LEGACY_PUBLIC_PRINTS_DIR, WAYBILLS_DIR]) {
    try {
      if (!fs.existsSync(dir)) continue;
      for (const name of fs.readdirSync(dir)) {
        if (!WAYBILL_FILE_RE.test(name)) continue;
        try {
          fs.unlinkSync(path.join(dir, name));
          deleted += 1;
        } catch {
          /* ignore */
        }
      }
    } catch (err) {
      console.warn(`[Labels] Không dọn được legacy ${dir}:`, err);
    }
  }
  if (deleted > 0) {
    console.log(`[Labels] Đã xóa ${deleted} file legacy (public/prints|storage/waybills).`);
  }
  return deleted;
}

// Boot: tạo storage/labels + dọn legacy /prints. Dọn PDF_DIR định kỳ do scheduleLabelPdfCleanup (cron 7 ngày).
try {
  assertLabelsDirWritable();
  console.log(`[Labels] PDF_DIR=${PDF_DIR} (writable OK)`);
} catch (err) {
  console.error("[Labels] BOOT: storage/labels không ghi được — in đơn sẽ thất bại:", err);
}
wipeLegacyPublicPrints();

type ServeLabelPdfResult = "sent" | "not_found" | "invalid";

function serveLabelPdfFromMem(filename: string, res: any): ServeLabelPdfResult {
  try {
    const safe = safeLabelFilename(decodeURIComponent(String(filename || "")));
    if (!safe) {
      res.status(400).type("text/plain").send("Tên file vận đơn không hợp lệ.");
      return "invalid";
    }
    const disk = getValidLabelDiskFile(safe);
    if (disk) {
      res.status(200);
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `inline; filename="${safe}"`);
      res.setHeader("Content-Length", String(disk.size));
      res.setHeader("Cache-Control", "private, max-age=300");
      res.setHeader("X-Content-Type-Options", "nosniff");
      const stream = fs.createReadStream(disk.filePath);
      stream.on("error", (err) => {
        console.error(`[Labels] Stream disk lỗi ${safe}:`, err);
        if (!res.headersSent) res.status(500).end();
        else res.destroy(err);
      });
      stream.pipe(res);
      console.log(`[Labels] Streamed PDF ${safe} (${disk.size} bytes)`);
      return "sent";
    }
    const hit = getLabelMem(safe);
    if (!hit || !hit.buf.length) {
      console.warn(`[Labels] 404 — không thấy file: ${safe} (dir=${PDF_DIR})`);
      return "not_found";
    }
    if (!isPdfBuffer(hit.buf, hit.contentType)) {
      console.error(
        `[Labels] Buffer không phải PDF hợp lệ: ${safe}, size=${hit.buf.length}, head=${hit.buf.subarray(0, 20).toString("hex")}`,
      );
      res.status(415).type("text/plain").send("File vận đơn không phải PDF hợp lệ.");
      return "invalid";
    }
    res.status(200);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="${safe}"`);
    res.setHeader("Content-Length", String(hit.buf.length));
    res.setHeader("Cache-Control", "private, max-age=300");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.end(hit.buf);
    console.log(`[Labels] Served PDF /api/public/labels/${safe} (${hit.buf.length} bytes)`);
    return "sent";
  } catch (err: any) {
    console.error(`[Labels] serveLabelPdf lỗi:`, err?.message || err);
    if (!res.headersSent) {
      res.status(500).type("text/plain").send("Lỗi đọc file vận đơn PDF.");
    }
    return "invalid";
  }
}

const APP_BASE_URL = resolveAppBaseUrl();

function resolveLabelsPublicBaseUrl(): string {
  const explicit = String(
    process.env.LABELS_BASE_URL || process.env.CPANEL_PUBLIC_URL || process.env.CPANEL_BACKEND_URL || "",
  ).trim();
  if (explicit) return explicit.replace(/\/$/, "");
  // Luôn trả về API backend (nơi Node lưu PDF) — không trả domain frontend Vercel/quanly SPA.
  return "https://api.linhkienamthanh.net";
}

/** Chuẩn hóa → absolute URL /api/public/labels/:file (không bao giờ /prints/). */
function absoluteLabelUrl(relativePath: string | null | undefined): string | null {
  if (!relativePath) return null;
  let fn = "";
  if (/^https?:\/\//i.test(relativePath)) {
    try {
      fn = decodeURIComponent(new URL(relativePath).pathname.split("/").pop() || "");
    } catch {
      return null;
    }
  } else {
    const p = relativePath.startsWith("/") ? relativePath : `/${relativePath}`;
    const fnMatch = p.match(/\/(?:api\/(?:public\/)?labels|labels|prints)\/([^/?#]+)$/i);
    fn = decodeURIComponent(fnMatch?.[1] || path.basename(p));
  }
  if (!safeLabelFilename(fn)) return null;
  // Chốt toàn vẹn trước khi công bố URL — không trả link file rỗng/404.
  try {
    assertLabelFileReady(fn);
  } catch (err: any) {
    console.error(`[Labels] absoluteLabelUrl TỪ CHỐI URL (file chưa sẵn sàng): ${fn} — ${err?.message || err}`);
    return null;
  }
  const url = `${resolveLabelsPublicBaseUrl()}/api/public/labels/${encodeURIComponent(fn)}`;
  console.log(`[Labels] URL trả về cho FE: ${url}`);
  return url;
}

// runShopeeConnectivityDiagnostics — services/shopee/diagnostics.js (Phase 6)

/** Chuẩn hóa timestamp Shopee API = GIÂY (10 chữ số). Nếu lỡ truyền ms (13 số) → chia 1000. */
function toShopeeUnixSeconds(raw: number | string | undefined | null, fallbackSec?: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    return fallbackSec != null ? fallbackSec : Math.floor(Date.now() / 1000);
  }
  // ms (≥ ~Sep 2001 in ms = 1e12) → seconds — tuyệt đối không gửi ms lên Shopee.
  if (n >= 1e12) return Math.floor(n / 1000);
  return Math.floor(n);
}

/** Full sync hủy/hoàn: 6 × 15 ngày = 90 ngày (Shopee max 15 ngày / request). */
const SHOPEE_CANCEL_RETURN_MAX_WINDOWS = 6;
/** Cửa sổ tối đa Shopee cho get_return_list. */
const SHOPEE_RETURN_LIST_WINDOW_SEC = 15 * 24 * 60 * 60;
/** Lookback riêng get_return_list — 90 ngày (không dùng 30 ngày của get_order_list). */
const SHOPEE_RETURN_LIST_LOOKBACK_SEC = 90 * 24 * 60 * 60;
/** Cứng: đơn thường lùi 30 ngày từ Date.now() — chặn kéo về năm 2000. */
const SHOPEE_HISTORY_LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000;
const SHOPEE_HISTORY_LOOKBACK_SEC = 30 * 24 * 60 * 60;
/** Ngân sách riêng cho đơn hủy/hoàn + returns — vét đến more=false. */
const SHOPEE_SYNC_MAX_CANCEL_RETURN_SNS = 10000;
/** get_return_list: page_size tối đa Shopee = 100; paginate đầy đủ. */
const SHOPEE_RETURN_LIST_PAGE_SIZE = 100;
const SHOPEE_RETURN_LIST_MAX_PAGES = 50;
/** Shopee v2 get_order_detail chấp nhận tối đa 50 order_sn cho mỗi request. */
const SHOPEE_ORDER_DETAIL_MAX_ORDER_SNS = 50;
/**
 * Batch kéo chi tiết: 20 đơn/mẻ (an toàn rate-limit, trong khoảng 10–20).
 * 1 request get_order_detail gom nhiều order_sn — không gọi tuần tự từng đơn.
 */
const ORDER_DETAIL_FETCH_BATCH_SIZE = 20;
/** Nghỉ giữa các mẻ get_order_detail — tránh Shopee 429. */
const ORDER_DETAIL_BATCH_DELAY_MS = 300;
/** Đồng bộ chunk outer = batch size (caller + fetchNormalize khớp nhau). */
const SHOPEE_SYNC_CHUNK_SIZE = ORDER_DETAIL_FETCH_BATCH_SIZE;
/** Nghỉ 1s giữa các lô — nhường GC / giải phóng process cPanel. */
const ORDER_SYNC_SAVE_DELAY_MS = 1000;
/** Nghỉ giữa mỗi lần get_tracking_number — tránh 429 (poll nhanh 300ms). */
const SHOPEE_TRACKING_FETCH_DELAY_MS = 300;
/** Nghỉ giữa mỗi lần gọi API Shopee khi in đơn hàng loạt — tránh rate-limit. */
const PRINT_API_DELAY_MS = 200;
/** Nghỉ giữa các chunk đơn hàng (đồng bộ nền) = delay mẻ detail. */
const SHOPEE_SYNC_CHUNK_DELAY_MS = ORDER_DETAIL_BATCH_DELAY_MS;
const SHOPEE_SYNC_BATCH_DELAY_MS = SHOPEE_SYNC_CHUNK_DELAY_MS;
const SHOPEE_ORDER_LIST_PAGE_DELAY_MS = 500;
/** get_order_list page_size — tối đa Shopee = 100. */
const SHOPEE_ORDER_LIST_PAGE_SIZE = 100;
/** Cầu chì cứng: tối đa 50 lần get_order_list / shop (CloudLinux nproc). */
const SHOPEE_ORDER_LIST_LOOP_SAFETY_CAP = 50;
/**
 * Incremental pull: lấy đơn có update_time trong N giây gần nhất.
 * Mặc định 14 ngày (an toàn, dưới trần 15 ngày của Shopee).
 * Shopee bắt buộc time_from/time_to là UNIX SECONDS (không phải ms).
 */
const SHOPEE_ORDER_LIST_INCREMENTAL_SEC = SHOPEE_HISTORY_LOOKBACK_SEC;
/** Sàn tối thiểu khi pull get_order_list — luôn ≥ 3 ngày. */
const SHOPEE_ORDER_LIST_MIN_LOOKBACK_SEC = 3 * 24 * 60 * 60;
/** Trần cửa sổ Shopee get_order_list = 15 ngày / 1 request. */
const SHOPEE_ORDER_LIST_MAX_WINDOW_SEC = 15 * 24 * 60 * 60;
/** Đồng bộ lịch sử: tối đa đúng 30 ngày (= 2 × 15 ngày chunks). */
const SHOPEE_ORDER_LIST_MAX_TOTAL_LOOKBACK_SEC = SHOPEE_HISTORY_LOOKBACK_SEC;
/** Deadline mỗi shop (list + detail) — đủ vét more=false, không để shop 2 bị SKIP. */
const ORDERS_PULL_PER_SHOP_MS = 180_000;
const ORDERS_PULL_PER_SHOP_LONG_MS = 300_000;
/** Deadline tường toàn phiên — fallback khi chưa biết số shop. */
const ORDERS_PULL_HARD_DEADLINE_MS = 180_000;
/** Vét đơn READY_TO_SHIP bị miss webhook — tối thiểu 7 ngày. */
const READY_TO_SHIP_BACKFILL_LOOKBACK_SEC = 7 * 24 * 60 * 60;
/** Incremental Cron: get_order_list order_status=SHIPPED — lookback 1–3 ngày (mặc định 3). */
const SHOPEE_SHIPPED_LOOKBACK_SEC = 3 * 24 * 60 * 60;
/** Incremental Cron: get_order_list order_status=COMPLETED — heal đơn kẹt SHIPPED (mặc định 15 ngày). */
const SHOPEE_COMPLETED_LOOKBACK_SEC = 15 * 24 * 60 * 60;
/** 2 order_sn GHN chưa Arrange — ép get_order_detail + upsert 1 lần khi boot. */
const FORCE_RESCUE_SHOPEE_ORDER_SNS = ["26081391A7VTJ7", "26081391Q3V4JV"];
/** Mutex in-process: chặn boot pull + manual pull chạy chồng lên nhau. */
const ORDERS_PULL_LOCK_TIMEOUT_MS = 15 * 60 * 1000;
let ordersPullInFlight = false;
let ordersPullStartedAt = 0;

/**
 * Chia [timeFrom, timeTo] (Unix SECONDS) thành các cửa sổ ≤ 15 ngày.
 * Shopee get_order_list từ chối khoảng > 15 ngày / request.
 * Chunk đi từ gần → xa (time_to mới nhất trước).
 */
function buildShopeeOrderListTimeChunks(
  timeFromSec: number,
  timeToSec: number,
  maxWindowSec = SHOPEE_ORDER_LIST_MAX_WINDOW_SEC,
): Array<{ timeFrom: number; timeTo: number }> {
  const to = toShopeeUnixSeconds(timeToSec);
  let from = toShopeeUnixSeconds(timeFromSec);
  if (from >= to) {
    from = to - Math.min(maxWindowSec, SHOPEE_ORDER_LIST_INCREMENTAL_SEC);
  }
  const windowSec = Math.max(60, Math.floor(maxWindowSec));
  const chunks: Array<{ timeFrom: number; timeTo: number }> = [];
  let cursorTo = to;
  // 30 ngày / 15 ngày mỗi request = tối đa 2 chunk. Cấm lùi vô hạn.
  const maxChunks = 2;
  while (cursorTo > from && chunks.length < maxChunks) {
    const cursorFrom = Math.max(from, cursorTo - windowSec);
    chunks.push({ timeFrom: cursorFrom, timeTo: cursorTo });
    if (cursorFrom <= from) break;
    // Biên kế tiếp: lùi 1 giây để tránh trùng sn ở ranh giới cửa sổ.
    cursorTo = cursorFrom - 1;
  }
  return chunks.length ? chunks : [{ timeFrom: from, timeTo: to }];
}

/** time_from cứng: Date.now() - 30 ngày (ms → unix seconds). */
function shopeeHistoryTimeFromMs(): number {
  return Date.now() - SHOPEE_HISTORY_LOOKBACK_MS;
}

function clampShopeeHistoryLookbackSec(raw?: number, allowShort = false): number {
  const n = Number(raw);
  if (allowShort && Number.isFinite(n) && n > 0) {
    return Math.max(60, Math.min(SHOPEE_HISTORY_LOOKBACK_SEC, n));
  }
  if (Number.isFinite(n) && n > 0) {
    return Math.max(
      SHOPEE_ORDER_LIST_MIN_LOOKBACK_SEC,
      Math.min(SHOPEE_HISTORY_LOOKBACK_SEC, n),
    );
  }
  return SHOPEE_HISTORY_LOOKBACK_SEC;
}

function applyShopeeCancelReturnClassification(order: any, detail?: any): void {
  if (!order) return;
  if (detail) {
    if (detail.cancel_reason) order.cancel_reason = String(detail.cancel_reason);
    if (detail.buyer_cancel_reason) order.buyer_cancel_reason = String(detail.buyer_cancel_reason);
    if (detail.cancel_by) order.cancel_by = String(detail.cancel_by);
  }
  if (stripCancelledReturnOnDelivered(order)) {
    order.is_rts = false;
    return;
  }
  const kind = classifyShopeeCancelReturnKind(order);
  if (kind) order.shopee_cancel_return_kind = kind;
  const sub = resolveShopeeSubStatus(kind);
  if (sub) order.sub_status = sub;
  order.is_rts = kind === "failed_delivery" || sub === "RTS";
  order.is_return = kind === "refund_return";
  // Hủy chưa giao: refund tiền ≠ trả hàng — gỡ leftover return_sn từ get_return_list.
  if (kind === "cancelled" && isUnshippedShopeeCancel(order)) {
    order.is_return = false;
    order.return_sn = "";
    order._clear_return_sn = true;
  }
}

/** Log lỗi Shopee đúng format yêu cầu (FE/ops đọc được error + message). */
function logShopeeSyncApiError(error: any, context?: string): void {
  try {
    const payload = error?.response?.data ?? error;
    console.log(
      "Shopee Sync API Error: ",
      JSON.stringify(payload) + (context ? ` | context=${context}` : ""),
    );
  } catch {
    console.log("Shopee Sync API Error: ", String(error), context || "");
  }
}

/**
 * Đếm tác vụ xác nhận/in đang chạy — sync nền PHẢI nhường bandwidth Shopee/Mongo
 * khi > 0 (không dùng chung heavyJob lock với ship-order async).
 */
let logisticsWorkDepth = 0;

function beginLogisticsWork(label = "logistics"): void {
  logisticsWorkDepth += 1;
  if (logisticsWorkDepth === 1) {
    console.log(`[Logistics] PRIORITY ON (${label}) — sync sẽ nhường API`);
  }
}

function endLogisticsWork(label = "logistics"): void {
  logisticsWorkDepth = Math.max(0, logisticsWorkDepth - 1);
  if (logisticsWorkDepth === 0) {
    console.log(`[Logistics] PRIORITY OFF (${label})`);
  }
}

function isLogisticsBusy(): boolean {
  return logisticsWorkDepth > 0;
}

/** Sync chờ logistics xong (có trần) — tránh đụng rate-limit / treo ship+print. */
async function yieldToLogisticsIfBusy(maxWaitMs = 15_000): Promise<void> {
  if (!isLogisticsBusy()) return;
  const t0 = Date.now();
  while (isLogisticsBusy() && Date.now() - t0 < maxWaitMs) {
    await sleep(200);
  }
}

function releaseOrdersPullLock(reason = "finally"): void {
  if (ordersPullInFlight) {
    const elapsed = ordersPullStartedAt > 0 ? Date.now() - ordersPullStartedAt : 0;
    console.log(`[Orders Pull] Lock RELEASED (${reason}) after ${elapsed}ms`);
  }
  ordersPullInFlight = false;
  ordersPullStartedAt = 0;
}

/** true = đang khóa thật; false = rảnh (kèm auto-unlock nếu khóa quá 15 phút). */
function isOrdersPullLocked(): boolean {
  if (!ordersPullInFlight) return false;
  const elapsed = ordersPullStartedAt > 0 ? Date.now() - ordersPullStartedAt : 0;
  if (ordersPullStartedAt > 0 && elapsed >= ORDERS_PULL_LOCK_TIMEOUT_MS) {
    console.warn(
      `[Orders Pull] Lock STALE (${elapsed}ms >= ${ORDERS_PULL_LOCK_TIMEOUT_MS}ms) — force unlock failsafe`,
    );
    releaseOrdersPullLock("stale_timeout");
    return false;
  }
  return true;
}

/** @returns true nếu chiếm được khóa */
function tryAcquireOrdersPullLock(): boolean {
  if (isOrdersPullLocked()) return false;
  ordersPullInFlight = true;
  ordersPullStartedAt = Date.now();
  console.log("[Orders Pull] Lock ACQUIRED");
  return true;
}

const ORDERS_PULL_IN_FLIGHT_SOFT_MESSAGE =
  "Hệ thống đang trong quá trình đồng bộ ngầm. Vui lòng đợi trong giây lát";

/** Delay tối thiểu giữa mỗi lần gọi API sản phẩm Shopee */
const SHOPEE_PRODUCT_API_DELAY_MS = 1000;
/** Hàng đợi sync stock/price → Shopee (tránh 429). */
const SHOPEE_SYNC_QUEUE_GAP_MS = 750;
const SHOPEE_SYNC_QUEUE_MAX_RETRY = 3;
/** Số item mỗi trang get_item_list — giữ nhỏ để tránh HTTP 413 / OOM cPanel. */
const SHOPEE_ITEM_LIST_PAGE_SIZE = 10;
/** Kích thước gói sản phẩm — xử lý xong 1 gói nghỉ batchPause */
const SHOPEE_PRODUCT_BATCH_SIZE = 10;
/** Nghỉ 2–3s giữa các gói sản phẩm */
const SHOPEE_PRODUCT_BATCH_PAUSE_MS = 2500;
/** get_item_base_info: batch cực nhỏ (≤10) — tránh spike RAM / cagefs_enter Unable to fork */
const SHOPEE_PRODUCT_BASE_INFO_BATCH = 10;
/** Micro-batch upsert Mapping — tối đa 10 item Shopee / lần ghi DB */
const CHANNEL_FETCH_MICRO_BATCH = 10;
/** Nhường event loop giữa mỗi item/batch — tránh CPU kill trên CloudLinux */
const CHANNEL_FETCH_YIELD_MS = 50;
/** Chunk ghi DB cho sync kho / cập nhật sản phẩm (≤50 item → lưu → nghỉ). */
const PRODUCT_SYNC_CHUNK_SIZE = 50;
/** Nghỉ giữa các chunk sync — tránh 503 / cagefs fork. */
const PRODUCT_SYNC_CHUNK_PAUSE_MS = 100;
/** Batch auto-link mỗi request — giữ nhỏ để tránh spike RAM/CPU trên host yếu. */
const AUTO_LINK_BATCH_LIMIT_DEFAULT = 50;
const AUTO_LINK_BATCH_LIMIT_MAX = 100;
/** Giới hạn số trang get_item_list mỗi phiên sync (không while(true)). */
const PRODUCT_SYNC_MAX_PAGES = 200;
function buildShopeeUpdateStockEntry(
  stock: number,
  modelId?: string | number | null,
  locationId?: string | null
): { model_id?: number; seller_stock: { stock: number; location_id?: string }[] } {
  const sellerStock: { stock: number; location_id?: string } = {
    stock: Math.max(0, Math.round(Number(stock) || 0)),
  };
  const loc = String(locationId || "").trim();
  if (loc) sellerStock.location_id = loc;
  const entry: { model_id?: number; seller_stock: { stock: number; location_id?: string }[] } = {
    seller_stock: [sellerStock],
  };
  // Shopee UpdateStockRequest.model_id = uint64 → BẮT BUỘC number, không gửi string.
  const mid = toShopeeIdNumber(modelId);
  if (mid != null) entry.model_id = mid;
  return entry;
}

function resolveShopeeReturnsApiShopId(shopId: string): string {
  return String(normalizeShopIdKey(shopId) || shopId || "").trim();
}

function isShopeeReturnsAuthError(result: any): boolean {
  if (!result) return false;
  const http = Number(result.httpStatus || 0);
  if (http === 401 || http === 403) return true;
  return isShopeeInvalidTokenError(result.error, result.message);
}

// v2.returns.get_return_list — danh sách Trả hàng/Hoàn tiền (Seller Center).
async function shopeeGetReturnList(
  shopId: string,
  accessToken: string,
  opts?: {
    pageNo?: number;
    pageSize?: number;
    status?: string;
    updateTimeFrom?: number;
    updateTimeTo?: number;
    createTimeFrom?: number;
    createTimeTo?: number;
  },
) {
  const apiShopId = resolveShopeeReturnsApiShopId(shopId);
  if (!apiShopId) {
    console.warn(`[Shopee Returns] get_return_list shop_id=${shopId} error=invalid_shop_id message=thiếu shop_id`);
    return { error: "invalid_shop_id", message: `get_return_list thiếu shop_id (input=${String(shopId)})`, httpStatus: 0 };
  }
  const apiPath = "/api/v2/returns/get_return_list";
  const timestamp = Math.floor(Date.now() / 1000);
  const sign = shopeeSign(apiPath, timestamp, accessToken, apiShopId);
  const params = new URLSearchParams({
    partner_id: SHOPEE_PARTNER_ID,
    timestamp: String(timestamp),
    access_token: accessToken,
    shop_id: apiShopId,
    sign,
    page_no: String(Math.max(1, opts?.pageNo ?? 1)),
    page_size: String(
      Math.min(100, Math.max(1, opts?.pageSize ?? SHOPEE_RETURN_LIST_PAGE_SIZE)),
    ),
  });
  if (opts?.status) params.set("status", String(opts.status));
  if (opts?.updateTimeFrom != null) {
    params.set("update_time_from", String(toShopeeUnixSeconds(opts.updateTimeFrom)));
  }
  if (opts?.updateTimeTo != null) {
    params.set("update_time_to", String(toShopeeUnixSeconds(opts.updateTimeTo)));
  }
  if (opts?.createTimeFrom != null) {
    params.set("create_time_from", String(toShopeeUnixSeconds(opts.createTimeFrom)));
  }
  if (opts?.createTimeTo != null) {
    params.set("create_time_to", String(toShopeeUnixSeconds(opts.createTimeTo)));
  }

  const url = `${SHOPEE_HOST}${apiPath}?${params.toString()}`;
  try {
    const { json, httpStatus } = await shopeeFetchJsonWithRetry(
      url,
      `get_return_list shop_id=${apiShopId}`,
    );
    if (json.error) {
      const errMsg = formatShopeeApiError(json, httpStatus);
      console.warn(
        `[Shopee Returns] get_return_list shop_id=${apiShopId} error=${json.error || "unknown"} message=${json.message || errMsg}`,
      );
      return { ...json, message: json.message || errMsg, httpStatus };
    }
    return json;
  } catch (err: any) {
    console.warn(
      `[Shopee Returns] get_return_list shop_id=${apiShopId} error=exception message=${err?.message || err}`,
    );
    return shopeeApiErrorResult(err, `get_return_list fetch (shop_id=${apiShopId})`);
  }
}

// v2.returns.get_return_detail — lấy tracking_number / return_tracking cho đơn hoàn.
async function shopeeGetReturnDetail(shopId: string, accessToken: string, returnSn: string) {
  const apiShopId = resolveShopeeReturnsApiShopId(shopId);
  if (!apiShopId) {
    console.warn(`[Shopee Returns] get_return_detail shop_id=${shopId} return_sn=${returnSn} error=invalid_shop_id message=thiếu shop_id`);
    return { error: "invalid_shop_id", message: `get_return_detail thiếu shop_id (input=${String(shopId)})`, httpStatus: 0 };
  }
  const apiPath = "/api/v2/returns/get_return_detail";
  const timestamp = Math.floor(Date.now() / 1000);
  const sign = shopeeSign(apiPath, timestamp, accessToken, apiShopId);
  const params = new URLSearchParams({
    partner_id: SHOPEE_PARTNER_ID,
    timestamp: String(timestamp),
    access_token: accessToken,
    shop_id: apiShopId,
    sign,
    return_sn: String(returnSn),
  });
  const url = `${SHOPEE_HOST}${apiPath}?${params.toString()}`;
  try {
    const { json, httpStatus } = await shopeeFetchJsonWithRetry(
      url,
      `get_return_detail shop_id=${apiShopId} return_sn=${returnSn}`,
    );
    if (json.error) {
      const errMsg = formatShopeeApiError(json, httpStatus);
      console.warn(
        `[Shopee Returns] get_return_detail shop_id=${apiShopId} return_sn=${returnSn} error=${json.error || "unknown"} message=${json.message || errMsg}`,
      );
      return { ...json, message: json.message || errMsg, httpStatus };
    }
    return json;
  } catch (err: any) {
    console.warn(
      `[Shopee Returns] get_return_detail shop_id=${apiShopId} return_sn=${returnSn} error=exception message=${err?.message || err}`,
    );
    return shopeeApiErrorResult(err, `get_return_detail fetch return_sn=${returnSn}`);
  }
}

/** v2.returns.get_reverse_tracking_info — fallback mã vận đơn chiều hoàn. */
async function shopeeGetReverseTrackingInfo(shopId: string, accessToken: string, returnSn: string) {
  const apiShopId = resolveShopeeReturnsApiShopId(shopId);
  if (!apiShopId) {
    console.warn(`[Shopee Returns] get_reverse_tracking_info shop_id=${shopId} return_sn=${returnSn} error=invalid_shop_id message=thiếu shop_id`);
    return { error: "invalid_shop_id", message: `get_reverse_tracking_info thiếu shop_id (input=${String(shopId)})`, httpStatus: 0 };
  }
  const apiPath = "/api/v2/returns/get_reverse_tracking_info";
  const timestamp = Math.floor(Date.now() / 1000);
  const sign = shopeeSign(apiPath, timestamp, accessToken, apiShopId);
  const params = new URLSearchParams({
    partner_id: SHOPEE_PARTNER_ID,
    timestamp: String(timestamp),
    access_token: accessToken,
    shop_id: apiShopId,
    sign,
    return_sn: String(returnSn),
  });
  const url = `${SHOPEE_HOST}${apiPath}?${params.toString()}`;
  try {
    const { json, httpStatus } = await shopeeFetchJsonWithRetry(
      url,
      `get_reverse_tracking_info shop_id=${apiShopId} return_sn=${returnSn}`,
    );
    if (json.error) {
      const errMsg = formatShopeeApiError(json, httpStatus);
      console.warn(
        `[Shopee Returns] get_reverse_tracking_info shop_id=${apiShopId} return_sn=${returnSn} error=${json.error || "unknown"} message=${json.message || errMsg}`,
      );
      return { ...json, message: errMsg, httpStatus };
    }
    return json;
  } catch (err: any) {
    console.warn(
      `[Shopee Returns] get_reverse_tracking_info shop_id=${apiShopId} return_sn=${returnSn} error=exception message=${err?.message || err}`,
    );
    return shopeeApiErrorResult(err, `get_reverse_tracking_info return_sn=${returnSn}`);
  }
}

function extractShopeeReturnListRows(result: any): any[] {
  const body = result?.response ?? result ?? {};
  let rows: any = body.return ?? body.return_list ?? body.returns ?? body.return_order_list ?? [];
  // Một số partner trả object map thay vì array.
  if (rows && !Array.isArray(rows) && typeof rows === "object") {
    rows = Object.values(rows);
  }
  if (!Array.isArray(rows) || rows.length === 0) {
    const keys = body && typeof body === "object" ? Object.keys(body).slice(0, 20) : [];
    if (keys.length) {
      console.warn(
        `[Shopee Returns] list rows rỗng — response keys: ${keys.join(", ")} error=${result?.error || ""} msg=${result?.message || ""}`,
      );
    }
    return [];
  }
  return rows;
}

function normalizeCarrierTrackingCode(raw: unknown): string {
  const s = String(raw || "").trim().toUpperCase();
  if (!s || s.length < 4 || /^0FG/i.test(s)) return "";
  return s;
}

/** Mã hoàn phải khác mã chiều đi — không copy outbound vào return_tracking_no. */
function distinctReturnTracking(candidate: unknown, outboundTn: unknown): string {
  const ret = normalizeCarrierTrackingCode(candidate);
  const out = normalizeCarrierTrackingCode(outboundTn);
  if (!ret) return "";
  if (out && ret === out) return "";
  return ret;
}

function outboundTrackingOf(order: any): string {
  return normalizeCarrierTrackingCode(
    order?.trackingNumber || order?.tracking_no || order?.shopee_tracking_number,
  );
}

function applyReturnTrackingAliases(order: any, tracking: string): void {
  const tn = normalizeCarrierTrackingCode(tracking);
  if (!order || !tn) return;
  order.return_tracking_no = tn;
  order.returnTrackingNumber = tn;
}

function isCancelledReturnStatus(raw: unknown): boolean {
  return String(raw || "").trim().toUpperCase() === "CANCELLED";
}

/** Persist mã hoàn — chỉ 4 field tracking, không đè cờ kho. */
async function persistReturnTrackingOnly(order: any, tracking: string, shopId: string): Promise<boolean> {
  const sn = String(order?.orderSn || "").replace(/^shopee-/i, "").trim();
  const rtn = normalizeCarrierTrackingCode(tracking);
  if (!sn || !rtn) return false;
  if (isCancelledReturnStatus(order?.return_status)) return false;
  applyReturnTrackingAliases(order, rtn);
  return updateReturnTrackingOnlyInStore(sn, rtn, {
    shopId: String(normalizeShopIdKey(shopId) || shopId || "").trim() || undefined,
    return_sn: String(order?.return_sn || "").trim() || undefined,
    return_status: String(order?.return_status || "").trim() || undefined,
  });
}

function existingHasReturnSn(existing: any): boolean {
  return Boolean(
    String(existing?.return_sn || existing?.data?.return_sn || "").trim(),
  );
}

/** Đánh dấu YCTH mới → queue toast realtime + cờ Mongo. */
function markNewReturnRequestAlert(order: any, existing: any): boolean {
  try {
    if (!order) return false;
    const hadReturn = existingHasReturnSn(existing);
    const hasReturn = Boolean(
      String(order.return_sn || order?.data?.return_sn || "").trim(),
    );
    if (!hasReturn || hadReturn) return false;
    order.return_alert_pending = true;
    order.return_alert_at = new Date().toISOString();
    pushReturnAlert({
      orderSn: String(order.orderSn || ""),
      returnSn: String(order.return_sn || ""),
      returnTrackingNumber:
        order.return_tracking_no || order.returnTrackingNumber || "",
      shopId: String(order.shopId || existing?.shopId || ""),
    });
    console.log(
      `[ReturnAlert] NEW return request order_sn=${order.orderSn} return_sn=${order.return_sn} rtn=${order.return_tracking_no || "(empty)"}`,
    );
    return true;
  } catch (err: any) {
    console.warn("[ReturnAlert] mark failed:", err?.message || err);
    return false;
  }
}

/** Gọi reverse logistics — chỉ ghi mã hoàn khi khác outbound. */
async function fillReturnTrackingFromShopee(
  shopId: string,
  accessToken: string,
  order: any,
): Promise<boolean> {
  const apiShopId = String(normalizeShopIdKey(shopId) || shopId || "").trim();
  if (isCancelledReturnStatus(order?.return_status)) {
    if (stripCancelledReturnOnDelivered(order)) {
      await clearCancelledDeliveredReturnInStore(String(order?.orderSn || ""), apiShopId);
    }
    return false;
  }
  if (!orderNeedsRealReturnTracking(order)) {
    return Boolean(normalizeCarrierTrackingCode(order?.return_tracking_no || order?.returnTrackingNumber));
  }
  let returnSn = String(order.return_sn || "").trim();
  if (!returnSn && order.orderSn) {
    try {
      returnSn = await findReturnSnForOrderWebhook(apiShopId, accessToken, String(order.orderSn));
      if (returnSn) order.return_sn = returnSn;
    } catch (findErr: any) {
      console.warn(
        `[Shopee Tracking] find return_sn ${order.orderSn}:`,
        findErr?.message || findErr,
      );
    }
  }
  if (!returnSn) {
    console.warn(
      `[Shopee Tracking] fill return TN skip no_return_sn order_sn=${order.orderSn || "-"} shop_id=${apiShopId}`,
    );
    return false;
  }
  try {
    const detail = await shopeeGetReturnDetail(apiShopId, accessToken, returnSn);
    if (detail?.error) {
      const errText = `${detail.error || ""} ${detail.message || ""}`;
      console.warn(
        `[Shopee Tracking] get_return_detail shop_id=${apiShopId} return_sn=${returnSn} error=${detail.error || "unknown"} message=${detail.message || ""}`,
      );
      if (isShopeeReturnsAuthError(detail)) {
        return false;
      }
      await shopeeSyncDelay(300);
      const { tracking } = await fetchReturnShippingTrackingNumber(
        apiShopId,
        accessToken,
        returnSn,
        undefined,
        outboundTrackingOf(order),
      );
      if (tracking) {
        applyReturnTrackingAliases(order, tracking);
        return true;
      }
      if (/error_reverse_logistics|does not have reverse logistics/i.test(errText)) {
        setTrackingEnrichCooldown(order, "reverse_logistics_pending");
      } else {
        setTrackingEnrichCooldown(order, "return_tracking_pending");
      }
      return false;
    }
    const body = detail?.response ?? detail;
    if (body?.status) order.return_status = String(body.status);
    if (isCancelledReturnStatus(order.return_status) || isCancelledReturnStatus(body?.status)) {
      order.return_status = "CANCELLED";
      if (stripCancelledReturnOnDelivered(order)) {
        await clearCancelledDeliveredReturnInStore(String(order.orderSn || ""), apiShopId);
        console.log(
          `[Shopee Tracking] skip cancelled YCTH on delivered order_sn=${order.orderSn || "-"} return_sn=${returnSn}`,
        );
        return false;
      }
      console.log(
        `[Shopee Tracking] skip return_tracking_no — return_status=CANCELLED order_sn=${order.orderSn || "-"}`,
      );
      return false;
    }
    const { tracking } = await fetchReturnShippingTrackingNumber(
      apiShopId,
      accessToken,
      returnSn,
      detail,
      outboundTrackingOf(order),
    );
    if (tracking) {
      applyReturnTrackingAliases(order, tracking);
      return true;
    }
    setTrackingEnrichCooldown(order, "return_tracking_pending");
    return false;
  } catch (err: any) {
    console.warn(`[Shopee Tracking] fill return TN ${order.orderSn}:`, err?.message || err);
    setTrackingEnrichCooldown(order, "returns_fallback_error");
    return false;
  }
}

/** Lấy mã vận đơn chiều hoàn: reverse_tracking_info.tracking_number ưu tiên (SPXVN...). */
async function fetchReturnShippingTrackingNumber(
  shopId: string,
  accessToken: string,
  returnSn: string,
  detailPayload?: any,
  outboundTn?: string,
): Promise<{ tracking: string; sources: Record<string, string> }> {
  const sources: Record<string, string> = {};
  const detailStatus = String(
    detailPayload?.response?.status ?? detailPayload?.status ?? "",
  ).trim().toUpperCase();
  if (detailStatus === "CANCELLED") {
    return { tracking: "", sources: { skipped: "cancelled_return" } };
  }
  const outbound = normalizeCarrierTrackingCode(outboundTn);

  let fromReverse = "";
  try {
    const reverse = await shopeeGetReverseTrackingInfo(shopId, accessToken, returnSn);
    if (!reverse?.error) {
      const body = reverse?.response ?? reverse ?? {};
      fromReverse = distinctReturnTracking(
        pickBestTrackingNumber(
          body.tracking_number,
          body.return_shipping_number,
          body.return_shipping_no,
          body.rts_tracking_number,
          Array.isArray(body?.tracking_info) ? body.tracking_info[0]?.tracking_number : undefined,
        ),
        outbound,
      );
      if (fromReverse) sources.reverse_tracking_info = fromReverse;
      console.log(
        `[Shopee Returns] reverse_tracking shop_id=${shopId} return_sn=${returnSn} tracking_number=${body.tracking_number || "(empty)"} rts=${body.rts_tracking_number || "(empty)"} extracted=${fromReverse || "(empty)"}`,
      );
    } else {
      const errText = `${reverse.error || ""} ${reverse.message || ""}`;
      if (/error_reverse_logistics|does not have reverse logistics/i.test(errText)) {
        console.log(
          `[Shopee Returns] get_reverse_tracking_info pending shop_id=${shopId} return_sn=${returnSn}: ${errText.trim()}`,
        );
      } else {
        console.warn(
          `[Shopee Returns] get_reverse_tracking_info shop_id=${shopId} return_sn=${returnSn} error=${reverse.error || "unknown"} message=${reverse.message || ""}`,
        );
      }
    }
  } catch (err: any) {
    console.warn(
      `[Shopee Returns] reverse_tracking exception shop_id=${shopId} return_sn=${returnSn}:`,
      err?.message || err,
    );
  }

  let fromDetail = "";
  if (!fromReverse) {
    fromDetail = distinctReturnTracking(
      extractTrackingFromReturnPayload(detailPayload),
      outbound,
    );
    if (fromDetail) sources.return_detail = fromDetail;
  }

  return { tracking: fromReverse || fromDetail || "", sources };
}

type ReturnListRow = { returnSn: string; orderSn?: string; status?: string };

function parseShopeeReturnListMore(result: any): boolean {
  const body = result?.response ?? result ?? {};
  return (
    body.more === true ||
    body.more === 1 ||
    body.more === "true" ||
    body.has_more === true ||
    body.has_more === 1
  );
}

function shopeeReturnRowTimeSec(row: any): number {
  const n = Number(row?.update_time ?? row?.create_time ?? 0);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return n >= 1e12 ? Math.floor(n / 1000) : Math.floor(n);
}

function pushShopeeReturnListRow(
  row: any,
  seen: Set<string>,
  out: ReturnListRow[],
  keepFromSec: number,
): boolean {
  const safeRow = normalizeShopeeReturnDetail(row) || row;
  const ts = shopeeReturnRowTimeSec(safeRow);
  if (ts > 0 && ts < keepFromSec) return false;
  const returnSn = extractReturnRequestCode(safeRow) || "";
  if (!returnSn || seen.has(returnSn)) return false;
  seen.add(returnSn);
  out.push({
    returnSn,
    orderSn: toShopeeSn(safeRow?.order_sn ?? safeRow?.orderSn) || undefined,
    status: safeRow?.status ? String(safeRow.status) : undefined,
  });
  return true;
}

/** Ưu tiên: returnDetail.tracking_number → orderDetail → DB cũ. Không bao giờ trả empty nếu đã có mã. */
function pickBestTrackingNumber(...candidates: unknown[]): string {
  for (const c of candidates) {
    const s = String(c || "").trim();
    if (!s || s.length < 4) continue;
    if (/^0FG/i.test(s)) continue;
    return s;
  }
  return "";
}

function extractTrackingFromReturnPayload(payload: any): string {
  const root = payload?.response ?? payload ?? {};
  const direct = pickBestTrackingNumber(
    root.tracking_number,
    root.return_shipping_number,
    root.return_shipping_no,
    root.return_tracking_no,
    root.return_tracking_number,
    root.rts_tracking_number,
    root?.tracking_info?.tracking_number,
    root?.reverse_logistics_info?.tracking_number,
    root?.reverse_logistics_info?.return_shipping_number,
    root?.reverse_tracking_number,
    root?.shipping_carrier_tracking_number,
  );
  if (direct) return direct;

  // Deep walk: tìm mọi key tracking_number / return_tracking* trong payload hoàn.
  const found: string[] = [];
  const walk = (node: any, depth: number) => {
    if (!node || depth > 8) return;
    if (typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item, depth + 1);
      return;
    }
    for (const [k, v] of Object.entries(node)) {
      const key = String(k).toLowerCase();
      if (key === "package_query_number") continue;
      if (
        (key === "tracking_number" ||
          key === "return_shipping_number" ||
          key === "return_shipping_no" ||
          key === "return_tracking_no" ||
          key === "return_tracking_number" ||
          key === "rts_tracking_number" ||
          key.includes("return_shipping") ||
          key.endsWith("_tracking_number")) &&
        v != null &&
        String(v).trim()
      ) {
        found.push(String(v).trim());
      } else if (v && typeof v === "object") {
        walk(v, depth + 1);
      }
    }
  };
  walk(root, 0);
  const picked = pickBestTrackingNumber(...found);
  if (picked) return picked;

  try {
    const deep = deepExtractShopeeTrackingCodes(root);
    return String(deep.carrier || "").trim();
  } catch {
    return "";
  }
}

function mapShopeeReturnKind(_detail: any): "refund_return" | "failed_delivery" {
  // get_return_list / get_return_detail = Trả hàng Hoàn tiền (kể cả type=2 Return-on-the-Spot).
  // RTS giao thất bại outbound KHÔNG đi qua API returns.
  return "refund_return";
}

async function shopeePaginateReturnListWindow(
  shopId: string,
  accessToken: string,
  opts: {
    timeFrom: number;
    timeTo: number;
    timeField: "update" | "create";
    status?: string;
    seen: Set<string>;
    out: ReturnListRow[];
    label: string;
    maxPages?: number;
    deadlineAt?: number;
  },
): Promise<void> {
  let pageNo = 1;
  const maxPages = Math.max(
    1,
    Math.min(SHOPEE_RETURN_LIST_MAX_PAGES, Number(opts.maxPages) || SHOPEE_RETURN_LIST_MAX_PAGES),
  );
  while (pageNo <= maxPages) {
    if (opts.deadlineAt && Date.now() >= opts.deadlineAt) break;
    if (opts.out.length >= SHOPEE_SYNC_MAX_CANCEL_RETURN_SNS) return;
    const listOpts: Parameters<typeof shopeeGetReturnList>[2] = {
      pageNo,
      pageSize: SHOPEE_RETURN_LIST_PAGE_SIZE,
      status: opts.status,
    };
    if (opts.timeField === "update") {
      listOpts.updateTimeFrom = opts.timeFrom;
      listOpts.updateTimeTo = opts.timeTo;
    } else {
      listOpts.createTimeFrom = opts.timeFrom;
      listOpts.createTimeTo = opts.timeTo;
    }
    const listResult = await shopeeGetReturnList(shopId, accessToken, listOpts);
    if (listResult.error) {
      console.warn(
        `[Shopee Returns] ${opts.label} page=${pageNo} lỗi:`,
        listResult.message || listResult.error,
      );
      return;
    }
    const rows = extractShopeeReturnListRows(listResult);
    for (const row of rows) {
      const safeRow = normalizeShopeeReturnDetail(row) || row;
      const returnSn = extractReturnRequestCode(safeRow) || "";
      if (!returnSn || opts.seen.has(returnSn)) continue;
      opts.seen.add(returnSn);
      opts.out.push({
        returnSn,
        orderSn: toShopeeSn(safeRow?.order_sn ?? safeRow?.orderSn) || undefined,
        status: safeRow?.status ? String(safeRow.status) : opts.status,
      });
      if (opts.out.length >= SHOPEE_SYNC_MAX_CANCEL_RETURN_SNS) break;
    }
    const more = parseShopeeReturnListMore(listResult);
    console.log(
      `[Shopee Returns] ${opts.label} page=${pageNo}: +${rows.length} (tổng ${opts.out.length}), more=${more}`,
    );
    // Strict exit: more=false hoặc trang rỗng → dừng (không đoán pageFull → tránh loop).
    if (!more || rows.length === 0) return;
    pageNo++;
    await shopeeSyncDelay(SHOPEE_ORDER_LIST_PAGE_DELAY_MS);
  }
}

/**
 * Quét get_return_list 90 ngày.
 * PRIMARY: không time-filter + paginate đến more=false (Shopee hay error_param khi lọc ngày).
 * PHỤ: cửa sổ update_time + create_time × 15 ngày (6 cửa sổ = 90 ngày).
 */
async function shopeeFetchAllReturnSns(
  shopId: string,
  accessToken: string,
  opts?: { mode?: "incremental" | "full"; maxPages?: number; deadlineAt?: number },
): Promise<ReturnListRow[]> {
  const mode = opts?.mode === "full" ? "full" : "incremental";
  const now = Math.floor(Date.now() / 1000);
  const historyFromSec = now - SHOPEE_RETURN_LIST_LOOKBACK_SEC;
  const out: ReturnListRow[] = [];
  const seen = new Set<string>();
  const maxPages = Math.max(
    1,
    Math.min(
      SHOPEE_RETURN_LIST_MAX_PAGES,
      Number(opts?.maxPages) || SHOPEE_RETURN_LIST_MAX_PAGES,
    ),
  );

  console.log(
    `[Shopee Returns] shop=${shopId} mode=${mode}: get_return_list no-time + windows 90d from=${historyFromSec}`,
  );

  let pageNo = 1;
  while (pageNo <= maxPages) {
    if (opts?.deadlineAt && Date.now() >= opts.deadlineAt) break;
    if (out.length >= SHOPEE_SYNC_MAX_CANCEL_RETURN_SNS) break;
    const listResult = await shopeeGetReturnList(shopId, accessToken, {
      pageNo,
      pageSize: SHOPEE_RETURN_LIST_PAGE_SIZE,
    });
    if (listResult.error) {
      console.warn(
        `[Shopee Returns] no-time page=${pageNo} LỖI:`,
        listResult.error,
        listResult.message || "",
      );
      break;
    }
    const rows = extractShopeeReturnListRows(listResult);
    let pageKept = 0;
    for (const row of rows) {
      if (pushShopeeReturnListRow(row, seen, out, historyFromSec)) pageKept += 1;
      if (out.length >= SHOPEE_SYNC_MAX_CANCEL_RETURN_SNS) break;
    }
    const more = parseShopeeReturnListMore(listResult);
    console.log(
      `[Shopee Returns] no-time page=${pageNo}: rows=${rows.length} kept=${pageKept} tổng=${out.length} more=${more}`,
    );
    if (!more || rows.length === 0) break;
    pageNo++;
    await shopeeSyncDelay(SHOPEE_ORDER_LIST_PAGE_DELAY_MS);
  }

  if (out.length > 0) {
    console.log(`[Shopee Returns] shop=${shopId} mode=${mode}: TỔNG ${out.length} return_sn (unique, 90d)`);
    return out;
  }

  const maxWindows = SHOPEE_CANCEL_RETURN_MAX_WINDOWS;
  const windowSec = SHOPEE_RETURN_LIST_WINDOW_SEC;
  for (const timeField of ["update", "create"] as const) {
    for (let windowIdx = 0; windowIdx < maxWindows; windowIdx++) {
      if (opts?.deadlineAt && Date.now() >= opts.deadlineAt) break;
      if (out.length >= SHOPEE_SYNC_MAX_CANCEL_RETURN_SNS) break;
      const timeTo = now - windowIdx * windowSec;
      const timeFrom = Math.max(historyFromSec, timeTo - windowSec + 1);
      if (timeFrom >= timeTo) break;
      await shopeePaginateReturnListWindow(shopId, accessToken, {
        timeFrom,
        timeTo,
        timeField,
        seen,
        out,
        label: `shop=${shopId} ${timeField} w${windowIdx + 1}`,
        maxPages,
        deadlineAt: opts?.deadlineAt,
      });
      await shopeeSyncDelay(SHOPEE_ORDER_LIST_PAGE_DELAY_MS);
    }
  }

  console.log(`[Shopee Returns] shop=${shopId} mode=${mode}: TỔNG ${out.length} return_sn (unique, 90d)`);
  return out;
}

/**
 * v2.order.get_order_list — time_from / time_to BẮT BUỘC là UNIX SECONDS.
 * toShopeeUnixSeconds() tự chia 1000 nếu lỡ truyền milliseconds (Date.now()).
 * Caller phải chia chunk ≤ 15 ngày; hàm này vẫn clamp an toàn nếu lỡ vượt.
 * Mặc định cửa sổ 14 ngày; KHÔNG gắn order_status trừ khi caller truyền rõ.
 */
async function shopeeGetOrderList(
  shopId: string,
  accessToken: string,
  opts?: {
    orderStatus?: string;
    cursor?: string;
    timeRangeField?: "create_time" | "update_time";
    timeFrom?: number;
    timeTo?: number;
    /** Quick Sync / cron: cho phép cửa sổ < 3 ngày (không ép MIN_LOOKBACK). */
    allowShortLookback?: boolean;
  },
) {
  const apiPath = "/api/v2/order/get_order_list";
  const timestamp = Math.floor(Date.now() / 1000);
  const sign = shopeeSign(apiPath, timestamp, accessToken, shopId);

  // Unix seconds (10 chữ số) — tuyệt đối không gửi milliseconds.
  let timeTo = toShopeeUnixSeconds(opts?.timeTo, timestamp);
  let timeFrom = toShopeeUnixSeconds(
    opts?.timeFrom,
    timeTo - SHOPEE_ORDER_LIST_INCREMENTAL_SEC,
  );
  if (timeFrom >= timeTo) {
    timeFrom = timeTo - SHOPEE_ORDER_LIST_INCREMENTAL_SEC;
  }
  // Cứng: không lùi quá 30 ngày từ Date.now() (trừ cron cửa sổ ngắn).
  if (!opts?.allowShortLookback) {
    const historyFloor = toShopeeUnixSeconds(shopeeHistoryTimeFromMs());
    if (timeFrom < historyFloor) timeFrom = historyFloor;
  }
  // Shopee từ chối cửa sổ > 15 ngày — clamp an toàn (caller nên chunk trước).
  if (timeTo - timeFrom > SHOPEE_ORDER_LIST_MAX_WINDOW_SEC) {
    timeFrom = timeTo - SHOPEE_ORDER_LIST_MAX_WINDOW_SEC;
  }
  // Sàn tối thiểu 3 ngày khi caller vô tình truyền cửa sổ quá ngắn.
  // Quick Sync (allowShortLookback) bỏ qua — giữ đúng time_from/time_to caller.
  if (
    !opts?.allowShortLookback &&
    timeTo - timeFrom < SHOPEE_ORDER_LIST_MIN_LOOKBACK_SEC
  ) {
    timeFrom = timeTo - SHOPEE_ORDER_LIST_MIN_LOOKBACK_SEC;
  }

  const timeRangeField =
    opts?.timeRangeField === "create_time" ? "create_time" : "update_time";

  const params = new URLSearchParams({
    partner_id: SHOPEE_PARTNER_ID,
    timestamp: String(timestamp),
    access_token: accessToken,
    shop_id: shopId,
    sign,
    time_range_field: timeRangeField,
    time_from: String(timeFrom),
    time_to: String(timeTo),
    page_size: String(SHOPEE_ORDER_LIST_PAGE_SIZE),
    response_optional_fields: "order_status",
    request_order_status_pending: "true",
  });
  // Chỉ gắn order_status khi caller chủ động truyền (kéo ALL mặc định).
  const statusFilter = String(opts?.orderStatus || "").trim();
  if (statusFilter) params.set("order_status", statusFilter);
  if (opts?.cursor !== undefined && opts.cursor !== "") params.set("cursor", opts.cursor);

  const url = `${SHOPEE_HOST}${apiPath}?${params.toString()}`;
  console.log(
    `[Shopee API] GetOrderList REQUEST shop=${shopId}` +
      ` field=${timeRangeField}` +
      ` time_from=${timeFrom} (${String(timeFrom).length} digits)` +
      ` time_to=${timeTo} (${String(timeTo).length} digits)` +
      ` window_days=${((timeTo - timeFrom) / 86400).toFixed(2)}` +
      ` cursor=${opts?.cursor || ""}` +
      ` status=${statusFilter || "ALL(no filter)"}`,
  );
  try {
    const { json, httpStatus } = await shopeeFetchJsonWithRetry(
      url,
      `get_order_list shop_id=${shopId}`,
    );
    const rowCount = Array.isArray(json?.response?.order_list)
      ? json.response.order_list.length
      : Array.isArray(json?.order_list)
        ? json.order_list.length
        : 0;
    console.log(
      `[Shopee API] GetOrderList RESPONSE shop=${shopId} HTTP=${httpStatus}` +
        ` error=${json?.error || "none"} rows=${rowCount} more=${json?.response?.more ?? json?.more}`,
      JSON.stringify(json).slice(0, 500),
    );

    if (httpStatus === 401 || httpStatus === 403 || isShopeeInvalidTokenError(json?.error, json?.message)) {
      console.error(
        `[Shopee API] GetOrderList AUTH FAIL shop=${shopId} HTTP=${httpStatus}`,
        json?.error,
        json?.message,
      );
    }

    if (json.error) {
      const errMsg = formatShopeeApiError(json, httpStatus);
      logShopeeSyncApiError(
        { ...(json || {}), httpStatus, message: json.message || errMsg },
        `get_order_list shop_id=${shopId}`,
      );
      console.error(`[Shopee API] GetOrderList lỗi: ${errMsg}`);
      return { ...json, message: json.message || errMsg, httpStatus };
    }
    return { ...json, httpStatus };
  } catch (err: any) {
    logShopeeSyncApiError(err, `get_order_list shop_id=${shopId}`);
    console.error(
      "[Shopee API] GetOrderList EXCEPTION:",
      `shop_id=${shopId}`,
      err?.message || err,
      err?.stack || "",
    );
    return shopeeApiErrorResult(err, `get_order_list fetch (shop_id=${shopId})`);
  }
}

function syncDiag(step: string, detail?: string): void {
  const ts = new Date().toISOString();
  console.log(`[${ts}] [Orders Sync] ${step}${detail ? ` — ${detail}` : ""}`);
}

function assertOrdersPullDeadline(deadlineAt: number, label: string): void {
  if (Date.now() <= deadlineAt) return;
  throw new Error(
    `ORDERS_PULL_DEADLINE — quá ${ORDERS_PULL_HARD_DEADLINE_MS}ms tại: ${label}`,
  );
}

/** Thu thập order_sn từ get_order_list — chia chunk ≤15 ngày + cursor pagination đến more=false. */
async function collectShopeeOrderSnsIncremental(
  shopId: string,
  accessToken: string,
  opts?: {
    lookbackSec?: number;
    deadlineAt?: number;
    /** Bỏ qua — không còn cắt SN. Giữ signature tương thích. */
    maxOrderSns?: number;
    /** Cầu chì runaway; mặc định SAFETY_CAP. */
    pageHardCap?: number;
    /** Quick Sync: cho phép lookback < 3 ngày. */
    allowShortLookback?: boolean;
  },
): Promise<{ orderSns: string[]; shopeeResponses: any[]; truncated: boolean }> {
  const timeTo = Math.floor(Date.now() / 1000);
  const rawLookback =
    Number(opts?.lookbackSec) > 0
      ? Number(opts.lookbackSec)
      : SHOPEE_ORDER_LIST_INCREMENTAL_SEC;
  const lookback = clampShopeeHistoryLookbackSec(rawLookback, opts?.allowShortLookback === true);
  const timeFrom = Math.max(toShopeeUnixSeconds(shopeeHistoryTimeFromMs()), timeTo - lookback);
  const allowShort = opts?.allowShortLookback === true;
  const orderSnSet = new Set<string>();
  const shopeeResponses: any[] = [];
  const deadlineAt = opts?.deadlineAt ?? Date.now() + ORDERS_PULL_PER_SHOP_MS;
  const pageSafetyCap = Math.min(
    SHOPEE_ORDER_LIST_LOOP_SAFETY_CAP,
    Math.max(1, Math.floor(opts?.pageHardCap ?? SHOPEE_ORDER_LIST_LOOP_SAFETY_CAP)),
  );
  let truncated = false;

  const timeChunks = buildShopeeOrderListTimeChunks(timeFrom, timeTo);
  syncDiag(
    "Fetching order list...",
    `shop=${shopId} field=update_time lookback=${lookback}s (~${(lookback / 86400).toFixed(1)}d)` +
      ` from=${timeFrom} to=${timeTo} chunks=${timeChunks.length} safetyCap=${pageSafetyCap}`,
  );

  let page = 0;
  let shopListCalls = 0;
  chunkLoop: for (let chunkIdx = 0; chunkIdx < timeChunks.length; chunkIdx++) {
    if (Date.now() > deadlineAt || shopListCalls >= pageSafetyCap) {
      truncated = true;
      break;
    }

    const chunk = timeChunks[chunkIdx];
    const chunkTimeFrom = toShopeeUnixSeconds(chunk.timeFrom);
    const chunkTimeTo = toShopeeUnixSeconds(chunk.timeTo);
    const seenCursors = new Set<string>();
    let cursor: string | undefined;

    syncDiag(
      "Order list time chunk",
      `shop=${shopId} chunk=${chunkIdx + 1}/${timeChunks.length}` +
        ` from=${chunkTimeFrom} to=${chunkTimeTo}` +
        ` (~${((chunkTimeTo - chunkTimeFrom) / 86400).toFixed(2)}d)`,
    );

    // Fail-safe: for-loop cứng ≤ 50 lần/shop — CẤM while(true).
    for (let pageIdx = 0; pageIdx < pageSafetyCap; pageIdx++) {
      if (Date.now() > deadlineAt || shopListCalls >= pageSafetyCap) {
        truncated = true;
        break chunkLoop;
      }
      try {
        assertOrdersPullDeadline(
          deadlineAt,
          `get_order_list chunk=${chunkIdx + 1} page=${page + 1} shop=${shopId}`,
        );
        shopListCalls += 1;
        page += 1;

        let listResult = await shopeeGetOrderList(shopId, accessToken, {
          timeRangeField: "update_time",
          timeFrom: chunkTimeFrom,
          timeTo: chunkTimeTo,
          cursor,
          allowShortLookback: allowShort,
          // Không truyền orderStatus — kéo toàn bộ trạng thái.
        });

        // Token hết hạn → force refresh + retry 1 lần trang hiện tại (không retry vô hạn).
        if (
          listResult?.httpStatus === 401 ||
          listResult?.httpStatus === 403 ||
          isShopeeInvalidTokenError(listResult?.error, listResult?.message)
        ) {
          syncDiag("GetOrderList AUTH FAIL — refresh once", `shop=${shopId}`);
          try {
            const refreshed = await refreshShopeeAccessTokenLocked(shopId, { force: true });
            if (refreshed) {
              accessToken = refreshed;
              listResult = await shopeeGetOrderList(shopId, accessToken, {
                timeRangeField: "update_time",
                timeFrom: chunkTimeFrom,
                timeTo: chunkTimeTo,
                cursor,
                allowShortLookback: allowShort,
              });
            }
          } catch (refreshErr: any) {
            logShopeeSyncApiError(refreshErr, `token_refresh shop_id=${shopId}`);
            console.error(
              `[Orders Pull] Token refresh thất bại shop=${shopId}:`,
              refreshErr?.message || refreshErr,
            );
            shopeeResponses.push({
              shop_id: shopId,
              page,
              chunk: chunkIdx + 1,
              error: "token_refresh_failed",
              detail: refreshErr?.message || String(refreshErr),
              raw: listResult,
            });
            truncated = true;
            break chunkLoop;
          }
        }

        shopeeResponses.push({
          shop_id: shopId,
          page,
          chunk: chunkIdx + 1,
          time_from: chunkTimeFrom,
          time_to: chunkTimeTo,
          cursor: cursor || "",
          raw: listResult,
        });

        if (listResult?.error) {
          logShopeeSyncApiError(listResult, `get_order_list shop_id=${shopId}`);
          console.error(
            `[Orders Pull] GetOrderList dừng shop=${shopId}:`,
            listResult.error,
            listResult.message || "",
          );
          truncated = true;
          break chunkLoop;
        }

        const rows = extractShopeeOrderListRows(listResult) as any[];
        for (const row of rows) {
          try {
            const sn = String(row?.order_sn || row?.ordersn || "").trim();
            if (sn) orderSnSet.add(sn);
          } catch (rowErr: any) {
            console.error(
              `[Orders Pull] Bỏ qua 1 đơn lỗi shop=${shopId}:`,
              rowErr?.message || rowErr,
              row,
            );
            continue;
          }
        }

        syncDiag(
          "Order list received",
          `${rows.length} orders (shop=${shopId} chunk=${chunkIdx + 1} page=${page} totalSn=${orderSnSet.size} cursor=${cursor || "(start)"})`,
        );

        const adv = advanceShopeeOrderListCursor({
          listResult,
          currentCursor: cursor,
          seenCursors,
          pageIndex: shopListCalls,
          hardCap: pageSafetyCap,
          logLabel: `shop=${shopId} chunk=${chunkIdx + 1}`,
        });
        syncDiag("Pagination decision", `${adv.action} — ${adv.reason}`);
        if (adv.action === "break") {
          if (String(adv.reason || "").includes("safetyCap")) truncated = true;
          break;
        }
        const nextCursor = String(adv.nextCursor || "").trim();
        if (!nextCursor || nextCursor === String(cursor || "").trim()) {
          truncated = true;
          break;
        }

        seenCursors.add(nextCursor);
        cursor = nextCursor;
        await shopeeSyncDelay(SHOPEE_ORDER_LIST_PAGE_DELAY_MS);
      } catch (pageErr: any) {
        if (String(pageErr?.message || "").includes("ORDERS_PULL_DEADLINE")) {
          truncated = true;
          throw pageErr;
        }
        logShopeeSyncApiError(pageErr, `get_order_list page shop_id=${shopId}`);
        console.error(
          `[Orders Pull] GetOrderList page exception shop=${shopId}:`,
          pageErr?.message || pageErr,
        );
        shopeeResponses.push({
          shop_id: shopId,
          page,
          chunk: chunkIdx + 1,
          error: "page_exception",
          detail: pageErr?.message || String(pageErr),
        });
        truncated = true;
        break chunkLoop;
      }
    }

    if (chunkIdx + 1 < timeChunks.length) {
      await shopeeSyncDelay(SHOPEE_ORDER_LIST_PAGE_DELAY_MS);
    }
  }

  syncDiag(
    "Order list pagination done",
    `shop=${shopId} pages=${page} chunks=${timeChunks.length} uniqueSn=${orderSnSet.size} truncated=${truncated}`,
  );
  return { orderSns: [...orderSnSet], shopeeResponses, truncated };
}

/** Thu thập order_sn theo 1 order_status (vd CANCELLED) — phục vụ lookup quét mã miss. */
async function collectShopeeOrderSnsByStatus(
  shopId: string,
  accessToken: string,
  orderStatus: string,
  opts?: {
    lookbackSec?: number;
    deadlineAt?: number;
    maxOrderSns?: number;
    pageHardCap?: number;
    timeRangeField?: "create_time" | "update_time";
    allowShortLookback?: boolean;
  },
): Promise<string[]> {
  const now = Math.floor(Date.now() / 1000);
  const rawLookback = Number(opts?.lookbackSec) || SHOPEE_ORDER_LIST_INCREMENTAL_SEC;
  const lookback = clampShopeeHistoryLookbackSec(rawLookback, opts?.allowShortLookback === true);
  const timeRangeField =
    opts?.timeRangeField === "create_time" ? "create_time" : "update_time";
  const allowShort = opts?.allowShortLookback === true;
  const timeFrom = Math.max(toShopeeUnixSeconds(shopeeHistoryTimeFromMs()), now - lookback);
  const timeTo = now;
  const orderSnSet = new Set<string>();
  const deadlineAt = opts?.deadlineAt ?? Date.now() + ORDERS_PULL_PER_SHOP_MS;
  const pageSafetyCap = Math.min(
    SHOPEE_ORDER_LIST_LOOP_SAFETY_CAP,
    Math.max(1, Math.floor(opts?.pageHardCap ?? SHOPEE_ORDER_LIST_LOOP_SAFETY_CAP)),
  );
  const status = String(orderStatus || "").trim().toUpperCase();
  if (!status) return [];

  const timeChunks = buildShopeeOrderListTimeChunks(timeFrom, timeTo);
  let page = 0;
  let shopListCalls = 0;

  chunkLoop: for (let chunkIdx = 0; chunkIdx < timeChunks.length; chunkIdx++) {
    if (Date.now() > deadlineAt || shopListCalls >= pageSafetyCap) break;
    const chunk = timeChunks[chunkIdx];
    const chunkTimeFrom = toShopeeUnixSeconds(chunk.timeFrom);
    const chunkTimeTo = toShopeeUnixSeconds(chunk.timeTo);
    const seenCursors = new Set<string>();
    let cursor: string | undefined;

    // Fail-safe: for-loop cứng ≤ 50 lần/shop — CẤM while(true).
    for (let pageIdx = 0; pageIdx < pageSafetyCap; pageIdx++) {
      if (Date.now() > deadlineAt || shopListCalls >= pageSafetyCap) break chunkLoop;
      shopListCalls += 1;
      page += 1;
      try {
        let listResult = await shopeeGetOrderList(shopId, accessToken, {
          timeRangeField,
          timeFrom: chunkTimeFrom,
          timeTo: chunkTimeTo,
          cursor,
          orderStatus: status,
          allowShortLookback: allowShort,
        });
        if (
          listResult?.httpStatus === 401 ||
          listResult?.httpStatus === 403 ||
          isShopeeInvalidTokenError(listResult?.error, listResult?.message)
        ) {
          try {
            const refreshed = await refreshShopeeAccessTokenLocked(shopId, { force: true });
            if (refreshed) {
              accessToken = refreshed;
              listResult = await shopeeGetOrderList(shopId, accessToken, {
                timeRangeField,
                timeFrom: chunkTimeFrom,
                timeTo: chunkTimeTo,
                cursor,
                orderStatus: status,
                allowShortLookback: allowShort,
              });
            }
          } catch (refreshErr: any) {
            logShopeeSyncApiError(refreshErr, `token_refresh status=${status} shop=${shopId}`);
            console.error(
              `[Orders Pull] Token refresh thất bại (status=${status}) shop=${shopId}:`,
              refreshErr?.message || refreshErr,
            );
            break chunkLoop;
          }
        }
        if (listResult?.error) {
          logShopeeSyncApiError(listResult, `get_order_list status=${status} shop=${shopId}`);
          break chunkLoop;
        }
        const rows = extractShopeeOrderListRows(listResult) as any[];
        for (const row of rows) {
          const sn = String(row?.order_sn || row?.ordersn || "").trim();
          if (sn) orderSnSet.add(sn);
        }
        const adv = advanceShopeeOrderListCursor({
          listResult,
          currentCursor: cursor,
          seenCursors,
          pageIndex: shopListCalls,
          hardCap: pageSafetyCap,
          logLabel: `scan-lookup status=${status} shop=${shopId} chunk=${chunkIdx + 1}`,
        });
        if (adv.action === "break") break;
        const nextCursor = String(adv.nextCursor || "").trim();
        if (!nextCursor || nextCursor === String(cursor || "").trim()) break;
        seenCursors.add(nextCursor);
        cursor = nextCursor;
        await shopeeSyncDelay(SHOPEE_ORDER_LIST_PAGE_DELAY_MS);
      } catch (pageErr: any) {
        logShopeeSyncApiError(pageErr, `get_order_list status=${status} shop=${shopId}`);
        break chunkLoop;
      }
    }
  }
  return [...orderSnSet];
}

/**
 * Khi quét miss local: kéo đơn từ Shopee (đặc biệt CANCELLED có mã VĐ) rồi khớp mã.
 * Trả order đã persist Mongo (hoặc null).
 */
async function resolveOrderFromShopeeByScanCode(rawCode: string): Promise<any | null> {
  const code = String(rawCode || "").trim();
  if (!code) return null;
  const scanKeys = new Set(
    [
      code,
      code.toUpperCase(),
      code.toLowerCase(),
      code.toUpperCase().replace(/[\s\-_#./\\|:;,]+/g, ""),
    ].filter((k) => k && k.length >= 4),
  );
  const primaryKey =
    [...scanKeys].find((k) => k.length >= 8) || [...scanKeys][0] || "";
  const looksLikeShopeeOrderSn = /^\d{6}[A-Z][A-Z0-9]{5,}$/i.test(primaryKey);
  const looksLikeTracking =
    !looksLikeShopeeOrderSn &&
    (/^(SPX(VN)?|GHN|GYA|GHTK|JNT|JT|NINJA|VTP|VNPOST)/i.test(primaryKey) ||
      /^\d{6,40}$/.test(primaryKey) ||
      /^[A-Z0-9][A-Z0-9\-]{5,39}$/i.test(primaryKey));
  const looksLikeOrderSn =
    !looksLikeTracking &&
    (looksLikeShopeeOrderSn || /^[A-Z0-9]{10,20}$/i.test(primaryKey));

  const orderMatchesScan = (order: any): boolean => {
    if (!order) return false;
    const fields = [
      order.orderSn,
      order.trackingNumber,
      order.tracking_no,
      order.return_tracking_no,
      order.packageNumber,
      order.internalTrackingCode,
    ];
    for (const f of fields) {
      const nk = String(f || "")
        .trim()
        .toUpperCase()
        .replace(/[\s\-_#./\\|:;,]+/g, "");
      if (!nk) continue;
      for (const sk of scanKeys) {
        const skn = sk.toUpperCase().replace(/[\s\-_#./\\|:;,]+/g, "");
        if (!skn) continue;
        if (nk === skn) return true;
        if (skn.length >= 10 && nk.length >= 10 && (nk.endsWith(skn) || skn.endsWith(nk))) {
          return true;
        }
      }
    }
    return false;
  };

  ensureShopeeLinkedShopTokenKeys();
  const shopIds = listShopeeSyncShopIds();
  if (!shopIds.length) return null;

  const deadlineAt = Date.now() + 55_000;
  const { orders } = await loadOrdersForApi();

  const persistAndReturn = async (
    shopId: string,
    accessToken: string,
    normalized: any[],
  ): Promise<any | null> => {
    if (!normalized.length) return null;
    await persistShopeeOrderChunk(orders, normalized, {
      apiShopId: shopId,
      accessToken,
      skipTracking: false,
    });
    for (const o of normalized) {
      if (orderMatchesScan(o)) return o;
      // Sau persist có thể đã có tracking từ get_tracking_number.
      if (needsShopeeTrackingEnrichment(o)) {
        try {
          await fetchAndForceSaveTrackingNumber(shopId, accessToken, o, { retries: 2 });
        } catch {
          /* ignore */
        }
      }
      if (orderMatchesScan(o)) return o;
    }
    // Match lại trên pool orders sau persist.
    for (const o of orders) {
      if (orderMatchesScan(o)) return o;
    }
    return null;
  };

  // A) Mã giống order_sn — get_order_detail trực tiếp từng shop.
  if (looksLikeOrderSn) {
    const sn = primaryKey.replace(/^SHOPEE-/i, "");
    for (const shopId of shopIds) {
      if (Date.now() > deadlineAt) break;
      try {
        const accessToken = await getValidShopeeAccessToken(shopId);
        if (!accessToken) continue;
        const { normalized } = await fetchNormalizeShopeeOrderChunk(
          shopId,
          accessToken,
          shopId,
          [sn],
          { enrichTracking: true, skipEscrow: true },
        );
        const hit = await persistAndReturn(shopId, accessToken, normalized);
        if (hit) {
          console.log(
            `[Orders Lookup] Shopee on-demand hit by order_sn=${sn} shop=${shopId} tn=${hit.tracking_no || hit.trackingNumber || "-"}`,
          );
          return hit;
        }
      } catch (err: any) {
        console.warn(
          `[Orders Lookup] Shopee order_sn resolve shop=${shopId}:`,
          err?.message || err,
        );
      }
    }
  }

  // B) Mã vận đơn — kéo CANCELLED / IN_CANCEL / TO_RETURN / SHIPPED 14 ngày rồi khớp tracking.
  if (looksLikeTracking || !looksLikeOrderSn) {
    // B0) Ưu tiên khớp mã vận đơn chiều hoàn qua get_return_list + reverse tracking.
    for (const shopId of shopIds) {
      if (Date.now() > deadlineAt) break;
      try {
        let accessToken = await getValidShopeeAccessToken(shopId);
        if (!accessToken) continue;
        const returnRows = await shopeeFetchAllReturnSns(shopId, accessToken, {
          mode: "incremental",
        });
        for (const row of returnRows.slice(0, 60)) {
          if (Date.now() > deadlineAt) break;
          const returnSn = String(row.returnSn || "").trim();
          if (!returnSn) continue;
          const fresh = await getValidShopeeAccessToken(shopId);
          if (fresh) accessToken = fresh;
          const detailResult = await shopeeGetReturnDetail(shopId, accessToken, returnSn);
          if (detailResult?.error) continue;
          const detail = detailResult?.response ?? detailResult ?? {};
          const { tracking: rtn } = await fetchReturnShippingTrackingNumber(
            shopId,
            accessToken,
            returnSn,
            detailResult,
            detail.tracking_number,
          );
          const candidates = [
            rtn,
            detail.tracking_number,
            detail.return_shipping_number,
            detail.return_shipping_no,
            detail.return_tracking_number,
          ]
            .map((v) => String(v || "").trim())
            .filter(Boolean);
          const matchedTn = candidates.find((tn) => {
            const nk = tn.toUpperCase().replace(/[\s\-_#./\\|:;,]+/g, "");
            for (const sk of scanKeys) {
              const skn = sk.toUpperCase().replace(/[\s\-_#./\\|:;,]+/g, "");
              if (!skn || !nk) continue;
              if (nk === skn) return true;
              if (skn.length >= 10 && nk.length >= 10 && (nk.endsWith(skn) || skn.endsWith(nk))) {
                return true;
              }
            }
            return false;
          });
          if (!matchedTn) continue;
          const orderSn = String(detail.order_sn || row.orderSn || "").trim();
          if (!orderSn) continue;
          await applyWebhookReturnFallback(shopId, accessToken, orderSn, orders, returnSn);
          const hit = orders.find((o: any) => String(o.orderSn) === orderSn);
          if (hit) {
            if (isMongoReady()) {
              try {
                await bulkUpsertOrdersToStore([hit]);
              } catch {
                /* ignore */
              }
            }
            console.log(
              `[Orders Lookup] Return waybill hit code=${code} order_sn=${orderSn} return_sn=${returnSn} rtn=${matchedTn}`,
            );
            return hit;
          }
        }
      } catch (retLookupErr: any) {
        console.warn(
          `[Orders Lookup] return waybill resolve shop=${shopId}:`,
          retLookupErr?.message || retLookupErr,
        );
      }
    }

    const statuses = ["CANCELLED", "IN_CANCEL", "TO_RETURN", "SHIPPED", "PROCESSED"];
    for (const shopId of shopIds) {
      if (Date.now() > deadlineAt) break;
      try {
        let accessToken = await getValidShopeeAccessToken(shopId);
        if (!accessToken) continue;
        const snSet = new Set<string>();
        for (const st of statuses) {
          if (Date.now() > deadlineAt) break;
          const sns = await collectShopeeOrderSnsByStatus(shopId, accessToken, st, {
            lookbackSec: SHOPEE_HISTORY_LOOKBACK_SEC,
            deadlineAt,
          });
          for (const sn of sns) snSet.add(sn);
        }
        const snList = [...snSet];
        if (!snList.length) continue;
        console.log(
          `[Orders Lookup] Shopee on-demand scan tracking shop=${shopId} candidates=${snList.length} code=${code}`,
        );
        for (let i = 0; i < snList.length; i += SHOPEE_SYNC_CHUNK_SIZE) {
          if (Date.now() > deadlineAt) break;
          const chunk = snList.slice(i, i + SHOPEE_SYNC_CHUNK_SIZE);
          const fresh = await getValidShopeeAccessToken(shopId);
          if (fresh) accessToken = fresh;
          const { normalized } = await fetchNormalizeShopeeOrderChunk(
            shopId,
            accessToken,
            shopId,
            chunk,
            { enrichTracking: true, skipEscrow: true },
          );
          // Ưu tiên đơn đã có TN khớp trước khi persist cả chunk.
          let matched = normalized.find((o) => orderMatchesScan(o));
          if (!matched) {
            for (const o of normalized) {
              if (!needsShopeeTrackingEnrichment(o) && hasUsableShopeeTrackingNumber(o)) continue;
              try {
                await fetchAndForceSaveTrackingNumber(shopId, accessToken!, o, { retries: 1 });
              } catch {
                /* ignore */
              }
              if (orderMatchesScan(o)) {
                matched = o;
                break;
              }
            }
          }
          if (matched) {
            const hit = await persistAndReturn(shopId, accessToken!, [matched]);
            if (hit) {
              console.log(
                `[Orders Lookup] Shopee on-demand hit by tracking code=${code} order_sn=${hit.orderSn} shop=${shopId}`,
              );
              return hit;
            }
          } else if (normalized.length) {
            // Persist chunk để lần sau local lookup có data (kể cả chưa khớp mã này).
            await persistShopeeOrderChunk(orders, normalized, {
              apiShopId: shopId,
              accessToken,
              skipTracking: true,
            });
          }
          if (i + SHOPEE_SYNC_CHUNK_SIZE < snList.length) {
            await shopeeSyncDelay(200);
          }
        }
      } catch (err: any) {
        console.warn(
          `[Orders Lookup] Shopee tracking resolve shop=${shopId}:`,
          err?.message || err,
        );
      }
    }
  }

  return null;
}

const SHOPEE_ACTIVE_STATUS_RECONCILE_LIMIT_PER_SHOP = 150;

/**
 * get_order_list chỉ trả về cửa sổ update_time gần đây và bị hard-cap để không
 * treo cPanel. Vì vậy một đơn đã quét ĐVVC từ trước có thể còn PROCESSED mãi
 * trong Mongo dù Shopee thực tế đã SHIPPED. Khi người dùng đồng bộ thủ công,
 * lấy trực tiếp get_order_detail cho pool đơn đang chờ/đã xử lý trong Mongo.
 */
async function reconcileActiveShopeeOrdersFromStore(
  orders: any[],
  shopIds: string[],
  deadlineAt: number,
): Promise<{ pulled: number; added: number; updated: number; errors: any[] }> {
  const result = { pulled: 0, added: 0, updated: 0, errors: [] as any[] };
  if (!isMongoReady()) {
    result.errors.push({ error: "mongodb_not_ready", message: "MongoDB chưa sẵn sàng để đối soát đơn cũ." });
    return result;
  }

  let mongoOrders: any[];
  try {
    mongoOrders = await loadOrdersFromStore();
  } catch (error: any) {
    result.errors.push({
      error: "active_orders_read_failed",
      message: error?.message || String(error),
    });
    return result;
  }

  const allowedShops = new Set(shopIds.map((id) => String(id).trim()).filter(Boolean));
  const byShop = new Map<string, string[]>();
  const byShopPriority = new Map<string, string[]>(); // handed_over / processed trước
  for (const order of mongoOrders) {
    if (String(order?.channel || "") !== "shopee") continue;
    const shopId = String(order?.shopId || "").trim();
    const orderSn = String(order?.orderSn || "").replace(/^shopee-/i, "").trim();
    const raw = String(order?.shopee_order_status || "").toUpperCase();
    const local = String(order?.status || "").toLowerCase();
    const handed =
      order?.is_handed_over === true ||
      order?.isHandedOverToCarrier === true ||
      String(order?.local_status || order?.localStatus || "").toUpperCase() === "HANDED_OVER";
    // Ưu tiên đối soát đơn còn TO_SHIP (Đã xử lý / Đã giao ĐVVC) — bắt SHIPPED.
    const isPickupStuck =
      raw === "READY_TO_SHIP" ||
      raw === "RETRY_SHIP" ||
      raw === "PROCESSED" ||
      local === "unprocessed" ||
      local === "processed" ||
      handed;
    const requiresReconcile =
      isPickupStuck ||
      raw === "SHIPPED" ||
      raw === "TO_CONFIRM_RECEIVE" ||
      raw === "IN_CANCEL" ||
      raw === "TO_RETURN" ||
      local === "shipping" ||
      local === "return_pending";
    if (!requiresReconcile || !shopId || !orderSn || !allowedShops.has(shopId)) continue;
    const target = isPickupStuck ? byShopPriority : byShop;
    const sns = target.get(shopId) || [];
    if (sns.length < SHOPEE_ACTIVE_STATUS_RECONCILE_LIMIT_PER_SHOP && !sns.includes(orderSn)) {
      sns.push(orderSn);
      target.set(shopId, sns);
    }
  }
  // Gộp: priority trước, rồi phần còn lại (không trùng).
  for (const [shopId, sns] of byShopPriority) {
    const rest = byShop.get(shopId) || [];
    const merged = [...sns];
    for (const sn of rest) {
      if (merged.length >= SHOPEE_ACTIVE_STATUS_RECONCILE_LIMIT_PER_SHOP) break;
      if (!merged.includes(sn)) merged.push(sn);
    }
    byShop.set(shopId, merged);
  }

  for (const [shopIdRaw, orderSns] of byShop) {
    const shopId = String(normalizeShopIdKey(shopIdRaw) || shopIdRaw || "").trim();
    try {
      assertOrdersPullDeadline(deadlineAt, `active reconcile shop=${shopId}`);
      let auth: Awaited<ReturnType<typeof getShopeeAccessTokenForApi>> | null = null;
      try {
        auth = await getShopeeAccessTokenForApi(shopId);
      } catch (tokenErr: any) {
        console.error(
          `[Sync Shop ${shopId}] Lỗi: getShopeeAccessTokenForApi (active reconcile):`,
          tokenErr?.message || tokenErr,
        );
        result.errors.push({
          shopId,
          error: "token_exception",
          message: tokenErr?.message || String(tokenErr),
        });
        continue;
      }
      if (!auth?.token) {
        const fail = describeShopeeTokenFailure(shopId);
        console.error(
          `[Sync Shop ${shopId}] Lỗi: không lấy được access_token để đối soát đơn cũ` +
            ` (${fail?.error || "no_token"}: ${fail?.message || "unknown"})`,
        );
        result.errors.push({
          shopId,
          error: "no_valid_access_token",
          message: `Shop ${shopId}: không lấy được access_token để đối soát đơn cũ.`,
        });
        continue;
      }

      const apiShopId = String(auth.apiShopId || shopId).trim();
      syncDiag("Active status reconcile START", `shop=${shopId} candidates=${orderSns.length}`);
      for (let i = 0; i < orderSns.length; i += SHOPEE_SYNC_CHUNK_SIZE) {
        assertOrdersPullDeadline(deadlineAt, `active reconcile chunk shop=${shopId} offset=${i}`);
        const chunk = orderSns.slice(i, i + SHOPEE_SYNC_CHUNK_SIZE);
        try {
          const { normalized, errors } = await fetchNormalizeShopeeOrderChunk(
            apiShopId,
            auth.token,
            String(auth.fileKey || shopId),
            chunk,
            { enrichTracking: false, skipEscrow: true },
          );
          if (errors.length) result.errors.push(...errors);
          if (normalized.length === 0) continue;
          const persisted = await persistShopeeOrderChunk(orders, normalized, {
            apiShopId,
            accessToken: auth.token,
            skipTracking: true,
          });
          result.pulled += normalized.length;
          result.added += persisted.added;
          result.updated += persisted.updated;
          syncDiag(
            "Active status reconcile SAVED",
            `shop=${shopId} chunk=${Math.floor(i / SHOPEE_SYNC_CHUNK_SIZE) + 1} ` +
              `pulled=${normalized.length} +${persisted.added}/~${persisted.updated}`,
          );
        } catch (error: any) {
          if (String(error?.message || "").includes("ORDERS_PULL_DEADLINE")) throw error;
          result.errors.push({
            shopId,
            error: "active_reconcile_chunk_failed",
            message: error?.message || String(error),
            orderSns: chunk,
          });
          console.error(
            `[Sync Shop ${shopId}] Lỗi: active reconcile chunk:`,
            error?.stack || error?.message || error,
          );
        }
        if (i + SHOPEE_SYNC_CHUNK_SIZE < orderSns.length) {
          await shopeeSyncDelay(SHOPEE_SYNC_CHUNK_DELAY_MS);
        }
      }
    } catch (shopErr: any) {
      if (String(shopErr?.message || "").includes("ORDERS_PULL_DEADLINE")) {
        syncDiag("Active reconcile SHOP DEADLINE — continue next shop", shopErr.message);
        result.errors.push({ shopId, error: "pull_shop_deadline", message: shopErr.message });
        continue;
      }
      console.error(
        `[Sync Shop ${shopId}] Lỗi: active reconcile shop exception (isolated):`,
        shopErr?.message || shopErr,
        shopErr?.stack || "",
      );
      result.errors.push({
        shopId,
        error: "active_reconcile_shop_failed",
        message: shopErr?.message || String(shopErr),
      });
    }
  }
  return result;
}

/** Mutex + cooldown — tránh spam get_order_detail khi FE poll + cron chồng nhau. */
let handedOverStatusReconcileInFlight = false;
let lastHandedOverStatusReconcileAt = 0;
const HANDED_OVER_STATUS_RECONCILE_COOLDOWN_MS = 45_000;

/**
 * Targeted Healing: đơn Đã giao ĐVVC (is_handed_over) + đơn READY_TO_SHIP/PROCESSED chưa quét mã.
 * - Query Mongo TO_SHIP (không page/limit/checkpoint) — cửa sổ update_time incremental không đủ.
 * - Batch get_order_detail (≤20 SN/request) + delay giữa các mẻ.
 * - Khi Shopee báo SHIPPED / TO_CONFIRM_RECEIVE → bulkUpsert Mongo → tự nhảy tab Đang giao.
 * Không block HTTP: caller phải ACK rồi setImmediate / cron.
 */
async function reconcileHandedOverCarrierStatuses(opts?: {
  /** Legacy input, cố ý bỏ qua: Targeted Healing luôn quét tất cả candidates. */
  maxOrders?: number;
  shopIds?: string[];
  force?: boolean;
  trigger?: string;
}): Promise<{
  success: boolean;
  skipped?: boolean;
  pulled: number;
  updated: number;
  shipped: number;
  candidates: number;
  errors: any[];
  message: string;
}> {
  const trigger = String(opts?.trigger || "manual");
  const empty = {
    success: true,
    skipped: true as const,
    pulled: 0,
    updated: 0,
    shipped: 0,
    candidates: 0,
    errors: [] as any[],
    message: "",
  };

  if (handedOverStatusReconcileInFlight) {
    return { ...empty, message: "reconcile_in_flight" };
  }
  if (
    !opts?.force &&
    Date.now() - lastHandedOverStatusReconcileAt < HANDED_OVER_STATUS_RECONCILE_COOLDOWN_MS
  ) {
    return { ...empty, message: "cooldown" };
  }
  if (!isMongoReady()) {
    return {
      ...empty,
      success: false,
      skipped: false,
      message: "mongodb_not_ready",
    };
  }
  if (isOrdersPullLocked()) {
    return { ...empty, message: "orders_pull_locked" };
  }

  handedOverStatusReconcileInFlight = true;
  lastHandedOverStatusReconcileAt = Date.now();
  const result = {
    success: true,
    pulled: 0,
    updated: 0,
    shipped: 0,
    candidates: 0,
    errors: [] as any[],
    message: "",
  };

  try {
    const candidates = await loadAllHandedOverShopeeOrdersFromStore({
      shopIds: Array.isArray(opts?.shopIds) ? opts.shopIds : undefined,
    });
    result.candidates = candidates.length;
    if (candidates.length === 0) {
      result.message = "no_to_ship_candidates";
      console.log(`[HandedOver Reconcile][${trigger}] empty — không có đơn TO_SHIP/ĐVVC cần dò.`);
      return result;
    }

    const tokenShopIds = new Set(
      listShopeeSyncShopIds().map((id) => normalizeShopIdKey(id) || String(id).trim()).filter(Boolean),
    );
    const filterShopIds = Array.isArray(opts?.shopIds)
      ? new Set(
          opts.shopIds
            .map((id) => normalizeShopIdKey(id) || String(id).trim())
            .filter(Boolean),
        )
      : null;
    const byShop = new Map<string, string[]>();
    let skippedNoShop = 0;
    let skippedFilter = 0;
    for (const order of candidates) {
      const shopId =
        normalizeShopIdKey(order?.shopId) ||
        normalizeShopIdKey(order?.data?.shopId) ||
        String(order?.shopId || order?.data?.shopId || "").trim();
      const orderSn = String(order?.orderSn || "")
        .replace(/^shopee-/i, "")
        .trim();
      if (!orderSn) continue;
      if (!shopId) {
        skippedNoShop += 1;
        console.warn(
          `[HandedOver Reconcile] SKIP thiếu shopId order_sn=${orderSn}`,
        );
        continue;
      }
      // Chỉ lọc khi caller truyền shopIds tường minh — KHÔNG bỏ đơn chỉ vì
      // listShopeeSyncShopIds() lệch key (bug cũ: silent skip → 0 đơn được gọi API).
      if (filterShopIds && !filterShopIds.has(shopId)) {
        skippedFilter += 1;
        continue;
      }
      if (!tokenShopIds.has(shopId)) {
        console.warn(
          `[HandedOver Reconcile] shopId=${shopId} order_sn=${orderSn} không có trong token store — vẫn thử getShopeeAccessTokenForApi`,
        );
      }
      const sns = byShop.get(shopId) || [];
      if (!sns.includes(orderSn)) sns.push(orderSn);
      byShop.set(shopId, sns);
    }

    const workingOrders = [...candidates];
    console.log(
      `[HandedOver Reconcile][${trigger}] START candidates=${candidates.length}` +
        ` shops=${byShop.size} mode=targeted_to_ship` +
        ` skippedNoShop=${skippedNoShop} skippedFilter=${skippedFilter}` +
        ` tokenShops=[${[...tokenShopIds].join(",")}]`,
    );

    for (const [shopIdRaw, orderSns] of byShop) {
      const shopId = String(normalizeShopIdKey(shopIdRaw) || shopIdRaw || "").trim();
      try {
        let auth: Awaited<ReturnType<typeof getShopeeAccessTokenForApi>> | null = null;
        try {
          auth = await getShopeeAccessTokenForApi(shopId);
        } catch (tokenErr: any) {
          console.error(
            `[Sync Shop ${shopId}] Lỗi: getShopeeAccessTokenForApi (ĐVVC):`,
            tokenErr?.message || tokenErr,
            tokenErr?.stack || "",
          );
          result.errors.push({
            shopId,
            error: "token_exception",
            message: tokenErr?.message || String(tokenErr),
          });
          continue;
        }
        if (!auth?.token) {
          const fail = describeShopeeTokenFailure(shopId);
          console.error(
            `[Sync Shop ${shopId}] Lỗi: không lấy được access_token để dò ĐVVC` +
              ` (${fail?.error || "no_token"}: ${fail?.message || "unknown"})` +
              ` apiShopIdType=string`,
          );
          result.errors.push({
            shopId,
            error: "no_valid_access_token",
            message: `Shop ${shopId}: không lấy được access_token để dò ĐVVC.`,
          });
          continue;
        }

        const apiShopId = String(auth.apiShopId || shopId).trim();
        for (let i = 0; i < orderSns.length; i += SHOPEE_SYNC_CHUNK_SIZE) {
          const chunk = orderSns.slice(i, i + SHOPEE_SYNC_CHUNK_SIZE);
          try {
            const { normalized, errors } = await fetchNormalizeShopeeOrderChunk(
              apiShopId,
              auth.token,
              String(auth.fileKey || shopId),
              chunk,
              { enrichTracking: false, skipEscrow: true },
            );
            if (errors.length) result.errors.push(...errors);
            if (normalized.length === 0) continue;

            for (const n of normalized) {
              const raw = String(n?.shopee_order_status || "").toUpperCase();
              const local = String(n?.status || "").toLowerCase();
              if (
                raw === "SHIPPED" ||
                raw === "TO_CONFIRM_RECEIVE" ||
                local === "shipping" ||
                local === "completed"
              ) {
                result.shipped += 1;
              }
            }

            const persisted = await persistShopeeOrderChunk(workingOrders, normalized, {
              apiShopId,
              accessToken: auth.token,
              skipTracking: true,
            });
            result.pulled += normalized.length;
            result.updated += persisted.updated + persisted.added;
            syncDiag(
              "HandedOver status reconcile SAVED",
              `shop=${shopId} chunk=${Math.floor(i / SHOPEE_SYNC_CHUNK_SIZE) + 1}` +
                ` pulled=${normalized.length} upd=${persisted.updated}`,
            );
          } catch (chunkErr: any) {
            result.errors.push({
              shopId,
              error: "handed_over_reconcile_chunk_failed",
              message: chunkErr?.message || String(chunkErr),
              orderSns: chunk,
            });
            console.error(
              `[Sync Shop ${shopId}] Lỗi: HandedOver chunk failed:`,
              chunkErr?.message || chunkErr,
            );
          }
          if (i + SHOPEE_SYNC_CHUNK_SIZE < orderSns.length) {
            await shopeeSyncDelay(SHOPEE_SYNC_CHUNK_DELAY_MS);
          }
        }
      } catch (shopErr: any) {
        result.errors.push({
          shopId,
          error: "handed_over_reconcile_shop_failed",
          message: shopErr?.message || String(shopErr),
        });
        console.error(
          `[Sync Shop ${shopId}] Lỗi: HandedOver reconcile shop exception:`,
          shopErr?.message || shopErr,
          shopErr?.stack || "",
        );
      }
    }

    // Safety net: đơn đã SHIPPED+ mà còn cờ ĐVVC → clear (không gọi Shopee).
    try {
      const cleared = await clearHandedOverFlagsForShippedOrders();
      if (cleared.modified > 0) {
        result.shipped = Math.max(result.shipped, cleared.modified);
        console.log(
          `[HandedOver Reconcile] clearHandedOverFlags modified=${cleared.modified}`,
        );
      }
    } catch (clearErr: any) {
      console.warn(
        "[HandedOver Reconcile] clearHandedOverFlags failed:",
        clearErr?.message || clearErr,
      );
    }

    try {
      invalidateOrdersRefreshCache();
    } catch {
      /* ignore */
    }

    result.message =
      `dò ${result.candidates} đơn TO_SHIP/ĐVVC → pulled=${result.pulled}` +
      ` shipped≈${result.shipped} errors=${result.errors.length}`;
    console.log(`[HandedOver Reconcile][${trigger}] DONE ${result.message}`);
    return result;
  } catch (err: any) {
    result.success = false;
    result.message = err?.message || String(err);
    result.errors.push({ error: "handed_over_reconcile_failed", message: result.message });
    console.error(`[HandedOver Reconcile][${trigger}] FATAL:`, result.message);
    return result;
  } finally {
    handedOverStatusReconcileInFlight = false;
  }
}

const CLEANUP_STUCK_SHIPPED_MAX_ORDERS = 2000;
const CLEANUP_STUCK_SHIPPED_DELAY_MS = 200;
const CLEANUP_STUCK_SHIPPED_DEADLINE_MS = 20 * 60 * 1000;
const CLEANUP_STUCK_SHIPPED_RATE_LIMIT_RETRY_MS = 2000;
const CLEANUP_STUCK_SHIPPED_FLUSH_EVERY = 25;
const CLEANUP_STUCK_SHIPPED_MAX_ERROR_LOG = 80;
const SHOPEE_TERMINAL_FOR_CLEANUP = new Set([
  "COMPLETED",
  "CANCELLED",
  "IN_CANCEL",
  "TO_RETURN",
]);

let cleanupStuckShippedInFlight = false;
let lastCleanupStuckShipped: Record<string, unknown> | null = null;

function getCleanupStuckShippedStatus() {
  return {
    inFlight: cleanupStuckShippedInFlight,
    result: lastCleanupStuckShipped,
  };
}

function beginCleanupStuckShippedJob(): boolean {
  if (cleanupStuckShippedInFlight) return false;
  cleanupStuckShippedInFlight = true;
  lastCleanupStuckShipped = null;
  return true;
}

function isCleanupShopeeRateLimit(detail: any, err?: any): boolean {
  if (isShopeeRateLimited(Number(detail?.httpStatus) || 0, detail)) return true;
  const blob = `${detail?.error || ""} ${detail?.message || ""} ${err?.message || ""} ${detail?.httpStatus || ""}`.toLowerCase();
  return (
    blob.includes("rate") ||
    blob.includes("too many") ||
    blob.includes("429") ||
    Number(detail?.httpStatus) === 429
  );
}

/** Timeout / 5xx / mạng — retry, KHÔNG force COMPLETED (tránh xóa nhầm đơn thật). */
function isCleanupTransientError(detail: any, err?: any): boolean {
  if (isCleanupShopeeRateLimit(detail, err)) return true;
  const http = Number(detail?.httpStatus) || 0;
  if (http >= 500) return true;
  const blob = `${detail?.error || ""} ${detail?.message || ""} ${err?.message || ""} ${err?.code || ""}`.toLowerCase();
  return (
    blob.includes("timeout") ||
    blob.includes("timed out") ||
    blob.includes("econnreset") ||
    blob.includes("econnrefused") ||
    blob.includes("enotfound") ||
    blob.includes("network") ||
    blob.includes("socket") ||
    blob.includes("fetch failed")
  );
}

function collectCleanupDetailList(detail: any): any[] {
  if (Array.isArray(detail?.response?.order_list)) return detail.response.order_list;
  if (Array.isArray(detail?.order_list)) return detail.order_list;
  return [];
}

function findCleanupOrderRow(list: any[], orderSn: string): any | null {
  const sn = String(orderSn || "").replace(/^shopee-/i, "").trim();
  if (!sn || !Array.isArray(list)) return null;
  for (let i = 0; i < list.length; i += 1) {
    const rowSn = String(list[i]?.order_sn || "")
      .replace(/^shopee-/i, "")
      .trim();
    if (rowSn === sn) return list[i];
  }
  return null;
}

function pushCleanupError(errors: any[], item: Record<string, unknown>) {
  if (errors.length >= CLEANUP_STUCK_SHIPPED_MAX_ERROR_LOG) return;
  errors.push(item);
}

/**
 * Deep Clean tab Đang giao:
 * 1) Lấy TOÀN BỘ đơn SHIPPED (không lọc ngày).
 * 2) for...of tuần tự từng đơn + delay 200ms. Terminal → update.
 *    Lỗi ghost (invalid shop_id / not found / no permission / empty) → FORCE COMPLETED.
 * 3) Recalculate counts Dashboard. Không đụng tab khác.
 */
async function cleanupStuckShippedOrders(opts?: {
  shopIds?: string[];
  maxOrders?: number;
  trigger?: string;
  alreadyLocked?: boolean;
}): Promise<Record<string, unknown>> {
  const trigger = String(opts?.trigger || "manual");
  const empty = {
    success: true,
    skipped: true,
    candidates: 0,
    ancientForced: 0,
    ghostForced: 0,
    recentCandidates: 0,
    checked: 0,
    updated: 0,
    completed: 0,
    cancelled: 0,
    toReturn: 0,
    stillShipped: 0,
    skippedNoShop: 0,
    skippedTransient: 0,
    shops: 0,
    chunks: 0,
    shippingBefore: 0,
    shippingAfter: 0,
    counts: {} as Record<string, number>,
    errors: [] as any[],
    message: "",
  };

  if (!opts?.alreadyLocked) {
    if (!beginCleanupStuckShippedJob()) {
      return { ...empty, message: "cleanup_shipped_in_flight" };
    }
  }
  if (!isMongoReady()) {
    cleanupStuckShippedInFlight = false;
    const fail = {
      ...empty,
      success: false,
      skipped: false,
      message: "mongodb_not_ready",
    };
    lastCleanupStuckShipped = fail;
    return fail;
  }
  const startedAt = Date.now();
  const deadlineAt = startedAt + CLEANUP_STUCK_SHIPPED_DEADLINE_MS;
  const maxOrders = Math.min(
    Math.max(1, Math.floor(Number(opts?.maxOrders) || CLEANUP_STUCK_SHIPPED_MAX_ORDERS)),
    CLEANUP_STUCK_SHIPPED_MAX_ORDERS,
  );
  const shopIdsOpt = Array.isArray(opts?.shopIds) ? opts.shopIds : undefined;
  const result = {
    success: true,
    skipped: false,
    candidates: 0,
    ancientForced: 0,
    ghostForced: 0,
    recentCandidates: 0,
    checked: 0,
    updated: 0,
    completed: 0,
    cancelled: 0,
    toReturn: 0,
    stillShipped: 0,
    skippedNoShop: 0,
    skippedTransient: 0,
    shops: 0,
    chunks: 0,
    shippingBefore: 0,
    shippingAfter: 0,
    counts: {} as Record<string, number>,
    errors: [] as any[],
    message: "",
  };

  type CleanupPatch = {
    orderSn: string;
    shopId: string;
    shopee_order_status: string;
  };
  type CleanupAuth =
    | { ok: true; token: string; apiShopId: string }
    | { ok: false };

  try {
    const beforeCounts = await recalculateOrderTabCountsFromStore({
      shopIds: shopIdsOpt,
    });
    result.shippingBefore = Number(beforeCounts.shipping) || 0;

    // BƯỚC 1: toàn bộ đơn Đang giao — không lọc ngày.
    const keys = await loadStuckShippedOrderKeysFromStore({
      shopIds: shopIdsOpt,
      limit: maxOrders,
    });
    result.candidates = keys.length;
    result.recentCandidates = keys.length;

    const patches: CleanupPatch[] = [];
    const authCache = new Map<string, CleanupAuth>();
    const shopSeen = new Set<string>();

    const flushPatches = async () => {
      if (patches.length === 0) return;
      const batch = patches.splice(0, patches.length);
      const wrote = await bulkHealTerminalStatusesFromShopee(batch);
      result.updated += Number(wrote.modified || wrote.written || 0);
    };

    const queuePatch = async (patch: CleanupPatch) => {
      patches.push(patch);
      if (patches.length >= CLEANUP_STUCK_SHIPPED_FLUSH_EVERY) {
        await flushPatches();
      }
    };

    const forceGhostCompleted = async (orderSn: string, shopId: string, reason: string) => {
      result.ghostForced += 1;
      result.completed += 1;
      console.warn(
        `[Cleanup SHIPPED][${trigger}] FORCE COMPLETED order_sn=${orderSn} shop=${shopId || "-"} reason=${reason}`,
      );
      await queuePatch({
        orderSn,
        shopId,
        shopee_order_status: "COMPLETED",
      });
    };

    const resolveAuth = async (shopId: string): Promise<CleanupAuth> => {
      const key = String(normalizeShopIdKey(shopId) || shopId || "").trim();
      const cached = authCache.get(key);
      if (cached) return cached;
      try {
        const auth = await getShopeeAccessTokenForApi(shopId);
        if (!auth?.token) {
          const miss: CleanupAuth = { ok: false };
          authCache.set(key, miss);
          return miss;
        }
        const hit: CleanupAuth = {
          ok: true,
          token: auth.token,
          apiShopId: String(auth.apiShopId || shopId).trim(),
        };
        authCache.set(key, hit);
        return hit;
      } catch {
        const miss: CleanupAuth = { ok: false };
        authCache.set(key, miss);
        return miss;
      }
    };

    const fetchOrderDetailOnce = async (
      apiShopId: string,
      token: string,
      orderSn: string,
    ): Promise<{ detail: any; err?: any }> => {
      try {
        const detail = await shopeeGetOrderDetail(apiShopId, token, [orderSn]);
        return { detail };
      } catch (err: any) {
        return { detail: null, err };
      }
    };

    console.log(
      `[Cleanup SHIPPED][${trigger}] DEEP CLEAN START candidates=${keys.length}` +
        ` shippingBefore=${result.shippingBefore}` +
        ` delay=${CLEANUP_STUCK_SHIPPED_DELAY_MS}ms sequential=1`,
    );

    // BƯỚC 2: tuần tự từng đơn — KHÔNG Promise.all, KHÔNG chunk lớn.
    for (let i = 0; i < keys.length; i += 1) {
      if (Date.now() >= deadlineAt) {
        pushCleanupError(result.errors, {
          error: "deadline",
          message: `stopped at ${i}/${keys.length}`,
        });
        break;
      }

      const row = keys[i];
      const sn = String(row.orderSn || "").replace(/^shopee-/i, "").trim();
      if (!sn) continue;
      const shopId = String(normalizeShopIdKey(row.shopId) || row.shopId || "").trim();
      if (shopId) shopSeen.add(shopId);

      if (!shopId) {
        result.skippedNoShop += 1;
        await forceGhostCompleted(sn, "", "missing_shop_id");
        continue;
      }

      const auth = await resolveAuth(shopId);
      if (!auth.ok) {
        await forceGhostCompleted(sn, shopId, "invalid_shop_id_or_no_token");
        await shopeeSyncDelay(CLEANUP_STUCK_SHIPPED_DELAY_MS);
        continue;
      }

      let fetched = await fetchOrderDetailOnce(auth.apiShopId, auth.token, sn);
      let retries = 0;
      while (
        retries < 2 &&
        isCleanupTransientError(fetched.detail, fetched.err)
      ) {
        retries += 1;
        await shopeeSyncDelay(CLEANUP_STUCK_SHIPPED_RATE_LIMIT_RETRY_MS);
        fetched = await fetchOrderDetailOnce(auth.apiShopId, auth.token, sn);
      }

      result.checked += 1;

      if (isCleanupTransientError(fetched.detail, fetched.err)) {
        result.skippedTransient += 1;
        result.stillShipped += 1;
        pushCleanupError(result.errors, {
          orderSn: sn,
          shopId,
          error: "transient_skip",
          message: fetched.err?.message || fetched.detail?.error || "rate_limit_or_timeout",
        });
        await shopeeSyncDelay(CLEANUP_STUCK_SHIPPED_DELAY_MS);
        continue;
      }

      const detail = fetched.detail;
      const list = collectCleanupDetailList(detail);
      const hit = findCleanupOrderRow(list, sn);

      if (!hit) {
        const apiError = String(detail?.error || fetched.err?.message || "").trim();
        await forceGhostCompleted(
          sn,
          shopId,
          apiError ? `shopee_error:${apiError}` : "order_not_found_or_empty",
        );
        await shopeeSyncDelay(CLEANUP_STUCK_SHIPPED_DELAY_MS);
        continue;
      }

      const raw = String(hit.order_status || "").trim().toUpperCase();
      if (SHOPEE_TERMINAL_FOR_CLEANUP.has(raw)) {
        if (raw === "COMPLETED") result.completed += 1;
        else if (raw === "TO_RETURN") result.toReturn += 1;
        else result.cancelled += 1;
        await queuePatch({
          orderSn: sn,
          shopId,
          shopee_order_status: raw,
        });
      } else {
        result.stillShipped += 1;
      }

      await shopeeSyncDelay(CLEANUP_STUCK_SHIPPED_DELAY_MS);
    }

    result.shops = shopSeen.size;
    result.chunks = result.checked;
    await flushPatches();

    try {
      invalidateOrdersRefreshCache();
    } catch {
      /* ignore */
    }

    // BƯỚC 3: đếm lại badge Dashboard.
    const afterCounts = await recalculateOrderTabCountsFromStore({
      shopIds: shopIdsOpt,
    });
    result.shippingAfter = Number(afterCounts.shipping) || 0;
    result.counts = afterCounts;
    result.message =
      `deepClean candidates=${result.candidates} checked=${result.checked}` +
      ` ghostForced=${result.ghostForced} updated=${result.updated}` +
      ` completed=${result.completed} cancelled=${result.cancelled}` +
      ` toReturn=${result.toReturn} stillShipped=${result.stillShipped}` +
      ` skippedTransient=${result.skippedTransient}` +
      ` shipping ${result.shippingBefore}→${result.shippingAfter}` +
      ` ${Date.now() - startedAt}ms`;
    console.log(`[Cleanup SHIPPED][${trigger}] DONE ${result.message}`);
    lastCleanupStuckShipped = result;
    return result;
  } catch (err: any) {
    result.success = false;
    result.message = err?.message || String(err);
    result.errors.push({ error: "cleanup_shipped_failed", message: result.message });
    console.error(`[Cleanup SHIPPED][${trigger}] FATAL:`, result.message);
    lastCleanupStuckShipped = result;
    return result;
  } finally {
    cleanupStuckShippedInFlight = false;
  }
}

const MAX_CROSS_SHOP_PROBE_PER_CHUNK = 8;

/**
 * Thử get_order_detail trên các shop ủy quyền khác — shop nào trả đơn thì là chủ sở hữu.
 */
async function probeOrderDetailOnOtherShops(
  orderSn: string,
  skipShopId: string,
): Promise<{ shopId: string; apiShopId: string; token: string; detail: any } | null> {
  const sn = String(orderSn || "").replace(/^shopee-/i, "").trim();
  if (!sn) return null;
  const skip = String(normalizeShopIdKey(skipShopId) || skipShopId || "").trim();
  const shopIds = listShopeeSyncShopIds();
  for (const sid of shopIds) {
    const key = String(normalizeShopIdKey(sid) || sid || "").trim();
    if (!key || key === skip) continue;
    try {
      const auth = await getShopeeAccessTokenForApi(sid);
      if (!auth?.token) continue;
      const detail = await shopeeGetOrderDetail(auth.apiShopId || sid, auth.token, [sn]);
      if (detail?.error) {
        console.error(
          `[RemapShop] probe fail order_sn=${sn} shop=${key}: ${detail.error} ${detail.message || ""}`,
        );
        await shopeeSyncDelay(SHOPEE_ORDER_LIST_PAGE_DELAY_MS);
        continue;
      }
      const list = detail?.response?.order_list || detail?.order_list || [];
      const hit = Array.isArray(list)
        ? list.find((it: any) => String(it?.order_sn || "").trim() === sn)
        : null;
      if (hit) {
        console.log(`[RemapShop] probe HIT order_sn=${sn} owner_shop=${key}`);
        return {
          shopId: key,
          apiShopId: String(auth.apiShopId || sid),
          token: auth.token,
          detail: hit,
        };
      }
    } catch (err: any) {
      console.error(
        `[RemapShop] probe exception order_sn=${sn} shop=${key}:`,
        err?.message || err,
      );
    }
    await shopeeSyncDelay(SHOPEE_ORDER_LIST_PAGE_DELAY_MS);
  }
  return null;
}

/**
 * Remap shopId cho đơn bị gắn nhầm AuDIO↔LKAT:
 * Thử get_order_detail với TỪNG shop có token — shop nào trả đơn thì là chủ sở hữu.
 */
async function remapMisassignedOrderShopIds(orders: any[]): Promise<{
  checked: number;
  remapped: number;
  unchanged: number;
  notFound: number;
  details: any[];
}> {
  const details: any[] = [];
  let remapped = 0;
  let unchanged = 0;
  let notFound = 0;
  const shopIds = listShopeeSyncShopIds();
  if (!orders.length || !shopIds.length) {
    return { checked: 0, remapped: 0, unchanged: 0, notFound: 0, details: [] };
  }

  const authByShop = new Map<string, { token: string; apiShopId: string }>();
  for (const sid of shopIds) {
    try {
      const auth = await getShopeeAccessTokenForApi(sid);
      if (auth?.token) {
        authByShop.set(normalizeShopIdKey(sid) || sid, {
          token: auth.token,
          apiShopId: auth.apiShopId || sid,
        });
      }
    } catch (err: any) {
      console.warn(`[RemapShop] token fail shop=${sid}:`, err?.message || err);
    }
  }

  const toPersist: any[] = [];
  for (const order of orders) {
    const orderSn = String(order?.orderSn || "")
      .replace(/^shopee-/i, "")
      .trim();
    if (!orderSn) continue;
    const currentShop =
      normalizeShopIdKey(order?.shopId) || String(order?.shopId || "").trim();
    const currentName = order?.shopName || null;
    let ownerShop: string | null = null;
    let ownerRaw: string | null = null;
    let ownerHit: any = null;
    const probeErrors: any[] = [];

    for (const [sid, auth] of authByShop) {
      try {
        const detail = await shopeeGetOrderDetail(auth.apiShopId, auth.token, [orderSn]);
        const list = detail?.response?.order_list || detail?.order_list || [];
        const hit = Array.isArray(list)
          ? list.find((it: any) => String(it?.order_sn || "") === orderSn)
          : null;
        if (hit) {
          ownerShop = sid;
          ownerRaw = String(hit.order_status || "").toUpperCase() || null;
          ownerHit = hit;
          break;
        }
        if (detail?.error) {
          probeErrors.push({ shopId: sid, error: detail.error, message: detail.message });
        }
      } catch (err: any) {
        probeErrors.push({ shopId: sid, error: err?.message || String(err) });
      }
      await shopeeSyncDelay(SHOPEE_ORDER_LIST_PAGE_DELAY_MS);
    }

    if (!ownerShop) {
      notFound += 1;
      details.push({
        orderSn,
        currentShop,
        currentName: order?.shopName || null,
        action: "not_found_on_any_shop",
        probeErrors: probeErrors.slice(0, 4),
      });
      console.error(
        `[RemapShop] order_sn=${orderSn} không tìm thấy trên shop nào — GIỮ NGUYÊN status, KHÔNG hủy`,
      );
      continue;
    }

    const correctName =
      resolveConnectedShopDisplayName(ownerShop) || `Shop ${ownerShop}`;
    const existingRaw = String(order?.shopee_order_status || "").toUpperCase();
    const existingLocal = String(order?.status || "").toLowerCase();
    const wronglyCancelled =
      Boolean(order?.shopee_not_found || order?.data?.shopee_not_found) ||
      ((existingRaw === "CANCELLED" || existingLocal === "cancelled") &&
        ownerRaw &&
        ownerRaw !== "CANCELLED" &&
        ownerRaw !== "IN_CANCEL");
    const norm = ownerHit
      ? normalizeShopeeOrderDetail(ownerShop, correctName, ownerHit)
      : null;
    const persistRow = {
      ...(norm || order),
      shopId: ownerShop,
      shopName: correctName,
      _shop_owner_verified: true,
    };
    if (ownerShop === currentShop) {
      unchanged += 1;
      if (String(order.shopName || "") !== correctName || wronglyCancelled) {
        order.shopId = ownerShop;
        order.shopName = correctName;
        if (norm) {
          order.shopee_order_status = norm.shopee_order_status;
          order.status = norm.status;
        }
        toPersist.push(persistRow);
        details.push({
          orderSn,
          currentShop,
          ownerShop,
          action: wronglyCancelled ? "status_healed" : "name_fixed",
          shopName: correctName,
          shopee_raw: ownerRaw,
        });
      } else {
        details.push({
          orderSn,
          currentShop,
          ownerShop,
          action: "ok",
          shopee_raw: ownerRaw,
        });
      }
      continue;
    }

    remapped += 1;
    order.shopId = ownerShop;
    order.shopName = correctName;
    if (norm) {
      order.shopee_order_status = norm.shopee_order_status;
      order.status = norm.status;
    }
    toPersist.push(persistRow);
    details.push({
      orderSn,
      currentShop,
      currentName,
      ownerShop,
      shopName: correctName,
      action: wronglyCancelled ? "remapped_status_healed" : "remapped",
      shopee_raw: ownerRaw,
    });
    console.log(
      `[RemapShop] order_sn=${orderSn} ${currentShop}(${currentName || "-"}) → ${ownerShop}(${correctName})` +
        ` raw=${ownerRaw || "-"}`,
    );
  }

  if (toPersist.length && isMongoReady()) {
    try {
      await bulkUpsertOrdersToStore(toPersist);
      invalidateOrdersRefreshCache();
    } catch (err: any) {
      console.error("[RemapShop] bulkUpsert failed:", err?.message || err);
    }
  }

  return {
    checked: orders.length,
    remapped,
    unchanged,
    notFound,
    details,
  };
}

/**
 * Chữa cháy: đơn CANCELLED vì sai shop_id (cờ shopee_not_found) → probe shop khác, restore status.
 */
async function repairWrongShopCancelledOrders(opts?: {
  limit?: number;
}): Promise<{ checked: number; remapped: number; healed: number }> {
  const empty = { checked: 0, remapped: 0, healed: 0 };
  if (!isMongoReady()) return empty;
  const limit = Math.max(1, Math.min(20, Number(opts?.limit) || 12));
  let keys: Array<{ orderSn: string; shopId: string }> = [];
  try {
    keys = await findWrongShopCancelledCandidatesFromStore({
      limit,
      lookbackDays: 14,
    });
  } catch (err: any) {
    console.error("[RepairShop] find candidates failed:", err?.message || err);
    return empty;
  }
  if (!keys.length) return empty;
  let loaded: any[] = [];
  try {
    loaded = await loadOrdersFromStore({
      orderSns: keys.map((k) => k.orderSn),
    });
  } catch (loadErr: any) {
    console.error("[RepairShop] loadOrders failed:", loadErr?.message || loadErr);
    return empty;
  }
  if (!loaded.length) return empty;
  console.log(`[RepairShop] probe ${loaded.length} đơn CANCELLED/shopee_not_found...`);
  const result = await remapMisassignedOrderShopIds(loaded);
  const healed = (result.details || []).filter((d: any) =>
    String(d?.action || "").includes("heal") || String(d?.action || "") === "remapped",
  ).length;
  console.log(
    `[RepairShop] DONE checked=${result.checked} remapped=${result.remapped} healed≈${healed} notFound=${result.notFound}`,
  );
  return { checked: result.checked, remapped: result.remapped, healed };
}

/**
 * DEBUG / TEST: Ép chạy đồng bộ ĐVVC → SHIPPED ngay (await, JSON chi tiết).
 * Dùng cho GET /api/test-sync-shopee — không đoán mò, trả từng đơn + lỗi Shopee/DB.
 */
async function debugForceSyncHandedOverOrders(opts?: {
  maxOrders?: number;
  shopIds?: string[];
  remapOnly?: boolean;
}): Promise<Record<string, unknown>> {
  const startedAt = Date.now();
  const maxOrders = Math.min(
    Math.max(Number(opts?.maxOrders) || 150, 1),
    200,
  );
  const mongoReady = isMongoReady();
  const tokenShops = listShopeeSyncShopIds();
  const tabFilter = orderTabFilter("handed_over_carrier");

  const out: Record<string, unknown> = {
    success: false,
    endpoint: "GET /api/test-sync-shopee",
    mongoReady,
    tokenShops,
    shopNameCanonical: {
      "4127421": "LKAT",
      "831052930": "AuDIO",
    },
    tabFilterNote:
      "Mongo tab handed_over_carrier = TO_SHIP (READY_TO_SHIP|RETRY_SHIP|PROCESSED) AND is_handed_over=true (aliases legacy). CẤM SHIPPED.",
    tabFilter,
    maxOrders,
    candidatesFound: 0,
    candidatesSample: [] as any[],
    shopRemap: null as any,
    skipped: [] as any[],
    shopsQueued: {} as Record<string, string[]>,
    ordersDetail: [] as any[],
    summary: {
      shippedFromShopee: 0,
      stillToShipOnShopee: 0,
      apiOk: 0,
      apiFail: 0,
      dbUpdated: 0,
      dbFailed: 0,
      forcedShipping: 0,
    },
    reconcileResult: null as any,
    elapsedMs: 0,
    message: "",
  };

  if (!mongoReady) {
    out.message = "MongoDB chưa sẵn sàng — không thể dò/cập nhật.";
    out.elapsedMs = Date.now() - startedAt;
    return out;
  }

  try {
    const page = await queryOrdersPageFromStore({
      tab: "handed_over_carrier",
      page: 1,
      pageSize: maxOrders,
      skipCounts: true,
      shopIds: Array.isArray(opts?.shopIds) ? opts.shopIds : undefined,
    });
    const candidates = (page?.rows || []).filter(
      (o: any) => String(o?.channel || "").toLowerCase() === "shopee",
    );
    out.candidatesFound = candidates.length;
    out.candidatesSample = candidates.slice(0, 15).map((o: any) => ({
      orderSn: o.orderSn,
      shopId: o.shopId ?? null,
      shopName: o.shopName ?? null,
      status: o.status,
      shopee_order_status: o.shopee_order_status,
      is_handed_over: o.is_handed_over,
      isHandedOverToCarrier: o.isHandedOverToCarrier,
      local_status: o.local_status || o.localStatus || null,
      trackingNumber: o.trackingNumber || o.tracking_no || null,
    }));

    if (candidates.length === 0) {
      // Fallback diagnose: đếm thô is_handed_over không qua TO_SHIP
      try {
        const { default: mongoose } = await import("mongoose");
        const col = mongoose.connection?.db?.collection("orders");
        if (col) {
          const rawHanded = await col.countDocuments({
            $or: [
              { is_handed_over: true },
              { "data.is_handed_over": true },
              { "data.local_status": "HANDED_OVER" },
            ],
          });
          const rawShippedHanded = await col.countDocuments({
            $and: [
              {
                $or: [
                  { is_handed_over: true },
                  { "data.is_handed_over": true },
                ],
              },
              {
                $or: [
                  { shopee_order_status: { $in: ["SHIPPED", "TO_CONFIRM_RECEIVE"] } },
                  { "data.shopee_order_status": { $in: ["SHIPPED", "TO_CONFIRM_RECEIVE"] } },
                  { status: "shipping" },
                ],
              },
            ],
          });
          out.rawDiagnose = {
            count_is_handed_over_any: rawHanded,
            count_handed_but_already_SHIPPED_or_shipping: rawShippedHanded,
            hint:
              rawHanded === 0
                ? "DB không có đơn is_handed_over=true — FE badge có thể lệch cache."
                : rawShippedHanded > 0
                  ? "Có đơn vừa is_handed_over vừa SHIPPED — cần clearHandedOverFlags."
                  : "Có is_handed_over nhưng không khớp filter TO_SHIP (raw status lạ?).",
          };
        }
      } catch (diagErr: any) {
        out.rawDiagnoseError = diagErr?.message || String(diagErr);
      }
      out.message =
        "Tìm thấy 0 đơn tab handed_over_carrier theo filter Mongo. Xem rawDiagnose.";
      out.elapsedMs = Date.now() - startedAt;
      return out;
    }

    // BƯỚC 0: Sửa shopId gắn nhầm AuDIO↔LKAT — probe get_order_detail mọi shop.
    console.log(
      `[TEST-SYNC-SHOPEE] Remap shopId cho ${candidates.length} đơn (tokenShops=${tokenShops.join(",")})...`,
    );
    const remapResult = await remapMisassignedOrderShopIds(candidates);
    out.shopRemap = {
      checked: remapResult.checked,
      remapped: remapResult.remapped,
      unchanged: remapResult.unchanged,
      notFound: remapResult.notFound,
      details: remapResult.details.slice(0, 100),
    };
    out.candidatesSample = candidates.slice(0, 15).map((o: any) => ({
      orderSn: o.orderSn,
      shopId: o.shopId ?? null,
      shopName: o.shopName ?? null,
      status: o.status,
      shopee_order_status: o.shopee_order_status,
      is_handed_over: o.is_handed_over,
    }));
    if (opts?.remapOnly) {
      out.success = true;
      out.message =
        `Remap shopId xong — remapped=${remapResult.remapped}` +
        ` unchanged=${remapResult.unchanged} notFound=${remapResult.notFound}`;
      out.elapsedMs = Date.now() - startedAt;
      return out;
    }

    const tokenShopSet = new Set(
      tokenShops.map((id) => normalizeShopIdKey(id) || String(id)).filter(Boolean),
    );
    const byShop = new Map<string, typeof candidates>();
    const skipped: any[] = [];

    for (const order of candidates) {
      const shopId =
        normalizeShopIdKey(order?.shopId) ||
        String(order?.shopId || "").trim();
      const orderSn = String(order?.orderSn || "")
        .replace(/^shopee-/i, "")
        .trim();
      if (!orderSn) {
        skipped.push({ reason: "missing_orderSn", order });
        continue;
      }
      if (!shopId) {
        skipped.push({
          reason: "missing_shopId",
          orderSn,
          status: order.status,
          shopee_order_status: order.shopee_order_status,
        });
        continue;
      }
      const list = byShop.get(shopId) || [];
      list.push(order);
      byShop.set(shopId, list);
    }
    out.skipped = skipped;
    const shopsQueued: Record<string, string[]> = {};
    for (const [sid, rows] of byShop) {
      shopsQueued[sid] = rows.map((r) => String(r.orderSn));
    }
    out.shopsQueued = shopsQueued;

    const summary = out.summary as {
      shippedFromShopee: number;
      stillToShipOnShopee: number;
      apiOk: number;
      apiFail: number;
      dbUpdated: number;
      dbFailed: number;
      forcedShipping: number;
    };
    const ordersDetail: any[] = [];
    const workingOrders = [...candidates];

    for (const [shopId, rows] of byShop) {
      const orderSns = rows.map((r) =>
        String(r.orderSn || "")
          .replace(/^shopee-/i, "")
          .trim(),
      );
      let auth: Awaited<ReturnType<typeof getShopeeAccessTokenForApi>> | null = null;
      try {
        auth = await getShopeeAccessTokenForApi(shopId);
      } catch (authErr: any) {
        for (const sn of orderSns) {
          ordersDetail.push({
            orderSn: sn,
            shopId,
            inTokenStore: tokenShopSet.has(shopId),
            shopee_call: "fail",
            shopee_error: authErr?.message || String(authErr),
            db_upsert: "skipped",
          });
          summary.apiFail += 1;
        }
        continue;
      }
      if (!auth?.token) {
        for (const sn of orderSns) {
          ordersDetail.push({
            orderSn: sn,
            shopId,
            inTokenStore: tokenShopSet.has(shopId),
            shopee_call: "fail",
            shopee_error: "no_valid_access_token",
            db_upsert: "skipped",
          });
          summary.apiFail += 1;
        }
        continue;
      }

      for (let i = 0; i < orderSns.length; i += SHOPEE_SYNC_CHUNK_SIZE) {
        const chunk = orderSns.slice(i, i + SHOPEE_SYNC_CHUNK_SIZE);
        const beforeBySn = new Map(
          rows
            .filter((r) =>
              chunk.includes(
                String(r.orderSn || "")
                  .replace(/^shopee-/i, "")
                  .trim(),
              ),
            )
            .map((r) => [
              String(r.orderSn || "")
                .replace(/^shopee-/i, "")
                .trim(),
              r,
            ]),
        );
        try {
          const { normalized, errors } = await fetchNormalizeShopeeOrderChunk(
            auth.apiShopId,
            auth.token,
            auth.fileKey || shopId,
            chunk,
            { enrichTracking: false, skipEscrow: true },
          );
          const errBySn = new Map<string, any>();
          for (const e of errors || []) {
            const sn = String(e?.orderSn || e?.order_sn || "").trim();
            if (sn) errBySn.set(sn, e);
          }

          const normalizedBySn = new Map(
            (normalized || []).map((n: any) => [
              String(n.orderSn || "")
                .replace(/^shopee-/i, "")
                .trim(),
              n,
            ]),
          );

          for (const sn of chunk) {
            const before = beforeBySn.get(sn);
            const n = normalizedBySn.get(sn);
            const apiErr = errBySn.get(sn);
            if (!n) {
              ordersDetail.push({
                orderSn: sn,
                shopId,
                inTokenStore: tokenShopSet.has(shopId),
                db_before: {
                  status: before?.status,
                  shopee_order_status: before?.shopee_order_status,
                  is_handed_over: before?.is_handed_over,
                },
                shopee_call: "fail",
                shopee_error:
                  apiErr?.message ||
                  apiErr?.error ||
                  "get_order_detail không trả đơn này",
                db_upsert: "skipped",
              });
              summary.apiFail += 1;
              continue;
            }

            const raw = String(n.shopee_order_status || "").toUpperCase();
            const local = String(n.status || "").toLowerCase();
            const isShipped =
              raw === "SHIPPED" ||
              raw === "TO_CONFIRM_RECEIVE" ||
              local === "shipping";
            if (isShipped) {
              summary.shippedFromShopee += 1;
              // Ép cứng trước upsert
              n.status = "shipping";
              n.shopee_order_status =
                raw === "TO_CONFIRM_RECEIVE" ? "TO_CONFIRM_RECEIVE" : "SHIPPED";
              n.is_handed_over = false;
              summary.forcedShipping += 1;
            } else {
              summary.stillToShipOnShopee += 1;
            }
            summary.apiOk += 1;

            // uint64 sample log
            const item0 = Array.isArray(n.items) ? n.items[0] : null;
            const uint64Sample = item0
              ? {
                  productId: item0.productId ?? item0.item_id,
                  productIdType: typeof (item0.productId ?? item0.item_id),
                  modelId: item0.modelId ?? item0.model_id,
                  modelIdType: typeof (item0.modelId ?? item0.model_id),
                }
              : null;

            let dbUpsert: "ok" | "fail" = "ok";
            let dbErr: string | null = null;
            try {
              const persisted = await persistShopeeOrderChunk(
                workingOrders,
                [n],
                {
                  apiShopId: auth.apiShopId,
                  accessToken: auth.token,
                  skipTracking: true,
                },
              );
              if ((persisted.updated || 0) + (persisted.added || 0) > 0) {
                summary.dbUpdated += 1;
              } else {
                // vẫn coi là ok nếu không throw (có thể stale snapshot)
                summary.dbUpdated += 1;
              }
            } catch (upErr: any) {
              dbUpsert = "fail";
              dbErr = upErr?.message || String(upErr);
              summary.dbFailed += 1;
            }

            ordersDetail.push({
              orderSn: sn,
              shopId,
              apiShopId: auth.apiShopId,
              inTokenStore: tokenShopSet.has(shopId),
              db_before: {
                status: before?.status,
                shopee_order_status: before?.shopee_order_status,
                is_handed_over: before?.is_handed_over,
              },
              shopee_call: "ok",
              shopee_raw_status: raw,
              mapped_local_status: n.status,
              forced_shipping: isShipped,
              uint64_sample: uint64Sample,
              db_upsert: dbUpsert,
              db_upsert_error: dbErr,
              willLeaveDvvcTab: isShipped,
            });
          }
        } catch (chunkErr: any) {
          for (const sn of chunk) {
            ordersDetail.push({
              orderSn: sn,
              shopId,
              shopee_call: "fail",
              shopee_error: chunkErr?.message || String(chunkErr),
              db_upsert: "skipped",
            });
            summary.apiFail += 1;
          }
        }
        if (i + SHOPEE_SYNC_CHUNK_SIZE < orderSns.length) {
          await shopeeSyncDelay(SHOPEE_SYNC_CHUNK_DELAY_MS);
        }
      }
    }

    // Safety net clear flags
    let cleared = { matched: 0, modified: 0 };
    try {
      cleared = await clearHandedOverFlagsForShippedOrders();
    } catch (clearErr: any) {
      out.clearFlagsError = clearErr?.message || String(clearErr);
    }

    try {
      invalidateOrdersRefreshCache();
    } catch {
      /* ignore */
    }

    out.ordersDetail = ordersDetail;
    out.clearHandedOverFlags = cleared;
    out.success = true;
    out.message =
      `Tìm thấy ${candidates.length} đơn ĐVVC → API ok=${summary.apiOk}` +
      ` fail=${summary.apiFail} → Shopee SHIPPED=${summary.shippedFromShopee}` +
      ` vẫn TO_SHIP=${summary.stillToShipOnShopee}` +
      ` → DB updated≈${summary.dbUpdated} fail=${summary.dbFailed}` +
      ` → clearFlags modified=${cleared.modified}`;
    out.elapsedMs = Date.now() - startedAt;
    console.log(`[TEST-SYNC-SHOPEE] ${out.message}`);
    return out;
  } catch (err: any) {
    out.success = false;
    out.message = err?.message || String(err);
    out.elapsedMs = Date.now() - startedAt;
    console.error("[TEST-SYNC-SHOPEE] FATAL:", out.message);
    return out;
  }
}

/**
 * Kéo đơn mới từ Shopee (get_order_list → get_order_detail → Mongo upsert).
 * Fast path mặc định: BỎ qua get_tracking_number + escrow tuần tự (đây là chỗ từng
 * làm sync "quay vòng" hàng phút). Tracking bổ sung sau qua webhook / enrich riêng.
 */
async function pullIncrementalOrdersFromShopee(opts?: {
  lookbackSec?: number;
  shopIds?: string[];
  /** true = gọi tracking tuần tự (CHẬM). Mặc định false để tránh treo. */
  enrichTracking?: boolean;
  /**
   * Đối soát các đơn cũ còn ở READY_TO_SHIP/PROCESSED bằng get_order_detail.
   * Chỉ bật khi người dùng bấm đồng bộ thủ công; get_order_list theo update_time
   * không trả lại các đơn cũ bị kẹt trạng thái.
   */
  reconcileActive?: boolean;
  /**
   * Cron/auto: cho phép cửa sổ ngắn (< 3 ngày) — webhook đã real-time;
   * tránh mỗi 30 phút kéo 5 ngày → chồng job / process spike cPanel.
   */
  allowShortLookback?: boolean;
}): Promise<{
  success: boolean;
  pulled: number;
  added: number;
  updated: number;
  shops: number;
  errors: any[];
  message: string;
  skipped?: boolean;
  elapsedMs?: number;
  truncatedShops?: number;
  maxOrderSnsPerShop?: number;
  lookbackSec?: number;
  warnings?: any[];
  /** Raw get_order_list responses — trả về FE để debug. */
  shopee_response?: any;
  total_success?: number;
  failed_orders?: string[];
}> {
  if (!tryAcquireOrdersPullLock()) {
    syncDiag("Pull SKIPPED — already in flight", "mutex busy");
    return {
      success: true,
      pulled: 0,
      added: 0,
      updated: 0,
      shops: 0,
      errors: [],
      warnings: [
        {
          error: "pull_in_flight",
          message: ORDERS_PULL_IN_FLIGHT_SOFT_MESSAGE,
        },
      ],
      message: ORDERS_PULL_IN_FLIGHT_SOFT_MESSAGE,
      skipped: true,
      elapsedMs: 0,
      shopee_response: { skipped: true, reason: "pull_in_flight" },
    };
  }

  const startedAt = Date.now();
  const enrichTracking = opts?.enrichTracking === true;
  const errors: any[] = [];
  const shopeeResponsePages: any[] = [];
  const failedOrdersSet = new Set<string>();
  let pulled = 0;
  let added = 0;
  let updated = 0;
  let truncatedShops = 0;
  let shopIds: string[] = [];
  let lookbackSec = SHOPEE_ORDER_LIST_INCREMENTAL_SEC;
  let pullDeadlineMs = ORDERS_PULL_HARD_DEADLINE_MS;
  let perShopBudgetMs = ORDERS_PULL_PER_SHOP_MS;
  let longLookback = false;
  let deadlineAt = startedAt + pullDeadlineMs;

  try {
    // Materialize shop con (VD: 831052930) trước khi liệt kê — tránh bỏ sót pull/UI.
    ensureShopeeLinkedShopTokenKeys();
    const rawShopIds = opts?.shopIds?.length ? opts.shopIds : listShopeeSyncShopIds();
    shopIds = [];
    const seenShop = new Set();
    for (const raw of rawShopIds) {
      try {
        const resolved = resolveShopeeTokenShopId(raw) || normalizeShopIdKey(raw);
        if (resolved && !seenShop.has(resolved)) {
          seenShop.add(resolved);
          shopIds.push(resolved);
        }
      } catch (resolveErr: any) {
        console.warn(
          `[Orders Pull] resolveShopeeTokenShopId skip shop=${raw}:`,
          resolveErr?.message || resolveErr,
        );
      }
    }
    const rawLookback = Number(opts?.lookbackSec) || SHOPEE_ORDER_LIST_INCREMENTAL_SEC;
    const shortLookback = opts?.allowShortLookback === true;
    lookbackSec = clampShopeeHistoryLookbackSec(rawLookback, shortLookback);
    longLookback = lookbackSec >= 168 * 3600;
    // Mỗi shop có ngân sách riêng — shop 2 không bị SKIP vì shop 1 đã dùng hết 90s chung.
    perShopBudgetMs = shortLookback
      ? ORDERS_PULL_PER_SHOP_MS
      : longLookback
        ? ORDERS_PULL_PER_SHOP_LONG_MS
        : ORDERS_PULL_PER_SHOP_MS;
    pullDeadlineMs = perShopBudgetMs * Math.max(1, shopIds.length);
    deadlineAt = startedAt + pullDeadlineMs;

    if (shopIds.length === 0) {
      return {
        success: false,
        pulled: 0,
        added: 0,
        updated: 0,
        shops: 0,
        errors: [{ error: "no_oauth_shop", message: "Chưa có shop Shopee OAuth." }],
        message: "Chưa có shop Shopee OAuth — cần ủy quyền lại.",
        elapsedMs: Date.now() - startedAt,
        shopee_response: { error: "no_oauth_shop" },
      };
    }

    // MongoDB là SSOT: pull/merge không được lấy orders.json cũ làm base.
    let orders: any[] = [];
    if (isMongoReady()) {
      try {
        orders = await loadOrdersFromStore();
      } catch (loadErr: any) {
        if (isMongoConnectionError(loadErr)) {
          console.warn(
            "[Orders Pull] loadOrdersFromStore timeout/network — thử reconnect:",
            loadErr?.message || loadErr,
          );
          const ok = await recoverMongoConnection("orders_pull_load");
          if (ok) {
            try {
              orders = await loadOrdersFromStore();
            } catch (retryErr: any) {
              errors.push({
                error: "mongo_load_failed",
                message: describeMongoWriteError(retryErr),
              });
              return {
                success: false,
                pulled: 0,
                added: 0,
                updated: 0,
                shops: shopIds.length,
                errors,
                message: describeMongoWriteError(retryErr),
                elapsedMs: Date.now() - startedAt,
                lookbackSec,
                shopee_response: [],
              };
            }
          } else {
            const friendly = describeMongoWriteError(loadErr);
            errors.push({ error: "mongo_reconnect_failed", message: friendly });
            return {
              success: false,
              pulled: 0,
              added: 0,
              updated: 0,
              shops: shopIds.length,
              errors,
              message: friendly,
              elapsedMs: Date.now() - startedAt,
              lookbackSec,
              shopee_response: [],
            };
          }
        } else {
          throw loadErr;
        }
      }
    }
    // Mỗi shop nhận đủ perShopBudgetMs — không chia fair-share làm shop 2 bị cắt.
    const perShopResults: Array<{
      shopId: string;
      status: string;
      sn: number;
      pulled: number;
      added: number;
      updated: number;
      error?: string;
    }> = [];
    syncDiag(
      "Pull START",
      `shops=${shopIds.length} ids=[${shopIds.join(",")}] lookback=${lookbackSec}s` +
        ` short=${shortLookback} deadline=${pullDeadlineMs}ms perShop=${perShopBudgetMs}ms` +
        ` enrichTracking=${enrichTracking} longLookback=${longLookback}`,
    );
    console.log(
      `[Orders Pull] Bắt đầu chạy tiến trình ngầm — shops=${shopIds.length} ids=[${shopIds.join(",")}] lookbackSec=${lookbackSec}`,
    );

    // TUẦN TỰ từng shop — CẤM mapWithConcurrency đa shop khi cùng mutate `orders`
    // (unshift/findIndex song song → race → crash/HTTP 500 HTML).
    for (let shopIdx = 0; shopIdx < shopIds.length; shopIdx++) {
      const shopId = shopIds[shopIdx];
      const remainingMs = Math.max(0, deadlineAt - Date.now());
      const shopBudgetMs = perShopBudgetMs;
      let shopPulled = 0;
      let shopAdded = 0;
      let shopUpdated = 0;
      let shopSn = 0;
      let shopStatus = "pending";
      let shopErrorMsg = "";

      try {
        await yieldToLogisticsIfBusy(12_000);
        // Cấp đủ thời gian từng shop; chỉ SKIP khi đã vượt deadline toàn phiên (n shop × perShop).
        if (Date.now() >= deadlineAt) {
          console.error(
            `[Orders Pull] shopId=${shopId} SKIP — deadlineAt đã qua (elapsed=${Date.now() - startedAt}ms remaining=${remainingMs}ms)`,
          );
          errors.push({
            shopId,
            error: "pull_deadline",
            message: `Hết thời gian pull trước shop ${shopId}`,
          });
          perShopResults.push({
            shopId,
            status: "SKIP",
            sn: 0,
            pulled: 0,
            added: 0,
            updated: 0,
            error: "pull_deadline",
          });
          continue;
        }

        const shopDeadlineAt = Math.min(deadlineAt, Date.now() + shopBudgetMs);
        const shopIdStr = String(normalizeShopIdKey(shopId) || shopId || "").trim();
        console.log(
          `[Sync Shop ${shopIdStr}] START idx=${shopIdx + 1}/${shopIds.length}` +
            ` typeofShopId=${typeof shopId} budgetMs=${shopDeadlineAt - Date.now()}` +
            ` remainingGlobal=${deadlineAt - Date.now()}ms`,
        );
        try {
          assertOrdersPullDeadline(shopDeadlineAt, `before shop=${shopIdStr}`);
          let accessToken: string | null = null;
          try {
            accessToken = await getValidShopeeAccessToken(shopIdStr);
          } catch (tokenErr: any) {
            console.error(
              `[Sync Shop ${shopIdStr}] Lỗi: getValidShopeeAccessToken exception:`,
              tokenErr?.message || tokenErr,
              tokenErr?.stack || "",
            );
            errors.push({
              shopId: shopIdStr,
              error: "token_exception",
              message: tokenErr?.message || String(tokenErr),
            });
            shopStatus = "ERROR";
            shopErrorMsg = "token_exception";
            perShopResults.push({
              shopId: shopIdStr,
              status: shopStatus,
              sn: 0,
              pulled: 0,
              added: 0,
              updated: 0,
              error: shopErrorMsg,
            });
            continue;
          }
          if (!accessToken) {
            const fail = describeShopeeTokenFailure(shopIdStr);
            const msg =
              `Shop ${shopIdStr}: không lấy được access_token hợp lệ` +
              ` (${fail?.error || "no_token"}: ${fail?.message || "unknown"}).` +
              ` Token có thể hết hạn / clone — vào Cài đặt → Ủy quyền lại ĐÚNG shop ${shopIdStr}.`;
            console.error(`[Sync Shop ${shopIdStr}] Lỗi: ${msg}`);
            errors.push({ shopId: shopIdStr, error: "no_valid_access_token", message: msg });
            shopStatus = "ERROR";
            shopErrorMsg = "no_valid_access_token";
            perShopResults.push({
              shopId: shopIdStr,
              status: shopStatus,
              sn: 0,
              pulled: 0,
              added: 0,
              updated: 0,
              error: shopErrorMsg,
            });
            continue;
          }

          // Xác minh token thật sự thuộc shop này trước khi get_order_list.
          try {
            const verified = await verifyShopeeShopToken(shopIdStr, accessToken);
            if (!verified?.ok) {
              const msg =
                `Shop ${shopIdStr}: token không hợp lệ với Shopee (${verified?.error || "verify_failed"}).` +
                ` Cần OAuth lại shop ${shopIdStr}.`;
              console.error(`[Sync Shop ${shopIdStr}] Lỗi: ${msg}`);
              errors.push({ shopId: shopIdStr, error: "token_shop_mismatch", message: msg });
              shopStatus = "ERROR";
              shopErrorMsg = "token_shop_mismatch";
              perShopResults.push({
                shopId: shopIdStr,
                status: shopStatus,
                sn: 0,
                pulled: 0,
                added: 0,
                updated: 0,
                error: shopErrorMsg,
              });
              continue;
            }
          } catch (verifyErr: any) {
            console.warn(
              `[Sync Shop ${shopIdStr}] Lỗi: verify skip:`,
              verifyErr?.message || verifyErr,
            );
          }

          const listCollect = await collectShopeeOrderSnsIncremental(shopIdStr, accessToken, {
            lookbackSec,
            deadlineAt: shopDeadlineAt,
            allowShortLookback: shortLookback,
          });
          let orderSnList = Array.isArray(listCollect?.orderSns) ? listCollect.orderSns : [];
          shopSn = orderSnList.length;
          if (listCollect?.truncated) truncatedShops += 1;
          if (Array.isArray(listCollect?.shopeeResponses) && listCollect.shopeeResponses.length) {
            shopeeResponsePages.push(...listCollect.shopeeResponses);
            // Nếu get_order_list lỗi và không có SN nào → đẩy lỗi rõ ràng lên FE (không nuốt thành "0 đơn").
            if (orderSnList.length === 0) {
              for (const page of listCollect.shopeeResponses) {
                const rawErr = page?.raw?.error || page?.error;
                if (!rawErr) continue;
                const msg =
                  page?.raw?.message ||
                  page?.detail ||
                  String(rawErr);
                logShopeeSyncApiError(page?.raw || page, `pull shop_id=${shopIdStr}`);
                console.error(`[Sync Shop ${shopIdStr}] Lỗi: get_order_list ${msg}`);
                errors.push({
                  shopId: shopIdStr,
                  error: String(rawErr),
                  message: `get_order_list: ${msg}`,
                });
                shopErrorMsg = String(rawErr);
              }
            }
          }

          // KHÔNG lọc theo order_status — kéo ALL từ get_order_list.
          // Lookback SHIPPED 1–3 ngày: bắt đơn Shopee đã SHIPPED nhưng Mongo còn READY_TO_SHIP/PROCESSED.
          if (Date.now() < shopDeadlineAt) {
            try {
              const shippedLookbackSec = Math.max(
                24 * 60 * 60,
                Math.min(
                  3 * 24 * 60 * 60,
                  Number(process.env.AUTO_SHIPPED_LOOKBACK_SEC) || SHOPEE_SHIPPED_LOOKBACK_SEC,
                ),
              );
              const shippedSns = await collectShopeeOrderSnsByStatus(
                shopIdStr,
                accessToken,
                "SHIPPED",
                {
                  lookbackSec: shippedLookbackSec,
                  deadlineAt: shopDeadlineAt,
                  timeRangeField: "update_time",
                  allowShortLookback: true,
                },
              );
              if (shippedSns.length) {
                const snSet = new Set(orderSnList);
                let addedShipped = 0;
                const localBySn = new Map<string, any>();
                try {
                  const localDocs = await loadOrdersFromStore({ orderSns: shippedSns });
                  for (const o of localDocs || []) {
                    const sn = String(o?.orderSn || "")
                      .replace(/^shopee-/i, "")
                      .trim();
                    if (sn) localBySn.set(sn, o);
                  }
                } catch (localErr: any) {
                  console.warn(
                    `[Sync Shop ${shopIdStr}] SHIPPED lookback local lookup skip:`,
                    localErr?.message || localErr,
                  );
                }
                for (const sn of shippedSns) {
                  if (!sn || snSet.has(sn)) continue;
                  const local = localBySn.get(sn);
                  const raw = String(local?.shopee_order_status || "").toUpperCase();
                  if (
                    local &&
                    (raw === "SHIPPED" ||
                      raw === "TO_CONFIRM_RECEIVE" ||
                      raw === "COMPLETED")
                  ) {
                    continue;
                  }
                  snSet.add(sn);
                  addedShipped += 1;
                }
                if (addedShipped > 0) {
                  orderSnList = [...snSet];
                  shopSn = orderSnList.length;
                  syncDiag(
                    "SHIPPED lookback merged",
                    `shop=${shopIdStr} +${addedShipped} sn get_order_list SHIPPED lookback=${shippedLookbackSec}s total=${orderSnList.length}`,
                  );
                  console.log(
                    `[Orders Pull] shopId=${shopIdStr} SHIPPED lookback +${addedShipped} sn (list=${shippedSns.length} window=${shippedLookbackSec}s)`,
                  );
                }
              }
            } catch (shippedErr: any) {
              console.warn(
                `[Sync Shop ${shopIdStr}] SHIPPED lookback skip:`,
                shippedErr?.message || shippedErr,
              );
            }
          }

          // Lookback COMPLETED: heal đơn Mongo còn SHIPPED/shipping dù Shopee đã giao xong.
          if (Date.now() < shopDeadlineAt) {
            try {
              const completedLookbackSec = Math.max(
                24 * 60 * 60,
                Math.min(
                  15 * 24 * 60 * 60,
                  Number(process.env.AUTO_COMPLETED_LOOKBACK_SEC) || SHOPEE_COMPLETED_LOOKBACK_SEC,
                ),
              );
              const completedSns = await collectShopeeOrderSnsByStatus(
                shopIdStr,
                accessToken,
                "COMPLETED",
                {
                  lookbackSec: completedLookbackSec,
                  deadlineAt: shopDeadlineAt,
                  timeRangeField: "update_time",
                  allowShortLookback: true,
                },
              );
              if (completedSns.length) {
                const snSet = new Set(orderSnList);
                let addedCompleted = 0;
                const localBySn = new Map<string, any>();
                try {
                  const localDocs = await loadOrdersFromStore({ orderSns: completedSns });
                  for (const o of localDocs || []) {
                    const sn = String(o?.orderSn || "")
                      .replace(/^shopee-/i, "")
                      .trim();
                    if (sn) localBySn.set(sn, o);
                  }
                } catch (localErr: any) {
                  console.warn(
                    `[Sync Shop ${shopIdStr}] COMPLETED lookback local lookup skip:`,
                    localErr?.message || localErr,
                  );
                }
                for (const sn of completedSns) {
                  if (!sn || snSet.has(sn)) continue;
                  const local = localBySn.get(sn);
                  const raw = String(local?.shopee_order_status || "").toUpperCase();
                  const localStatus = String(local?.status || "");
                  if (local && raw === "COMPLETED" && localStatus === "completed") continue;
                  snSet.add(sn);
                  addedCompleted += 1;
                }
                if (addedCompleted > 0) {
                  orderSnList = [...snSet];
                  shopSn = orderSnList.length;
                  syncDiag(
                    "COMPLETED lookback merged",
                    `shop=${shopIdStr} +${addedCompleted} sn get_order_list COMPLETED lookback=${completedLookbackSec}s total=${orderSnList.length}`,
                  );
                  console.log(
                    `[Orders Pull] shopId=${shopIdStr} COMPLETED lookback +${addedCompleted} sn (list=${completedSns.length} window=${completedLookbackSec}s)`,
                  );
                }
              }
            } catch (completedErr: any) {
              console.warn(
                `[Sync Shop ${shopIdStr}] COMPLETED lookback skip:`,
                completedErr?.message || completedErr,
              );
            }
          }

          // Lịch sử Hủy/RTS: get_order_list status=CANCELLED|IN_CANCEL — cửa sổ cứng 30 ngày.
          if (!shortLookback && Date.now() < shopDeadlineAt) {
            try {
              const cancelLookbackSec = SHOPEE_HISTORY_LOOKBACK_SEC;
              const cancelStatuses = ["CANCELLED", "IN_CANCEL"];
              const snSet = new Set(orderSnList);
              let addedCancel = 0;
              for (const st of cancelStatuses) {
                if (Date.now() >= shopDeadlineAt) break;
                const sns = await collectShopeeOrderSnsByStatus(shopIdStr, accessToken, st, {
                  lookbackSec: cancelLookbackSec,
                  deadlineAt: shopDeadlineAt,
                  timeRangeField: "update_time",
                });
                for (const sn of sns) {
                  if (!sn || snSet.has(sn)) continue;
                  snSet.add(sn);
                  addedCancel += 1;
                }
              }
              if (addedCancel > 0) {
                orderSnList = [...snSet];
                shopSn = orderSnList.length;
                syncDiag(
                  "CANCELLED 30d merged",
                  `shop=${shopIdStr} +${addedCancel} sn lookback=${cancelLookbackSec}s total=${orderSnList.length}`,
                );
              }
            } catch (cancelErr: any) {
              console.warn(
                `[Sync Shop ${shopIdStr}] CANCELLED 30d lookback skip:`,
                cancelErr?.message || cancelErr,
              );
            }
          }

          // MỌI pull (kể cả cron/Quick): bổ sung order_sn từ get_return_list (TO_RETURN).
          if (Date.now() < shopDeadlineAt) {
            try {
              const returnRows = await shopeeFetchAllReturnSns(shopIdStr, accessToken, {
                mode: "full",
                maxPages: SHOPEE_RETURN_LIST_MAX_PAGES,
              });
              const snSet = new Set(orderSnList);
              let addedFromReturns = 0;
              for (const row of returnRows || []) {
                const sn = String(row?.orderSn || "").trim();
                if (!sn || snSet.has(sn)) continue;
                snSet.add(sn);
                addedFromReturns += 1;
              }
              if (addedFromReturns > 0) {
                orderSnList = [...snSet];
                shopSn = orderSnList.length;
                syncDiag(
                  "Return list merged",
                  `shop=${shopIdStr} +${addedFromReturns} order_sn from get_return_list (total=${orderSnList.length})`,
                );
              }
            } catch (returnErr: any) {
              console.error(
                `[Sync Shop ${shopIdStr}] Lỗi: shopeeFetchAllReturnSns skip:`,
                returnErr?.message || returnErr,
              );
            }
          }

          if (listCollect?.truncated) {
            syncDiag(
              "Pagination truncated",
              `shop=${shopId} sn=${orderSnList.length} — deadline hoặc safetyCap, chưa more=false`,
            );
          }

          syncDiag("Order list received (shop total)", `${orderSnList.length} orders shop=${shopId}`);
          console.log(
            `[Orders Pull] shopId=${shopId} list sn=${orderSnList.length}`,
          );

          if (orderSnList.length === 0) {
            shopStatus = shopErrorMsg ? "ERROR" : "DONE";
            console.log(
              `[Orders Pull] shopId=${shopId} DONE sn=0 pulled=0` +
                (shopErrorMsg ? ` err=${shopErrorMsg}` : ""),
            );
            perShopResults.push({
              shopId,
              status: shopStatus,
              sn: 0,
              pulled: 0,
              added: 0,
              updated: 0,
              error: shopErrorMsg || undefined,
            });
            continue;
          }

          for (let i = 0; i < orderSnList.length; i += SHOPEE_SYNC_CHUNK_SIZE) {
            try {
              assertOrdersPullDeadline(shopDeadlineAt, `detail chunk shop=${shopId} offset=${i}`);
              const chunkSns = orderSnList.slice(i, i + SHOPEE_SYNC_CHUNK_SIZE);
              const chunkNo = Math.floor(i / SHOPEE_SYNC_CHUNK_SIZE) + 1;
              try {
                const fresh = await getValidShopeeAccessToken(shopIdStr);
                if (fresh) accessToken = fresh;

                syncDiag(
                  "Fetching details for chunk...",
                  `shop=${shopIdStr} chunk=${chunkNo} count=${chunkSns.length} sn=${chunkSns.slice(0, 3).join(",")}`,
                );
                const {
                  normalized,
                  errors: chunkErrors,
                  failed_orders: chunkFailed = [],
                } = await fetchNormalizeShopeeOrderChunk(
                  shopIdStr,
                  accessToken,
                  shopIdStr,
                  chunkSns,
                  { enrichTracking: false, skipEscrow: true },
                );
                if (Array.isArray(chunkErrors) && chunkErrors.length) errors.push(...chunkErrors);
                for (const sn of chunkFailed) {
                  if (sn) failedOrdersSet.add(String(sn));
                }

                if (!Array.isArray(normalized) || normalized.length === 0) {
                  console.warn(
                    `[Orders Pull] shopId=${shopId} get_order_detail normalize rỗng cho ${chunkSns.length} sn — ${chunkSns.join(",")}`,
                  );
                  continue;
                }

                syncDiag("Saving to MongoDB...", `shop=${shopId} chunk=${chunkNo} docs=${normalized.length}`);
                // Bọc riêng logic lưu DB — lỗi map/BulkWrite phải log + đẩy lên FE, không nuốt.
                try {
                  const upsert = await persistShopeeOrderChunk(orders, normalized, {
                    apiShopId: shopIdStr,
                    accessToken,
                    // Persist TRƯỚC — logistics/tracking chạy sau, fail không drop đơn.
                    skipTracking: true,
                  });
                  added += upsert.added;
                  updated += upsert.updated;
                  pulled += normalized.length;
                  shopPulled += normalized.length;
                  shopAdded += upsert.added;
                  shopUpdated += upsert.updated;
                  syncDiag(
                    "MongoDB save OK",
                    `shop=${shopIdStr} +${upsert.added}/~${upsert.updated} elapsed=${Date.now() - startedAt}ms`,
                  );
                } catch (saveErr: any) {
                  const friendly = describeMongoWriteError(saveErr);
                  console.error(
                    `[Sync Shop ${shopIdStr}] Lỗi: Mongo/JSON upsert FAILED:`,
                    friendly,
                    saveErr?.message || saveErr,
                    saveErr?.stack || "",
                    "order_sn=",
                    normalized.map((o) => o?.orderSn).join(","),
                  );
                  if (isMongoConnectionError(saveErr)) {
                    void recoverMongoConnection("orders_pull_upsert");
                  }
                  errors.push({
                    shopId: shopIdStr,
                    error: "db_upsert_failed",
                    message: friendly,
                    orderSns: normalized.map((o) => o?.orderSn),
                  });
                  shopErrorMsg = "db_upsert_failed";
                }
              } catch (chunkErr: any) {
                if (String(chunkErr?.message || "").includes("ORDERS_PULL_DEADLINE")) throw chunkErr;
                console.error(
                  `[Sync Shop ${shopIdStr}] Lỗi: Chunk exception:`,
                  chunkErr?.message || chunkErr,
                  chunkErr?.stack || "",
                );
                errors.push({
                  shopId: shopIdStr,
                  error: "chunk_failed",
                  message: chunkErr?.message || String(chunkErr),
                });
                shopErrorMsg = chunkErr?.message || "chunk_failed";
              }
              if (i + SHOPEE_SYNC_CHUNK_SIZE < orderSnList.length) {
                await yieldToLogisticsIfBusy(8_000);
                await shopeeSyncDelay(
                  isLogisticsBusy() ? Math.max(SHOPEE_SYNC_CHUNK_DELAY_MS, 600) : SHOPEE_SYNC_CHUNK_DELAY_MS,
                );
              }
            } catch (loopErr: any) {
              if (String(loopErr?.message || "").includes("ORDERS_PULL_DEADLINE")) throw loopErr;
              console.error(
                `[Orders Pull] shopId=${shopId} Loop exception offset=${i}:`,
                loopErr?.message || loopErr,
              );
              errors.push({
                shopId,
                error: "chunk_loop_failed",
                message: loopErr?.message || String(loopErr),
              });
              shopErrorMsg = loopErr?.message || "chunk_loop_failed";
            }
          }
          shopStatus = shopErrorMsg && shopPulled === 0 ? "ERROR" : "DONE";
          console.log(
            `[Orders Pull] shopId=${shopId} ${shopStatus} sn=${shopSn} pulled=${shopPulled}` +
              ` +${shopAdded}/~${shopUpdated}` +
              (shopErrorMsg ? ` err=${shopErrorMsg}` : ""),
          );
          perShopResults.push({
            shopId,
            status: shopStatus,
            sn: shopSn,
            pulled: shopPulled,
            added: shopAdded,
            updated: shopUpdated,
            error: shopErrorMsg || undefined,
          });
        } catch (shopErr: any) {
          const sid = String(normalizeShopIdKey(shopId) || shopId || "").trim();
          if (String(shopErr?.message || "").includes("ORDERS_PULL_DEADLINE")) {
            syncDiag("SHOP DEADLINE — continue next shop", shopErr.message);
            console.error(
              `[Sync Shop ${sid}] Lỗi: SKIP — shop deadline: ${shopErr.message}`,
            );
            errors.push({
              shopId: sid,
              error: "pull_shop_deadline",
              message: shopErr.message,
            });
            perShopResults.push({
              shopId: sid,
              status: "SKIP",
              sn: shopSn,
              pulled: shopPulled,
              added: shopAdded,
              updated: shopUpdated,
              error: "pull_shop_deadline",
            });
            continue;
          }
          console.error(
            `[Sync Shop ${sid}] Lỗi:`,
            shopErr?.message || shopErr,
            shopErr?.stack || "",
          );
          errors.push({
            shopId: sid,
            error: "pull_shop_failed",
            message: shopErr?.message || String(shopErr),
          });
          perShopResults.push({
            shopId: sid,
            status: "ERROR",
            sn: shopSn,
            pulled: shopPulled,
            added: shopAdded,
            updated: shopUpdated,
            error: shopErr?.message || "pull_shop_failed",
          });
        }
      } catch (outerShopErr: any) {
        // Tuyệt đối không để 1 shop (vd 831052930) làm sập cả phiên pull.
        const sid = String(normalizeShopIdKey(shopId) || shopId || "").trim();
        console.error(
          `[Sync Shop ${sid}] Lỗi: OUTER ERROR:`,
          outerShopErr?.message || outerShopErr,
          outerShopErr?.stack || "",
        );
        errors.push({
          shopId: sid,
          error: "pull_shop_outer_failed",
          message: outerShopErr?.message || String(outerShopErr),
        });
        perShopResults.push({
          shopId: sid,
          status: "ERROR",
          sn: shopSn,
          pulled: shopPulled,
          added: shopAdded,
          updated: shopUpdated,
          error: outerShopErr?.message || "pull_shop_outer_failed",
        });
      }
    }

    console.log(
      `[Orders Pull] perShop summary:`,
      JSON.stringify(perShopResults),
    );

    if (Date.now() <= deadlineAt) {
      try {
        const repaired = await repairWrongShopCancelledOrders({ limit: 12 });
        if (repaired.checked > 0) {
          pulled += repaired.healed;
          updated += repaired.remapped + repaired.healed;
          syncDiag(
            "Repair wrong-shop CANCELLED",
            `checked=${repaired.checked} remapped=${repaired.remapped} healed=${repaired.healed}`,
          );
        }
      } catch (repairErr: any) {
        console.error(
          "[Orders Pull] repairWrongShopCancelledOrders FAILED:",
          repairErr?.message || repairErr,
        );
      }
    }

    // Nút "Làm mới" phải đối soát cả các đơn cũ đang PROCESSED/READY_TO_SHIP.
    if (opts?.reconcileActive === true && Date.now() <= deadlineAt) {
      try {
        const reconciled = await reconcileActiveShopeeOrdersFromStore(orders, shopIds, deadlineAt);
        pulled += reconciled.pulled;
        added += reconciled.added;
        updated += reconciled.updated;
        errors.push(...reconciled.errors);
        syncDiag(
          "Active status reconcile DONE",
          `pulled=${reconciled.pulled} +${reconciled.added}/~${reconciled.updated} errors=${reconciled.errors.length}`,
        );
      } catch (reconcileErr: any) {
        console.error(
          "[Orders Pull] reconcileActive FAILED:",
          reconcileErr?.message || reconcileErr,
          reconcileErr?.stack || "",
        );
        errors.push({
          error: "reconcile_failed",
          message: reconcileErr?.message || String(reconcileErr),
        });
      }
    }

    const elapsedMs = Date.now() - startedAt;
    const dbErrors = errors.filter((e) => String(e?.error || "") === "db_upsert_failed");
    const failed_orders = [...failedOrdersSet];
    // Lỗi detail từng đơn = soft — không fail cả phiên nếu đã kéo được đơn.
    const hardErrors = errors.filter((e) => {
      const code = String(e?.error || "");
      return (
        code !== "pull_sn_cap" &&
        code !== "pull_deadline" &&
        code !== "pull_shop_deadline" &&
        code !== "normalize_failed" &&
        code !== "normalize_null" &&
        code !== "order_detail_missing" &&
        code !== "order_detail_exception" &&
        code !== "rate_limit_retry_failed"
      );
    });
    const softOnly =
      errors.length > 0 && hardErrors.length === 0 && (pulled > 0 || truncatedShops > 0);
    // Lỗi lưu DB → success=false để FE thấy (không nuốt). Còn lại: kéo được đơn = success.
    const success =
      dbErrors.length === 0 && (pulled > 0 || hardErrors.length === 0 || softOnly);
    const message =
      dbErrors.length > 0
        ? `Lỗi lưu MongoDB: ${dbErrors[0]?.message || "db_upsert_failed"}`
        : pulled > 0
          ? `Kéo đơn hoàn tất — thành công ${pulled} đơn` +
            (failed_orders.length ? `, lỗi ${failed_orders.length} đơn` : "") +
            ` (+${added} mới, ~${updated} cập nhật) trong ${elapsedMs}ms`
          : hardErrors.length > 0
            ? `Pull 0 đơn — có lỗi: ${hardErrors[0]?.message || hardErrors[0]?.error}`
            : errors.length > 0
              ? `Pull 0 đơn — ${errors[0]?.message || errors[0]?.error}`
              : "Shopee trả 0 order_sn trong cửa sổ thời gian (hoặc token lỗi).";

    syncDiag(
      "Pull DONE",
      `${message} success=${success} errors=${errors.length} hard=${hardErrors.length} failed=${failed_orders.length} truncatedShops=${truncatedShops}`,
    );
    console.log(
      `[Orders Pull] Số lượng lấy được từ Sàn — pulled=${pulled} +${added}/~${updated}` +
        ` success=${success} elapsedMs=${elapsedMs} perShop=${JSON.stringify(perShopResults)}`,
    );
    // Bù mã GHN sau khi pull xong — không chặn deadline list/detail.
    if (pulled > 0 || added > 0) {
      kickMissingShopeeTrackingEnrichment("after_pull");
    }
    return {
      success,
      pulled,
      added,
      updated,
      shops: shopIds.length,
      errors,
      perShop: perShopResults,
      warnings:
        truncatedShops > 0
          ? [
              {
                error: "pull_truncated",
                message: `${truncatedShops} shop chưa vét hết (deadline/safetyCap) — chạy lại Đồng bộ nếu còn lệch Seller Center.`,
              },
            ]
          : [],
      message,
      elapsedMs,
      truncatedShops,
      lookbackSec,
      shopee_response: shopeeResponsePages,
      total_success: pulled,
      failed_orders,
    };
  } catch (pullFatal: any) {
    logShopeeSyncApiError(pullFatal, "pullIncrementalOrdersFromShopee fatal");
    console.error(
      "[Orders Pull] FATAL:",
      pullFatal?.message || pullFatal,
      pullFatal?.stack || "",
    );
    return {
      success: false,
      pulled: Number(pulled) || 0,
      added: Number(added) || 0,
      updated: Number(updated) || 0,
      shops: shopIds.length || 0,
      errors: [
        ...errors,
        {
          error: "orders_pull_fatal",
          message: pullFatal?.message || String(pullFatal),
        },
      ],
      message: pullFatal?.message || String(pullFatal) || "Đồng bộ đơn hàng thất bại",
      elapsedMs: Date.now() - startedAt,
      lookbackSec,
      shopee_response: Array.isArray(shopeeResponsePages) ? shopeeResponsePages.slice(0, 6) : [],
      total_success: Number(pulled) || 0,
      failed_orders: [...failedOrdersSet],
    };
  } finally {
    releaseOrdersPullLock("pullIncremental_finally");
  }
}

/**
 * Quét riêng CANCELLED / IN_CANCEL / TO_RETURN (+ return_list) — cửa sổ rộng hơn sync thường.
 * Bật enrichTracking để gắn mã vận đơn ngay (phục vụ quét kiện hoàn).
 */
async function pullShopeeCancelReturnOrders(opts?: {
  lookbackSec?: number;
  shopIds?: string[];
}): Promise<{
  success: boolean;
  pulled: number;
  added: number;
  updated: number;
  shops: number;
  errors: any[];
  message: string;
  skipped?: boolean;
  elapsedMs?: number;
}> {
  if (!tryAcquireOrdersPullLock()) {
    return {
      success: true,
      pulled: 0,
      added: 0,
      updated: 0,
      shops: 0,
      errors: [],
      message: ORDERS_PULL_IN_FLIGHT_SOFT_MESSAGE,
      skipped: true,
      elapsedMs: 0,
    };
  }

  const startedAt = Date.now();
  const errors: any[] = [];
  let pulled = 0;
  let added = 0;
  let updated = 0;
  let shopIds: string[] = [];
  let lookbackSec = SHOPEE_HISTORY_LOOKBACK_SEC;
  const statuses = ["CANCELLED", "IN_CANCEL", "TO_RETURN"];

  try {
    lookbackSec = clampShopeeHistoryLookbackSec(
      Number(opts?.lookbackSec) || SHOPEE_HISTORY_LOOKBACK_SEC,
      false,
    );
    ensureShopeeLinkedShopTokenKeys();
    shopIds = (opts?.shopIds?.length ? opts.shopIds : listShopeeSyncShopIds())
      .map((id) => normalizeShopIdKey(id))
      .filter(Boolean);

    if (shopIds.length === 0) {
      return {
        success: false,
        pulled: 0,
        added: 0,
        updated: 0,
        shops: 0,
        errors: [{ error: "no_oauth_shop", message: "Chưa có shop Shopee OAuth." }],
        message: "Chưa có shop Shopee OAuth.",
        elapsedMs: Date.now() - startedAt,
      };
    }

    const orders = isMongoReady()
      ? await (async () => {
          try {
            return await loadOrdersFromStore();
          } catch (loadErr: any) {
            console.error(
              "[CancelReturn Pull] loadOrdersFromStore failed:",
              loadErr?.message || loadErr,
            );
            return [];
          }
        })()
      : [];
    const perShopBudgetMs = ORDERS_PULL_PER_SHOP_MS;

    // Duyệt HẾT shop — CẤM break deadline toàn cục (shop 2 bị bỏ qua).
    for (const shopId of shopIds) {
      const shopDeadlineAt = Date.now() + perShopBudgetMs;
      try {
        let accessToken = await getValidShopeeAccessToken(shopId);
        if (!accessToken) {
          errors.push({ shopId, error: "no_valid_access_token", message: `Shop ${shopId}: thiếu token` });
          continue;
        }

        const snSet = new Set<string>();
        for (const st of statuses) {
          if (Date.now() >= shopDeadlineAt) break;
          try {
            const sns = await collectShopeeOrderSnsByStatus(shopId, accessToken, st, {
              lookbackSec,
              deadlineAt: shopDeadlineAt,
            });
            for (const sn of sns) snSet.add(sn);
          } catch (stErr: any) {
            console.warn(
              `[CancelReturn Pull] status=${st} shop=${shopId}:`,
              stErr?.message || stErr,
            );
          }
        }

        if (Date.now() < shopDeadlineAt) {
          try {
            const returnRows = await shopeeFetchAllReturnSns(shopId, accessToken, {
              mode: "incremental",
              deadlineAt: shopDeadlineAt,
            });
            for (const row of returnRows) {
              const sn = String(row?.orderSn || "").trim();
              if (sn) snSet.add(sn);
            }
          } catch (returnErr: any) {
            console.warn(
              `[CancelReturn Pull] return_list shop=${shopId}:`,
              returnErr?.message || returnErr,
            );
          }
        }

        const orderSnList = [...snSet];
        syncDiag(
          "CancelReturn list",
          `shop=${shopId} sn=${orderSnList.length} lookback=${lookbackSec}s`,
        );
        if (!orderSnList.length) continue;

        for (let i = 0; i < orderSnList.length; i += SHOPEE_SYNC_CHUNK_SIZE) {
          if (Date.now() >= shopDeadlineAt) break;
          const chunkSns = orderSnList.slice(i, i + SHOPEE_SYNC_CHUNK_SIZE);
          const fresh = await getValidShopeeAccessToken(shopId);
          if (fresh) accessToken = fresh;
          const { normalized, errors: chunkErrors } = await fetchNormalizeShopeeOrderChunk(
            shopId,
            accessToken,
            shopId,
            chunkSns,
            { enrichTracking: true, skipEscrow: true },
          );
          if (chunkErrors.length) errors.push(...chunkErrors);
          if (!normalized.length) continue;
          try {
            const upsert = await persistShopeeOrderChunk(orders, normalized, {
              apiShopId: shopId,
              accessToken,
              skipTracking: false,
            });
            added += upsert.added;
            updated += upsert.updated;
            pulled += normalized.length;
          } catch (saveErr: any) {
            errors.push({
              shopId,
              error: "db_upsert_failed",
              message: saveErr?.message || String(saveErr),
            });
          }
          if (i + SHOPEE_SYNC_CHUNK_SIZE < orderSnList.length) {
            // Rate-limit: nghỉ đủ giữa các lô get_order_detail (đa shop / hàng loạt).
            // Nếu đang xác nhận/in → nhường thêm để không nghẽn logistics.
            await yieldToLogisticsIfBusy(8_000);
            await shopeeSyncDelay(
              isLogisticsBusy() ? Math.max(SHOPEE_SYNC_CHUNK_DELAY_MS, 600) : SHOPEE_SYNC_CHUNK_DELAY_MS,
            );
          }
        }
      } catch (shopErr: any) {
        errors.push({
          shopId,
          error: "cancel_return_pull_failed",
          message: shopErr?.message || String(shopErr),
        });
      }
      await shopeeSyncDelay(400);
    }

    const elapsedMs = Date.now() - startedAt;
    try {
      const rec = await reclassifyCancelReturnsInStore({
        lookbackMs: SHOPEE_HISTORY_LOOKBACK_MS,
        limit: 2000,
      });
      console.log(
        `[CancelReturn Pull] reclassify scanned=${rec.scanned} updated=${rec.updated}`,
      );
    } catch (recErr: any) {
      console.warn(
        "[CancelReturn Pull] reclassify skip:",
        recErr?.message || recErr,
      );
    }
    const message =
      pulled > 0
        ? `Cancel/return: kéo/cập nhật ${pulled} đơn (+${added}/~${updated}) trong ${elapsedMs}ms`
        : errors.length
          ? `Cancel/return 0 đơn — ${errors[0]?.message || errors[0]?.error}`
          : "Cancel/return: 0 order_sn trong cửa sổ.";
    syncDiag("CancelReturn Pull DONE", message);
    return {
      success: pulled > 0 || errors.length === 0,
      pulled,
      added,
      updated,
      shops: shopIds.length,
      errors,
      message,
      elapsedMs,
    };
  } finally {
    releaseOrdersPullLock("pullCancelReturn_finally");
  }
}

/**
 * Sync chuyên biệt Yêu cầu trả hàng (Shopee Return APIs):
 * get_return_list → get_return_detail → get_reverse_tracking_info
 * Lưu: order_sn, return_sn, return_tracking_no, refund_amount, reason, status, items.
 */
const RETURN_REQUESTS_PER_SHOP_MS = 90_000;
let returnRequestsSyncInFlight = false;

async function syncShopeeReturnRequests(opts?: {
  mode?: "incremental" | "full";
  shopIds?: string[];
  maxReturns?: number;
}): Promise<{
  success: boolean;
  pulled: number;
  updated: number;
  shops: number;
  errors: any[];
  message: string;
  elapsedMs: number;
  skipped?: boolean;
}> {
  if (returnRequestsSyncInFlight) {
    return {
      success: true,
      pulled: 0,
      updated: 0,
      shops: 0,
      errors: [],
      message: ORDERS_PULL_IN_FLIGHT_SOFT_MESSAGE,
      skipped: true,
      elapsedMs: 0,
    };
  }
  returnRequestsSyncInFlight = true;
  const startedAt = Date.now();
  const errors: any[] = [];
  let pulled = 0;
  let updated = 0;
  const mode = opts?.mode === "full" ? "full" : "incremental";
  const maxReturns = Math.max(
    10,
    Math.min(400, Number(opts?.maxReturns) || (mode === "full" ? 200 : 120)),
  );

  try {
    ensureShopeeLinkedShopTokenKeys();
    const shopIds = (opts?.shopIds?.length ? opts.shopIds : listShopeeSyncShopIds())
      .map((id) => normalizeShopIdKey(id))
      .filter(Boolean);
    if (!shopIds.length) {
      return {
        success: false,
        pulled: 0,
        updated: 0,
        shops: 0,
        errors: [{ error: "no_oauth_shop" }],
        message: "Chưa có shop Shopee OAuth.",
        elapsedMs: Date.now() - startedAt,
      };
    }

    // CẤM dump toàn bộ collection — chỉ nạp đơn theo order_sn khi cần.
    const orders: any[] = [];
    const perShopMaxReturns = Math.max(
      20,
      Math.min(mode === "full" ? 120 : 80, maxReturns),
    );

    // BẮT BUỘC duyệt HẾT shop — mỗi shop ngân sách riêng, CẤM break/return sớm.
    for (let shopIndex = 0; shopIndex < shopIds.length; shopIndex++) {
      const shopId = shopIds[shopIndex];
      console.log(`[Return Sync] Đang xử lý shop_id=${shopId}, index=${shopIndex}`);
      const shopDeadlineAt = Date.now() + RETURN_REQUESTS_PER_SHOP_MS;
      try {
        let accessToken = await getValidShopeeAccessToken(shopId);
        if (!accessToken) {
          console.warn(
            `[Return Sync Error] Shop: ${shopId}, SN: -, Lỗi: no_valid_access_token — cần Ủy quyền lại Shop ${shopId}`,
          );
          errors.push({ shopId, error: "no_valid_access_token" });
          await shopeeSyncDelay(300);
          continue;
        }
        const returnRows = await shopeeFetchAllReturnSns(shopId, accessToken, {
          mode: "full",
          maxPages: SHOPEE_RETURN_LIST_MAX_PAGES,
          deadlineAt: shopDeadlineAt,
        });
        const limited = returnRows.slice(0, perShopMaxReturns);
        console.log(
          `[ReturnRequests Sync] shop=${shopId} (${shopIndex + 1}/${shopIds.length}) mode=${mode} rows=${returnRows.length} process=${limited.length}`,
        );

        const patches: any[] = [];
        for (const row of limited) {
          if (Date.now() >= shopDeadlineAt) {
            console.warn(
              `[ReturnRequests Sync] shop=${shopId} hết ngân sách — giữ ${patches.length} patch, chuyển shop tiếp theo`,
            );
            break;
          }
          const returnSn = String(row.returnSn || "").trim();
          if (!returnSn) continue;
          try {
            const rowOrderSn = toShopeeSn(row.orderSn) || "";
            if (rowOrderSn) {
              const existingEarly = orders.find((o: any) => String(o.orderSn) === rowOrderSn);
              if (existingEarly && !shouldApplyShopeeReturnOverlay(existingEarly)) {
                applyShopeeCancelReturnClassification(existingEarly);
                if (!String(existingEarly.return_sn || "").trim()) {
                  existingEarly.return_sn = returnSn;
                }
                if (orderNeedsRealReturnTracking(existingEarly)) {
                  const { tracking } = await fetchReturnShippingTrackingNumber(
                    shopId,
                    accessToken,
                    returnSn,
                    undefined,
                    outboundTrackingOf(existingEarly),
                  );
                  if (tracking) applyReturnTrackingAliases(existingEarly, tracking);
                  applyShopeeCancelReturnClassification(existingEarly);
                  await shopeeSyncDelay(300);
                }
                patches.push(existingEarly);
                continue;
              }
            }
            const fresh = await getValidShopeeAccessToken(shopId);
            if (fresh) accessToken = fresh;
            const detailResult = await shopeeGetReturnDetail(shopId, accessToken, returnSn);
            await shopeeSyncDelay(300);
            if (detailResult?.error) {
              errors.push({
                shopId,
                returnSn,
                error: detailResult.error,
                message: detailResult.message,
              });
              console.warn(
                `[ReturnRequests Sync] get_return_detail shop=${shopId} return_sn=${returnSn} error=${detailResult.error || "unknown"} message=${detailResult.message || ""}`,
              );
              if (isShopeeReturnsAuthError(detailResult)) {
                continue;
              }
              let existingOnErr = rowOrderSn
                ? orders.find((o: any) => String(o.orderSn) === rowOrderSn)
                : undefined;
              if (!existingOnErr && rowOrderSn && isMongoReady()) {
                try {
                  const loaded = await loadOrdersFromStore({ orderSns: [rowOrderSn], limit: 1 });
                  existingOnErr = loaded[0];
                  if (existingOnErr) orders.push(existingOnErr);
                } catch (loadErr: any) {
                  console.warn(
                    `[ReturnRequests Sync] load order ${rowOrderSn}:`,
                    loadErr?.message || loadErr,
                  );
                }
              }
              const { tracking } = await fetchReturnShippingTrackingNumber(
                shopId,
                accessToken,
                returnSn,
                undefined,
                outboundTrackingOf(existingOnErr),
              );
              await shopeeSyncDelay(300);
              if (tracking && existingOnErr) {
                if (!String(existingOnErr.return_sn || "").trim()) existingOnErr.return_sn = returnSn;
                applyReturnTrackingAliases(existingOnErr, tracking);
                applyShopeeCancelReturnClassification(existingOnErr);
                patches.push(existingOnErr);
              }
              continue;
            }
            const detail = detailResult?.response ?? detailResult ?? {};
            const orderSn =
              toShopeeSn(detail.order_sn ?? detail.orderSn ?? row.orderSn) || "";
            if (!orderSn) continue;
            let existing = orders.find((o: any) => String(o.orderSn) === orderSn);
            if (!existing && isMongoReady()) {
              try {
                const loaded = await loadOrdersFromStore({ orderSns: [orderSn], limit: 1 });
                existing = loaded[0];
                if (existing) orders.push(existing);
              } catch (loadErr: any) {
                console.warn(
                  `[ReturnRequests Sync] load order ${orderSn}:`,
                  loadErr?.message || loadErr,
                );
                existing = undefined;
              }
            }
            const returnStatusEarly = String(detail.status || row.status || "").toUpperCase();
            if (returnStatusEarly === "CANCELLED") {
              if (existing) {
                existing.return_status = "CANCELLED";
                if (stripCancelledReturnOnDelivered(existing)) {
                  patches.push(existing);
                }
              }
              continue;
            }
            // Hủy chưa giao (get_order_list CANCELLED) — refund tiền ≠ overlay return_sn.
            // RTS/CANCELLED+mã đi: vẫn kéo mã hoàn, không đổi tab thành YCTH.
            if (existing && !shouldApplyShopeeReturnOverlay(existing)) {
              applyShopeeCancelReturnClassification(existing);
              if (!String(existing.return_sn || "").trim()) {
                existing.return_sn = returnSn;
              }
              if (orderNeedsRealReturnTracking(existing)) {
                const { tracking } = await fetchReturnShippingTrackingNumber(
                  shopId,
                  accessToken,
                  returnSn,
                  detailResult,
                  outboundTrackingOf(existing),
                );
                if (tracking) applyReturnTrackingAliases(existing, tracking);
                applyShopeeCancelReturnClassification(existing);
                await shopeeSyncDelay(300);
              }
              patches.push(existing);
              continue;
            }
            const mappedReturnSn =
              extractReturnRequestCode(detail) || returnSn;

            const { tracking: returnShipTn } = await fetchReturnShippingTrackingNumber(
              shopId,
              accessToken,
              mappedReturnSn,
              detailResult,
              existing?.trackingNumber || existing?.tracking_no,
            );
            const kind = mapShopeeReturnKind(detail);
            const returnStatus = String(detail.status || row.status || "").toUpperCase();
            const refundAmount = Number(detail.refund_amount);
            const reason = String(detail.reason || "").trim();
            const textReason = String(detail.text_reason || "").trim();
            const itemRows = Array.isArray(detail.item)
              ? detail.item
              : Array.isArray(detail.items)
                ? detail.items
                : [];
            const items = itemRows.map((it: any, idx: number) => ({
              productId:
                toShopeeId(it.item_id) ||
                String(it.item_id || it.productId || `return-item-${idx}`),
              productTitle: String(it.name || it.item_name || it.model_name || `SP hoàn #${orderSn}`),
              productImage: Array.isArray(it.images) && it.images[0] ? String(it.images[0]) : undefined,
              quantity: Math.max(1, Number(it.amount || it.quantity || 1) || 1),
              price: Number(it.item_price || it.refund_amount || refundAmount || 0) || 0,
              modelId: it.model_id != null ? (toShopeeId(it.model_id) || String(it.model_id)) : undefined,
              modelSku: it.variation_sku || it.model_sku ? String(it.variation_sku || it.model_sku) : undefined,
              modelName: it.model_name ? String(it.model_name) : undefined,
              activity_id:
                it.activity_id != null
                  ? toShopeeId(it.activity_id) || String(it.activity_id)
                  : undefined,
              promotion_id:
                it.promotion_id != null
                  ? toShopeeId(it.promotion_id) || String(it.promotion_id)
                  : undefined,
            }));

            const existingRaw = String(existing?.shopee_order_status || "").toUpperCase();
            const alreadyCancelled =
              existingRaw === "CANCELLED" ||
              existingRaw === "IN_CANCEL" ||
              existing?.status === "cancelled";

            const patch: any = {
              id: existing?.id || `shopee-${orderSn}`,
              orderSn,
              channel: "shopee",
              shopId: existing?.shopId || shopId,
              return_sn: mappedReturnSn,
              return_status: returnStatus,
              return_refund_request_type: Number(detail.return_refund_request_type ?? 0),
              shopee_cancel_return_kind: kind,
              return_create_time: Number(detail.create_time) || undefined,
              return_update_time: Number(detail.update_time) || undefined,
              refund_amount: Number.isFinite(refundAmount) ? refundAmount : undefined,
              return_reason: reason || undefined,
              text_reason: textReason || undefined,
              date: existing?.date || new Date((Number(detail.create_time) || Date.now() / 1000) * 1000).toISOString(),
              totalAmount:
                Number.isFinite(refundAmount) && refundAmount > 0
                  ? refundAmount
                  : Number(existing?.totalAmount) || 1,
              revenue: existing?.revenue ?? 0,
              items: items.length ? items : existing?.items || [
                {
                  productId: "return-placeholder",
                  productTitle: `Đơn hoàn ${orderSn}`,
                  quantity: 1,
                  price: Number.isFinite(refundAmount) ? refundAmount : 1,
                },
              ],
            };

            if (returnShipTn) {
              applyReturnTrackingAliases(patch, returnShipTn);
            } else {
              const keepRet = distinctReturnTracking(
                existing?.return_tracking_no || existing?.returnTrackingNumber,
                existing?.trackingNumber || existing?.tracking_no,
              );
              if (keepRet) applyReturnTrackingAliases(patch, keepRet);
            }

            if (alreadyCancelled) {
              patch.status = "cancelled";
              patch.shopee_order_status = existingRaw === "IN_CANCEL" ? "IN_CANCEL" : "CANCELLED";
            } else if (
              existing?.status === "return_received" ||
              existing?.local_status === "RETURN_RECEIVED"
            ) {
              patch.status = "return_received";
              patch.shopee_order_status = existing?.shopee_order_status || "TO_RETURN";
            } else {
              patch.status = "return_pending";
              patch.shopee_order_status = existing?.shopee_order_status || "TO_RETURN";
            }

            // Giữ outbound tracking riêng — không ghi đè bằng mã chiều hoàn.
            if (existing?.trackingNumber || existing?.tracking_no) {
              patch.trackingNumber = existing.trackingNumber || existing.tracking_no;
              patch.tracking_no = existing.tracking_no || existing.trackingNumber;
            }

            const merged = existing
              ? mergeShopeeOrderOnSync(existing, { ...existing, ...patch })
              : patch;
            merged.return_sn = patch.return_sn;
            merged.return_status = patch.return_status;
            merged.return_refund_request_type = patch.return_refund_request_type;
            merged.shopee_cancel_return_kind = "refund_return";
            merged.is_return = true;
            merged.sub_status = "RETURN";
            if (patch.return_create_time) merged.return_create_time = patch.return_create_time;
            if (patch.return_update_time) merged.return_update_time = patch.return_update_time;
            merged.refund_amount = patch.refund_amount;
            merged.return_reason = patch.return_reason;
            merged.text_reason = patch.text_reason;
            if (patch.return_tracking_no) applyReturnTrackingAliases(merged, patch.return_tracking_no);
            if (patch.status) merged.status = patch.status;
            markNewReturnRequestAlert(merged, existing);

            patches.push(merged);
            pulled += 1;
            await shopeeSyncDelay(300);
          } catch (rowErr: any) {
            console.warn(
              `[Return Sync Error] Shop: ${shopId}, SN: ${returnSn}, Lỗi: ${rowErr?.message || rowErr}`,
            );
            errors.push({
              shopId,
              returnSn,
              error: "return_detail_failed",
              message: rowErr?.message || String(rowErr),
            });
            await shopeeSyncDelay(300);
          }
        }

        if (patches.length) {
          const upsert = await persistShopeeOrderChunk(orders, patches, {
            apiShopId: shopId,
            accessToken,
            skipTracking: true,
          });
          updated += upsert.updated + upsert.added;
          for (const p of patches) {
            const idx = orders.findIndex((o: any) => String(o.orderSn) === String(p.orderSn));
            if (idx >= 0) orders[idx] = p;
            else orders.unshift(p);
          }
        }
      } catch (shopErr: any) {
        console.warn(
          `[Return Sync Error] Shop: ${shopId}, SN: -, Lỗi: ${shopErr?.message || shopErr}`,
        );
        errors.push({
          shopId,
          error: "return_requests_sync_failed",
          message: shopErr?.message || String(shopErr),
        });
      }
      await shopeeSyncDelay(400);
    }

    const elapsedMs = Date.now() - startedAt;
    const message =
      pulled > 0
        ? `Return requests: đồng bộ ${pulled} YCTH (~${updated} DB) trong ${elapsedMs}ms`
        : errors.length
          ? `Return requests 0 — ${errors[0]?.message || errors[0]?.error}`
          : "Return requests: không có yêu cầu trả hàng mới.";
    console.log(`[ReturnRequests Sync] ${message}`);
    return {
      success: pulled > 0 || errors.length === 0,
      pulled,
      updated,
      shops: shopIds.length,
      errors,
      message,
      elapsedMs,
    };
  } finally {
    returnRequestsSyncInFlight = false;
  }
}

/**
 * P1: retry đơn đã có return_sn nhưng return_tracking_no trống.
 * An toàn CPU: mutex + limit 30 + chia đều theo shop (15/shop) + sleep 500ms.
 */
const RETURN_TRACKING_RETRY_HARD_LIMIT = 30;
const RETURN_TRACKING_RETRY_PER_SHOP = 15;
const RETURN_TRACKING_RETRY_DELAY_MS = 500;
const AMTHANH_SHOP_ID = "831052930";
let returnTrackingRetryInFlight = false;

function listReturnTrackingShopIds(): string[] {
  ensureShopeeLinkedShopTokenKeys();
  const ids = listShopeeSyncShopIds()
    .map((id) => normalizeShopIdKey(id))
    .filter(Boolean);
  if (!ids.includes(AMTHANH_SHOP_ID)) ids.push(AMTHANH_SHOP_ID);
  ids.sort((a, b) => (a === AMTHANH_SHOP_ID ? -1 : b === AMTHANH_SHOP_ID ? 1 : 0));
  return ids;
}

async function retryPendingReturnTracking(opts?: {
  limit?: number;
  trigger?: string;
}): Promise<{ attempted: number; filled: number; errors: number; skipped?: boolean }> {
  const empty = { attempted: 0, filled: 0, errors: 0 };
  if (returnTrackingRetryInFlight) {
    console.log("[ReturnTracking Retry] SKIPPED — job đang chạy (mutex).");
    return { ...empty, skipped: true };
  }
  returnTrackingRetryInFlight = true;
  const startedAt = Date.now();
  try {
    if (!isMongoReady()) return empty;
    const hardLimit = Math.min(
      RETURN_TRACKING_RETRY_HARD_LIMIT,
      Math.max(1, Math.floor(Number(opts?.limit) || RETURN_TRACKING_RETRY_HARD_LIMIT)),
    );
    const shopIds = listReturnTrackingShopIds();
    if (!shopIds.length) {
      console.warn("[ReturnTracking Retry] skip no_shopId — chưa có shop Shopee OAuth.");
      return empty;
    }

    let attempted = 0;
    let filled = 0;
    let errors = 0;

    for (let shopIndex = 0; shopIndex < shopIds.length; shopIndex++) {
      if (attempted >= hardLimit) break;
      const shopId = shopIds[shopIndex];
      console.log(`[Return Sync] Đang xử lý shop_id=${shopId}, index=${shopIndex}`);
      const shopCap = Math.min(
        RETURN_TRACKING_RETRY_PER_SHOP,
        hardLimit - attempted,
      );
      if (shopCap <= 0) break;

      let candidates: any[] = [];
      try {
        candidates = await loadReturnTrackingPendingFromStore({
          shopId,
          lookbackMs: 30 * 24 * 60 * 60 * 1000,
          limit: shopCap,
        });
      } catch (err: any) {
        console.warn(
          `[ReturnTracking Retry] load shop=${shopId} failed:`,
          err?.message || err,
        );
        await shopeeSyncDelay(RETURN_TRACKING_RETRY_DELAY_MS);
        continue;
      }
      candidates = (candidates || [])
        .filter((order) => {
          const returnSn = String(order?.return_sn || "").trim();
          return Boolean(returnSn) && orderNeedsRealReturnTracking(order);
        })
        .slice(0, shopCap);
      if (!candidates.length) {
        console.log(`[ReturnTracking Retry] shop=${shopId} — 0 pending`);
        await shopeeSyncDelay(RETURN_TRACKING_RETRY_DELAY_MS);
        continue;
      }

      let shopAttempted = 0;
      let shopFilled = 0;
      for (const order of candidates) {
        if (attempted >= hardLimit) break;
        if (shopAttempted >= shopCap) break;
        const orderShopId =
          normalizeShopIdKey(order?.shopId) || String(order?.shopId || "").trim() || shopId;
        const returnSn = String(order?.return_sn || "").trim();
        if (!orderShopId) {
          console.warn(
            `[ReturnTracking Retry] skip no_shopId order_sn=${order?.orderSn || "-"}`,
          );
          continue;
        }
        if (!returnSn) {
          console.warn(
            `[ReturnTracking Retry] skip no_return_sn order_sn=${order?.orderSn || "-"} shop_id=${orderShopId}`,
          );
          continue;
        }
        shopAttempted += 1;
        attempted += 1;
        try {
          const accessToken = await getValidShopeeAccessToken(orderShopId);
          if (!accessToken) {
            console.warn(
              `[Return Sync Error] Shop: ${orderShopId}, SN: ${order?.orderSn || "-"}, Lỗi: no_valid_access_token — cần Ủy quyền lại Shop ${orderShopId}`,
            );
            await shopeeSyncDelay(RETURN_TRACKING_RETRY_DELAY_MS);
            continue;
          }
          const ok = await fillReturnTrackingFromShopee(orderShopId, accessToken, order);
          await shopeeSyncDelay(RETURN_TRACKING_RETRY_DELAY_MS);
          const rtn = distinctReturnTracking(
            order.return_tracking_no || order.returnTrackingNumber,
            order.trackingNumber || order.tracking_no,
          );
          if (ok && rtn) {
            const saved = await persistReturnTrackingOnly(order, rtn, orderShopId);
            if (saved) {
              shopFilled += 1;
              filled += 1;
              console.log(
                `[ReturnTracking Retry] filled shop=${orderShopId} order_sn=${order.orderSn} return_sn=${returnSn} rtn=${rtn}`,
              );
            }
          }
        } catch (rowErr: any) {
          errors += 1;
          console.warn(
            `[Return Sync Error] Shop: ${orderShopId}, SN: ${order?.orderSn || returnSn}, Lỗi: ${rowErr?.message || rowErr}`,
          );
          await shopeeSyncDelay(RETURN_TRACKING_RETRY_DELAY_MS);
        }
      }
      console.log(
        `[ReturnTracking Retry] shop=${shopId} (${shopIndex + 1}/${shopIds.length}) attempted=${shopAttempted} filled=${shopFilled}`,
      );
      await shopeeSyncDelay(RETURN_TRACKING_RETRY_DELAY_MS);
    }

    console.log(
      `[ReturnTracking Retry] trigger=${opts?.trigger || "cron"} shops=${shopIds.length} attempted=${attempted} filled=${filled} errors=${errors} ${Date.now() - startedAt}ms`,
    );
    return { attempted, filled, errors };
  } finally {
    returnTrackingRetryInFlight = false;
  }
}

/**
 * One-shot: quét 30 ngày CẢ 2 shop, bù return_tracking_no cho Hàng Hoàn / RTS.
 * Mỗi shop ngân sách riêng — CẤM break sớm bỏ shop sau.
 */
const RETURN_TRACKING_BACKFILL_PER_SHOP_MS = 55_000;
const RETURN_TRACKING_BACKFILL_LIMIT_PER_SHOP = 80;
const RETURN_TRACKING_BACKFILL_DELAY_MS = 500;
let returnTrackingBackfill30dInFlight = false;
let returnTrackingBackfill30dOnce = false;

async function backfillMissingReturnTracking30d(opts?: {
  trigger?: string;
  limitPerShop?: number;
  shopId?: string;
  force?: boolean;
}): Promise<{
  shops: number;
  attempted: number;
  filled: number;
  errors: number;
  skipped?: boolean;
  message: string;
}> {
  const empty = { shops: 0, attempted: 0, filled: 0, errors: 0, message: "" };
  if (returnTrackingBackfill30dInFlight) {
    return { ...empty, skipped: true, message: "Backfill mã hoàn đang chạy." };
  }
  if (returnTrackingBackfill30dOnce && opts?.trigger === "boot" && !opts?.force) {
    return { ...empty, skipped: true, message: "Backfill mã hoàn boot đã chạy 1 lần." };
  }
  returnTrackingBackfill30dInFlight = true;
  if (opts?.trigger === "boot") returnTrackingBackfill30dOnce = true;
  const startedAt = Date.now();
  const limitPerShop = Math.min(
    RETURN_TRACKING_BACKFILL_LIMIT_PER_SHOP,
    Math.max(1, Math.floor(Number(opts?.limitPerShop) || RETURN_TRACKING_BACKFILL_LIMIT_PER_SHOP)),
  );
  let attempted = 0;
  let filled = 0;
  let errors = 0;
  try {
    const wantedShop = String(normalizeShopIdKey(opts?.shopId) || opts?.shopId || "").trim();
    const shopIds = listReturnTrackingShopIds().filter((id) =>
      wantedShop ? id === wantedShop : true,
    );
    if (!shopIds.length) {
      return { ...empty, message: "Chưa có shop Shopee OAuth." };
    }
    console.log(
      `[ReturnTracking Backfill] START trigger=${opts?.trigger || "manual"} shops=${shopIds.length} ids=[${shopIds.join(",")}] cap=${limitPerShop}/shop`,
    );

    for (let shopIndex = 0; shopIndex < shopIds.length; shopIndex++) {
      const shopId = shopIds[shopIndex];
      console.log(`[Return Sync] Đang xử lý shop_id=${shopId}, index=${shopIndex}`);
      const shopDeadlineAt = Date.now() + RETURN_TRACKING_BACKFILL_PER_SHOP_MS;
      let shopAttempted = 0;
      let shopFilled = 0;
      try {
        let accessToken = await getValidShopeeAccessToken(shopId);
        if (!accessToken) {
          errors += 1;
          console.warn(
            `[Return Sync Error] Shop: ${shopId}, SN: -, Lỗi: no_valid_access_token — cần Ủy quyền lại Shop ${shopId}`,
          );
          await shopeeSyncDelay(RETURN_TRACKING_BACKFILL_DELAY_MS);
          continue;
        }

        const returnSnByOrder = new Map<string, string>();
        const returnRows = await shopeeFetchAllReturnSns(shopId, accessToken, {
          mode: "full",
          maxPages: 15,
          deadlineAt: shopDeadlineAt,
        });
        for (const row of returnRows) {
          const sn = toShopeeSn(row.orderSn) || "";
          const rsn = String(row.returnSn || "").trim();
          if (sn && rsn) returnSnByOrder.set(sn, rsn);
        }

        const seenSn = new Set<string>();
        const limitedRows = returnRows.slice(0, limitPerShop);
        for (const row of limitedRows) {
          if (Date.now() >= shopDeadlineAt) break;
          if (shopAttempted >= limitPerShop) break;
          const returnSn = String(row.returnSn || "").trim();
          const orderSn = toShopeeSn(row.orderSn) || "";
          if (!returnSn || !orderSn) continue;
          seenSn.add(orderSn);
          shopAttempted += 1;
          attempted += 1;
          try {
            const fresh = await getValidShopeeAccessToken(shopId);
            if (fresh) accessToken = fresh;
            let existing: any;
            if (isMongoReady()) {
              const loaded = await loadOrdersFromStore({ orderSns: [orderSn], limit: 1 });
              existing = loaded[0];
            }
            if (!existing) {
              existing = {
                id: `shopee-${orderSn}`,
                orderSn,
                channel: "shopee",
                shopId,
                return_sn: returnSn,
              };
            }
            if (!String(existing.return_sn || "").trim()) existing.return_sn = returnSn;
            applyShopeeCancelReturnClassification(existing);
            if (!orderNeedsRealReturnTracking(existing)) {
              await shopeeSyncDelay(RETURN_TRACKING_BACKFILL_DELAY_MS);
              continue;
            }
            const ok = await fillReturnTrackingFromShopee(shopId, accessToken, existing);
            await shopeeSyncDelay(RETURN_TRACKING_BACKFILL_DELAY_MS);
            const rtn = distinctReturnTracking(
              existing.return_tracking_no || existing.returnTrackingNumber,
              existing.trackingNumber || existing.tracking_no,
            );
            if (ok && rtn) {
              const saved = await persistReturnTrackingOnly(existing, rtn, shopId);
              if (saved) {
                shopFilled += 1;
                filled += 1;
                console.log(
                  `[ReturnTracking Backfill] OK shop=${shopId} order_sn=${orderSn} rtn=${rtn}`,
                );
              }
            }
          } catch (rowErr: any) {
            errors += 1;
            console.warn(
              `[Return Sync Error] Shop: ${shopId}, SN: ${orderSn}, Lỗi: ${rowErr?.message || rowErr}`,
            );
            await shopeeSyncDelay(RETURN_TRACKING_BACKFILL_DELAY_MS);
          }
        }

        if (isMongoReady() && Date.now() < shopDeadlineAt && shopAttempted < limitPerShop) {
          let mongoRows: any[] = [];
          try {
            mongoRows = await loadMissingReturnTrackingBackfillFromStore({
              shopId,
              lookbackMs: 30 * 24 * 60 * 60 * 1000,
              limit: limitPerShop,
            });
          } catch (loadErr: any) {
            console.warn(
              `[ReturnTracking Backfill] mongo shop=${shopId}:`,
              loadErr?.message || loadErr,
            );
          }
          for (const order of mongoRows) {
            if (Date.now() >= shopDeadlineAt) break;
            if (shopAttempted >= limitPerShop) break;
            const orderSn = toShopeeSn(order?.orderSn) || "";
            if (!orderSn || seenSn.has(orderSn)) continue;
            seenSn.add(orderSn);
            const mapped = returnSnByOrder.get(orderSn);
            if (mapped && !String(order.return_sn || "").trim()) order.return_sn = mapped;
            if (!orderNeedsRealReturnTracking(order)) continue;
            shopAttempted += 1;
            attempted += 1;
            try {
              const fresh = await getValidShopeeAccessToken(shopId);
              if (fresh) accessToken = fresh;
              const ok = await fillReturnTrackingFromShopee(shopId, accessToken, order);
              await shopeeSyncDelay(RETURN_TRACKING_BACKFILL_DELAY_MS);
              const rtn = distinctReturnTracking(
                order.return_tracking_no || order.returnTrackingNumber,
                order.trackingNumber || order.tracking_no,
              );
              if (ok && rtn) {
                const saved = await persistReturnTrackingOnly(order, rtn, shopId);
                if (saved) {
                  shopFilled += 1;
                  filled += 1;
                  console.log(
                    `[ReturnTracking Backfill] OK mongo shop=${shopId} order_sn=${orderSn} rtn=${rtn}`,
                  );
                }
              }
            } catch (rowErr: any) {
              errors += 1;
              console.warn(
                `[Return Sync Error] Shop: ${shopId}, SN: ${orderSn}, Lỗi: ${rowErr?.message || rowErr}`,
              );
              await shopeeSyncDelay(RETURN_TRACKING_BACKFILL_DELAY_MS);
            }
          }
        }

        console.log(
          `[ReturnTracking Backfill] shop=${shopId} (${shopIndex + 1}/${shopIds.length}) attempted=${shopAttempted} filled=${shopFilled}`,
        );
      } catch (shopErr: any) {
        errors += 1;
        console.warn(
          `[Return Sync Error] Shop: ${shopId}, SN: -, Lỗi: ${shopErr?.message || shopErr}`,
        );
      }
      await shopeeSyncDelay(RETURN_TRACKING_BACKFILL_DELAY_MS);
    }

    const message =
      `Backfill mã hoàn 30d shops=${shopIds.length} attempted=${attempted} filled=${filled} errors=${errors} ${Date.now() - startedAt}ms`;
    console.log(`[ReturnTracking Backfill] ${message}`);
    return { shops: shopIds.length, attempted, filled, errors, message };
  } finally {
    returnTrackingBackfill30dInFlight = false;
  }
}

// v2.order.get_order_detail
async function shopeeGetOrderDetail(shopId: string, accessToken: string, orderSnList: string[]) {
  if (orderSnList.length === 0 || orderSnList.length > SHOPEE_ORDER_DETAIL_MAX_ORDER_SNS) {
    throw new Error(
      `get_order_detail requires 1–${SHOPEE_ORDER_DETAIL_MAX_ORDER_SNS} order_sn values; received ${orderSnList.length}`,
    );
  }
  // Shopee OpenAPI bắt buộc shop_id dạng chuỗi số — tránh Number làm lệch sign/URL.
  const apiShopId = String(normalizeShopIdKey(shopId) || shopId || "").trim();
  if (!apiShopId) {
    return {
      error: "invalid_shop_id",
      message: `get_order_detail thiếu shop_id hợp lệ (input=${String(shopId)})`,
      httpStatus: 0,
    };
  }
  const apiPath = "/api/v2/order/get_order_detail";
  const timestamp = Math.floor(Date.now() / 1000);
  const sign = shopeeSign(apiPath, timestamp, accessToken, apiShopId);

  const params = new URLSearchParams({
    partner_id: SHOPEE_PARTNER_ID,
    timestamp: String(timestamp),
    access_token: accessToken,
    shop_id: apiShopId,
    sign,
    order_sn_list: orderSnList.join(","),
    // Note: `image_info` is nested inside item_list automatically — not a top-level field.
    // `order_status` / `create_time` are NOT valid values here (they're returned by default);
    // passing them causes Shopee to reject the whole request with response_optional_fields error.
    response_optional_fields:
      "buyer_user_id,item_list,total_amount,shipping_carrier,package_list,can_partial_cancel_order,buyer_preference_for_partial_cancellation,cancel_reason,buyer_cancel_reason,cancel_by,pending_terms,pending_description",
    // Bắt buộc để nhận PENDING + pending_terms từ Shopee.
    request_order_status_pending: "true",
  });

  const url = `${SHOPEE_HOST}${apiPath}?${params.toString()}`;
  console.log(
    `[Shopee API] GetOrderDetail REQUEST shop=${apiShopId} count=${orderSnList.length} sn=${orderSnList.slice(0, 5).join(",")}`,
  );
  try {
    const { json, httpStatus } = await shopeeFetchJsonWithRetry(
      url,
      `get_order_detail shop_id=${apiShopId} (${orderSnList.length} orders)`
    );
    const returned = Array.isArray(json?.response?.order_list)
      ? json.response.order_list.length
      : Array.isArray(json?.order_list)
        ? json.order_list.length
        : 0;
    console.log(
      `[Shopee API] GetOrderDetail RESPONSE shop=${apiShopId} HTTP=${httpStatus}` +
        ` error=${json?.error || "none"} returned=${returned}/${orderSnList.length}:`,
      JSON.stringify(json).slice(0, 500),
    );

    if (httpStatus === 401 || httpStatus === 403 || isShopeeInvalidTokenError(json?.error, json?.message)) {
      console.error(
        `[Sync Shop ${apiShopId}] Lỗi: GetOrderDetail AUTH FAIL HTTP=${httpStatus}`,
        json?.error,
        json?.message,
      );
    }

    if (json.error) {
      const errMsg = formatShopeeApiError(json, httpStatus);
      logShopeeSyncApiError(
        { ...(json || {}), httpStatus, message: json.message || errMsg },
        `get_order_detail shop_id=${apiShopId}`,
      );
      console.error(`[Sync Shop ${apiShopId}] Lỗi: GetOrderDetail ${errMsg}`);
      return { ...json, message: json.message || errMsg, httpStatus };
    }
    return { ...json, httpStatus };
  } catch (err: any) {
    logShopeeSyncApiError(err, `get_order_detail shop_id=${apiShopId}`);
    console.error(
      `[Sync Shop ${apiShopId}] Lỗi: GetOrderDetail EXCEPTION:`,
      err?.message || err,
      err?.stack || "",
    );
    return shopeeApiErrorResult(err, `get_order_detail fetch (shop_id=${apiShopId})`);
  }
}

// v2.payment.get_escrow_detail — đối soát escrow_amount + withholding_cit_tax (VN CB seller).
async function shopeeGetEscrowDetail(shopId: string, accessToken: string, orderSn: string) {
  const apiPath = "/api/v2/payment/get_escrow_detail";
  const timestamp = Math.floor(Date.now() / 1000);
  const sign = shopeeSign(apiPath, timestamp, accessToken, shopId);
  const params = new URLSearchParams({
    partner_id: SHOPEE_PARTNER_ID,
    timestamp: String(timestamp),
    access_token: accessToken,
    shop_id: shopId,
    sign,
    order_sn: String(orderSn),
  });
  const url = `${SHOPEE_HOST}${apiPath}?${params.toString()}`;
  try {
    const { json, httpStatus } = await shopeeFetchJsonWithRetry(
      url,
      `get_escrow_detail shop_id=${shopId} order_sn=${orderSn}`,
    );
    if (json.error) {
      return { ...json, message: json.message || formatShopeeApiError(json, httpStatus) };
    }
    return json;
  } catch (err) {
    return shopeeApiErrorResult(err, `get_escrow_detail fetch (shop_id=${shopId}, order_sn=${orderSn})`);
  }
}

type ShopSyncTimeRange = "all" | "24h";
type ShopeeUpdateWindow = { from: number; to: number } | undefined;

// v2.product.get_item_list — paginated list of item_ids currently listed on the shop.
async function shopeeGetItemList(
  shopId: string,
  accessToken: string,
  offset: number,
  updateWindow?: ShopeeUpdateWindow,
) {
  const apiPath = "/api/v2/product/get_item_list";
  const timestamp = Math.floor(Date.now() / 1000);
  const sign = shopeeSign(apiPath, timestamp, accessToken, shopId);

  const params = new URLSearchParams({
    partner_id: SHOPEE_PARTNER_ID,
    timestamp: String(timestamp),
    access_token: accessToken,
    shop_id: shopId,
    sign,
    offset: String(offset),
    page_size: String(SHOPEE_ITEM_LIST_PAGE_SIZE),
    item_status: "NORMAL",
  });
  if (updateWindow) {
    params.set("update_time_from", String(toShopeeUnixSeconds(updateWindow.from)));
    params.set("update_time_to", String(toShopeeUnixSeconds(updateWindow.to)));
  }

  const url = `${SHOPEE_HOST}${apiPath}?${params.toString()}`;
  const rangeLabel = updateWindow ? ` update=${updateWindow.from}-${updateWindow.to}` : "";
  const { json, httpStatus } = await shopeeFetchJsonWithRetry(
    url,
    `GET ${apiPath} offset=${offset}${rangeLabel}`,
  );
  console.log(
    `[Shopee API] GET ${apiPath} (offset=${offset}${rangeLabel}) -> HTTP ${httpStatus}:`,
    JSON.stringify(json),
  );
  if (json.error) {
    json.message = json.message || formatShopeeApiError(json, httpStatus);
    console.error(`[Shopee API] Lỗi get_item_list: ${json.error} — ${json.message}`);
  }
  return json;
}

// v2.product.get_item_base_info — name/SKU/price/stock/image for up to 50 items at a time.
async function shopeeGetItemBaseInfo(shopId: string, accessToken: string, itemIds: Array<string | number>) {
  const apiPath = "/api/v2/product/get_item_base_info";
  const timestamp = Math.floor(Date.now() / 1000);
  const sign = shopeeSign(apiPath, timestamp, accessToken, shopId);
  const idList = itemIds.map((id) => toShopeeId(id)).filter(Boolean) as string[];

  const params = new URLSearchParams({
    partner_id: SHOPEE_PARTNER_ID,
    timestamp: String(timestamp),
    access_token: accessToken,
    shop_id: shopId,
    sign,
    item_id_list: idList.join(","),
    need_tax_info: "false",
    need_complaint_policy: "false",
  });

  const url = `${SHOPEE_HOST}${apiPath}?${params.toString()}`;
  const { json, httpStatus } = await shopeeFetchJsonWithRetry(url, `GET ${apiPath} (${idList.length} items)`);
  // Không dump toàn bộ response vào log (dễ OOM / fork fail trên cPanel).
  const itemCount = asShopeeArray(json?.response?.item_list).length;
  console.log(
    `[Shopee API] GET ${apiPath} (${itemIds.length} ids) -> HTTP ${httpStatus}, items=${itemCount}, error=${json?.error || "none"}`
  );
  if (json.error) {
    json.message = json.message || formatShopeeApiError(json, httpStatus);
    console.error(`[Shopee API] Lỗi get_item_base_info: ${json.error} — ${json.message}`);
  }
  return json;
}

// v2.product.get_model_list — required for items that have variants (has_model=true);
// get_item_base_info's own price_info/stock_info_v2 do NOT reflect real numbers for those.
async function shopeeGetModelList(shopId: string, accessToken: string, itemId: string | number) {
  const apiPath = "/api/v2/product/get_model_list";
  const timestamp = Math.floor(Date.now() / 1000);
  const sign = shopeeSign(apiPath, timestamp, accessToken, shopId);
  const safeItemId = toShopeeId(itemId) || String(itemId);

  const params = new URLSearchParams({
    partner_id: SHOPEE_PARTNER_ID,
    timestamp: String(timestamp),
    access_token: accessToken,
    shop_id: shopId,
    sign,
    item_id: safeItemId,
  });

  const url = `${SHOPEE_HOST}${apiPath}?${params.toString()}`;
  const { json, httpStatus } = await shopeeFetchJsonWithRetry(url, `GET ${apiPath} item_id=${safeItemId}`);
  console.log(`[Shopee API] GET ${apiPath} (item_id=${safeItemId}) -> HTTP ${httpStatus}:`, JSON.stringify(json));
  if (json.error) {
    json.message = json.message || formatShopeeApiError(json, httpStatus);
  }
  return json;
}

async function shopeeGetModelListWithRetry(shopId: string, accessToken: string, itemId: string | number, retries = 3) {
  let last: any = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await sleep(SHOPEE_PRODUCT_API_DELAY_MS * attempt);
    last = await shopeeGetModelList(shopId, accessToken, itemId);
    if (!last?.error) return last;
    if (isShopeeRateLimited(0, last)) await sleep(SHOPEE_PRODUCT_API_DELAY_MS * 2);
  }
  return last;
}

/** Cache location_id theo shop — multi-warehouse bắt buộc có location_id trong seller_stock. */
const shopeeWarehouseLocationCache = new Map<string, { locationId: string | null; at: number }>();
const SHOPEE_WAREHOUSE_CACHE_TTL_MS = 10 * 60 * 1000;

async function shopeeGetWarehouseDetail(shopId: string, accessToken: string) {
  const apiPath = "/api/v2/shop/get_warehouse_detail";
  const timestamp = Math.floor(Date.now() / 1000);
  const sign = shopeeSign(apiPath, timestamp, accessToken, shopId);
  const params = new URLSearchParams({
    partner_id: SHOPEE_PARTNER_ID,
    timestamp: String(timestamp),
    access_token: accessToken,
    shop_id: shopId,
    sign,
    warehouse_type: "1",
  });
  const url = `${SHOPEE_HOST}${apiPath}?${params.toString()}`;
  const { json, httpStatus } = await shopeeFetchJsonWithRetry(url, `GET ${apiPath} shop=${shopId}`);
  console.log(
    `[Shopee API] GET ${apiPath} shop=${shopId} -> HTTP ${httpStatus}, error=${json?.error || "none"}`
  );
  return json;
}

/** Lấy location_id pickup đầu tiên; null nếu shop không multi-warehouse / không whitelist. */
async function resolveShopeeStockLocationId(
  shopId: string,
  accessToken: string
): Promise<string | null> {
  const key = String(shopId || "").trim();
  if (!key) return null;
  const cached = shopeeWarehouseLocationCache.get(key);
  if (cached && Date.now() - cached.at < SHOPEE_WAREHOUSE_CACHE_TTL_MS) {
    return cached.locationId;
  }
  try {
    const json = await shopeeGetWarehouseDetail(key, accessToken);
    if (json?.error) {
      shopeeWarehouseLocationCache.set(key, { locationId: null, at: Date.now() });
      return null;
    }
    const list = asShopeeArray(json?.response);
    const first = list.find((w: any) => String(w?.location_id || "").trim()) || list[0];
    const locationId = String(first?.location_id || "").trim() || null;
    shopeeWarehouseLocationCache.set(key, { locationId, at: Date.now() });
    return locationId;
  } catch (err) {
    console.warn(`[Shopee Warehouse] get_warehouse_detail thất bại shop=${key}:`, err);
    shopeeWarehouseLocationCache.set(key, { locationId: null, at: Date.now() });
    return null;
  }
}

/** Khớp model_id từ get_model_list theo SKU; trả hasModel nếu item có biến thể. */
async function resolveShopeeModelIdFromApi(
  shopId: string,
  accessToken: string,
  itemId: string | number,
  product: any
): Promise<{ modelId: string | null; hasModel: boolean }> {
  try {
    const json = await shopeeGetModelListWithRetry(shopId, accessToken, itemId);
    if (json?.error) return { modelId: null, hasModel: false };
    const { models } = parseModelListFromResponse(json);
    if (models.length === 0) return { modelId: null, hasModel: false };
    const sku = String(product?.sku || product?.modelSku || "").trim().toLowerCase();
    if (sku) {
      const bySku = models.find(
        (m: any) => String(m?.model_sku || "").trim().toLowerCase() === sku
      );
      if (bySku?.model_id != null) {
        const id = toShopeeId(bySku.model_id);
        if (id) return { modelId: id, hasModel: true };
      }
    }
    if (models.length === 1 && models[0]?.model_id != null) {
      const id = toShopeeId(models[0].model_id);
      if (id) return { modelId: id, hasModel: true };
    }
    return { modelId: null, hasModel: true };
  } catch (err) {
    console.warn(`[Shopee Sync] resolve model_id từ API thất bại item_id=${itemId}:`, err);
    return { modelId: null, hasModel: false };
  }
}

// v2.product.update_stock — đẩy tồn kho seller_stock lên sàn Shopee (theo item_id, có/không model_id).
async function shopeeUpdateStock(
  shopId: string,
  accessToken: string,
  itemId: string | number,
  stockList: { model_id?: string | number; seller_stock: { stock: number; location_id?: string }[] }[]
) {
  const apiPath = "/api/v2/product/update_stock";
  const timestamp = Math.floor(Date.now() / 1000);
  const sign = shopeeSign(apiPath, timestamp, accessToken, shopId);
  const url = `${SHOPEE_HOST}${apiPath}?partner_id=${SHOPEE_PARTNER_ID}&timestamp=${timestamp}&access_token=${accessToken}&shop_id=${shopId}&sign=${sign}`;

  // UpdateStockRequest.item_id / model_id = uint64 → phải là NUMBER trong JSON body.
  const safeItemId = toShopeeIdNumber(itemId);
  if (safeItemId == null) {
    return {
      error: "error_param",
      message: "item_id không hợp lệ khi gọi update_stock",
      response: { failure_list: [], success_list: [] },
    };
  }
  const normalizedStockList = (Array.isArray(stockList) ? stockList : []).map((row) => {
    const entry: { model_id?: number; seller_stock: { stock: number; location_id?: string }[] } = {
      seller_stock: row.seller_stock,
    };
    const mid = toShopeeIdNumber(row?.model_id);
    if (mid != null) entry.model_id = mid;
    return entry;
  });
  const body = { item_id: safeItemId, stock_list: normalizedStockList };
  console.log(`[Shopee API] POST ${apiPath} REQUEST item_id=${safeItemId}:`, JSON.stringify(body));
  const { json, httpStatus } = await shopeePostJsonWithRetry(url, body, `POST ${apiPath} item_id=${safeItemId}`);
  console.log(`[Shopee API] POST ${apiPath} RESPONSE item_id=${safeItemId} HTTP ${httpStatus}:`, JSON.stringify(json));
  return json;
}

/** Chuẩn hóa 1 dòng price_list — original_price NUMBER; model_id NUMBER (uint64). */
function buildShopeeUpdatePriceEntry(
  sellingPrice: unknown,
  modelId?: string | number | null
): { model_id?: number; original_price: number } {
  // VN và hầu hết region (trừ SG/MY/BR/...): giá phải là số nguyên.
  const originalPrice = Math.max(0, Math.round(Number(sellingPrice) || 0));
  const entry: { model_id?: number; original_price: number } = {
    original_price: originalPrice,
  };
  const mid = toShopeeIdNumber(modelId);
  if (mid != null) entry.model_id = mid;
  return entry;
}

async function shopeeUpdatePrice(
  shopId: string,
  accessToken: string,
  itemId: string | number,
  priceList: { model_id?: string | number; original_price: number }[]
) {
  const apiPath = "/api/v2/product/update_price";
  const timestamp = Math.floor(Date.now() / 1000);
  const sign = shopeeSign(apiPath, timestamp, accessToken, shopId);
  const url = `${SHOPEE_HOST}${apiPath}?partner_id=${SHOPEE_PARTNER_ID}&timestamp=${timestamp}&access_token=${accessToken}&shop_id=${shopId}&sign=${sign}`;

  const safeItemId = toShopeeIdNumber(itemId);
  const normalizedPriceList = (Array.isArray(priceList) ? priceList : []).map((row) => {
    const originalPrice = Math.max(0, Math.round(Number(row?.original_price) || 0));
    const entry: { model_id?: number; original_price: number } = {
      original_price: originalPrice,
    };
    const mid = toShopeeIdNumber(row?.model_id);
    if (mid != null) entry.model_id = mid;
    return entry;
  });
  if (safeItemId == null) {
    return {
      error: "error_param",
      message: "item_id không hợp lệ khi gọi update_price",
      response: { failure_list: [], success_list: [] },
    };
  }
  if (normalizedPriceList.length === 0) {
    return {
      error: "error_param",
      message: "price_list rỗng khi gọi update_price",
      response: { failure_list: [], success_list: [] },
    };
  }

  const body = { item_id: safeItemId, price_list: normalizedPriceList };
  console.log(`[Shopee API] POST ${apiPath} REQUEST item_id=${safeItemId}:`, JSON.stringify(body));
  const { json, httpStatus } = await shopeePostJsonWithRetry(url, body, `POST ${apiPath} item_id=${safeItemId}`, {
    maxAttempts: SHOPEE_SYNC_QUEUE_MAX_RETRY,
  });
  console.log(
    `[Shopee API] POST ${apiPath} RESPONSE item_id=${safeItemId} HTTP ${httpStatus}:`,
    JSON.stringify(json)
  );
  // HTTP 200 vẫn có thể chứa error/message/failure_list trong JSON body.
  if (json && typeof json === "object") {
    const businessError = String(json.error || "").trim();
    if (businessError && !String(json.message || "").trim()) {
      json.message = formatShopeeApiError(json, httpStatus >= 400 ? httpStatus : undefined);
    }
  }
  return json;
}

/** v2.product.update_model — cập nhật model_sku (SKU phân loại) lên Shopee. */
async function shopeeUpdateModelSku(
  shopId: string,
  accessToken: string,
  itemId: string | number,
  modelId: string | number,
  modelSku: string
) {
  const apiPath = "/api/v2/product/update_model";
  const timestamp = Math.floor(Date.now() / 1000);
  const sign = shopeeSign(apiPath, timestamp, accessToken, shopId);
  const url = `${SHOPEE_HOST}${apiPath}?partner_id=${SHOPEE_PARTNER_ID}&timestamp=${timestamp}&access_token=${accessToken}&shop_id=${shopId}&sign=${sign}`;

  const safeItemId = toShopeeIdNumber(itemId);
  const safeModelId = toShopeeIdNumber(modelId);
  if (safeItemId == null || safeModelId == null) {
    return {
      error: "error_param",
      message: "item_id/model_id không hợp lệ khi gọi update_model",
      response: { failure_list: [], success_list: [] },
    };
  }

  const body = {
    item_id: safeItemId,
    model: [
      {
        model_id: safeModelId,
        model_sku: String(modelSku || "").trim(),
      },
    ],
  };
  console.log(`[Shopee API] POST ${apiPath} REQUEST item_id=${safeItemId}:`, JSON.stringify(body));
  const { json, httpStatus } = await shopeePostJsonWithRetry(url, body, `POST ${apiPath} item_id=${safeItemId}`, {
    maxAttempts: SHOPEE_SYNC_QUEUE_MAX_RETRY,
  });
  console.log(
    `[Shopee API] POST ${apiPath} RESPONSE item_id=${safeItemId} HTTP ${httpStatus}:`,
    JSON.stringify(json)
  );
  if (json && typeof json === "object") {
    const businessError = String(json.error || "").trim();
    if (businessError && !String(json.message || "").trim()) {
      json.message = formatShopeeApiError(json, httpStatus >= 400 ? httpStatus : undefined);
    }
  }
  return json;
}

// ---------------------------------------------------------------------------
// Shopee Open API v2 — Đăng bán sản phẩm (Guide 217)
// upload_image → add_item → init_tier_variation → add_model
// ---------------------------------------------------------------------------

/** Shopee thường HTTP 200 kể cả khi lỗi — bắt buộc đọc body.error / lỗi lồng. */
function extractShopeeBusinessError(json: any, httpStatus?: number): string | null {
  if (!json || typeof json !== "object") {
    return httpStatus && httpStatus >= 400 ? `Shopee API lỗi HTTP ${httpStatus}` : null;
  }
  const topError = String(json.error ?? "").trim();
  const topMessage = String(json.message ?? json.msg ?? "").trim();
  if (topError) {
    return formatShopeeApiError(json, httpStatus);
  }
  // upload_image: lỗi từng ảnh trong image_info_list dù error=""
  const infoList = Array.isArray(json?.response?.image_info_list)
    ? json.response.image_info_list
    : [];
  for (const row of infoList) {
    const rowErr = String(row?.error ?? row?.image_info?.error ?? "").trim();
    const rowMsg = String(row?.message ?? row?.image_info?.message ?? "").trim();
    if (rowErr || (rowMsg && !row?.image_info?.image_id && !row?.image_id)) {
      return [rowErr, rowMsg].filter(Boolean).join(" — ") || "upload_image lỗi từng ảnh";
    }
  }
  // Một số API trả failure_list mà error rỗng
  const failures = Array.isArray(json?.response?.failure_list) ? json.response.failure_list : [];
  if (failures.length > 0) {
    const f0 = failures[0];
    const fMsg = String(f0?.failed_reason || f0?.message || f0?.error || "").trim();
    return fMsg || `Shopee failure_list (${failures.length})`;
  }
  if (httpStatus && httpStatus >= 400) {
    return topMessage || `Shopee API lỗi HTTP ${httpStatus}`;
  }
  return null;
}

function assertShopeeApiOk(json: any, httpStatus: number | undefined, context: string): void {
  const bizErr = extractShopeeBusinessError(json, httpStatus);
  if (bizErr) {
    console.log("[SHOPEE UPLOAD ERROR]:", JSON.stringify(json ?? { error: bizErr }, null, 2));
    const rawCode = String(json?.error || "").trim();
    if (isShopeeInvalidCategoryError(rawCode) || isShopeeInvalidCategoryError(bizErr)) {
      const err: any = new Error(`${context}: ${SHOPEE_INVALID_CATEGORY_USER_MSG}`);
      err.code = SHOPEE_INVALID_CATEGORY_CODE;
      err.shopee_error = rawCode || SHOPEE_INVALID_CATEGORY_CODE;
      throw err;
    }
    throw new Error(`${context}: ${bizErr}`);
  }
}

async function shopeeFetchCategoryList(shopId: string, accessToken: string): Promise<any[]> {
  const apiPath = "/api/v2/product/get_category";
  const timestamp = Math.floor(Date.now() / 1000);
  const sign = shopeeSign(apiPath, timestamp, accessToken, shopId);
  const params = new URLSearchParams({
    partner_id: SHOPEE_PARTNER_ID,
    timestamp: String(timestamp),
    access_token: accessToken,
    shop_id: shopId,
    sign,
    language: "vi",
  });
  const url = `${SHOPEE_HOST}${apiPath}?${params.toString()}`;
  let json: any;
  let httpStatus: number | undefined;
  try {
    const ax = await shopeeAxiosGet(url, `GET ${apiPath}`);
    json = ax.json;
    httpStatus = ax.httpStatus;
  } catch {
    const fb = await shopeeFetchJsonWithRetry(url, `GET ${apiPath}`);
    json = fb.json;
    httpStatus = fb.httpStatus;
  }
  assertShopeeApiOk(json, httpStatus, "get_category");
  return asShopeeArray(json?.response?.category_list);
}

async function resolveShopeePublishCategoryId(
  shopId: string,
  accessToken: string,
  payload: any,
): Promise<number> {
  const raw = payload?.shopeeCategoryId ?? payload?.shopeeCategory?.categoryId;
  const asInt = toShopeeCategoryIdInt(raw);
  if (asInt == null) {
    const err: any = new Error("Thiếu category_id Shopee hợp lệ (phải là số nguyên leaf)");
    err.code = SHOPEE_INVALID_CATEGORY_CODE;
    throw err;
  }

  const catDeps = {
    shopId,
    accessToken,
    fetchCategoryList: shopeeFetchCategoryList,
  };
  // Luôn đảm bảo có cache mới (hoặc sync nếu hết hạn)
  let cache = await getOrSyncShopeeCategories(APP_ROOT, catDeps, { force: false });
  let validated = validateShopeeLeafCategoryId(asInt, cache);
  if (!validated.ok) {
    // Force sync một lần rồi validate lại
    cache = await getOrSyncShopeeCategories(APP_ROOT, catDeps, { force: true });
    validated = validateShopeeLeafCategoryId(asInt, cache);
  }
  if (!validated.ok) {
    const err: any = new Error(validated.error || SHOPEE_INVALID_CATEGORY_USER_MSG);
    err.code = validated.code || SHOPEE_INVALID_CATEGORY_CODE;
    throw err;
  }
  return validated.categoryId!;
}

function stripHtmlToText(html: string): string {
  return String(html || "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function flattenShopeeAttributeNodes(nodes: any[]): any[] {
  const out: any[] = [];
  for (const n of Array.isArray(nodes) ? nodes : []) {
    if (!n || typeof n !== "object") continue;
    if (n.attribute_id != null) out.push(n);
    if (Array.isArray(n.attribute_tree)) out.push(...flattenShopeeAttributeNodes(n.attribute_tree));
    if (Array.isArray(n.child_attribute_list)) out.push(...flattenShopeeAttributeNodes(n.child_attribute_list));
    if (Array.isArray(n.children)) out.push(...flattenShopeeAttributeNodes(n.children));
  }
  return out;
}

async function resolvePublishImageBuffer(src: string): Promise<{ buf: Buffer; filename: string; mime: string }> {
  const raw = String(src || "").trim();
  if (!raw) throw new Error("Ảnh trống");

  if (raw.startsWith("data:image")) {
    const m = raw.match(/^data:(image\/[\w+.-]+);base64,(.+)$/i);
    if (!m) throw new Error("Data URL ảnh không hợp lệ");
    const mime = m[1].toLowerCase();
    const ext = mime.includes("png") ? "png" : mime.includes("webp") ? "webp" : "jpg";
    return { buf: Buffer.from(m[2], "base64"), filename: `item.${ext}`, mime };
  }

  const framedMatch = raw.match(/\/api\/framed-images\/([^/?#]+)/i);
  if (framedMatch) {
    const filePath = path.join(APP_ROOT, "data", "framed_images", `${decodeURIComponent(framedMatch[1])}.jpg`);
    if (fs.existsSync(filePath)) {
      return { buf: fs.readFileSync(filePath), filename: "item.jpg", mime: "image/jpeg" };
    }
  }

  let fetchUrl = raw;
  if (raw.startsWith("/")) {
    fetchUrl = `${APP_BASE_URL.replace(/\/$/, "")}${raw}`;
  }
  const res = await fetch(fetchUrl);
  if (!res.ok) throw new Error(`Không tải được ảnh (${res.status}): ${raw.slice(0, 120)}`);
  const mime = (res.headers.get("content-type") || "image/jpeg").split(";")[0].trim() || "image/jpeg";
  const ext = mime.includes("png") ? "png" : mime.includes("webp") ? "webp" : "jpg";
  return { buf: Buffer.from(await res.arrayBuffer()), filename: `item.${ext}`, mime };
}

async function shopeeUploadImage(
  shopId: string,
  accessToken: string,
  imageBuffer: Buffer,
  filename = "item.jpg",
  mime = "image/jpeg",
): Promise<string> {
  const apiPath = "/api/v2/media_space/upload_image";
  const timestamp = Math.floor(Date.now() / 1000);
  const sign = shopeeSign(apiPath, timestamp, accessToken, shopId);
  const url =
    `${SHOPEE_HOST}${apiPath}?partner_id=${SHOPEE_PARTNER_ID}` +
    `&timestamp=${timestamp}&access_token=${encodeURIComponent(accessToken)}&shop_id=${shopId}&sign=${sign}`;

  const form = new FormData();
  const fileBytes = new Uint8Array(imageBuffer);
  form.append("image", new Blob([fileBytes], { type: mime }), filename);
  form.append("scene", "normal");

  const res = await fetchWithTimeout(url, { method: "POST", body: form }, 90_000);
  const rawText = await res.text();
  let json: any = {};
  try {
    json = rawText ? parseShopeeJson(rawText) : {};
  } catch {
    console.log("[SHOPEE UPLOAD ERROR]:", JSON.stringify({ httpStatus: res.status, rawText: rawText.slice(0, 2000) }, null, 2));
    throw new Error(`upload_image phản hồi không phải JSON (HTTP ${res.status})`);
  }
  assertShopeeApiOk(json, res.status, "upload_image");
  const info =
    json?.response?.image_info_list?.[0]?.image_info ||
    json?.response?.image_info_list?.[0] ||
    json?.response?.image_info;
  const imageId = info?.image_id || info?.image_id_list?.[0];
  if (!imageId) {
    console.log("[SHOPEE UPLOAD ERROR]:", JSON.stringify(json, null, 2));
    throw new Error("upload_image: Shopee không trả image_id (HTTP 200 nhưng thiếu image_id)");
  }
  return String(imageId);
}

async function shopeeGetChannelList(shopId: string, accessToken: string) {
  const apiPath = "/api/v2/logistics/get_channel_list";
  const timestamp = Math.floor(Date.now() / 1000);
  const sign = shopeeSign(apiPath, timestamp, accessToken, shopId);
  const params = new URLSearchParams({
    partner_id: SHOPEE_PARTNER_ID,
    timestamp: String(timestamp),
    access_token: accessToken,
    shop_id: shopId,
    sign,
  });
  const { json, httpStatus } = await shopeeFetchJsonWithRetry(
    `${SHOPEE_HOST}${apiPath}?${params.toString()}`,
    `GET ${apiPath}`,
  );
  assertShopeeApiOk(json, httpStatus, "get_channel_list");
  const list = asShopeeArray(json?.response?.logistics_channel_list);
  return list
    .filter((c: any) => c && Number(c.logistics_channel_id) > 0)
    .map((c: any) => ({
      logistic_id: Number(c.logistics_channel_id),
      enabled: Boolean(c.enabled !== false),
      logistic_name: String(c.logistics_channel_name || `Kênh ${c.logistics_channel_id}`),
      channel_type: classifyLogisticChannelType(c),
      has_size_limit: Boolean(c.size_limit || c.max_dimension || c.max_length || c.max_width || c.max_height),
      max_dimension: (() => {
        const md = c.max_dimension;
        if (!md) {
          const ml = Number(c.max_length || 0);
          const mw = Number(c.max_width || 0);
          const mh = Number(c.max_height || 0);
          if (ml > 0 || mw > 0 || mh > 0) return { max_length: ml, max_width: mw, max_height: mh };
          return undefined;
        }
        return {
          max_length: Number(md.max_length || 0),
          max_width: Number(md.max_width || 0),
          max_height: Number(md.max_height || 0),
        };
      })(),
      cod_enabled: Boolean(c.cod_enabled ?? c.support_cod ?? c.is_cod),
      fee_type: String(c.fee_type || ''),
    }));
}

function classifyLogisticChannelType(c: any): string {
  const name = String(c.logistics_channel_name || '').toLowerCase();
  const mask = Number(c.mask_channel || 0);
  // Shopee bitmask: 1=express(hoa toc), 2=fast(nhanh), 4=pickup, 8=bulky
  if (mask === 1 || /hoả? ?tốc|express|same.?day/i.test(name)) return 'express';
  if (mask === 2 || /nhanh|fast|next.?day/i.test(name)) return 'fast';
  if (mask === 4 || /lấy ?hàng|pick.?up|self.?collect/i.test(name)) return 'pickup';
  if (mask === 8 || /cồng ?kềnh|bulky|heavy|large/i.test(name)) return 'bulky';
  // Heuristic by name
  if (/hoả? ?tốc|express|same.?day|now/i.test(name)) return 'express';
  if (/nhanh|fast|next.?day/i.test(name)) return 'fast';
  if (/lấy ?hàng|pick.?up|self.?collect/i.test(name)) return 'pickup';
  if (/cồng ?kềnh|bulky|heavy|large/i.test(name)) return 'bulky';
  return 'other';
}

/**
 * Resolve generic channel keys → actual logistic_id[], intersected with shop's real channels.
 * FE sends perShopLogistics as string keys (e.g. ["express","fast"]);
 * Backend must cross-check each resolved id against fullChannels before sending to Shopee.
 */
function resolveLogisticIdsBackend(
  genericKeys: string[],
  fullChannels: { logistic_id: number; logistic_name: string }[],
): { resolved: number[]; excluded: string[] } {
  if (!Array.isArray(genericKeys) || !genericKeys.length || !Array.isArray(fullChannels)) {
    return { resolved: [], excluded: [] };
  }

  const SHOP_CHANNEL_KEY_MAP: Record<string, (name: string) => boolean> = {
    bulky: (name) => /cồng ?kềnh|bulky|heavy|large/i.test(name),
    express: (name) => /hoả? ?tốc|express/i.test(name),
    fast: (name) => /nhanh|fast|next.?day/i.test(name) && !/hoả? ?tốc/i.test(name),
    sameday: (name) => /trong ?ngày|same.?day/i.test(name),
    spx_locker: (name) => /tủ ?nhận ?hàng|tủ spx|spx ?locker/i.test(name),
    smartbox: (name) => /smartbox|viettel/i.test(name),
    pickup: (name) => /lấy ?hàng|pick.?up|self.?collect|điểm ?nhận/i.test(name),
  };

  const availableChannelIds = new Set(fullChannels.map((c) => c.logistic_id));
  const resolved: number[] = [];
  const excluded: string[] = [];

  for (const key of genericKeys) {
    const matcher = SHOP_CHANNEL_KEY_MAP[key];
    if (!matcher) continue;
    const matched = fullChannels.filter((ch) => matcher(String(ch.logistic_name || '').toLowerCase()));
    if (!matched.length) {
      excluded.push(key);
      continue;
    }
    for (const ch of matched) {
      if (availableChannelIds.has(ch.logistic_id)) {
        resolved.push(ch.logistic_id);
      } else {
        excluded.push(`${key}(id=${ch.logistic_id})`);
      }
    }
  }

  return {
    resolved: [...new Set(resolved)],
    excluded,
  };
}

/** Lọc kênh vận chuyển hợp lệ theo enabledLogistics + kích thước + weight. */
function buildLogisticInfoFromPayload(
  fullChannels: any[],
  enabledLogistics: number[],
  payload: any,
): any[] {
  const pkgLength = Math.max(1, Number(payload?.packageLength || 10));
  const pkgWidth = Math.max(1, Number(payload?.packageWidth || 10));
  const pkgHeight = Math.max(1, Number(payload?.packageHeight || 10));
  const pkgWeight = Number(payload?.packageWeight || payload?.weight || 500);
  const dims = [pkgLength, pkgWidth, pkgHeight].sort((a, b) => b - a);

  // Tủ nhận hàng (locker) — bị disable mặc định vì kích thước gói hàng dễ vượt limit.
  const LOCKER_KEYWORDS = ['tủ nhận hàng', 'smartbox', 'locker', 'tủ spx', 'spx express locker'];

  const result: any[] = [];
  for (const ch of fullChannels) {
    // FE đã bật toggle?
    const feEnabled = enabledLogistics.includes(ch.logistic_id);
    // Hoặc legacy: lấy all enabled channels nếu FE không gửi enabledLogistics
    const isEnabled = enabledLogistics.length > 0
      ? feEnabled
      : (ch.enabled !== false);
    if (!isEnabled) continue;

    // Phát hiện kênh locker
    const chNameLower = String(ch.logistic_name || '').toLowerCase();
    const isLocker = LOCKER_KEYWORDS.some((kw) => chNameLower.includes(kw));

    // Kiểm tra giới hạn kích thước
    if (ch.has_size_limit && ch.max_dimension) {
      const md = [ch.max_dimension.max_length, ch.max_dimension.max_width, ch.max_dimension.max_height].sort(
        (a, b) => b - a,
      );
      // locker: disable nếu kích thước vượt giới hạn hoặc nếu không có thông tin limit (an toàn)
      if (isLocker) {
        result.push({ logistic_id: ch.logistic_id, enabled: false });
        continue;
      }
      if (dims[0] > md[0] || dims[1] > md[1] || dims[2] > md[2]) continue;
    } else if (isLocker) {
      // Không có max_dimension mà là locker → disable mặc định
      result.push({ logistic_id: ch.logistic_id, enabled: false });
      continue;
    }

    result.push({ logistic_id: ch.logistic_id, enabled: true });
  }
  return result;
}

async function shopeeGetAttributeTree(shopId: string, accessToken: string, categoryId: number) {
  const apiPath = "/api/v2/product/get_attribute_tree";
  const timestamp = Math.floor(Date.now() / 1000);
  const sign = shopeeSign(apiPath, timestamp, accessToken, shopId);
  // Không cache — luôn gọi Shopee live (cây thuộc tính thay đổi theo OpenAPI mới).
  const params = new URLSearchParams({
    partner_id: SHOPEE_PARTNER_ID,
    timestamp: String(timestamp),
    access_token: accessToken,
    shop_id: shopId,
    sign,
    category_id_list: String(categoryId),
    language: "vi",
  });
  const url = `${SHOPEE_HOST}${apiPath}?${params.toString()}`;
  // Ưu tiên Axios + json-bigint; fallback fetch retry nếu Axios lỗi mạng.
  let json: any;
  let httpStatus: number | undefined;
  try {
    const ax = await shopeeAxiosGet(url, `GET ${apiPath} category=${categoryId}`);
    json = ax.json;
    httpStatus = ax.httpStatus;
  } catch {
    const fb = await shopeeFetchJsonWithRetry(url, `GET ${apiPath} category=${categoryId}`);
    json = fb.json;
    httpStatus = fb.httpStatus;
  }
  assertShopeeApiOk(json, httpStatus, "get_attribute_tree");
  const listEntry = asShopeeArray(json?.response?.list)[0];
  const tree =
    asShopeeArray(listEntry?.attribute_tree).length > 0
      ? asShopeeArray(listEntry?.attribute_tree)
      : asShopeeArray(json?.response?.attribute_list).length > 0
        ? asShopeeArray(json?.response?.attribute_list)
        : asShopeeArray(listEntry?.attribute_list);
  const flat = flattenShopeeAttributeNodes(tree);
  return flat.map((a: any) => {
    const values = asShopeeArray(a.attribute_value_list || a.value_list || a.values);
    return {
      attribute_id: Number(a.attribute_id),
      attribute_name: String(a.name || a.attribute_name || a.display_attribute_name || `Attr ${a.attribute_id}`),
      mandatory: Boolean(a.mandatory ?? a.is_mandatory ?? a.mandatory_region),
      input_type: String(a.attribute_info?.input_type || a.input_type || a.attribute_type || ""),
      values: values.map((v: any) => ({
        value_id: Number(v.value_id ?? v.attribute_value_id ?? 0),
        name: String(v.name || v.original_value_name || v.display_value_name || ""),
      })),
    };
  });
}

async function shopeeProductPost(
  apiPath: string,
  shopId: string,
  accessToken: string,
  body: Record<string, unknown>,
  context: string,
) {
  const timestamp = Math.floor(Date.now() / 1000);
  const sign = shopeeSign(apiPath, timestamp, accessToken, shopId);
  const url =
    `${SHOPEE_HOST}${apiPath}?partner_id=${SHOPEE_PARTNER_ID}` +
    `&timestamp=${timestamp}&access_token=${encodeURIComponent(accessToken)}&shop_id=${shopId}&sign=${sign}`;
  console.log(`[Shopee Publish] POST ${apiPath} shop=${shopId}:`, JSON.stringify(body).slice(0, 2000));
  // Axios + json-bigint: uint64 (item_id/promotion_id/activity_id) không bị Number làm tròn.
  let json: any;
  let httpStatus: number | undefined;
  try {
    const ax = await shopeeAxiosPost(url, body, context);
    json = ax.json;
    httpStatus = ax.httpStatus;
  } catch {
    const fb = await shopeePostJsonWithRetry(url, body, context);
    json = fb.json;
    httpStatus = fb.httpStatus;
  }
  assertShopeeApiOk(json, httpStatus, context);
  const response = json?.response;
  if (response == null && context === "add_item") {
    console.log("[SHOPEE UPLOAD ERROR]:", JSON.stringify(json, null, 2));
    throw new Error(`${context}: HTTP ${httpStatus || 200} nhưng thiếu response.item_id`);
  }
  return response ?? json;
}

/** Danh mục Y tế / Dược phẩm — bắt buộc medicine_id theo Shopee OpenAPI. */
function isShopeeMedicalCategory(payload: any): boolean {
  const text = [
    payload?.shopeeCat,
    payload?.shopeeCategory?.label,
    payload?.shopeeCategory?.level1,
    payload?.shopeeCategory?.level2,
    payload?.shopeeCategory?.level3,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase()
    .normalize("NFC");
  return /dược|thuốc|y\s*tế|sức\s*khỏe|pharmacy|medicine|healthcare|health\s*care|pharma|\botc\b|thực phẩm chức năng|bổ sung sức khỏe|chăm sóc sức khỏe/.test(
    text,
  );
}

function resolveShopeeMedicineId(payload: any): string | null {
  const raw =
    payload?.medicine_id ??
    payload?.medicineId ??
    payload?.warehouseMedicineId ??
    null;
  if (raw == null || raw === "") return null;
  return toShopeeId(raw) || String(raw).trim() || null;
}

function buildShopeeAttributeListFromPayload(payload: any, mandatoryAttrs: any[]): any[] {
  const fromFe = Array.isArray(payload?.shopeeAttributes) ? payload.shopeeAttributes : [];
  const byId = new Map<number, any>();
  for (const row of fromFe) {
    const attributeId = Number(row?.attribute_id);
    if (!Number.isFinite(attributeId) || attributeId <= 0) continue;
    const valueId = Number(row?.value_id ?? row?.attribute_value_list?.[0]?.value_id ?? 0);
    const originalValueName = String(
      row?.original_value_name ||
        row?.value_name ||
        row?.attribute_value_list?.[0]?.original_value_name ||
        "",
    ).trim();
    if (!valueId && !originalValueName) continue;
    byId.set(attributeId, {
      attribute_id: attributeId,
      attribute_value_list: [
        {
          value_id: Number.isFinite(valueId) ? valueId : 0,
          ...(originalValueName ? { original_value_name: originalValueName } : {}),
        },
      ],
    });
  }

  for (const attr of mandatoryAttrs) {
    const attributeId = Number(attr.attribute_id);
    if (!Number.isFinite(attributeId) || byId.has(attributeId)) continue;
    const first = Array.isArray(attr.values) ? attr.values[0] : null;
    if (first && (first.value_id || first.name)) {
      byId.set(attributeId, {
        attribute_id: attributeId,
        attribute_value_list: [
          {
            value_id: Number(first.value_id) || 0,
            ...(first.name ? { original_value_name: String(first.name) } : {}),
          },
        ],
      });
    }
  }

  return Array.from(byId.values());
}

function resolveShopeeBrandId(payload: any): number {
  const raw = Number(payload?.shopeeBrandId ?? payload?.brand_id);
  if (Number.isFinite(raw) && raw > 0) return raw;
  const name = String(payload?.shopeeBrand || "").trim().toLowerCase();
  if (!name || name === "nobrand" || name === "no brand" || name === "no_brand") return 0;
  return 0; // fallback No Brand
}

function packageWeightToKg(payload: any): number {
  const raw = Number(payload?.packageWeight ?? payload?.weight ?? 500);
  if (!Number.isFinite(raw) || raw <= 0) return 0.5;
  // FE dùng gram; nếu đã là kg (< 30) giữ nguyên
  return raw > 30 ? raw / 1000 : raw;
}

async function publishOneItemToShopee(shopId: string, payload: any): Promise<string> {
  const accessToken = await getValidShopeeAccessToken(shopId);
  if (!accessToken) {
    const fail = describeShopeeTokenFailure(shopId);
    throw new Error(fail.message);
  }

  const categoryId = await resolveShopeePublishCategoryId(shopId, accessToken, payload);

  const images: string[] = Array.isArray(payload?.images) ? payload.images.filter(Boolean) : [];
  if (!images.length) throw new Error("Thiếu hình ảnh sản phẩm");

  const medicalCategory = isShopeeMedicalCategory(payload);
  const medicineId = resolveShopeeMedicineId(payload);
  if (medicalCategory && !medicineId) {
    throw new Error("Danh mục Y tế/Dược phẩm bắt buộc nhập Mã thuốc (medicine_id)");
  }

  // 1) Media Space — bắt buộc image_id Shopee, không dùng URL ngoài
  const imageIds: string[] = [];
  for (const src of images.slice(0, 9)) {
    const { buf, filename, mime } = await resolvePublishImageBuffer(src);
    if (buf.length > 10 * 1024 * 1024) throw new Error(`Ảnh vượt 10MB: ${filename}`);
    imageIds.push(await shopeeUploadImage(shopId, accessToken, buf, filename, mime));
    await sleep(SHOPEE_PRODUCT_API_DELAY_MS);
  }

  const fullChannels = await shopeeGetChannelList(shopId, accessToken);

  let enabledLogistics: number[] = Array.isArray(payload?.enabledLogistics)
    ? payload.enabledLogistics.map(Number).filter((n: number) => n > 0)
    : [];

  // --- BƯỚC QUAN TRỌNG: Resolve & intersect với kênh thực tế của shop ---
  if (Array.isArray(payload?.perShopLogistics) && payload.perShopLogistics.length > 0) {
    const resolved = resolveLogisticIdsBackend(payload.perShopLogistics, fullChannels);
    enabledLogistics = resolved.resolved;
    if (resolved.excluded.length > 0) {
      console.warn("[SHOPEE LOGISTIC FILTER] Đã loại trừ các kênh không tồn tại trong shop:", resolved.excluded);
    }
  }

  const logisticInfo = buildLogisticInfoFromPayload(fullChannels, enabledLogistics, payload);
  if (!logisticInfo.length) {
    throw new Error("Shop chưa có kênh vận chuyển enabled (get_channel_list) hoặc kích thước gói hàng không phù hợp với bất kỳ kênh nào");
  }
  await sleep(SHOPEE_PRODUCT_API_DELAY_MS);

  // Luôn đồng bộ get_attribute_tree mới nhất — không dùng cache/hardcode.
  let mandatoryAttrs: any[] = [];
  let attributeTreeError: string | null = null;
  try {
    const allAttrs = await shopeeGetAttributeTree(shopId, accessToken, categoryId);
    mandatoryAttrs = allAttrs.filter((a) => a.mandatory);
  } catch (err: any) {
    attributeTreeError = err?.message || String(err);
    console.log("[SHOPEE UPLOAD ERROR]:", JSON.stringify({ step: "get_attribute_tree", error: attributeTreeError }, null, 2));
  }
  await sleep(SHOPEE_PRODUCT_API_DELAY_MS);

  const attributeList = buildShopeeAttributeListFromPayload(payload, mandatoryAttrs);
  const missingMandatory = mandatoryAttrs.filter(
    (a) => !attributeList.some((x) => Number(x.attribute_id) === Number(a.attribute_id)),
  );
  if (missingMandatory.length > 0) {
    const names = missingMandatory.map((a) => a.attribute_name).join(", ");
    throw new Error(`Thiếu thuộc tính bắt buộc: ${names}`);
  }
  // Không có tree + FE cũng không gửi attribute → vẫn cho add_item thử, nhưng log rõ
  if (attributeTreeError && !attributeList.length) {
    console.warn(
      `[Shopee Publish] Không lấy được attribute_tree và FE không gửi attributes — add_item có thể bị Shopee từ chối. ${attributeTreeError}`,
    );
  }

  const variants = Array.isArray(payload?.variants) ? payload.variants : [];
  const hasVariants =
    variants.length > 1 ||
    (variants.length === 1 &&
      String(variants[0]?.name || "").trim() &&
      !/^mặc định$/i.test(String(variants[0]?.name || "").trim()));

  const basePrice = Math.max(
    0,
    Math.round(Number(variants[0]?.priceShopee ?? payload?.price ?? 0)),
  );
  const baseStock = Math.max(0, Math.round(Number(variants[0]?.stock ?? 0)));
  if (basePrice <= 0) throw new Error("Giá Shopee phải > 0");

  const itemName = String(
    (payload?.shopTitles && payload.shopTitles[shopId]) || payload?.title || "Sản phẩm",
  )
    .trim()
    .slice(0, 120);
  const description = stripHtmlToText(payload?.descriptionHtml || payload?.description || itemName).slice(
    0,
    5000,
  ) || itemName;

  const weightKg = packageWeightToKg(payload);
  const brandId = resolveShopeeBrandId(payload);
  const perVariationWeight = Boolean(payload?.perVariationWeight);

  // Chỉ update khi có forceUpdateItemId rõ ràng (từ trang edit sản phẩm đã đăng).
  // Form "Đăng bán mới" KHÔNG gửi forceUpdateItemId → luôn nhánh add_item.
  const existingItemId =
    payload?.forceUpdateItemId
      ? (toShopeeId(payload.forceUpdateItemId) || toShopeeId(payload?.item_id) || null)
      : null;

  // Pre-order
  const isPreOrder = Boolean(payload?.isPreOrder || payload?.is_pre_order);
  const daysToShip = Math.max(7, Math.min(15, Math.round(Number(payload?.daysToShip || payload?.days_to_ship || 10))));

  // 2) add_item / update_item — map medicine_id khi có (bắt buộc ngành Y tế/Dược)
  const itemBody: Record<string, unknown> = {
    item_name: itemName,
    description,
    category_id: categoryId, // integer leaf — đã validate qua get_category
    brand: { brand_id: brandId },
    image: { image_id_list: imageIds },
    original_price: basePrice,
    seller_stock: [{ stock: hasVariants ? 0 : baseStock }],
    // Khi per-variation weight ON: weight/dimension ở root dùng giá trị trung bình (Shopee vẫn yêu cầu)
    // Cân nặng thực tế từng model sẽ được gắn trong model_list
    weight: weightKg,
    dimension: {
      package_length: Math.max(1, Math.round(Number(payload?.packageLength || 10))),
      package_width: Math.max(1, Math.round(Number(payload?.packageWidth || 10))),
      package_height: Math.max(1, Math.round(Number(payload?.packageHeight || 10))),
    },
    logistic_info: logisticInfo,
    item_status: "NORMAL",
    condition: "NEW",
    is_pre_order: isPreOrder,
  };
  if (isPreOrder) {
    itemBody.days_to_ship = daysToShip;
  }
  if (attributeList.length) itemBody.attribute_list = attributeList;
  if (medicineId) {
    // Shopee docs: medicine_id int64 — gửi Number nếu safe, còn không giữ String digits.
    const midNum = Number(medicineId);
    itemBody.medicine_id = Number.isSafeInteger(midNum) && midNum > 0 ? midNum : medicineId;
  }

  let itemId: string | null = existingItemId;
  if (existingItemId) {
    const updateBody = { ...itemBody, item_id: toShopeeIdNumber(existingItemId) ?? Number(existingItemId) };
    // update_item không nhận original_price / seller_stock giống add_item — giữ field Shopee chấp nhận
    delete updateBody.original_price;
    delete updateBody.seller_stock;
    await shopeeProductPost(
      "/api/v2/product/update_item",
      shopId,
      accessToken,
      updateBody,
      "update_item",
    );
  } else {
    const addResp = await shopeeProductPost(
      "/api/v2/product/add_item",
      shopId,
      accessToken,
      itemBody,
      "add_item",
    );
    itemId = toShopeeId(addResp?.item_id);
    if (!itemId) {
      console.log("[SHOPEE UPLOAD ERROR]:", JSON.stringify({ step: "add_item", response: addResp }, null, 2));
      throw new Error("add_item không trả về item_id hợp lệ (Shopee không tạo sản phẩm)");
    }
  }
  await sleep(SHOPEE_PRODUCT_API_DELAY_MS);

  // 3) Biến thể: init_tier_variation → add_model (chỉ khi add mới)
  // Shopee Go struct: item_id = uint64 → BẮT BUỘC Number, không gửi string.
  // 3) Biến thể: init_tier_variation → add_model (chỉ khi add mới)
  if (hasVariants && !existingItemId) {
    const itemIdNum = toShopeeIdNumber(itemId) ?? Number(itemId);
    if (!Number.isFinite(itemIdNum) || itemIdNum <= 0) {
      throw new Error(`item_id không hợp lệ cho init_tier_variation: ${itemId}`);
    }

    // Build tier_variation (tối đa 2 tier)
    const tierVariations = tierAttrs.filter((a) => a.values.length > 0).slice(0, 2).map((a) => ({
      name: (a.name || 'Phân loại').trim().slice(0, 14) || 'Phân loại',
      option_list: a.values.map((v) => String(v).trim()).filter(Boolean),
    }));

    const tierName = tierVariations[0]?.name || 'Phân loại';

    // Build models với tier_indices
    const modelListWithWeight = variants.map((v: any, idx: number) => {
      const price = Math.max(
        0,
        Math.round(Number(v.priceShopee ?? v.pricePromo ?? v.original_price ?? 0)),
      );
      const base: any = {
        tier_index: v.tierIndices || [idx],
        original_price: price,
        seller_stock: [{ stock: Math.max(0, Math.round(Number(v.stock || 0))) }],
        model_sku: String(v.sku || "").slice(0, 100),
      };
      if (perVariationWeight) {
        const vWeight = Number(v.weight || 0);
        base.weight = vWeight > 30 ? vWeight / 1000 : (vWeight > 0 ? vWeight : weightKg);
      }
      return base;
    });

    for (const m of modelListWithWeight) {
      if (m.original_price <= 0) throw new Error("Mỗi phân loại cần giá Shopee > 0");
    }

    const tierErrors: string[] = [];
    try {
      await shopeeProductPost(
        "/api/v2/product/init_tier_variation",
        shopId,
        accessToken,
        {
          item_id: itemIdNum,
          tier_variation: tierVariations,
          model: modelListWithWeight,
        },
        "init_tier_variation",
      );
    } catch (initErr: any) {
      const initMsg = initErr?.message || String(initErr);
      tierErrors.push(initMsg);
      console.log("[SHOPEE UPLOAD ERROR]:", JSON.stringify({ step: "init_tier_variation+model", error: initMsg, item_id: itemIdNum }, null, 2));
      try {
        await shopeeProductPost(
          "/api/v2/product/init_tier_variation",
          shopId,
          accessToken,
          {
            item_id: itemIdNum,
            tier_variation: tierVariations,
          },
          "init_tier_variation",
        );
        await sleep(SHOPEE_PRODUCT_API_DELAY_MS);
        await shopeeProductPost(
          "/api/v2/product/add_model",
          shopId,
          accessToken,
          { item_id: itemIdNum, model_list: modelListWithWeight },
          "add_model",
        );
      } catch (fallbackErr: any) {
        const fbMsg = fallbackErr?.message || String(fallbackErr);
        console.log("[SHOPEE UPLOAD ERROR]:", JSON.stringify({ step: "add_model_fallback", error: fbMsg, prior: tierErrors, item_id: itemIdNum }, null, 2));
        throw new Error(
          `Đã tạo item_id=${itemId} nhưng khởi tạo biến thể thất bại: ${fbMsg}`,
        );
      }
    }
  }

  if (!itemId) throw new Error("Không có item_id Shopee sau add/update");

  // ─── POST-PROCESSING: Lấy real model_ids từ Shopee ───────────────────────
  let modelIds: string[] = [];
  if (hasVariants && !existingItemId) {
    try {
      await sleep(SHOPEE_PRODUCT_API_DELAY_MS);
      const modelListResp = await shopeeGetModelListWithRetry(shopId, accessToken, itemId, 2);
      if (modelListResp && !modelListResp.error) {
        const rawModels = modelListResp.response?.model || modelListResp.response?.model_list || [];
        modelIds = rawModels
          .map((m: any) => m?.model_id != null ? String(m.model_id) : null)
          .filter(Boolean) as string[];
      }
    } catch (modelErr) {
      console.warn(`[Shopee Publish] get_model_list thất bại item_id=${itemId}:`, modelErr);
      // Fallback: dùng SKU mapping từ payload gốc
      modelIds = variants
        .filter((v: any) => v?.sku)
        .map((v: any) => v.sku);
    }
  }

  return { itemId, modelIds };
}

type ChannelSyncLine = {
  productId: string;
  sku: string;
  channel: string;
  action: string;
  success: boolean;
  message: string;
};

function parseShopeeApiResult(
  result: any,
  product: any,
  action: string
): ChannelSyncLine {
  const businessError = String(result?.error ?? "").trim();
  const businessMessage = String(result?.message ?? result?.msg ?? "").trim();
  const failures: any[] = Array.isArray(result?.response?.failure_list)
    ? result.response.failure_list
    : [];
  const successes: any[] = Array.isArray(result?.response?.success_list)
    ? result.response.success_list
    : [];

  const failLine = (message: string): ChannelSyncLine => ({
    productId: product.id,
    sku: product.sku,
    channel: "shopee",
    action,
    success: false,
    message: humanizeShopeeErrorMessage(message),
  });

  // Bắt buộc đọc error/message trong JSON dù HTTP status = 200.
  if (businessError) {
    const detail =
      businessMessage && !/^HTTP\s+\d+$/i.test(businessMessage)
        ? `${businessError} — ${businessMessage}`
        : businessError;
    return failLine(detail);
  }
  if (failures.length > 0) {
    const f = failures[0];
    return failLine(String(f.failed_reason || f.error || f.message || JSON.stringify(f)));
  }
  // update_price/update_stock: nếu không có success_list và cũng không có failure_list rõ ràng
  // nhưng message báo lỗi → vẫn fail.
  if (businessMessage && /fail|error|invalid|reject/i.test(businessMessage)) {
    return failLine(businessMessage);
  }
  if (action === "update_price" && successes.length === 0 && failures.length === 0) {
    return failLine(
      businessMessage || "Shopee không xác nhận cập nhật giá (success_list rỗng).",
    );
  }
  return {
    productId: product.id,
    sku: product.sku,
    channel: "shopee",
    action,
    success: true,
    message: `Cập nhật ${action} Shopee thành công`,
  };
}

async function syncProductToShopee(
  product: any,
  shopId: string,
  accessToken: string
): Promise<ChannelSyncLine[]> {
  const itemId = getShopeeItemIdForStockPush(product);
  let modelId = resolveShopeeModelIdForStockPush(product);
  if (itemId == null) {
    const base = {
      productId: product.id,
      sku: product.sku,
      channel: "shopee",
      success: false,
      message: "Thiếu shopeeItemId — SKU chưa liên kết Shopee",
    };
    return [
      { ...base, action: "update_stock" },
      { ...base, action: "update_price" },
    ];
  }

  let needsModel = productRequiresShopeeModelId(product, 1);
  if (modelId == null) {
    const fromApi = await resolveShopeeModelIdFromApi(shopId, accessToken, itemId, product);
    if (fromApi.hasModel) needsModel = true;
    if (fromApi.modelId != null) {
      modelId = fromApi.modelId;
      product.shopeeModelId = String(fromApi.modelId);
    }
  }

  if (needsModel && modelId == null) {
    const msg = "Phân loại (variant) thiếu model_id — bắt buộc truyền item_id + model_id khi update_stock";
    await appendShopeeSyncErrorToDb({
      itemId,
      modelId: undefined,
      sku: product.sku,
      shopId,
      action: "update_stock",
      error: msg,
      productId: product.id,
    });
    const base = {
      productId: product.id,
      sku: product.sku,
      channel: "shopee" as const,
      success: false,
      message: msg,
    };
    return [
      { ...base, action: "update_stock" },
      { ...base, action: "update_price" },
    ];
  }

  const preCheck = await verifyShopeeItemExists(shopId, accessToken, itemId);
  if (!preCheck.exists) {
    await markShopeeItemsInvalidInDb([itemId], preCheck.detail || "product.error_item_not_found");
    const msg = `Shopee item không tồn tại (${preCheck.detail || "product.error_item_not_found"}) — đã đánh dấu invalid`;
    await appendShopeeSyncErrorToDb({
      itemId,
      modelId: modelId ?? product.shopeeModelId,
      sku: product.sku,
      shopId,
      action: "update_stock",
      error: msg,
      productId: product.id,
    });
    const base = {
      productId: product.id,
      sku: product.sku,
      channel: "shopee" as const,
      success: false,
      message: msg,
    };
    return [
      { ...base, action: "update_stock" },
      { ...base, action: "update_price" },
    ];
  }

  const locationId = await resolveShopeeStockLocationId(shopId, accessToken);
  const stockEntry = buildShopeeUpdateStockEntry(product.stock, modelId, locationId);
  const priceEntry = buildShopeeUpdatePriceEntry(product.sellingPrice, modelId);

  let stockResult: any;
  try {
    stockResult = await shopeeUpdateStock(shopId, accessToken, itemId, [stockEntry]);
  } catch (err: unknown) {
    const netMsg = extractShopeeStockPushErrorMessage(err, err instanceof Error ? err.message : String(err));
    await appendShopeeSyncErrorToDb({
      itemId,
      modelId: modelId ?? product.shopeeModelId,
      sku: product.sku,
      shopId,
      action: "update_stock",
      error: netMsg,
      productId: product.id,
    });
    const base = {
      productId: product.id,
      sku: product.sku,
      channel: "shopee" as const,
      success: false,
      message: `update_stock: ${netMsg} — đã bỏ qua`,
    };
    return [
      { ...base, action: "update_stock" },
      { ...base, action: "update_price" },
    ];
  }

  if (isShopeeItemNotFoundError(stockResult)) {
    const detail = `${stockResult?.error || "product.error_item_not_found"}${stockResult?.message ? ` — ${stockResult.message}` : ""}`;
    await markShopeeItemsInvalidInDb([itemId], detail);
    await appendShopeeSyncErrorToDb({
      itemId,
      modelId: product.shopeeModelId,
      sku: product.sku,
      shopId,
      action: "update_stock",
      error: detail,
      productId: product.id,
    });
    const msg = `update_stock: ${detail} — đã đánh dấu invalid, bỏ qua`;
    const base = { productId: product.id, sku: product.sku, channel: "shopee" as const, success: false, message: msg };
    return [
      { ...base, action: "update_stock" },
      { ...base, action: "update_price" },
    ];
  }
  await sleep(SHOPEE_PRODUCT_API_DELAY_MS);
  const priceResult = await shopeeUpdatePrice(shopId, accessToken, itemId, [priceEntry]);
  if (isShopeeItemNotFoundError(priceResult)) {
    await markShopeeItemsInvalidInDb([itemId], priceResult?.error || "product.error_item_not_found");
  }

  return [
    parseShopeeApiResult(stockResult, product, "update_stock"),
    parseShopeeApiResult(priceResult, product, "update_price"),
  ];
}

async function syncProductToWoo(product: any, shop: any): Promise<ChannelSyncLine[]> {
  const base = {
    productId: product.id,
    sku: product.sku,
    channel: "woocommerce",
    action: "update_product",
  };

  const { wooUrl, consumerKey, consumerSecret } = resolveWooCredentials(shop || {});
  if (!wooUrl || !consumerKey || !consumerSecret) {
    return [{ ...base, success: false, message: "Chưa cấu hình WooCommerce (URL/Consumer Key/Secret)" }];
  }
  if (!product.wooId) {
    return [{ ...base, success: false, message: "Thiếu wooId — SKU chưa liên kết WooCommerce" }];
  }

  try {
    const result = await updateWooProductStockPrice(shop, product.wooId, {
      regular_price: Math.round(Number(product.sellingPrice) || 0),
      stock_quantity: Math.max(0, Math.round(Number(product.stock) || 0)),
    });
    if (!result.success) {
      return [{ ...base, success: false, message: result.message || "WooCommerce từ chối cập nhật" }];
    }
    return [{ ...base, success: true, message: `Cập nhật giá & tồn kho WooCommerce thành công (ID: ${product.wooId})` }];
  } catch (e: any) {
    return [{ ...base, success: false, message: `Lỗi kết nối WooCommerce: ${e?.message || "network error"}` }];
  }
}

async function syncProductToTikTok(product: any): Promise<ChannelSyncLine[]> {
  const base = {
    productId: product.id,
    sku: product.sku,
    channel: "tiktok",
    action: "update_product",
  };
  if (!product.tiktokId) {
    return [{ ...base, success: false, message: "Thiếu tiktokId — SKU chưa liên kết TikTok Shop" }];
  }
  return [{ ...base, success: false, message: "API TikTok Shop chưa được tích hợp trên server" }];
}

async function resolveShopeeShopForItemId(
  itemId: string | number,
  preferredShopId?: string
): Promise<{ shopId: string; accessToken: string } | null> {
  const shopIds = listShopeeSyncShopIds();
  if (!shopIds.length) return null;

  const preferred = String(preferredShopId || "").trim();
  const tryOrder = preferred && shopIds.includes(preferred)
    ? [preferred, ...shopIds.filter((id) => id !== preferred)]
    : shopIds;

  for (const sid of tryOrder) {
    const accessToken = await getValidShopeeAccessToken(sid);
    if (!accessToken) continue;
    const result = await shopeeGetItemBaseInfo(sid, accessToken, [itemId]);
    const found = Array.isArray(result?.response?.item_list) && result.response.item_list.length > 0;
    if (!result?.error && found) {
      return { shopId: sid, accessToken };
    }
  }
  return null;
}

function isStaleShopeeItemErrorText(text: string): boolean {
  const t = String(text || "").toLowerCase();
  return (
    t.includes("item_not_found") ||
    t.includes("error_item_not_found") ||
    t.includes("item_id is not found") ||
    t.includes("item is not found") ||
    t.includes("is not found")
  );
}

function isShopeeItemNotFoundError(result: any): boolean {
  const parts = [
    result?.error,
    result?.message,
    result?.response?.error,
    ...(Array.isArray(result?.response?.failure_list) ? result.response.failure_list : []).map(
      (f: any) => f?.failed_reason || f?.error
    ),
  ];
  return parts.some((p) => isStaleShopeeItemErrorText(String(p || "")));
}

async function verifyShopeeItemExists(
  shopId: string,
  accessToken: string,
  itemId: string | number
): Promise<{ exists: boolean; detail?: string }> {
  const result = await shopeeGetItemBaseInfo(shopId, accessToken, [itemId]);
  if (result?.error || isShopeeItemNotFoundError(result)) {
    const detail = `${result?.error || "product.error_item_not_found"}${result?.message ? ` — ${result.message}` : ""}`.trim();
    return { exists: false, detail };
  }
  const found = Array.isArray(result?.response?.item_list) && result.response.item_list.length > 0;
  if (!found) return { exists: false, detail: "product.error_item_not_found" };
  return { exists: true };
}

async function refreshShopeeLiveItemIdSet(shopId: string, accessToken: string): Promise<Set<string>> {
  const ids = await fetchAllShopeeItemIds(shopId, accessToken);
  console.log(`[Shopee Push Stock] Refresh get_item_list: ${ids.length} item_id đang liệt kê trên shop`);
  return new Set(ids);
}

async function markShopeeItemsInvalidInDb(itemIds: Array<string | number>, reason: string): Promise<string[]> {
  const idSet = new Set(
    itemIds.map((v) => toShopeeId(v)).filter((id): id is string => !!id),
  );
  if (idSet.size === 0) return [];

  const products = await loadProducts();
  const affectedSkus: string[] = [];

  const nextProducts = products.map((p: any) => {
    const itemId = getShopeeItemIdForStockPush(p);
    if (itemId == null || !idSet.has(itemId)) return p;

    const children = getProductChildrenList(p);
    for (const c of children.length ? children : [p]) {
      const sku = String(c.sku || "").trim();
      if (sku) affectedSkus.push(sku);
    }
    console.warn(`[Shopee Stock] item_id=${itemId}: ${reason} — đánh dấu invalid, bỏ qua đẩy tồn`);
    const channels = Array.isArray(p.channels) ? p.channels.filter((c: string) => c !== "shopee") : p.channels;
    return {
      ...p,
      shopeeItemId: undefined,
      shopeeModelId: undefined,
      shopeeId: undefined,
      shopeeLinkStatus: "invalid",
      children: children.map((c: any) => ({
        ...c,
        shopeeItemId: undefined,
        shopeeModelId: undefined,
        shopeeId: undefined,
        shopeeLinkStatus: "invalid",
        channels: Array.isArray(c.channels) ? c.channels.filter((ch: string) => ch !== "shopee") : c.channels,
      })),
      channels,
      lastSynced: new Date().toISOString(),
    };
  });

  if (affectedSkus.length > 0) await saveProducts(nextProducts);

  try {
    const listings = await readChannelListingsDb();
    let listingChanged = false;
    const nextListings = listings.map((row: any) => {
      const parsed = parseShopeeChannelLinkIds(row.channelId, row.modelId, row.itemId);
      const cid = parsed.itemId || toShopeeId(row.channelId);
      if (row.platform !== "shopee" || !cid || !idSet.has(cid)) return row;
      listingChanged = true;
      return {
        ...sanitizeChannelListingRow(row),
        status: "invalid",
        linkedProductId: undefined,
        updatedAt: new Date().toISOString(),
      };
    });
    if (listingChanged) await writeChannelListingsDb(nextListings);
  } catch (err) {
    console.error("[Shopee Stock] Không cập nhật channel_listings:", err);
  }

  return [...new Set(affectedSkus)];
}

/** Parse channelId dạng itemId hoặc itemId:modelId (+ hint từ listing). uint64 → string. */
function parseShopeeChannelLinkIds(
  channelId?: string | number | null,
  modelIdHint?: string | number | null,
  itemIdHint?: string | number | null
): { itemId: string | null; modelId: string | null } {
  const cid = String(channelId ?? "").trim();
  if (cid.includes(":")) {
    const [left, right] = cid.split(":");
    return {
      itemId: toShopeeId(left) || toShopeeId(itemIdHint),
      modelId: toShopeeId(right) || toShopeeId(modelIdHint),
    };
  }

  return {
    itemId: toShopeeId(cid.match(/(\d{6,})/)?.[1] ?? cid) || toShopeeId(itemIdHint),
    modelId: toShopeeId(modelIdHint),
  };
}

function resolveShopeeModelIdForStockPush(product: any): string | null {
  for (const c of [product?.shopeeModelId, product?.modelId, product?.model_id]) {
    const id = toShopeeId(c);
    if (id) return id;
  }
  const fromChannel = parseShopeeChannelLinkIds(product?.shopeeId ?? product?.shopeeItemId);
  if (fromChannel.modelId) return fromChannel.modelId;
  const fromId = String(product?.id || "").match(/-model-(\d+)/);
  if (fromId) return toShopeeId(fromId[1]);
  return null;
}

function getShopeeItemIdForStockPush(product: any): string | null {
  const parsed = parseShopeeChannelLinkIds(
    product?.shopeeItemId ?? product?.shopeeId,
    product?.shopeeModelId,
    product?.itemId
  );
  if (parsed.itemId) return parsed.itemId;
  const fromId = String(product?.id || "").match(/shopee-item-(\d+)/);
  if (fromId) return toShopeeId(fromId[1]);
  return null;
}

/** Variant buộc phải có model_id khi gọi update_stock. */
function productRequiresShopeeModelId(product: any, siblingCountForItem: number): boolean {
  if (siblingCountForItem > 1) return true;
  if (resolveShopeeModelIdForStockPush(product) != null) return true;
  if (String(product?.id || "").includes("-model-")) return true;
  if (String(product?.shopeeId || product?.shopeeItemId || "").includes(":")) return true;
  return false;
}

/** Gán item_id + model_id chuẩn lên sản phẩm kho gốc khi liên kết Shopee. */
function applyShopeeLinkFieldsToProduct(
  product: any,
  channelId: string,
  opts?: { modelId?: string | number | null; itemId?: string | number | null }
): any {
  const parsed = parseShopeeChannelLinkIds(channelId, opts?.modelId ?? product?.shopeeModelId, opts?.itemId);
  const channels: string[] = Array.isArray(product?.channels) ? [...product.channels] : [];
  if (!channels.includes("shopee")) channels.push("shopee");
  const next = { ...product, channels };
  if (parsed.itemId) {
    next.shopeeItemId = String(parsed.itemId);
    next.shopeeId =
      parsed.modelId != null ? `${parsed.itemId}:${parsed.modelId}` : String(channelId || parsed.itemId);
  } else if (channelId) {
    next.shopeeId = String(channelId);
    next.shopeeItemId = String(channelId);
  }
  if (parsed.modelId) next.shopeeModelId = String(parsed.modelId);
  return next;
}

function extractSkusFromShopeeRows(rows: any[]): string[] {
  return rows.map((r) => String(r.sku || "").trim()).filter(Boolean);
}

/** Trích thông báo lỗi Shopee chi tiết từ response / exception. */
function extractShopeeStockPushErrorMessage(resultOrErr: unknown, fallback = "Lỗi Shopee update_stock"): string {
  let out = fallback;
  if (resultOrErr == null) {
    out = fallback;
  } else if (typeof resultOrErr === "string") {
    out = resultOrErr || fallback;
  } else {
    const anyVal = resultOrErr as any;
    if (anyVal instanceof Error) {
      const fromResp = anyVal as Error & { response?: { data?: any } };
      const data = fromResp.response?.data;
      out = (data ? formatShopeeApiError(data) : "") || fromResp.message || fallback;
    } else {
      const failures: any[] =
        anyVal?.response?.failure_list ||
        anyVal?.response?.stock_list?.filter?.((s: any) => s.failed_reason) ||
        [];
      if (Array.isArray(failures) && failures.length > 0) {
        const reasons = failures
          .map((f: any) => String(f.failed_reason || f.error || f.message || "").trim())
          .filter(Boolean);
        if (reasons.length) out = reasons.join("; ");
        else out = formatShopeeApiError(anyVal) || fallback;
      } else {
        out = formatShopeeApiError(anyVal) || fallback;
      }
    }
  }
  return humanizeShopeeErrorMessage(out);
}

async function pushStockUpdatesToShopee(
  updatedProducts: any[],
  requestedShopId?: string
): Promise<{ ok: boolean; errors: string[]; warnings: string[]; pushed: number; staleSkus: string[] }> {
  const flattened = flattenProductsForStockSync(updatedProducts);
  const shopeeRows: any[] = [];
  for (const raw of flattened) {
    const mapped = await resolveProductWithShopeeMapping(raw);
    if (mapped && getShopeeItemIdForStockPush(mapped) != null) {
      shopeeRows.push(mapped);
    }
  }
  if (shopeeRows.length === 0) {
    return { ok: true, errors: [], warnings: [], pushed: 0, staleSkus: [] };
  }

  const preferredShopId = resolveShopeeTokenShopId(requestedShopId);
  const shopIdsForSync = resolveShopeeShopIdsForSync(requestedShopId);
  if (!shopIdsForSync.length) {
    const msg = getShopeeUnauthorizedShopMessage();
    console.error(`[Shopee Stock Push] ${msg}`);
    return { ok: false, errors: [msg], warnings: [], pushed: 0, staleSkus: [] };
  }

  console.log(
    `[Shopee Stock Push] Multi-shop sync shops=[${shopIdsForSync.join(", ")}] preferred=${preferredShopId || "(none)"}`,
  );

  // Prefetch token per shop (auto-refresh nếu hết hạn)
  const tokenByShop = new Map<string, string>();
  for (const sid of shopIdsForSync) {
    try {
      console.log(`[Shopee Stock Push] Lấy access_token shop_id=${sid}...`);
      const tok = await getValidShopeeAccessToken(sid);
      if (tok) {
        tokenByShop.set(sid, tok);
        console.log(`[Shopee Stock Push] access_token OK shop_id=${sid}`);
      } else {
        console.error(
          `[Shopee Stock Push] Không lấy được access_token shop_id=${sid} — cần Ủy quyền lại Shop.`,
        );
      }
    } catch (err: any) {
      console.error(
        `[Shopee Stock Push] Lỗi refresh/lấy token shop_id=${sid}:`,
        err?.message || err,
      );
    }
  }

  const errors: string[] = [];
  const warnings: string[] = [];
  const staleSkus: string[] = [];
  let liveItemIds: Set<string> | null = null;
  const primaryShop =
    preferredShopId && tokenByShop.has(preferredShopId)
      ? preferredShopId
      : shopIdsForSync.find((s) => tokenByShop.has(s)) || "";
  const accessToken = primaryShop ? tokenByShop.get(primaryShop) || null : null;
  if (primaryShop && accessToken) {
    try {
      liveItemIds = await refreshShopeeLiveItemIdSet(primaryShop, accessToken);
    } catch (err: any) {
      warnings.push(`Không refresh được danh sách item Shopee: ${err?.message || err}. Sẽ kiểm tra từng item.`);
    }
  }

  const byItem = new Map<string, any[]>();
  for (const p of shopeeRows) {
    const itemId = getShopeeItemIdForStockPush(p)!;
    if (!byItem.has(itemId)) byItem.set(itemId, []);
    byItem.get(itemId)!.push(p);
  }

  const invalidItemIds = new Set<string>();
  let pushed = 0;

  const markStaleItem = (itemId: string, rows: any[], detail: string) => {
    const skus = extractSkusFromShopeeRows(rows);
    warnings.push(`item_id=${itemId} (SKU: ${skus.join(", ")}): ${detail}`);
    staleSkus.push(...skus);
    invalidItemIds.add(itemId);
  };

  const itemEntries = [...byItem.entries()];
  let processedInBatch = 0;

  for (const [itemId, rows] of itemEntries) {
    let resolved =
      primaryShop && accessToken ? { shopId: primaryShop, accessToken } : null;
    if (!resolved) {
      // Đa shop: thử lần lượt từng shop đã có token
      for (const sid of shopIdsForSync) {
        const tok = tokenByShop.get(sid);
        if (!tok) continue;
        const found = await resolveShopeeShopForItemId(itemId, sid);
        if (found) {
          resolved = found;
          break;
        }
      }
      if (!resolved) {
        resolved = await resolveShopeeShopForItemId(itemId, primaryShop || undefined);
      }
    }
    if (!resolved) {
      markStaleItem(
        itemId,
        rows,
        "Không tìm thấy trên Shopee — đã bỏ qua đẩy tồn. Hãy đồng bộ lại sản phẩm hoặc cập nhật liên kết."
      );
      continue;
    }

    if (liveItemIds && !liveItemIds.has(itemId)) {
      const verified = await verifyShopeeItemExists(resolved.shopId, resolved.accessToken, itemId);
      if (!verified.exists) {
        markStaleItem(
          itemId,
          rows,
          `Không còn trong danh sách Shopee (${verified.detail || "product.error_item_not_found"}) — đã bỏ qua đẩy tồn.`
        );
        continue;
      }
    }

    const preCheck = await verifyShopeeItemExists(resolved.shopId, resolved.accessToken, itemId);
    if (!preCheck.exists) {
      markStaleItem(
        itemId,
        rows,
        `get_item_base_info thất bại (${preCheck.detail || "product.error_item_not_found"}) — đã bỏ qua đẩy tồn.`
      );
      for (const p of rows) {
        await appendShopeeSyncErrorToDb({
          itemId,
          modelId: p.shopeeModelId,
          sku: p.sku,
          shopId: resolved.shopId,
          action: "update_stock",
          error: preCheck.detail || "product.error_item_not_found",
          productId: p.id,
        });
      }
      continue;
    }

    await sleep(SHOPEE_PRODUCT_API_DELAY_MS);

    const locationId = await resolveShopeeStockLocationId(resolved.shopId, resolved.accessToken);
    const stockList: ReturnType<typeof buildShopeeUpdateStockEntry>[] = [];
    for (const p of rows) {
      let modelId = resolveShopeeModelIdForStockPush(p);
      // Tồn lấy từ Kho sản phẩm chính (Master Inventory) — field stock trên hàng đã flatten.
      const masterStock = Math.max(0, Math.round(Number(p.stock) || 0));
      let needsModel = productRequiresShopeeModelId(p, rows.length);
      if (modelId == null && (needsModel || rows.length === 1)) {
        const fromApi = await resolveShopeeModelIdFromApi(
          resolved.shopId,
          resolved.accessToken,
          itemId,
          p
        );
        if (fromApi.hasModel) needsModel = true;
        if (fromApi.modelId != null) {
          modelId = fromApi.modelId;
          p.shopeeModelId = String(fromApi.modelId);
        }
      }
      if (needsModel && modelId == null) {
        const line = `SKU ${p.sku || p.id}: phân loại (variant) thiếu model_id — bắt buộc truyền item_id + model_id khi update_stock.`;
        errors.push(line);
        await appendShopeeSyncErrorToDb({
          itemId,
          modelId: undefined,
          sku: p.sku,
          shopId: resolved.shopId,
          action: "update_stock",
          error: line,
          productId: p.id,
        });
        continue;
      }
      stockList.push(buildShopeeUpdateStockEntry(masterStock, modelId, locationId));
    }

    if (stockList.length === 0) {
      processedInBatch++;
      await sleep(SHOPEE_PRODUCT_API_DELAY_MS);
      continue;
    }

    let result: any;
    try {
      result = await shopeeUpdateStock(resolved.shopId, resolved.accessToken, itemId, stockList);
    } catch (err: unknown) {
      const netMsg = extractShopeeStockPushErrorMessage(err, err instanceof Error ? err.message : String(err));
      const skus = extractSkusFromShopeeRows(rows).join(", ");
      errors.push(`item_id=${itemId} (SKU: ${skus}): update_stock lỗi — ${netMsg}`);
      for (const p of rows) {
        await appendShopeeSyncErrorToDb({
          itemId,
          modelId: resolveShopeeModelIdForStockPush(p) ?? p.shopeeModelId,
          sku: p.sku,
          shopId: resolved.shopId,
          action: "update_stock",
          error: netMsg,
          productId: p.id,
        });
      }
      processedInBatch++;
      await sleep(SHOPEE_PRODUCT_API_DELAY_MS);
      if (processedInBatch % SHOPEE_PRODUCT_BATCH_SIZE === 0 && processedInBatch < itemEntries.length) {
        console.log(`[Shopee Push Stock] Nghỉ ${SHOPEE_PRODUCT_BATCH_PAUSE_MS}ms sau ${processedInBatch}/${itemEntries.length} item...`);
        await sleep(SHOPEE_PRODUCT_BATCH_PAUSE_MS);
      }
      continue;
    }

    const failures: any[] =
      result?.response?.failure_list ||
      result?.response?.stock_list?.filter?.((s: any) => s.failed_reason) ||
      [];

    if (result?.error || isShopeeItemNotFoundError(result)) {
      const skus = extractSkusFromShopeeRows(rows).join(", ");
      const detail = extractShopeeStockPushErrorMessage(result);
      if (isShopeeItemNotFoundError(result) || result?.error === "product.error_item_not_found") {
        markStaleItem(itemId, rows, `update_stock: ${detail} — sản phẩm đã mất trên Shopee, đã bỏ qua.`);
      } else {
        errors.push(`item_id=${itemId} (SKU: ${skus}): ${detail}`);
      }
      for (const p of rows) {
        await appendShopeeSyncErrorToDb({
          itemId,
          modelId: resolveShopeeModelIdForStockPush(p) ?? p.shopeeModelId,
          sku: p.sku,
          shopId: resolved.shopId,
          action: "update_stock",
          error: detail,
          productId: p.id,
        });
      }
    }

    if (Array.isArray(failures) && failures.length > 0) {
      for (const f of failures) {
        const reason = String(f.failed_reason || f.error || "");
        if (!reason) continue;
        const line = `item_id=${itemId} model_id=${f.model_id ?? "?"}: ${reason}`;
        if (isStaleShopeeItemErrorText(reason)) {
          markStaleItem(itemId, rows, line);
        } else {
          errors.push(line);
        }
        await appendShopeeSyncErrorToDb({
          itemId,
          modelId: f.model_id,
          shopId: resolved.shopId,
          action: "update_stock",
          error: reason,
        });
      }
    }

    if (!result?.error && !isShopeeItemNotFoundError(result) && (!failures.length || failures.every((f: any) => !f.failed_reason && !f.error))) {
      pushed += rows.length;
    }

    processedInBatch++;
    await sleep(SHOPEE_PRODUCT_API_DELAY_MS);
    if (processedInBatch % SHOPEE_PRODUCT_BATCH_SIZE === 0 && processedInBatch < itemEntries.length) {
      console.log(`[Shopee Push Stock] Nghỉ ${SHOPEE_PRODUCT_BATCH_PAUSE_MS}ms sau ${processedInBatch}/${itemEntries.length} item...`);
      await sleep(SHOPEE_PRODUCT_BATCH_PAUSE_MS);
    }
  }

  if (invalidItemIds.size > 0) {
    const dbSkus = await markShopeeItemsInvalidInDb(
      [...invalidItemIds],
      "Sản phẩm không tồn tại trên Shopee (product.error_item_not_found)"
    );
    for (const sku of dbSkus) {
      if (!staleSkus.includes(sku)) staleSkus.push(sku);
    }
  }

  return { ok: errors.length === 0, errors, warnings, pushed, staleSkus: [...new Set(staleSkus)] };
}

// Shopee Sync Queue → services/stockSyncQueue.js (Phase 4)
// resolveProductWithShopeeMapping imported from stockSyncQueue (init trong startServer).

function getItemAvatarUrl(item: any): string | undefined {
  const list = item?.image?.image_url_list;
  return Array.isArray(list) && list.length > 0 ? String(list[0]) : undefined;
}

/** Ép mọi giá trị Shopee về mảng an toàn — tránh crash `.map` khi API trả object/null. */
function asShopeeArray<T = any>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

function parseModelListFromResponse(modelResult: any): { tierVariations: any[]; models: any[] } {
  const resp = modelResult?.response || {};
  const modelsRaw = resp?.model_list ?? resp?.model ?? [];
  const tiersRaw =
    resp?.tier_variation ?? resp?.standardise_tier_variation ?? resp?.tier_variations ?? [];
  return {
    tierVariations: asShopeeArray(tiersRaw),
    models: asShopeeArray(modelsRaw).filter((m) => m != null),
  };
}

function extractInlineModelsFromItem(item: any): { tierVariations: any[]; models: any[] } {
  const tierVariations = asShopeeArray(
    item?.tier_variation ?? item?.standardise_tier_variation ?? item?.tier_variations ?? []
  );
  let models: any[] = [];
  if (asShopeeArray(item?.model_list).length > 0) {
    models = asShopeeArray(item?.model_list);
  } else if (asShopeeArray(item?.model).length > 0) {
    models = asShopeeArray(item?.model);
  } else if (asShopeeArray(item?.models).length > 0) {
    models = asShopeeArray(item?.models);
  }
  return { tierVariations, models: models.filter((m) => m != null) };
}

function itemHasShopeeVariants(item: any): boolean {
  if (item?.has_model === true || item?.has_model === 1) return true;
  const { models } = extractInlineModelsFromItem(item);
  return models.length > 0;
}

function getModelDisplayName(model: any, tierVariations: any[]): string {
  if (model?.model_name) return String(model.model_name).trim();
  const tierIndex: number[] = Array.isArray(model?.tier_index) ? model.tier_index : [];
  const parts: string[] = [];
  const tiers = asShopeeArray(tierVariations);
  for (let tierPos = 0; tierPos < tierIndex.length; tierPos++) {
    const optIdx = tierIndex[tierPos];
    const tier = tiers?.[tierPos];
    let opt = tier?.option_list?.[optIdx]?.option;
    if (!opt && tier?.variation_option_list?.[optIdx]?.variation_option_name) {
      opt = tier?.variation_option_list?.[optIdx]?.variation_option_name;
    }
    if (!opt && Array.isArray(tier?.options)) opt = tier?.options?.[optIdx];
    if (opt) parts.push(String(opt).trim());
  }
  if (parts.length > 0) return parts.join(" / ");
  const sku = String(model?.model_sku || "").trim();
  if (sku) return sku;
  return model?.model_id != null ? `Phân loại #${model.model_id}` : "Phân loại";
}

function parseModelStock(model: any): number {
  const s2 = model?.stock_info_v2;
  if (s2?.seller_stock?.[0]?.stock != null) return Math.max(0, Number(s2.seller_stock[0].stock) || 0);
  if (s2?.summary_info?.total_available_stock != null) return Math.max(0, Number(s2.summary_info.total_available_stock) || 0);
  if (model?.stock != null) return Math.max(0, Number(model.stock) || 0);
  if (model?.normal_stock != null) return Math.max(0, Number(model.normal_stock) || 0);
  return Math.max(0, Number(model?.stock_info?.[0]?.current_stock) || 0);
}

function parseModelPrice(model: any): number {
  const pi = model?.price_info;
  if (Array.isArray(pi) && pi.length > 0) {
    return Math.max(0, Number(pi[0].current_price ?? pi[0].original_price) || 0);
  }
  if (pi && typeof pi === "object") {
    return Math.max(0, Number(pi.current_price ?? pi.original_price) || 0);
  }
  return Math.max(0, Number(model?.price) || 0);
}

/** Shopee weight thường là kg → FE form dùng gram. */
function parseShopeeWeightGrams(item: any): number {
  const raw = Number(item?.weight ?? item?.package_weight ?? item?.dimension?.weight ?? 0);
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  // > 30 coi như đã là gram; ngược lại là kg.
  return raw > 30 ? Math.round(raw) : Math.round(raw * 1000);
}

function buildSingleWarehouseRow(item: any): any {
  const itemId = item?.item_id;
  const avatarUrl = getItemAvatarUrl(item);
  const sku = String(item?.item_sku || "").trim() || String(itemId);
  const stock = parseModelStock(item);
  const priceInfo = asShopeeArray(item?.price_info);
  const price =
    Number(priceInfo[0]?.current_price ?? priceInfo[0]?.original_price) ||
    parseModelPrice(item) ||
    0;
  const weight = parseShopeeWeightGrams(item);

  return {
    id: `shopee-item-${itemId}`,
    title: item?.item_name || `Sản phẩm Shopee ${itemId}`,
    sku,
    barcode: sku,
    category: item?.category_id ? String(item.category_id) : "Chưa phân loại",
    stock,
    importPrice: 0,
    sellingPrice: price,
    weight,
    channels: ["shopee"],
    imageUrl: avatarUrl,
    avatarUrl,
    description: item?.description || "",
    status: item?.item_status !== "NORMAL" ? "draft" : (stock > 0 ? "active" : "out_of_stock"),
    shopeeId: String(itemId),
    shopeeItemId: String(itemId),
    children: [],
    lastSynced: new Date().toISOString(),
  };
}

/** Parent Product + children — mỗi model là 1 child (giữ model_id để đồng bộ tồn). */
function buildParentWarehouseRow(item: any, children: any[]): any {
  const itemId = item?.item_id;
  const avatarUrl = getItemAvatarUrl(item);
  const sku = String(item?.item_sku || "").trim() || String(itemId);
  const safeChildren = asShopeeArray(children).filter((c) => c != null);
  const totalStock = safeChildren.reduce((sum, c) => sum + (Number(c?.stock) || 0), 0);
  const prices = safeChildren.map((c) => Number(c?.sellingPrice) || 0).filter((n) => n > 0);
  const price = prices.length ? Math.min(...prices) : 0;
  const weight = parseShopeeWeightGrams(item);
  const baseName = item?.item_name || `Sản phẩm Shopee ${itemId}`;

  return {
    id: `shopee-item-${itemId}`,
    title: baseName,
    sku,
    barcode: sku,
    category: item?.category_id ? String(item.category_id) : "Chưa phân loại",
    stock: totalStock,
    importPrice: 0,
    sellingPrice: price,
    weight,
    channels: ["shopee"],
    imageUrl: avatarUrl,
    avatarUrl,
    description: item?.description || "",
    status: item?.item_status !== "NORMAL" ? "draft" : (totalStock > 0 ? "active" : "out_of_stock"),
    shopeeId: String(itemId),
    shopeeItemId: String(itemId),
    children: safeChildren,
    lastSynced: new Date().toISOString(),
  };
}

/** Flatten Parent→Child thành dòng SKU phẳng (dùng cho update_stock theo model_id). */
function flattenProductsForStockSync(products: any[]): any[] {
  const out: any[] = [];
  for (const p of products || []) {
    const children = getProductChildrenList(p);
    if (children.length > 0) {
      for (const child of children) {
        out.push(inheritShopeeLinkFromParent(child, p));
      }
      continue;
    }
    out.push(p);
  }
  return out;
}

function getModelImageUrl(item: any, model: any, tierVariations: any[]): string {
  const tierIndex: number[] = Array.isArray(model?.tier_index) ? model.tier_index : [];
  for (let tierPos = 0; tierPos < tierIndex.length; tierPos++) {
    const optIdx = tierIndex[tierPos];
    const tier = tierVariations?.[tierPos];
    const opt = tier?.option_list?.[optIdx] || tier?.variation_option_list?.[optIdx];
    const url = opt?.image?.image_url || opt?.image_url;
    if (url) return url;
  }
  return getItemAvatarUrl(item);
}

function buildVariantWarehouseRow(item: any, model: any, tierVariations: any[], modelIndex: number): any {
  const safeModel = model && typeof model === "object" ? model : {};
  const itemId = toShopeeId(item?.item_id) || String(item?.item_id ?? "");
  const modelId = toShopeeId(safeModel.model_id) || (safeModel.model_id != null ? String(safeModel.model_id) : `idx${modelIndex}`);
  const tiers = asShopeeArray(tierVariations);
  const modelName = getModelDisplayName(safeModel, tiers);
  const baseName = item?.item_name || `Sản phẩm Shopee ${itemId}`;
  const avatarUrl = getModelImageUrl(item, safeModel, tiers);
  const parentSku = String(item?.item_sku || "").trim() || undefined;
  const sku = String(safeModel.model_sku || "").trim() || `${itemId}-M${modelId}`;
  const stock = parseModelStock(safeModel);
  const price = parseModelPrice(safeModel);
  const weight = parseShopeeWeightGrams(item);
  const tierIndex = asShopeeArray<number>(safeModel.tier_index);

  return {
    id: `shopee-item-${itemId}-model-${modelId}`,
    title: `${baseName} - ${modelName}`,
    sku,
    barcode: sku,
    modelName,
    parentSku,
    category: item?.category_id ? String(item.category_id) : "Chưa phân loại",
    stock,
    importPrice: 0,
    sellingPrice: price,
    weight,
    channels: ["shopee"],
    imageUrl: avatarUrl,
    avatarUrl,
    description: item?.description || "",
    status: item?.item_status !== "NORMAL" ? "draft" : (stock > 0 ? "active" : "out_of_stock"),
    shopeeId: `${itemId}:${modelId}`,
    shopeeItemId: String(itemId),
    shopeeModelId: String(modelId),
    tierLabels: tierIndex
      .map((optIdx: number, tierPos: number) => tiers?.[tierPos]?.option_list?.[optIdx]?.option)
      .filter(Boolean),
    lastSynced: new Date().toISOString(),
  };
}

async function syncShopeeItemToWarehouseRows(
  shopId: string,
  accessToken: string,
  item: any,
  opts?: { strict?: boolean }
): Promise<{ rows: any[]; modelCount: number; error?: string }> {
  try {
    if (!item || item.item_id == null) {
      return { rows: [], modelCount: 0, error: "invalid_item" };
    }

    const itemId = item.item_id;
    let { tierVariations, models } = extractInlineModelsFromItem(item);
    const hasVariants = itemHasShopeeVariants(item);

    const toParentRows = (modelList: any[]) => {
      const safeModels = asShopeeArray(modelList).filter((m) => m != null);
      const children = safeModels.map((model, idx) =>
        buildVariantWarehouseRow(item, model, tierVariations, idx)
      );
      return {
        rows: [buildParentWarehouseRow(item, children)],
        modelCount: children.length,
      };
    };

    if (models.length > 0) {
      const result = toParentRows(models);
      console.log(`[Shopee Sync] item_id=${itemId} -> Parent + ${result.modelCount} children (model_list inline)`);
      return result;
    }

    if (!hasVariants) {
      return { rows: [buildSingleWarehouseRow(item)], modelCount: 0 };
    }

    const modelResult = await shopeeGetModelListWithRetry(shopId, accessToken, itemId, 3);
    if (modelResult?.error || isShopeeItemNotFoundError(modelResult)) {
      const err = `${modelResult?.error || "product.error_item_not_found"}${modelResult?.message ? `: ${modelResult.message}` : ""}`;
      console.error(`[Shopee Sync] get_model_list item_id=${itemId}: ${err}`);
      await appendShopeeSyncErrorToDb({
        itemId,
        shopId,
        action: "pullProducts",
        error: err,
      });
      if (opts?.strict || isShopeeItemNotFoundError(modelResult)) {
        return { rows: [], modelCount: 0, error: isShopeeItemNotFoundError(modelResult) ? "item_not_found" : err };
      }
      // Fallback an toàn: lưu 1 dòng parent thay vì crash
      return { rows: [buildSingleWarehouseRow(item)], modelCount: 0, error: err };
    }

    const parsed = parseModelListFromResponse(modelResult);
    tierVariations = parsed.tierVariations;
    models = parsed.models;

    if (models.length > 0) {
      const result = toParentRows(models);
      console.log(`[Shopee Sync] item_id=${itemId} -> Parent + ${result.modelCount} children (get_model_list)`);
      return result;
    }

    console.warn(`[Shopee Sync] item_id=${itemId} has_model=true nhưng model_list rỗng — lưu 1 dòng parent`);
    return { rows: [buildSingleWarehouseRow(item)], modelCount: 0 };
  } catch (err: unknown) {
    const reason = err instanceof Error ? err.message : String(err);
    console.error(`[Shopee Sync] syncShopeeItemToWarehouseRows item_id=${item?.item_id}: ${reason}`);
    try {
      await appendShopeeSyncErrorToDb({
        itemId: item?.item_id,
        shopId,
        action: "pullProducts",
        error: reason,
      });
    } catch {
      /* ignore */
    }
    // Không ném ra ngoài — trả lỗi có kiểm soát
    if (item?.item_id != null) {
      try {
        return { rows: [buildSingleWarehouseRow(item)], modelCount: 0, error: reason };
      } catch {
        return { rows: [], modelCount: 0, error: reason };
      }
    }
    return { rows: [], modelCount: 0, error: reason };
  }
}

async function fetchShopeeItemListPage(
  shopId: string,
  accessToken: string,
  offset: number,
  updateWindow?: ShopeeUpdateWindow,
): Promise<{ itemIds: string[]; hasMore: boolean; nextOffset: number; pageIndex: number }> {
  const listResult = await shopeeGetItemList(shopId, accessToken, offset, updateWindow);
  if (listResult?.error) {
    throw new Error(formatShopeeApiError(listResult) || `${listResult.error}: ${listResult.message || ""}`);
  }
  const items = asShopeeArray(listResult?.response?.item);
  const itemIds = items
    .map((it: any) => toShopeeId(it?.item_id))
    .filter((id: string | null): id is string => !!id);
  const hasMore = !!listResult?.response?.has_next_page && items.length > 0;
  const nextOffset = listResult?.response?.next_offset ?? offset + items.length;
  const pageIndex = Math.floor(offset / SHOPEE_ITEM_LIST_PAGE_SIZE);
  return { itemIds, hasMore, nextOffset, pageIndex };
}

async function processShopeeItemsToListingRows(
  shopId: string,
  accessToken: string,
  items: any[]
): Promise<{
  rows: any[];
  skippedItems: { itemId: string; reason: string }[];
  variantItemCount: number;
}> {
  const products: any[] = [];
  const skippedItems: { itemId: string; reason: string }[] = [];
  let variantItemCount = 0;
  const safeItems = asShopeeArray(items).filter((it) => it != null && it.item_id != null);

  // Strict sequential for...of — CẤM Promise.all / map(async).
  for (const item of safeItems) {
    try {
      const r = await syncShopeeItemToWarehouseRows(shopId, accessToken, item);
      if (r.error && (!r.rows || r.rows.length === 0)) {
        skippedItems.push({ itemId: String(item?.item_id), reason: r.error });
      } else {
        if (r.modelCount > 0) variantItemCount++;
        products.push(...asShopeeArray(r.rows));
      }
    } catch (err: unknown) {
      const reason = err instanceof Error ? err.message : String(err);
      console.error(`[Shopee Sync] pullProducts item_id=${item?.item_id}: ${reason}`);
      try {
        await appendShopeeSyncErrorToDb({
          itemId: item?.item_id,
          shopId,
          action: "pullProducts",
          error: reason,
        });
      } catch {
        /* ignore */
      }
      skippedItems.push({ itemId: String(item?.item_id ?? "?"), reason });
    }
    await yieldEventLoop(CHANNEL_FETCH_YIELD_MS);
  }

  return {
    rows: dedupeShopeeParentVariantRows(products),
    skippedItems,
    variantItemCount,
  };
}

/** Khóa UPSERT mapping: shopee::itemId[::modelId] — tránh duplicate key khi pull lại. */
function channelListingUpsertKey(itemId: string, modelId?: string | null): string {
  const mid = String(modelId || "").trim();
  return mid ? `shopee::${itemId}::${mid}` : `shopee::${itemId}`;
}

/** Bóc item_id + model_id từ row Shopee / listing (optional chaining an toàn). */
function resolveUpsertItemModelFromRow(item: any): { itemId: string; modelId: string; channelId: string } | null {
  if (!item || typeof item !== "object") return null;

  const parsed = parseShopeeChannelLinkIds(
    item?.shopeeId ?? item?.channelId,
    item?.shopeeModelId ?? item?.modelId,
    item?.shopeeItemId ?? item?.itemId
  );

  const itemId =
    (parsed.itemId != null ? String(parsed.itemId) : "") ||
    String(item?.shopeeItemId ?? item?.itemId ?? "").trim() ||
    String(item?.shopeeId ?? "").split(":")[0]?.trim() ||
    "";
  if (!itemId) return null;

  const modelId =
    (parsed.modelId != null ? String(parsed.modelId) : "") ||
    String(item?.shopeeModelId ?? item?.modelId ?? "").trim() ||
    (String(item?.shopeeId || "").includes(":")
      ? String(item.shopeeId).split(":")[1]?.trim() || ""
      : "") ||
    "";

  const channelId = modelId ? `${itemId}:${modelId}` : itemId;
  return { itemId, modelId, channelId };
}

/**
 * UPSERT incremental channel_listings theo khóa item_id + model_id.
 * Có rồi → cập nhật; chưa có → thêm. Không dùng insert/create thuần (tránh duplicate crash).
 * Caller phải await và yield giữa các lần gọi (xem upsertChannelListingsBatchSequential).
 */
async function upsertChannelListingsBatch(
  batchRows: any[],
  shopId: string,
  shopName: string
): Promise<number> {
  try {
    if (!Array.isArray(batchRows) || batchRows.length === 0) return 0;

    ensureDataDirs();

    const existing = await readChannelListingsDb();
    const byKey = new Map<string, any>();
    for (const listing of existing) {
      if (!listing || typeof listing !== "object") continue;
      const ids = resolveUpsertItemModelFromRow(listing);
      if (!ids) continue;
      byKey.set(channelListingUpsertKey(ids.itemId, ids.modelId), listing);
    }

    let flatRows: any[] = [];
    try {
      flatRows = flattenProductsForStockSync(batchRows);
    } catch (flatErr: unknown) {
      console.error("DB Save Error:", flatErr);
      flatRows = batchRows.filter((r) => r != null);
    }

    let saved = 0;
    let inserted = 0;
    let updated = 0;

    for (const item of flatRows) {
      try {
        const ids = resolveUpsertItemModelFromRow(item);
        if (!ids) continue;

        const key = channelListingUpsertKey(ids.itemId, ids.modelId);
        const prev = byKey.get(key);
        const keepExistingLink =
          prev?.status === "success" &&
          !!prev?.linkedProductId &&
          !isSyntheticShopeePullProduct({ id: prev.linkedProductId });

        if (prev) updated++;
        else inserted++;

        byKey.set(
          key,
          sanitizeChannelListingRow({
            id: prev?.id || `cl-shopee-${ids.channelId}`,
            title: String(item?.title || ""),
            sku: String(item?.sku || ""),
            imageUrl: item?.avatarUrl || item?.imageUrl || undefined,
            channelId: ids.channelId,
            platform: "shopee",
            shopName: String(shopName || ""),
            shopId: shopId != null ? String(shopId) : undefined,
            modelId: ids.modelId || prev?.modelId,
            itemId: ids.itemId,
            price: Math.max(0, Math.round(Number(item?.sellingPrice ?? item?.price) || 0)),
            weight: Math.max(0, Number(item?.weight) || 0),
            stock: Math.max(0, Math.round(Number(item?.stock) || 0)),
            status: keepExistingLink ? "success" : prev?.status === "failed" ? "failed" : "unlinked",
            linkedProductId: keepExistingLink ? prev.linkedProductId : undefined,
          })
        );
        saved++;
      } catch (rowErr: unknown) {
        console.error("DB Save Error: (skip row)", rowErr);
      }
    }

    await writeChannelListingsDbAsync(Array.from(byKey.values()));
    console.log(
      `Đã lưu DB thành công — channel_listings UPSERT insert=${inserted}, update=${updated}, touched=${saved}, totalKeys=${byKey.size}`
    );
    return saved;
  } catch (err: unknown) {
    console.error("DB Save Error:", err);
    throw err instanceof Error ? err : new Error(String(err));
  }
}

/** UPSERT tuần tự + yield CPU sau mỗi lần ghi (tránh cagefs_enter Unable to fork). */
async function upsertChannelListingsBatchSequential(
  batchRows: any[],
  shopId: string,
  shopName: string
): Promise<number> {
  const saved = await upsertChannelListingsBatch(batchRows, shopId, shopName);
  await yieldEventLoop(CHANNEL_FETCH_YIELD_MS);
  return saved;
}

/**
 * Pull 1 trang Shopee → xử lý STRICT SEQUENCE: micro-batch ≤10 id,
 * mỗi item sync + upsert DB xong 100% rồi mới sang item tiếp (có yield 50ms).
 * CẤM Promise.all / map(async).
 */
async function pullShopeeChannelListingsPage(
  shopId: string,
  accessToken: string,
  shopName: string,
  offset: number,
  updateWindow?: ShopeeUpdateWindow,
): Promise<{
  currentOffset: number;
  nextOffset: number;
  hasMore: boolean;
  pageIndex: number;
  rowsSaved: number;
  pageStats: {
    itemsInPage: number;
    rowsInPage: number;
    variantItemCount: number;
    skippedCount: number;
  };
  skippedItems: { itemId: string; reason: string }[];
}> {
  try {
    const page = await fetchShopeeItemListPage(shopId, accessToken, offset, updateWindow);
    if (page.itemIds.length === 0) {
      return {
        currentOffset: offset,
        nextOffset: page.nextOffset,
        hasMore: false,
        pageIndex: page.pageIndex,
        rowsSaved: 0,
        pageStats: { itemsInPage: 0, rowsInPage: 0, variantItemCount: 0, skippedCount: 0 },
        skippedItems: [],
      };
    }

    let rowsSaved = 0;
    let rowsInPage = 0;
    let variantItemCount = 0;
    const skippedItems: { itemId: string; reason: string }[] = [];
    const allIds = asShopeeArray(page.itemIds).filter((n) => Number.isFinite(Number(n)) && Number(n) > 0);

    // Micro-batch ≤10 id — tuần tự tuyệt đối, không gom cả trang vào RAM.
    for (let batchStart = 0; batchStart < allIds.length; batchStart += CHANNEL_FETCH_MICRO_BATCH) {
      const idBatch = allIds.slice(batchStart, batchStart + CHANNEL_FETCH_MICRO_BATCH);
      const baseItems = await fetchShopeeBaseItemsByIds(shopId, accessToken, idBatch);
      await yieldEventLoop(CHANNEL_FETCH_YIELD_MS);

      for (const item of asShopeeArray(baseItems)) {
        if (!item || item.item_id == null) continue;
        try {
          const r = await syncShopeeItemToWarehouseRows(shopId, accessToken, item);
          if (r.error && (!r.rows || r.rows.length === 0)) {
            skippedItems.push({ itemId: String(item.item_id), reason: r.error });
          } else {
            if (r.modelCount > 0) variantItemCount++;
            const rows = asShopeeArray(r.rows);
            rowsInPage += rows.length;
            // Await upsert dứt điểm TỪNG sản phẩm trước khi sang item tiếp theo.
            rowsSaved += await upsertChannelListingsBatchSequential(rows, shopId, shopName);
          }
        } catch (itemErr: unknown) {
          const reason = itemErr instanceof Error ? itemErr.message : String(itemErr);
          console.error(`[Shopee Channel Fetch] item_id=${item?.item_id}: ${reason}`);
          skippedItems.push({ itemId: String(item?.item_id ?? "?"), reason });
          try {
            await appendShopeeSyncErrorToDb({
              itemId: item?.item_id,
              shopId,
              action: "channelFetch",
              error: reason,
            });
          } catch {
            /* ignore */
          }
        }
        await yieldEventLoop(CHANNEL_FETCH_YIELD_MS);
      }

      await yieldEventLoop(CHANNEL_FETCH_YIELD_MS);
    }

    console.log(
      `[Shopee Channel Fetch] Trang offset=${offset}: ${allIds.length} item -> ${rowsInPage} dong, da luu ${rowsSaved} vao DB (sequential)`,
    );

    return {
      currentOffset: offset,
      nextOffset: page.nextOffset,
      hasMore: page.hasMore,
      pageIndex: page.pageIndex,
      rowsSaved,
      pageStats: {
        itemsInPage: allIds.length,
        rowsInPage,
        variantItemCount,
        skippedCount: skippedItems.length,
      },
      skippedItems,
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[Shopee Channel Fetch] Page offset=${offset} failed:`, message);
    throw err instanceof Error ? err : new Error(message);
  }
}

/**
 * UPSERT Kho gốc theo khóa shopeeItemId (item_id) / id.
 * Có rồi → cập nhật; chưa có → thêm mới. Map đúng title/sku/price/stock từ Shopee.
 */
async function mergeWarehouseProductsBatch(batchRows: any[]): Promise<{
  upserted: number;
  existingCount: number;
  upsertCount: number;
  batchRows: number;
  loadMs: number;
  upsertMs: number;
}> {
  try {
    if (!Array.isArray(batchRows) || batchRows.length === 0) {
      return { upserted: 0, existingCount: 0, upsertCount: 0, batchRows: 0, loadMs: 0, upsertMs: 0 };
    }

    ensureDataDirs();
    // Chỉ load SP liên quan trang hiện tại — cấm find({}) toàn catalog (OOM/HTML 500 cPanel).
    const wantedIds: string[] = [];
    const wantedItemIds: string[] = [];
    for (const row of batchRows) {
      if (!row || typeof row !== "object") continue;
      const itemId = String(row.shopeeItemId || row.item_id || "").trim();
      const id = String(row.id || "").trim();
      if (itemId) {
        wantedItemIds.push(itemId);
        wantedIds.push(`shopee-item-${itemId}`);
      }
      if (id) wantedIds.push(id);
    }
    const loadStarted = Date.now();
    const existing = await loadProductsByIdsFromStore(wantedIds, wantedItemIds);
    const loadMs = Date.now() - loadStarted;
    const byId = new Map<string, any>();
    const byShopeeItemId = new Map<string, string>();

    for (const p of existing) {
      if (!p || typeof p !== "object" || p.id == null) continue;
      const id = String(p.id);
      byId.set(id, p);
      const itemId = String(p.shopeeItemId || "").trim();
      if (itemId) byShopeeItemId.set(itemId, id);
    }

    let upserted = 0;
    const changedRows: any[] = [];
    for (const row of batchRows) {
      try {
        if (!row || typeof row !== "object") continue;

        const itemId = String(row.shopeeItemId || row.item_id || "").trim();
        const existingId = itemId ? byShopeeItemId.get(itemId) : undefined;
        const id =
          existingId ||
          String(row.id || (itemId ? `shopee-item-${itemId}` : `prod-${Date.now()}-${upserted}`));

        const prev = byId.get(id);
        const mapped = {
          ...row,
          id,
          title: String(row.title || row.item_name || prev?.title || `Shopee ${itemId || id}`),
          sku: String(row.sku || row.item_sku || prev?.sku || itemId || id),
          stock: Math.max(0, Number(row.stock ?? prev?.stock) || 0),
          sellingPrice: Math.max(0, Number(row.sellingPrice ?? row.price ?? prev?.sellingPrice) || 0),
          importPrice: Math.max(0, Number(row.importPrice ?? prev?.importPrice) || 0),
          shopeeItemId: itemId || prev?.shopeeItemId,
          shopeeId: row.shopeeId != null ? String(row.shopeeId) : prev?.shopeeId || itemId,
          channels: Array.isArray(row.channels) && row.channels.length
            ? row.channels
            : prev?.channels || ["shopee"],
          children: Array.isArray(row.children) ? row.children : prev?.children || [],
          lastSynced: new Date().toISOString(),
        };

        const merged = mergeShopeeRowPreservingLocal(prev, mapped);
        byId.set(id, merged);
        if (itemId) byShopeeItemId.set(itemId, id);
        changedRows.push(merged);
        upserted++;
      } catch (rowErr: unknown) {
        console.error("Lỗi khi lưu DB chunk: (skip row)", rowErr);
      }
    }

    console.log("Dữ liệu sau khi map (trước khi lưu):", upserted);
    // Chỉ upsert các dòng của trang hiện tại — tránh ghi lại cả catalog mỗi page
    // (nguyên nhân khởi tạo chậm dần rồi timeout sau vài trang).
    const upsertStarted = Date.now();
    await upsertProductsToStoreAsync(changedRows);
    const upsertMs = Date.now() - upsertStarted;
    return {
      upserted,
      existingCount: existing.length,
      upsertCount: changedRows.length,
      batchRows: batchRows.length,
      loadMs,
      upsertMs,
    };
  } catch (error: unknown) {
    console.error("Lỗi khi lưu DB chunk:", error);
    throw error instanceof Error ? error : new Error(String(error));
  }
}

/**
 * Đồng bộ kho Shopee — chunked/paginated:
 * Tải ≤50 item → Lưu DB → nghỉ 100ms → lặp (không vét cạn 1 lần, không Promise.all).
 */
async function pullShopeeWarehouseAllPages(
  shopId: string,
  accessToken: string
): Promise<{
  stats: {
    itemCount: number;
    rowCount: number;
    variantItemCount: number;
    skippedCount: number;
    pageCount: number;
  };
  skippedItems: { itemId: string; reason: string }[];
}> {
  const startedAt = Date.now();
  // Không được xóa dữ liệu Shopee cũ trước khi pull hoàn tất. Mọi trang đều upsert
  // theo item_id; lỗi hoặc timeout sẽ giữ nguyên kho đang dùng.
  writeInventoryAudit("shopee_sync_started", { shopId, mode: "safe_upsert" });

  let offset = 0;
  let hasMore = true;
  let pageGuard = 0;
  let itemCount = 0;
  let rowCount = 0;
  let variantItemCount = 0;
  const skippedItems: { itemId: string; reason: string }[] = [];
  let pendingRows: any[] = [];
  let pendingItemCount = 0;

  const flushPending = async () => {
    if (pendingRows.length === 0) return 0;
    try {
      console.log("Dữ liệu sau khi map (trước khi lưu):", pendingRows.length);
      const n = await mergeWarehouseProductsBatch(pendingRows);
      pendingRows = [];
      pendingItemCount = 0;
      return n.upserted;
    } catch (error: unknown) {
      console.error("Lỗi khi lưu DB chunk:", error);
      throw error;
    }
  };

  while (hasMore && pageGuard < PRODUCT_SYNC_MAX_PAGES) {
    pageGuard++;
    console.log(`Đang cập nhật trang ${pageGuard}... (warehouse sync / khởi tạo offset=${offset})`);

    try {
      const page = await fetchShopeeItemListPage(shopId, accessToken, offset);
      console.log("Dữ liệu thô từ Shopee (số lượng):", page.itemIds.length);
      if (page.itemIds.length === 0) {
        console.log(`Đang cập nhật trang ${pageGuard}... trống — hasMore=${page.hasMore}`);
        if (!page.hasMore) break;
        offset = page.nextOffset;
        await sleep(PRODUCT_SYNC_CHUNK_PAUSE_MS);
        continue;
      }

      // Micro-batch id ≤ CHANNEL_FETCH_MICRO_BATCH — tuần tự, không gom cả trang khổng lồ.
      const allIds = asShopeeArray(page.itemIds).filter((n) => Number.isFinite(Number(n)) && Number(n) > 0);
      for (let batchStart = 0; batchStart < allIds.length; batchStart += CHANNEL_FETCH_MICRO_BATCH) {
        const idBatch = allIds.slice(batchStart, batchStart + CHANNEL_FETCH_MICRO_BATCH);
        const baseItems = await fetchShopeeBaseItemsByIds(shopId, accessToken, idBatch);
        console.log("Dữ liệu thô từ Shopee (số lượng):", asShopeeArray(baseItems).length);
        await yieldEventLoop(CHANNEL_FETCH_YIELD_MS);

        for (const item of asShopeeArray(baseItems)) {
          if (!item || item.item_id == null) continue;
          try {
            const r = await syncShopeeItemToWarehouseRows(shopId, accessToken, item);
            if (r.error && (!r.rows || r.rows.length === 0)) {
              skippedItems.push({ itemId: String(item.item_id), reason: r.error });
            } else {
              if (r.modelCount > 0) variantItemCount++;
              const rows = asShopeeArray(r.rows);
              console.log("Dữ liệu sau khi map (trước khi lưu):", rows.length);
              pendingRows.push(...rows);
              pendingItemCount += 1;
              itemCount += 1;
              rowCount += rows.length;

              // Đủ ~50 sản phẩm → ghi DB → nghỉ 100ms.
              if (pendingItemCount >= PRODUCT_SYNC_CHUNK_SIZE) {
                try {
                  flushPending();
                } catch (chunkErr: unknown) {
                  console.error("Lỗi khi lưu DB chunk:", chunkErr);
                  skippedItems.push({
                    itemId: `chunk_page_${pageGuard}`,
                    reason: chunkErr instanceof Error ? chunkErr.message : String(chunkErr),
                  });
                  pendingRows = [];
                  pendingItemCount = 0;
                }
                console.log(
                  `Đang cập nhật trang ${pageGuard}... đã lưu chunk ${PRODUCT_SYNC_CHUNK_SIZE} item (tổng item=${itemCount})`
                );
                await sleep(PRODUCT_SYNC_CHUNK_PAUSE_MS);
              }
            }
          } catch (itemErr: unknown) {
            const reason = itemErr instanceof Error ? itemErr.message : String(itemErr);
            skippedItems.push({ itemId: String(item?.item_id ?? "?"), reason });
            console.error(`[Shopee Warehouse Sync] item_id=${item?.item_id}: ${reason}`);
          }
          await yieldEventLoop(CHANNEL_FETCH_YIELD_MS);
        }
      }

      try {
        flushPending();
      } catch (chunkErr: unknown) {
        console.error("Lỗi khi lưu DB chunk:", chunkErr);
        skippedItems.push({
          itemId: `flush_page_${pageGuard}`,
          reason: chunkErr instanceof Error ? chunkErr.message : String(chunkErr),
        });
        pendingRows = [];
        pendingItemCount = 0;
      }
      console.log(
        `Đang cập nhật trang ${pageGuard}... xong — itemsInPage=${allIds.length}, totalItems=${itemCount}, totalRows=${rowCount}`
      );

      hasMore = page.hasMore;
      offset = page.nextOffset;
      if (hasMore) await sleep(PRODUCT_SYNC_CHUNK_PAUSE_MS);
    } catch (pageErr: unknown) {
      const reason = pageErr instanceof Error ? pageErr.message : String(pageErr);
      skippedItems.push({ itemId: `page_${pageGuard}`, reason });
      console.error(`[Shopee Warehouse Sync] Dừng tại trang ${pageGuard}: ${reason}`);
      try {
        flushPending();
      } catch (chunkErr: unknown) {
        console.error("Lỗi khi lưu DB chunk:", chunkErr);
      }
      break;
    }
  }

  try {
    flushPending();
  } catch (chunkErr: unknown) {
    console.error("Lỗi khi lưu DB chunk:", chunkErr);
  }

  const verified = (await loadProducts()).filter(
    (p: any) => p.shopeeItemId || (Array.isArray(p.channels) && p.channels.includes("shopee"))
  ).length;
  console.log(
    `[Shopee Warehouse Sync] HOAN TAT ${itemCount} item -> ${rowCount} dong (${variantItemCount} co phan loai), verifiedInDb=${verified}, ${Date.now() - startedAt}ms, pages=${pageGuard}`,
  );

  return {
    stats: {
      itemCount,
      rowCount,
      variantItemCount,
      skippedCount: skippedItems.length,
      pageCount: pageGuard,
    },
    skippedItems,
  };
}

async function syncShopeeWarehouseSinglePage(
  shopId: string,
  accessToken: string,
  offset: number,
): Promise<{
  currentOffset: number;
  nextOffset: number;
  hasMore: boolean;
  pageIndex: number;
  pageStats: {
    itemsInPage: number;
    rowsInPage: number;
    variantItemCount: number;
    skippedCount: number;
    savedCount: number;
  };
  skippedItems: { itemId: string; reason: string }[];
  productCount: number;
  mergeDebug?: {
    existingCount: number;
    upsertCount: number;
    batchRows: number;
    loadMs: number;
    upsertMs: number;
  };
}> {
  const pageStarted = Date.now();
  const page = await fetchShopeeItemListPage(shopId, accessToken, offset);
  if (page.itemIds.length === 0) {
    let productCount = 0;
    try {
      productCount = await countProducts();
    } catch {
      productCount = 0;
    }
    return {
      currentOffset: offset,
      nextOffset: page.nextOffset,
      hasMore: false,
      pageIndex: page.pageIndex,
      pageStats: {
        itemsInPage: 0,
        rowsInPage: 0,
        variantItemCount: 0,
        skippedCount: 0,
        savedCount: 0,
      },
      skippedItems: [],
      productCount,
      mergeDebug: { existingCount: 0, upsertCount: 0, batchRows: 0, loadMs: 0, upsertMs: 0 },
    };
  }

  const allIds = asShopeeArray(page.itemIds).filter((n) => Number.isFinite(Number(n)) && Number(n) > 0);
  const pageRows: any[] = [];
  let variantItemCount = 0;
  const skippedItems: { itemId: string; reason: string }[] = [];

  for (let batchStart = 0; batchStart < allIds.length; batchStart += CHANNEL_FETCH_MICRO_BATCH) {
    const idBatch = allIds.slice(batchStart, batchStart + CHANNEL_FETCH_MICRO_BATCH);
    const baseItems = await fetchShopeeBaseItemsByIds(shopId, accessToken, idBatch);
    await yieldEventLoop(CHANNEL_FETCH_YIELD_MS);

    for (const item of asShopeeArray(baseItems)) {
      if (!item || item.item_id == null) continue;
      try {
        const r = await syncShopeeItemToWarehouseRows(shopId, accessToken, item);
        if (r.error && (!r.rows || r.rows.length === 0)) {
          skippedItems.push({ itemId: String(item.item_id), reason: r.error });
        } else {
          if (r.modelCount > 0) variantItemCount++;
          pageRows.push(...asShopeeArray(r.rows));
        }
      } catch (itemErr: unknown) {
        const reason = itemErr instanceof Error ? itemErr.message : String(itemErr);
        console.error(`[Shopee Warehouse Sync] page offset=${offset} item_id=${item?.item_id}: ${reason}`);
        skippedItems.push({ itemId: String(item?.item_id ?? "?"), reason });
      }
      await yieldEventLoop(CHANNEL_FETCH_YIELD_MS);
    }
  }

  const dedupedRows = dedupeShopeeParentVariantRows(pageRows);
  const mergeResult =
    dedupedRows.length > 0
      ? await mergeWarehouseProductsBatch(dedupedRows)
      : { upserted: 0, existingCount: 0, upsertCount: 0, batchRows: 0, loadMs: 0, upsertMs: 0 };
  const savedCount = mergeResult.upserted;
  // Tránh loadProducts() lần 2 (nặng, dễ timeout/500 HTML trên cPanel).
  let productCount = Number(mergeResult.existingCount || 0) + Number(savedCount || 0);
  try {
    productCount = await countProducts();
  } catch {
    /* giữ ước lượng ở trên */
  }

  console.log(
    `[Shopee Warehouse Sync] Page ${page.pageIndex + 1} offset=${offset}: items=${allIds.length}, rows=${dedupedRows.length}, saved=${savedCount}, totalShopee=${productCount}, durationMs=${Date.now() - pageStarted}, upsertCount=${mergeResult.upsertCount}, existingCount=${mergeResult.existingCount}`
  );

  return {
    currentOffset: offset,
    nextOffset: page.nextOffset,
    hasMore: page.hasMore,
    pageIndex: page.pageIndex,
    pageStats: {
      itemsInPage: allIds.length,
      rowsInPage: dedupedRows.length,
      variantItemCount,
      skippedCount: skippedItems.length,
      savedCount,
    },
    skippedItems,
    productCount,
    mergeDebug: {
      existingCount: mergeResult.existingCount,
      upsertCount: mergeResult.upsertCount,
      batchRows: mergeResult.batchRows,
      loadMs: mergeResult.loadMs,
      upsertMs: mergeResult.upsertMs,
    },
  };
}

async function fetchAllShopeeItemIds(shopId: string, accessToken: string): Promise<string[]> {
  const allItemIds: string[] = [];
  let offset = 0;
  let hasNext = true;
  let pageGuard = 0;
  while (hasNext && pageGuard < 100) {
    const listResult = await shopeeGetItemList(shopId, accessToken, offset);
    if (listResult.error) {
      throw new Error(formatShopeeApiError(listResult) || `${listResult.error}: ${listResult.message || ""}`);
    }
    const items = listResult.response?.item || [];
    for (const it of items) {
      const id = toShopeeId(it?.item_id);
      if (id) allItemIds.push(id);
    }
    hasNext = !!listResult.response?.has_next_page && items.length > 0;
    offset = listResult.response?.next_offset ?? offset + items.length;
    pageGuard++;
    if (hasNext) await sleep(SHOPEE_PRODUCT_API_DELAY_MS);
  }
  return allItemIds;
}

async function fetchShopeeBaseItemsByIds(
  shopId: string,
  accessToken: string,
  itemIds: Array<string | number>,
): Promise<any[]> {
  const allItems: any[] = [];
  const ids = asShopeeArray(itemIds)
    .map((v) => toShopeeId(v))
    .filter((id): id is string => !!id);
  const batches: string[][] = [];
  for (let i = 0; i < ids.length; i += SHOPEE_PRODUCT_BASE_INFO_BATCH) {
    batches.push(ids.slice(i, i + SHOPEE_PRODUCT_BASE_INFO_BATCH));
  }

  // for...of tuần tự — await bắt được lỗi từng batch
  for (let batchIdx = 0; batchIdx < batches.length; batchIdx++) {
    const batch = batches[batchIdx];
    try {
      const baseInfoResult = await shopeeGetItemBaseInfo(shopId, accessToken, batch);
      if (baseInfoResult?.error) {
        const errMsg =
          formatShopeeApiError(baseInfoResult) ||
          `${baseInfoResult.error}: ${baseInfoResult.message || ""}`;
        console.error(`[Shopee Sync] get_item_base_info batch ${batchIdx}: ${errMsg}`);
      } else {
        allItems.push(...asShopeeArray(baseInfoResult?.response?.item_list).filter((it) => it != null));
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[Shopee Sync] get_item_base_info batch ${batchIdx} exception: ${msg}`);
    }
    if (batchIdx < batches.length - 1) {
      await sleep(SHOPEE_PRODUCT_API_DELAY_MS);
    }
  }

  return allItems;
}

async function fetchShopeeListingRowsFromApi(shopId: string, accessToken: string) {
  const result = await pullShopeeWarehouseAllPages(shopId, accessToken);
  return {
    rows: (await loadProducts()).filter((p: any) => p.shopeeItemId || p.channels?.includes("shopee")),
    stats: result.stats,
    skippedItems: result.skippedItems,
  };
}

async function runFullShopeeWarehouseSync(shopId: string, accessToken: string) {
  try {
    const { stats, skippedItems } = await pullShopeeWarehouseAllPages(shopId, accessToken);
    const allProducts = await loadProducts();
    const productCount = allProducts.filter((p: any) => p.shopeeItemId || p.channels?.includes("shopee")).length;
    const variantSkuCount = allProducts.reduce(
      (n: number, p: any) => n + getProductChildrenList(p).length,
      0
    );
    return { shopId, stats: { ...stats, variantSkuCount }, skippedItems, productCount };
  } catch (err) {
    const { message, details } = extractHttpClientError(err);
    console.error("[Shopee Product Sync] runFullShopeeWarehouseSync failed:", message, details);
    throw new Error(message);
  }
}

async function syncStockFromShopee(shopId: string, accessToken: string) {
  const products = await loadProducts();
  const localShopee = products.filter((p) => p.shopeeItemId);
  const itemIds = [
    ...new Set(
      localShopee
        .map((p) => Number(p.shopeeItemId))
        .filter((n) => Number.isFinite(n) && n > 0)
    ),
  ];

  if (itemIds.length === 0) {
    return { updated: 0, compared: 0, products };
  }

  const stockBySku = new Map<string, number>();
  const allItems = await fetchShopeeBaseItemsByIds(shopId, accessToken, itemIds);

  await runInShopeeBatches(allItems, async (item) => {
    const r = await syncShopeeItemToWarehouseRows(shopId, accessToken, item);
    for (const row of flattenProductsForStockSync(r.rows)) {
      const sku = String(row.sku || "").trim();
      if (sku) stockBySku.set(sku, Math.max(0, Number(row.stock) || 0));
    }
  });

  let updated = 0;
  let compared = 0;
  const next = products.map((p) => {
    const children = getProductChildrenList(p);
    if (children.length > 0) {
      let childChanged = false;
      const nextChildren = children.map((c: any) => {
        const sku = String(c.sku || "").trim();
        if (!sku || !stockBySku.has(sku)) return c;
        compared++;
        const newStock = stockBySku.get(sku)!;
        if (Number(c.stock) === newStock) return c;
        updated++;
        childChanged = true;
        return { ...c, stock: newStock, lastSynced: new Date().toISOString() };
      });
      if (!childChanged) return p;
      const totalStock = nextChildren.reduce((s: number, c: any) => s + (Number(c.stock) || 0), 0);
      return { ...p, children: nextChildren, stock: totalStock, lastSynced: new Date().toISOString() };
    }

    const sku = String(p.sku || "").trim();
    if (!sku || !p.shopeeItemId || !stockBySku.has(sku)) return p;
    compared++;
    const newStock = stockBySku.get(sku)!;
    if (Number(p.stock) === newStock) return p;
    updated++;
    return mergeProductPatch(p, { stock: newStock });
  });

  await saveProducts(next);
  console.log(`[Sync Stock] Shopee shop_id=${shopId}: ${compared} SKU so sánh, ${updated} SKU cập nhật`);
  return { updated, compared, products: next };
}

async function fetchShopeeItemVariants(
  shopId: string,
  accessToken: string,
  itemId: string | number
): Promise<{ item: any; variantProducts: any[]; error?: string; modelCount: number }> {
  const baseInfoResult = await shopeeGetItemBaseInfo(shopId, accessToken, [itemId]);
  if (baseInfoResult.error) {
    return { item: null, variantProducts: [], modelCount: 0, error: `${baseInfoResult.error}: ${baseInfoResult.message}` };
  }
  const item = baseInfoResult.response?.item_list?.[0];
  if (!item) {
    return { item: null, variantProducts: [], modelCount: 0, error: "item_not_found" };
  }

  const { rows, modelCount, error } = await syncShopeeItemToWarehouseRows(shopId, accessToken, item, { strict: true });
  if (error && rows.length === 0) {
    return { item, variantProducts: [], modelCount: 0, error };
  }
  return { item, variantProducts: rows, modelCount, error };
}

function mergeShopeeRowPreservingLocal(existing: any, incoming: any): any {
  if (!existing) return incoming;
  return {
    ...existing,
    ...incoming,
    importPrice: existing.importPrice ?? incoming.importPrice,
    wholesalePrice: existing.wholesalePrice ?? incoming.wholesalePrice,
    weight: existing.weight ?? incoming.weight,
    unit: existing.unit ?? incoming.unit,
    description: existing.description || incoming.description,
  };
}

function replaceProductsForShopeeItem(products: any[], itemId: string, variantProducts: any[]): any[] {
  const key = String(itemId);
  const byId = new Map<string, any>();
  for (const p of products) {
    byId.set(p.id, p);
    for (const c of getProductChildrenList(p)) byId.set(c.id, c);
  }
  const without = products.filter((p: any) => {
    const pItemId = p.shopeeItemId || String(p.id || "").match(/^shopee-item-(\d+)/)?.[1];
    return String(pItemId) !== key;
  });

  const mergedParents = variantProducts.map((row) => {
    const prev = byId.get(row.id);
    const incomingChildren = getProductChildrenList(row);
    if (incomingChildren.length > 0) {
      const mergedChildren = incomingChildren.map((child: any) =>
        mergeShopeeRowPreservingLocal(byId.get(child.id), child)
      );
      return mergeShopeeRowPreservingLocal(prev, { ...row, children: mergedChildren });
    }
    return mergeShopeeRowPreservingLocal(prev, row);
  });
  return [...mergedParents, ...without];
}

function dedupeShopeeParentVariantRows(products: any[]): any[] {
  // Parent-Child: mỗi item_id chỉ giữ 1 Parent (có children). Loại flat child cũ nếu còn sót.
  const byItem = new Map<string, any>();
  const others: any[] = [];

  for (const p of asShopeeArray(products)) {
    if (!p || typeof p !== "object") continue;
    const itemId = p?.shopeeItemId || String(p?.id || "").match(/^shopee-item-(\d+)/)?.[1];
    if (!itemId) {
      others.push(p);
      continue;
    }
    const key = String(itemId);
    const isParent = getProductChildrenList(p).length > 0 || /^shopee-item-\d+$/.test(String(p?.id || ""));
    const isFlatChild = !!p?.shopeeModelId || String(p?.id || "").includes("-model-");

    if (isFlatChild && !isParent) continue;

    const prev = byItem.get(key);
    if (!prev) {
      byItem.set(key, p);
      continue;
    }
    const prevHasChildren = getProductChildrenList(prev).length > 0;
    const nextHasChildren = getProductChildrenList(p).length > 0;
    if (nextHasChildren && !prevHasChildren) byItem.set(key, p);
    else if (isParent && !/^shopee-item-\d+$/.test(String(prev?.id || ""))) byItem.set(key, p);
  }

  return [...byItem.values(), ...others];
}

// v2.logistics.get_shipping_parameter — tells us whether this order ships via
// "pickup" (Shopee courier picks up from seller's address), "dropoff" (seller
// drops the parcel at a branch) or "non_integrated" (3rd-party carrier, manual
// tracking number), plus the concrete address/time-slot/branch options.
// Timeout từng HTTP logistics (fail-fast) — request treo abort ngay.
const SHOPEE_LOGISTICS_TIMEOUT_MS = 5_000;
// Mỗi đơn xác nhận tối đa 8s (chỉ get_shipping_parameter + ship_order, KHÔNG recover/enrich).
const SHIP_ORDER_OPERATION_TIMEOUT_MS = 8_000;
/** FE gửi tối đa ~5 đơn/request — BE xử lý tuần tự trong 1 process. */
const SHIP_ORDER_CHUNK_SIZE = 5;
/** CẤM concurrency — for...of tuần tự để tránh Rate Limit Shopee + Over Process cPanel. */
const SHIP_ORDER_CHUNK_CONCURRENCY = 1;
/** Nghỉ giữa các đơn trong chunk — tránh Shopee rate-limit. */
const SHIP_ORDER_CHUNK_PAUSE_MS = 200;
/** Poll READY trong 1 request chunk in đơn — 1s/lần, lần đầu poll ngay. */
const PRINT_CHUNK_POLL_MAX = 10;
const PRINT_CHUNK_POLL_MS = 1000;
const PRINT_CHUNK_DEADLINE_MS = 45_000;
/** (Legacy) Không dùng delay cố định sau ship trong Confirm&Print — poll READY thay thế. */
const SHIP_ORDER_PDF_READY_DELAY_MS = 0;
/** Poll get_shipping_document_result: tối đa 10 lần × 1.5s. */
const SHIP_ORDER_PDF_RETRY_MAX = 10;
const SHIP_ORDER_PDF_RETRY_DELAY_MS = 1500;
/** Timeout cho polling PDF batch (ms) */
const SHIP_ORDER_PDF_RETRY_TIMEOUT_MS = 120_000;
const SHOPEE_SHIPPING_DOC_BATCH_MAX = 50;
/** Trần kích thước PDF batch — tránh OOM cPanel khi buffer quá lớn. */
const SHOPEE_WAYBILL_PDF_MAX_BYTES = 25 * 1024 * 1024;
/** Tracking gate trước in: concurrency thấp, độc lập sync. */
const PRINT_TRACKING_CHUNK_SIZE = 10;
const PRINT_TRACKING_CONCURRENCY = 5;
const PRINT_TRACKING_CHUNK_PAUSE_MS = 300;

/** In-memory cache get_address_list — tránh gọi lại API trong cùng bulk ship. */
const shopeeAddressListMemCache = new Map<
  string,
  { at: number; result: any; list: any[] }
>();
const shopeeAddressListInflight = new Map<
  string,
  Promise<{ result: any; list: any[]; fromCache: boolean }>
>();
const SHOPEE_ADDRESS_LIST_MEM_TTL_MS = 10 * 60 * 1000;

/**
 * get_address_list: In-Memory → Redis (TTL 24h) → API (coalesce inflight theo shop).
 * Chỉ cache response thành công. Bulk ship không gọi API thừa.
 *
 * QUAN TRỌNG: KHÔNG gắn AbortSignal của 1 đơn vào inflight dùng chung —
 * timeout/abort đơn A sẽ giết luôn đơn B–N đang chờ cùng promise → treo/lỗi hàng loạt.
 */
async function getShopeeAddressListCached(
  shopId: string,
  accessToken: string,
  _signal?: AbortSignal,
): Promise<{ result: any; list: any[]; fromCache: boolean }> {
  const sid = String(shopId || "").trim();
  const mem = shopeeAddressListMemCache.get(sid);
  if (mem && Date.now() - mem.at < SHOPEE_ADDRESS_LIST_MEM_TTL_MS && mem.result && !mem.result.error) {
    return { result: mem.result, list: mem.list || [], fromCache: true };
  }
  const cached = await getCachedShopeeAddressList(sid);
  if (cached?.result && !cached.result.error) {
    shopeeAddressListMemCache.set(sid, {
      at: Date.now(),
      result: cached.result,
      list: cached.list || [],
    });
    return { result: cached.result, list: cached.list || [], fromCache: true };
  }
  const inflight = shopeeAddressListInflight.get(sid);
  if (inflight) return inflight;

  const run = (async () => {
    // Timeout riêng của fetchShopeeLogisticsJson — không dùng signal caller.
    const result = await shopeeGetAddressList(sid, accessToken, undefined);
    const list = result?.response?.address_list || result?.address_list || [];
    if (result && !result.error) {
      shopeeAddressListMemCache.set(sid, { at: Date.now(), result, list });
      await setCachedShopeeAddressList(sid, result);
    }
    return { result, list, fromCache: false };
  })().finally(() => {
    shopeeAddressListInflight.delete(sid);
  });
  shopeeAddressListInflight.set(sid, run);
  return run;
}

async function fetchShopeeLogisticsJson(
  url: string,
  init: RequestInit,
  context: string,
  opts?: { timeoutMs?: number; signal?: AbortSignal },
): Promise<{ response: Response; json: any }> {
  const timeoutMs = opts?.timeoutMs ?? SHOPEE_LOGISTICS_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onParentAbort = () => controller.abort();
  if (opts?.signal) {
    if (opts.signal.aborted) controller.abort();
    else opts.signal.addEventListener("abort", onParentAbort, { once: true });
  }
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const raw = await response.text();
    let json: any;
    try {
      json = raw ? JSON.parse(raw) : {};
    } catch {
      throw new Error(
        `Shopee ${context} trả về dữ liệu không phải JSON (HTTP ${response.status}): ${raw.slice(0, 300)}`,
      );
    }
    return { response, json };
  } catch (error: any) {
    if (error?.name === "AbortError" || opts?.signal?.aborted) {
      throw new Error(`Shopee ${context} timeout sau ${timeoutMs / 1000} giây.`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
    opts?.signal?.removeEventListener("abort", onParentAbort);
  }
}

async function shopeeGetShippingParameter(
  shopId: string,
  accessToken: string,
  orderSn: string,
  packageNumber?: string,
  signal?: AbortSignal,
) {
  const apiPath = "/api/v2/logistics/get_shipping_parameter";
  const timestamp = Math.floor(Date.now() / 1000);
  const sign = shopeeSign(apiPath, timestamp, accessToken, shopId);

  const params = new URLSearchParams({
    partner_id: SHOPEE_PARTNER_ID,
    timestamp: String(timestamp),
    access_token: accessToken,
    shop_id: shopId,
    sign,
    order_sn: orderSn,
  });
  if (packageNumber) params.set("package_number", packageNumber);

  const url = `${SHOPEE_HOST}${apiPath}?${params.toString()}`;
  const { response, json } = await fetchShopeeLogisticsJson(url, {}, "get_shipping_parameter", { signal });
  console.log(`[Shopee API] GET ${apiPath} (order_sn=${orderSn}) -> HTTP ${response.status}:`, JSON.stringify(json));
  return json;
}

// v2.logistics.get_address_list — danh sách địa chỉ kho/lấy hàng mới nhất của shop.
async function shopeeGetAddressList(shopId: string, accessToken: string, signal?: AbortSignal) {
  const apiPath = "/api/v2/logistics/get_address_list";
  const timestamp = Math.floor(Date.now() / 1000);
  const sign = shopeeSign(apiPath, timestamp, accessToken, shopId);
  const params = new URLSearchParams({
    partner_id: SHOPEE_PARTNER_ID,
    timestamp: String(timestamp),
    access_token: accessToken,
    shop_id: shopId,
    sign,
  });
  const url = `${SHOPEE_HOST}${apiPath}?${params.toString()}`;
  const { response, json } = await fetchShopeeLogisticsJson(url, {}, "get_address_list", { signal });
  console.log(`[Shopee API] GET ${apiPath} (shop_id=${shopId}) -> HTTP ${response.status}:`, JSON.stringify(json));
  return json;
}

function isShopeePickupAddressActive(addr: any): boolean {
  if (!addr || addr.address_id === undefined || addr.address_id === null) return false;
  const status = String(addr.address_status || addr.status || "").toLowerCase();
  if (status && /disabled|invalid|deleted|inactive/.test(status)) return false;
  const flags = Array.isArray(addr.address_flag) ? addr.address_flag.map(String) : [];
  if (flags.length > 0 && !flags.some((f) => /pickup|default|warehouse|return/.test(f.toLowerCase()))) {
    return false;
  }
  return true;
}

/** Chọn address_id + pickup_time_id hợp lệ — ưu tiên địa chỉ kho mới từ get_address_list. */
function resolvePickupShipmentFromParams(
  paramPickup: any,
  shopAddressList: any[],
): { address_id: number | string; pickup_time_id: string | number } | null {
  const paramAddresses = Array.isArray(paramPickup?.address_list) ? paramPickup.address_list : [];
  const activeShopIds = new Set(
    shopAddressList.filter(isShopeePickupAddressActive).map((a) => a.address_id),
  );

  const tryAddress = (addr: any): { address_id: number | string; pickup_time_id: string | number } | null => {
    if (addr?.address_id === undefined || addr?.address_id === null) return null;
    if (activeShopIds.size > 0 && !activeShopIds.has(addr.address_id)) return null;
    const slots = Array.isArray(addr.time_slot_list) ? addr.time_slot_list : [];
    const slot = slots.find(
      (s: any) => s?.pickup_time_id !== undefined && s?.pickup_time_id !== null && s?.pickup_time_id !== "",
    ) || slots[0];
    if (!slot || slot.pickup_time_id === undefined || slot.pickup_time_id === null) {
      // Shopee cho phép pickup_time_id rỗng với một số kênh — vẫn gửi address_id.
      return { address_id: addr.address_id, pickup_time_id: slot?.pickup_time_id ?? "" };
    }
    return { address_id: addr.address_id, pickup_time_id: slot.pickup_time_id };
  };

  // 1) Ưu tiên địa chỉ pickup mặc định từ get_address_list, khớp với get_shipping_parameter.
  for (const shopAddr of shopAddressList) {
    if (!isShopeePickupAddressActive(shopAddr)) continue;
    const paramAddr = paramAddresses.find((p) => p.address_id === shopAddr.address_id);
    if (paramAddr) {
      const picked = tryAddress(paramAddr);
      if (picked) return picked;
    }
  }

  // 2) Thử lần lượt mọi address trong get_shipping_parameter (không chỉ [0]).
  for (const paramAddr of paramAddresses) {
    const picked = tryAddress(paramAddr);
    if (picked) return picked;
  }

  // 3) Fallback: address_id từ get_address_list + slot rỗng (Shopee tự xếp lịch).
  const fallbackShop = shopAddressList.find(isShopeePickupAddressActive);
  if (fallbackShop) {
    return { address_id: fallbackShop.address_id, pickup_time_id: "" };
  }

  return null;
}

// v2.logistics.ship_order — arranges the actual shipment (pickup/dropoff/non_integrated)
// so the order moves to "Chờ lấy hàng" (LOGISTICS_REQUEST_CREATED) on Shopee.
//
// IMPORTANT: `package_number` is INTENTIONALLY never accepted/sent by this
// function. Shopee hard-rejects ship_order with "Please don't request with
// package_number for this unsplit order" for the vast majority of normal
// (unsplit) orders, and there is no reliable local heuristic to prove an
// order is genuinely split. Per explicit product decision, this project only
// ships normal/unsplit orders — package_number must NEVER appear in this body.
async function shopeeShipOrder(
  shopId: string,
  accessToken: string,
  orderSn: string,
  shipmentBody: Record<string, any>,
  signal?: AbortSignal,
) {
  const apiPath = "/api/v2/logistics/ship_order";
  const timestamp = Math.floor(Date.now() / 1000);
  const sign = shopeeSign(apiPath, timestamp, accessToken, shopId);
  const url = `${SHOPEE_HOST}${apiPath}?partner_id=${SHOPEE_PARTNER_ID}&timestamp=${timestamp}&access_token=${accessToken}&shop_id=${shopId}&sign=${sign}`;

  const body: Record<string, any> = { order_sn: orderSn, ...shipmentBody };
  delete body.package_number; // absolute guard — never send this key, no matter what shipmentBody contains

  const { response, json } = await fetchShopeeLogisticsJson(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }, "ship_order", { signal });
  console.log(`[Shopee API] POST ${apiPath} (order_sn=${orderSn}) body=${JSON.stringify(body)} -> HTTP ${response.status}:`, JSON.stringify(json));
  return json;
}

type ShipMethod = "pickup" | "dropoff";

// Full "ship this order" flow for a REAL Shopee shop: call get_shipping_parameter
// to discover the concrete address/time-slot (pickup) or branch (dropoff) options,
// honor the method the seller explicitly picked in the "Xác nhận đơn hàng" modal,
// then call ship_order. Fails clearly if Shopee doesn't support the chosen method
// for this specific order's logistics channel (info_needed doesn't list it).
async function shipShopeeOrderReal(
  order: any,
  method: ShipMethod,
  signal?: AbortSignal,
  opts?: { skipRecover?: boolean },
): Promise<{
  success: boolean;
  error?: string;
  message?: string;
  mode?: string;
  shopId?: string;
  trackingNumber?: string;
  alreadyShipped?: boolean;
  skipped?: boolean;
}> {
  const skipRecover = opts?.skipRecover === true;
  const throwIfAborted = () => {
    if (signal?.aborted) throw new Error(`Ship order ${order?.orderSn || ""} aborted/timeout`);
  };

  try {
  throwIfAborted();
  const shopCheck = validateOrderShopForShipment(order);
  if (!shopCheck.ok) {
    return { success: false, error: shopCheck.error, message: shopCheck.message };
  }
  const shopId = shopCheck.shopId;
  if (!shopId) {
    return { success: false, error: "missing_shop_id", message: "Đơn hàng thiếu shop_id, không xác định được shop Shopee để gọi API." };
  }

  let accessToken: string;
  try {
    accessToken = (await getValidShopeeAccessToken(shopId)) || "";
    if (!accessToken) {
      const fail = describeShopeeTokenFailure(shopId);
      return { success: false, error: fail.error, message: fail.message };
    }
  } catch (err) {
    if (err instanceof ShopeeRefreshTokenExpiredError) {
      return { success: false, error: err.code, message: err.message };
    }
    throw err;
  }

  /** Batch confirm: đã ship / lỗi → skip ngay, KHÔNG get_order_detail / tracking / sleep. */
  const failOrSkipAlreadyShipped = (apiResult: any, fallbackError: string, fallbackMessage: string) => {
    if (isAlreadyShippedError(apiResult)) {
      return {
        success: true as const,
        alreadyShipped: true as const,
        skipped: true as const,
        mode: method,
        shopId,
        trackingNumber: order.trackingNumber || order.tracking_no || undefined,
      };
    }
    return {
      success: false as const,
      error: String(apiResult?.error || fallbackError),
      message: String(apiResult?.message || fallbackMessage),
      mode: method,
      shopId,
      skipped: true as const,
    };
  };

  // Deliberately called WITHOUT package_number — see shopeeShipOrder's comment.
  let paramResult = await shopeeGetShippingParameter(shopId, accessToken, order.orderSn, undefined, signal);
  if (isShopeeInvalidTokenError(paramResult?.error, paramResult?.message)) {
    try {
      accessToken = await refreshShopeeAccessTokenLocked(shopId, { force: true });
      paramResult = await shopeeGetShippingParameter(shopId, accessToken, order.orderSn, undefined, signal);
    } catch (err) {
      if (err instanceof ShopeeRefreshTokenExpiredError) {
        return { success: false, error: err.code, message: err.message };
      }
      throw err;
    }
  }
  console.log(`D\u1EEE LI\u1EC6U SHOPEE TR\u1EA2 V\u1EC0 (get_shipping_parameter) - \u0111\u01A1n ${order.orderSn}:`, JSON.stringify(paramResult));
  if (paramResult.error) {
    console.error(`[Shopee L\u1ED6I] get_shipping_parameter th\u1EA5t b\u1EA1i cho \u0111\u01A1n ${order.orderSn} -> error="${paramResult.error}" message="${paramResult.message}"`);
    if (skipRecover) {
      return failOrSkipAlreadyShipped(paramResult, paramResult.error, paramResult.message);
    }
    const recovered = await tryRecoverAlreadyShippedShopeeOrder(shopId, accessToken, order, signal);
    if (recovered.ok) {
      return {
        success: true,
        alreadyShipped: true,
        mode: method,
        shopId,
        trackingNumber: recovered.trackingNumber || order.trackingNumber,
      };
    }
    return { success: false, error: paramResult.error, message: paramResult.message };
  }

  const infoNeeded = paramResult.response?.info_needed || {};
  let shipmentBody: Record<string, any> = {};

  if (method === "dropoff") {
    if (!Object.prototype.hasOwnProperty.call(infoNeeded, "dropoff")) {
      console.error(`[Shopee L\u1ED6I] \u0110\u01A1n ${order.orderSn} kh\xF4ng h\u1ED7 tr\u1EE3 dropoff. info_needed=${JSON.stringify(infoNeeded)}`);
      if (skipRecover) {
        return failOrSkipAlreadyShipped(
          { error: "dropoff_not_supported", message: "dropoff_not_supported" },
          "dropoff_not_supported",
          "Đơn vị vận chuyển của đơn này KHÔNG hỗ trợ hình thức \"Tự mang hàng ra bưu cục\". Vui lòng chọn \"Lấy hàng\" (pickup) thay thế.",
        );
      }
      const recovered = await tryRecoverAlreadyShippedShopeeOrder(shopId, accessToken, order, signal);
      if (recovered.ok) {
        return {
          success: true,
          alreadyShipped: true,
          mode: method,
          shopId,
          trackingNumber: recovered.trackingNumber || order.trackingNumber,
        };
      }
      return { success: false, error: "dropoff_not_supported", message: "Đơn vị vận chuyển của đơn này KHÔNG hỗ trợ hình thức \"Tự mang hàng ra bưu cục\". Vui lòng chọn \"Lấy hàng\" (pickup) thay thế." };
    }
    const dropoffRequirements = Array.isArray(infoNeeded.dropoff) ? infoNeeded.dropoff : [];
    const branch = paramResult.response?.dropoff?.branch_list?.find(
      (item: any) => item?.branch_id !== undefined && item?.branch_id !== null,
    );
    if (dropoffRequirements.includes("branch_id") && !branch) {
      console.error(`[Shopee LỖI] Đơn ${order.orderSn} bắt buộc branch_id nhưng Shopee không trả về branch hợp lệ. dropoff=${JSON.stringify(paramResult.response?.dropoff)}`);
      return { success: false, error: "no_dropoff_branch_available", message: "Shopee yêu cầu branch_id nhưng không trả về bưu cục dropoff khả dụng cho đơn này." };
    }
    shipmentBody = { dropoff: branch ? { branch_id: branch.branch_id } : {} };
  } else {
    if (!Object.prototype.hasOwnProperty.call(infoNeeded, "pickup")) {
      console.error(`[Shopee L\u1ED6I] \u0110\u01A1n ${order.orderSn} kh\xF4ng h\u1ED7 tr\u1EE3 pickup. info_needed=${JSON.stringify(infoNeeded)}`);
      if (skipRecover) {
        return failOrSkipAlreadyShipped(
          { error: "pickup_not_supported", message: "pickup_not_supported" },
          "pickup_not_supported",
          "Đơn vị vận chuyển của đơn này KHÔNG hỗ trợ hình thức \"Lấy hàng\". Vui lòng chọn \"Tự mang hàng ra bưu cục\" (dropoff) thay thế.",
        );
      }
      const recovered = await tryRecoverAlreadyShippedShopeeOrder(shopId, accessToken, order, signal);
      if (recovered.ok) {
        return {
          success: true,
          alreadyShipped: true,
          mode: method,
          shopId,
          trackingNumber: recovered.trackingNumber || order.trackingNumber,
        };
      }
      return { success: false, error: "pickup_not_supported", message: "Đơn vị vận chuyển của đơn này KHÔNG hỗ trợ hình thức \"Lấy hàng\". Vui lòng chọn \"Tự mang hàng ra bưu cục\" (dropoff) thay thế." };
    }
    // Pickup: nếu get_shipping_parameter đã có address + pickup_time_id hợp lệ → bỏ hẳn get_address_list.
    const pickupFromParamOnly = resolvePickupShipmentFromParams(
      paramResult.response?.pickup,
      [],
    );
    let pickupChoice = pickupFromParamOnly;
    if (!pickupChoice) {
      // Fallback: Redis cache 24h (shopee:address_list:{shopId}) → API nếu miss / Redis down.
      const { result: addressListResult, list: shopAddressList, fromCache } =
        await getShopeeAddressListCached(shopId, accessToken, signal);
      if (addressListResult?.error) {
        console.warn(
          `[Shopee Ship] get_address_list cảnh báo đơn ${order.orderSn}: ${addressListResult.error} — fallback get_shipping_parameter`,
        );
      } else {
        console.log(
          `[Shopee Ship] get_address_list đơn ${order.orderSn} via ${fromCache ? "Redis cache" : "API+cache"} (${shopAddressList.length} addr)`,
        );
      }
      pickupChoice = resolvePickupShipmentFromParams(paramResult.response?.pickup, shopAddressList);
    } else {
      console.log(
        `[Shopee Ship] Đơn ${order.orderSn} skip get_address_list — dùng address/slot từ get_shipping_parameter`,
      );
    }
    if (!pickupChoice) {
      console.error(
        `[Shopee LỖI] Đơn ${order.orderSn} không có address/time_slot pickup khả dụng. pickup=${JSON.stringify(paramResult.response?.pickup)}`,
      );
      if (skipRecover) {
        return {
          success: false,
          error: "no_pickup_slot_available",
          message: "Shopee không trả về địa chỉ kho/lịch hẹn lấy hàng (pickup) khả dụng. Vui lòng cập nhật địa chỉ lấy hàng trên Shopee Seller Centre rồi thử lại.",
          skipped: true,
        };
      }
      const recovered = await tryRecoverAlreadyShippedShopeeOrder(shopId, accessToken, order, signal);
      if (recovered.ok) {
        return {
          success: true,
          alreadyShipped: true,
          mode: method,
          shopId,
          trackingNumber: recovered.trackingNumber || order.trackingNumber,
        };
      }
      return {
        success: false,
        error: "no_pickup_slot_available",
        message: "Shopee không trả về địa chỉ kho/lịch hẹn lấy hàng (pickup) khả dụng. Vui lòng cập nhật địa chỉ lấy hàng trên Shopee Seller Centre rồi thử lại.",
      };
    }
    shipmentBody = {
      pickup: {
        address_id: pickupChoice.address_id,
        pickup_time_id: pickupChoice.pickup_time_id,
      },
    };
    console.log(
      `[Shopee Ship] Đơn ${order.orderSn} pickup address_id=${pickupChoice.address_id} pickup_time_id=${pickupChoice.pickup_time_id}`,
    );
  }

  throwIfAborted();
  let shipResult = await shopeeShipOrder(shopId, accessToken, order.orderSn, shipmentBody, signal);
  if (isShopeeInvalidTokenError(shipResult?.error, shipResult?.message)) {
    try {
      accessToken = await refreshShopeeAccessTokenLocked(shopId, { force: true });
      shipResult = await shopeeShipOrder(shopId, accessToken, order.orderSn, shipmentBody, signal);
    } catch (err) {
      if (err instanceof ShopeeRefreshTokenExpiredError) {
        return { success: false, error: err.code, message: err.message };
      }
      throw err;
    }
  }
  console.log(`D\u1EEE LI\u1EC6U SHOPEE TR\u1EA2 V\u1EC0 (ship_order) - \u0111\u01A1n ${order.orderSn}:`, JSON.stringify(shipResult));
  if (shipResult.error) {
    console.error(`[Shopee L\u1ED6I] ship_order th\u1EA5t b\u1EA1i cho \u0111\u01A1n ${order.orderSn} -> error="${shipResult.error}" message="${shipResult.message}" request_id="${shipResult.request_id || ""}"`);
    if (skipRecover) {
      return failOrSkipAlreadyShipped(shipResult, shipResult.error, shipResult.message);
    }
    const recovered = await tryRecoverAlreadyShippedShopeeOrder(shopId, accessToken, order, signal);
    if (recovered.ok) {
      return {
        success: true,
        alreadyShipped: true,
        mode: method,
        shopId,
        trackingNumber: recovered.trackingNumber || order.trackingNumber,
      };
    }
    return { success: false, error: shipResult.error, message: shipResult.message, mode: method, shopId };
  }

  // Sau ship thành công: trả về ngay — không sleep / không chờ tracking (PDF & mã vận đơn lo sau).
  return {
    success: true,
    mode: method,
    shopId,
    trackingNumber: order.trackingNumber || order.tracking_no || shipResult?.trackingNumber || undefined,
  };
  } catch (error: any) {
    if (error instanceof ShopeeRefreshTokenExpiredError) {
      return { success: false, error: error.code, message: error.message };
    }
    if (signal?.aborted || /timeout|aborted/i.test(String(error?.message || ""))) {
      return {
        success: false,
        error: "timeout",
        message: error?.message || `Ship order ${order?.orderSn || ""} timeout`,
        skipped: true,
      };
    }
    console.error(`[Shopee LỖI] shipShopeeOrderReal exception đơn ${order?.orderSn}:`, error?.stack || error);
    return {
      success: false,
      error: "internal_server_error",
      message: "Lỗi nội bộ server: " + (error?.message || String(error)),
    };
  }
}

// TikTok Shop / off-platform (manual) orders: no real Partner API is wired up
// in this project yet (only Shopee has a Live App configured in .env), so we
// apply the same pickup/dropoff decision locally and generate a tracking
// number consistent with the seller's choice, instead of silently no-oping.
function arrangeShipmentLocal(order: any, method: ShipMethod): { success: boolean; mode: string; trackingNumber: string } {
  const prefix = order.channel === "tiktok" ? "TTS" : "DIRECT";
  const trackingNumber = order.trackingNumber || `${prefix}-${method === "dropoff" ? "DROPOFF" : "PICKUP"}-${Math.floor(10000000 + Math.random() * 90000000)}`;
  return { success: true, mode: method, trackingNumber };
}

// Single entry point used by both the single-order and bulk ship routes.
async function arrangeShipment(
  order: any,
  method: ShipMethod,
  signal?: AbortSignal,
  opts?: { skipRecover?: boolean },
): Promise<{
  success: boolean;
  error?: string;
  message?: string;
  mode?: string;
  trackingNumber?: string;
  shopId?: string;
  alreadyShipped?: boolean;
  skipped?: boolean;
}> {
  if (order.channel === "shopee") {
    return shipShopeeOrderReal(order, method, signal, opts);
  }
  return arrangeShipmentLocal(order, method);
}

// In thường dùng chung cho create/poll/download — TUYỆT ĐỐI không dùng THERMAL_AIR_WAYBILL.
const SHOPEE_SHIPPING_DOCUMENT_TYPE = "NORMAL_AIR_WAYBILL" as const;

// v2.logistics.get_tracking_number — for INTEGRATED channels, ship_order does
// not return the tracking_number synchronously (the 3PL assigns it a few
// seconds/minutes later). create_shipping_document REQUIRES a real
// tracking_number for these channels — omitting it is exactly what causes
// Shopee's "logistics.tracking_number_invalid" even for a perfectly valid,
// already-shipped order. This fetches the authoritative tracking_number.
async function shopeeGetTrackingNumber(shopId: string, accessToken: string, orderSn: string, packageNumber?: string) {
  const apiPath = "/api/v2/logistics/get_tracking_number";
  try {
    const timestamp = Math.floor(Date.now() / 1000);
    const sign = shopeeSign(apiPath, timestamp, accessToken, shopId);
    const params = new URLSearchParams({
      partner_id: SHOPEE_PARTNER_ID,
      timestamp: String(timestamp),
      access_token: accessToken,
      shop_id: shopId,
      sign,
      order_sn: orderSn,
      response_optional_fields: "plp_number,first_mile_tracking_number,last_mile_tracking_number",
    });
    if (packageNumber) params.set("package_number", packageNumber);

    const url = `${SHOPEE_HOST}${apiPath}?${params.toString()}`;
    const res = await fetchWithTimeout(url);
    const json: any = await res.json();
    // Log FULL payload để lần ra vị trí mã GHN / ĐVVC (VD: GYAGLRYW).
    console.log(
      `[Shopee API] GET ${apiPath} FULL PAYLOAD order_sn=${orderSn} HTTP=${res.status}:`,
      JSON.stringify(json),
    );
    return json;
  } catch (err: any) {
    // Không throw — caller try/catch / vòng lặp sync không bị sập.
    const message = err?.message || String(err);
    console.warn(`[Shopee API] get_tracking_number exception order_sn=${orderSn}:`, message);
    return { error: "get_tracking_number_exception", message, order_sn: orderSn };
  }
}

/** Fallback: bóc mã từ shipping_document_info khi get_tracking_number trả rỗng. */
async function shopeeGetShippingDocumentDataInfo(
  shopId: string,
  accessToken: string,
  orderSn: string,
  packageNumber?: string,
) {
  const apiPath = "/api/v2/logistics/get_shipping_document_data_info";
  const timestamp = Math.floor(Date.now() / 1000);
  const sign = shopeeSign(apiPath, timestamp, accessToken, shopId);
  const url = `${SHOPEE_HOST}${apiPath}?partner_id=${SHOPEE_PARTNER_ID}&timestamp=${timestamp}&access_token=${accessToken}&shop_id=${shopId}&sign=${sign}`;
  const body: Record<string, unknown> = {
    order_list: [
      {
        order_sn: orderSn,
        ...(packageNumber ? { package_number: packageNumber } : {}),
      },
    ],
  };
  const res = await fetchWithTimeout(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json: any = await res.json();
  console.log(
    `[Shopee API] POST ${apiPath} FULL PAYLOAD order_sn=${orderSn} HTTP=${res.status}:`,
    JSON.stringify(json),
  );
  return json;
}

// v2.logistics.create_shipping_document — kicks off async AWB/label generation for up to 50 orders.
// Payload chuẩn Shopee v2 (mỗi phần tử order_list BẮT BUỘC đủ 3 trường):
//   { order_sn, package_number, shipping_document_type: "NORMAL_AIR_WAYBILL" }
// (+ tracking_number khi có mã carrier thật)
async function shopeeCreateShippingDocument(
  shopId: string,
  accessToken: string,
  orderList: {
    order_sn: string;
    package_number: string;
    tracking_number?: string;
    shipping_document_type?: string;
  }[],
  signal?: AbortSignal,
) {
  const sanitizedOrderList = orderList
    .map((row) => {
      const order_sn = String(row?.order_sn || "").trim();
      const package_number = String(row?.package_number || "").trim();
      const rawTn = String(row?.tracking_number || "").trim();
      // Giữ nguyên tracking_number thực tế (kể cả mã OFG/SPX/J&T/GHN); không regex chặn.
      const tracking_number = rawTn ? rawTn : "";
      const incomingType = String(row?.shipping_document_type || "").trim();
      // ÉP CỨNG NORMAL_AIR_WAYBILL — bỏ THERMAL_AIR_WAYBILL / mọi type khác từ caller.
      if (incomingType && incomingType !== SHOPEE_SHIPPING_DOCUMENT_TYPE) {
        console.warn(
          `[Shopee API] create_shipping_document override type ${incomingType} → ${SHOPEE_SHIPPING_DOCUMENT_TYPE} order_sn=${order_sn}`,
        );
      }
      return {
        order_sn,
        package_number,
        tracking_number,
        shipping_document_type: SHOPEE_SHIPPING_DOCUMENT_TYPE,
      };
    })
    .filter((row) => row.order_sn && row.package_number);

  // Guard: mỗi row PHẢI đủ 3 field bắt buộc trước khi gọi Shopee.
  const missingType = sanitizedOrderList.filter(
    (row) => String(row.shipping_document_type || "").trim() !== SHOPEE_SHIPPING_DOCUMENT_TYPE,
  );
  if (missingType.length > 0) {
    throw new Error(
      `missing_shipping_document_type: ${missingType.map((r) => r.order_sn).join(",")}`,
    );
  }

  const invalidRows = orderList.filter(
    (row) => !String(row?.order_sn || "").trim() || !String(row?.package_number || "").trim(),
  );
  if (invalidRows.length > 0 || sanitizedOrderList.length === 0) {
    throw new Error(
      `missing_package_number: create_shipping_document bị chặn trước khi gọi Shopee (${invalidRows
        .map((row) => String(row?.order_sn || "(missing_order_sn)"))
        .join(",") || "empty_order_list"})`,
    );
  }

  const apiPath = "/api/v2/logistics/create_shipping_document";
  const timestamp = Math.floor(Date.now() / 1000);
  const sign = shopeeSign(apiPath, timestamp, accessToken, shopId);
  const url = `${SHOPEE_HOST}${apiPath}?partner_id=${SHOPEE_PARTNER_ID}&timestamp=${timestamp}&access_token=${accessToken}&shop_id=${shopId}&sign=${sign}`;
  const requestBody = { order_list: sanitizedOrderList };

  console.log(
    `[Shopee API] POST ${apiPath} REQUEST PAYLOAD (có shipping_document_type) shop=${shopId} n=${sanitizedOrderList.length}:`,
    JSON.stringify(requestBody, null, 2),
  );

  let json: any = {};
  try {
    const res = await fetchWithTimeout(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(requestBody),
      signal,
    });
    json = await res.json().catch(() => ({}));
    const resultList: any[] = json?.response?.result_list || json?.result_list || [];
    const failedResultList = resultList.filter(
      (item: any) => String(item?.fail_error || "").trim(),
    );
    // Chỉ log ERROR khi thật sự fail — response thành công thường chỉ echo order_sn/package_number.
    if (failedResultList.length > 0 || json?.error || !res.ok) {
      console.error(
        "SHOPEE DETAIL ERROR (response result_list — KHÔNG phải request payload):",
        JSON.stringify(failedResultList.length > 0 ? failedResultList : resultList, null, 2),
      );
      console.error(
        "SHOPEE CREATE REQUEST WAS:",
        JSON.stringify(requestBody, null, 2),
      );
    }
    console.log(
      `[Shopee API] POST ${apiPath} FULL RESPONSE shop=${shopId} n=${sanitizedOrderList.length} HTTP=${res.status}:`,
      JSON.stringify(json),
    );
    if (!res.ok) {
      throw new Error(
        `create_shipping_document HTTP ${res.status}: ${String(json?.message || json?.error || "Shopee request failed")}`,
      );
    }
    if (json?.error) {
      const failSummary = failedResultList
        .map(
          (item: any) =>
            `${item?.order_sn || "?"}/${item?.package_number || "?"}: ${item?.fail_error || ""} — ${item?.fail_message || ""}`,
        )
        .join(" | ");
      throw new Error(
        `${String(json.error)}: ${String(json?.message || "Shopee từ chối create_shipping_document")}${
          failSummary ? ` | result_list: ${failSummary}` : ""
        }`,
      );
    }
    if (failedResultList.length > 0) {
      console.error(
        `[Shopee API] ${apiPath} package failures=${failedResultList.length}:`,
        JSON.stringify(
          failedResultList.map((item: any) => ({
            order_sn: item?.order_sn,
            package_number: item?.package_number,
            fail_error: item?.fail_error,
            fail_message: item?.fail_message,
          })),
          null,
          2,
        ),
      );
    }
    json.failed_result_list = failedResultList;
    return json;
  } catch (err: any) {
    const resultList: any[] = json?.response?.result_list || json?.result_list || [];
    if (resultList.length > 0) {
      console.error(
        "SHOPEE DETAIL ERROR (response result_list — KHÔNG phải request payload):",
        JSON.stringify(resultList, null, 2),
      );
      console.error("SHOPEE CREATE REQUEST WAS:", JSON.stringify(requestBody, null, 2));
    }
    throw err;
  }
}

// v2.logistics.get_shipping_document_result — 1 lần / request (FE tự poll mỗi 2s).
async function shopeeGetShippingDocumentResult(
  shopId: string,
  accessToken: string,
  orderList: {
    order_sn: string;
    package_number: string;
    shipping_document_type?: string;
  }[],
  signal?: AbortSignal,
) {
  if (orderList.some((row) => !String(row?.package_number || "").trim())) {
    throw new Error("missing_package_number: get_shipping_document_result bị chặn");
  }
  const apiPath = "/api/v2/logistics/get_shipping_document_result";
  const timestamp = Math.floor(Date.now() / 1000);
  const sign = shopeeSign(apiPath, timestamp, accessToken, shopId);
  const url = `${SHOPEE_HOST}${apiPath}?partner_id=${SHOPEE_PARTNER_ID}&timestamp=${timestamp}&access_token=${accessToken}&shop_id=${shopId}&sign=${sign}`;

  // shipping_document_type BẮT BUỘC NORMAL_AIR_WAYBILL trong TỪNG item order_list.
  const pollOrderList = orderList.map((row) => ({
    order_sn: String(row?.order_sn || "").trim(),
    package_number: String(row?.package_number || "").trim(),
    shipping_document_type: SHOPEE_SHIPPING_DOCUMENT_TYPE,
  }));

  const res = await fetchWithTimeout(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ order_list: pollOrderList }),
    signal,
  });
  const json: any = await res.json().catch(() => ({}));
  console.log(
    `[Shopee API] POST ${apiPath} FULL RESPONSE shop=${shopId} n=${pollOrderList.length} HTTP=${res.status}:`,
    JSON.stringify(json),
  );
  return json;
}

// v2.logistics.download_shipping_document — response body IS the raw PDF (binary).
// TUYỆT ĐỐI không log nội dung buffer — chỉ log size/content-type.
async function shopeeDownloadShippingDocument(
  shopId: string,
  accessToken: string,
  orderList: { order_sn: string; package_number: string }[],
  filename: string,
  signal?: AbortSignal,
) {
  if (orderList.some((row) => !String(row?.package_number || "").trim())) {
    throw new Error("missing_package_number: download_shipping_document bị chặn");
  }
  ensureLabelsDir();
  const safe = safeLabelFilename(filename);
  if (!safe) return { error: "invalid_filename", message: "Tên file PDF cache không hợp lệ." };
  const destination = path.join(PDF_DIR, safe);
  const cached = getValidLabelDiskFile(safe);
  if (cached) {
    console.log(`[Shopee API] PDF cache HIT ${safe} (${cached.size} bytes) — bỏ qua download`);
    return {
      filename: safe,
      filePath: cached.filePath,
      size: cached.size,
      contentType: "application/pdf",
      cached: true,
    };
  }

  const apiPath = "/api/v2/logistics/download_shipping_document";
  const timestamp = Math.floor(Date.now() / 1000);
  const sign = shopeeSign(apiPath, timestamp, accessToken, shopId);
  const url = `${SHOPEE_HOST}${apiPath}?partner_id=${SHOPEE_PARTNER_ID}&timestamp=${timestamp}&access_token=${accessToken}&shop_id=${shopId}&sign=${sign}`;

  // shipping_document_type BẮT BUỘC NORMAL_AIR_WAYBILL trong TỪNG item order_list.
  const downloadOrderList = orderList.map((row) => ({
    order_sn: String(row?.order_sn || "").trim(),
    package_number: String(row?.package_number || "").trim(),
    shipping_document_type: SHOPEE_SHIPPING_DOCUMENT_TYPE,
  }));

  console.log(`[Shopee API] Bắt đầu tải PDF batch n=${downloadOrderList.length} shop=${shopId}`);
  const res = await fetchWithTimeout(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ order_list: downloadOrderList }),
    signal,
  }, 60_000);

  const contentType = String(res.headers.get("content-type") || "").toLowerCase();
  console.log(`[Shopee API] POST ${apiPath} n=${orderList.length} HTTP ${res.status} content-type=${contentType || "(empty)"}`);

  if (contentType.includes("application/json") || contentType.includes("text/")) {
    const json: any = await res.json().catch(() => ({}));
    console.log(
      `[Shopee API] ${apiPath} trả JSON lỗi (không phải file): error=${json?.error || ""} message=${String(json?.message || "").slice(0, 200)}`,
    );
    return {
      error: json.error || "download_failed",
      message: json.message || "Shopee không trả về file vận đơn.",
    };
  }

  if (!res.ok || !res.body) {
    return {
      error: "download_failed",
      message: `Shopee download_shipping_document HTTP ${res.status}.`,
    };
  }

  const declaredLength = Number(res.headers.get("content-length") || 0);
  if (declaredLength > SHOPEE_WAYBILL_PDF_MAX_BYTES) {
    return {
      error: "pdf_too_large",
      message: `PDF quá lớn (${declaredLength} bytes).`,
    };
  }

  const tempPath = `${destination}.${process.pid}.${Date.now()}.part`;
  let receivedBytes = 0;
  const limiter = new Transform({
    transform(chunk, _encoding, callback) {
      receivedBytes += chunk.length;
      if (receivedBytes > SHOPEE_WAYBILL_PDF_MAX_BYTES) {
        callback(new Error(`PDF vượt quá ${SHOPEE_WAYBILL_PDF_MAX_BYTES} bytes.`));
        return;
      }
      callback(null, chunk);
    },
  });

  try {
    await pipeline(
      Readable.fromWeb(res.body as any),
      limiter,
      fs.createWriteStream(tempPath, { flags: "wx" }),
    );
    if (receivedBytes < 64) throw new Error(`PDF rỗng hoặc quá nhỏ (${receivedBytes} bytes).`);
    const tempFd = fs.openSync(tempPath, "r");
    try {
      const magic = Buffer.allocUnsafe(4);
      if (fs.readSync(tempFd, magic, 0, 4, 0) !== 4 || magic.toString() !== "%PDF") {
        throw new Error("Dữ liệu tải về không phải PDF hợp lệ.");
      }
    } finally {
      fs.closeSync(tempFd);
    }
    if (fs.existsSync(destination)) fs.unlinkSync(destination);
    fs.renameSync(tempPath, destination);
    console.log(`[Shopee API] ${apiPath} stream OK file=${safe} size=${receivedBytes} bytes`);
  } catch (readErr: any) {
    try {
      if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    } catch {
      /* ignore cleanup */
    }
    console.error(`[Shopee API] ${apiPath} stream thất bại:`, readErr?.message || readErr);
    return { error: "download_read_failed", message: String(readErr?.message || readErr) };
  }

  return {
    filename: safe,
    filePath: destination,
    size: receivedBytes,
    contentType: contentType || "application/pdf",
    cached: false,
  };
}

type ShopeeWaybillOrderRow = {
  order_sn: string;
  package_number: string;
  tracking_number?: string;
  /** Bắt buộc khi gọi create/poll/download — luôn NORMAL_AIR_WAYBILL. */
  shipping_document_type?: string;
};

function shippingDocRowKey(row: { order_sn?: string; package_number?: string }): string {
  return `${String(row?.order_sn || "").trim()}::${String(row?.package_number || "").trim()}`;
}

function isPackageShouldPrintFirstError(error: unknown, message?: unknown): boolean {
  const text = `${String(error || "")} ${String(message || "")}`;
  // Chỉ bắt "should print first" — KHÔNG match trần NORMAL_AIR_WAYBILL (tránh self-heal giả / vòng lặp).
  return /should[_\s-]*print[_\s-]*first/i.test(text);
}

/** Sleep chuẩn Promise — dùng trong vòng poll in đơn. */
const sleepMs = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

type BatchWaybillOptions = {
  deadlineAt?: number;
  signal?: AbortSignal;
};

class PackageShouldPrintFirstError extends Error {
  code = "package_should_print_first";
  constructor(message: string) {
    super(message || "The package should print first");
    this.name = "PackageShouldPrintFirstError";
  }
}

type SingleWaybillResult = {
  success: boolean;
  orderSn: string;
  filename?: string;
  filePath?: string;
  size?: number;
  contentType?: string;
  cached?: boolean;
  error?: string;
  message?: string;
};

/** Lỗi cứng — FE tuyệt đối không auto-retry (không dùng package_should_print_first / timeout). */
function fatalShopeePrintResult(orderSn: string): SingleWaybillResult {
  return {
    success: false,
    orderSn: String(orderSn || "").replace(/^shopee-/i, "").trim(),
    error: "fatal_error",
    message: "Shopee từ chối tạo file. Vui lòng kiểm tra lại trạng thái đơn trên Shopee.",
  };
}

function isShopeeOrderNotFoundError(error: unknown, message?: unknown): boolean {
  const text = `${String(error || "")} ${String(message || "")}`;
  return (
    /not\s*found/i.test(text) ||
    /error_not_found/i.test(text) ||
    /order[_.\s-]*not[_.\s-]*found/i.test(text) ||
    /order_sn.*(invalid|does not exist|không tồn tại)/i.test(text)
  );
}

function isShopeeWrongShopError(error: unknown, message?: unknown): boolean {
  const text = `${String(error || "")} ${String(message || "")}`;
  return (
    /invalid_shop/i.test(text) ||
    /error_shop/i.test(text) ||
    /wrong.?shop/i.test(text) ||
    /sai.?shop/i.test(text) ||
    /error_permission/i.test(text) ||
    /shop_id.*(invalid|mismatch|not.?match|không)/i.test(text) ||
    /(invalid|mismatch).*shop_id/i.test(text)
  );
}

/** API lỗi ≠ đơn hủy. Chỉ log — tuyệt đối không ghi CANCELLED. */
async function markLocalOrdersCancelledForShopeeNotFound(
  orderSns: string[],
  shopId: string,
  reason: string,
): Promise<void> {
  const sns = [
    ...new Set(
      (orderSns || [])
        .map((sn) => String(sn || "").replace(/^shopee-/i, "").trim())
        .filter(Boolean),
    ),
  ];
  if (!sns.length) return;
  const shopKey = String(normalizeShopIdKey(shopId) || shopId || "").trim();
  console.error(
    `[Sync Shop ${shopKey || "-"}] get_order_detail FAIL n=${sns.length}` +
      ` sns=${sns.slice(0, 8).join(",")}${sns.length > 8 ? "…" : ""} reason=${reason}` +
      ` — GIỮ NGUYÊN status DB, KHÔNG đánh CANCELLED`,
  );
  try {
    await markOrdersCancelledAsShopeeNotFoundInStore(sns, {
      shopId: shopKey || undefined,
      reason,
    });
  } catch (err: any) {
    console.error(
      `[Sync Shop ${shopKey || "-"}] log API-error skip-cancel failed:`,
      err?.message || err,
    );
  }
}

/**
 * Luồng lấy PDF 1 đơn — ĐÚNG 5 bước tuyến tính, CẤM nhảy cóc / bỏ Create.
 * B1 cache → B2 (rows đã có package_number) → B3 create(NORMAL_AIR_WAYBILL)
 * → chờ Shopee tiếp nhận → B4 poll READY → B5 download(NORMAL_AIR_WAYBILL).
 * Poll/Download báo "should print first" → Create khẩn cấp (payload ĐỘC LẬP 1 đơn) + sleep(2000) + retry Poll/Download đúng 1 lần.
 * Create khẩn cấp fail / catch → fatal_error (cấm package_should_print_first / timeout).
 */
async function fetchSingleOrderWaybillFromRows(
  shopId: string,
  accessToken: string,
  orderSn: string,
  rows: ShopeeWaybillOrderRow[],
  opts?: BatchWaybillOptions,
): Promise<SingleWaybillResult> {
  const sn = String(orderSn || "").replace(/^shopee-/i, "").trim();
  const filename = `order_${sn}.pdf`;
  ensureLabelsDir();

  // ── BƯỚC 1: LOCAL CACHE ──
  const localPath = path.join(PDF_DIR, filename);
  if (fs.existsSync(localPath)) {
    const cached = getValidLabelDiskFile(filename);
    if (cached) {
      console.log(`[Shopee Print] B1 CACHE HIT ${filename} (${cached.size} bytes)`);
      return {
        success: true,
        orderSn: sn,
        filename: cached.safe,
        filePath: cached.filePath,
        size: cached.size,
        contentType: "application/pdf",
        cached: true,
      };
    }
  }

  // ── BƯỚC 2: package_number bắt buộc (caller đã enrich; thiếu → dừng) ──
  if (!rows.length || rows.some((r) => !String(r.package_number || "").trim())) {
    return {
      success: false,
      orderSn: sn,
      error: "missing_package_number",
      message: "Thiếu kiện hàng",
    };
  }

  const runCreate = async (label: string): Promise<SingleWaybillResult | null> => {
    console.log(
      `[Shopee Print] B3 CREATE ${sn} (${label}) type=${SHOPEE_SHIPPING_DOCUMENT_TYPE} packages=${rows.map((r) => r.package_number).join(",")}`,
    );
    // BẮT BUỘC: mỗi item order_list phải có shipping_document_type = NORMAL_AIR_WAYBILL.
    const order_list = rows.map((r) => ({
      order_sn: String(r.order_sn || "").trim(),
      package_number: String(r.package_number || "").trim(),
      shipping_document_type: SHOPEE_SHIPPING_DOCUMENT_TYPE,
      ...(String(r.tracking_number || "").trim()
        ? { tracking_number: String(r.tracking_number).trim() }
        : {}),
    }));
    const createResult = await shopeeCreateShippingDocument(
      shopId,
      accessToken,
      order_list,
      opts?.signal,
    );
    const createTopError = String(createResult?.error || "").trim();
    if (createTopError) {
      return {
        success: false,
        orderSn: sn,
        error: createTopError,
        message: String(createResult?.message || "Shopee từ chối create_shipping_document"),
      };
    }
    const createList: any[] =
      createResult?.response?.result_list || createResult?.result_list || [];
    const failedCreates = createList.filter((item: any) => String(item?.fail_error || "").trim());
    if (createList.length > 0 && failedCreates.length === createList.length) {
      const first = failedCreates[0];
      return {
        success: false,
        orderSn: sn,
        error: String(first?.fail_error || "create_shipping_document_failed"),
        message: String(first?.fail_message || "Create thất bại"),
      };
    }
    console.log(`[Shopee Print] B3 CREATE OK ${sn}`);
    return null;
  };

  const runPollDownload = async (): Promise<SingleWaybillResult> => {
    // ── BƯỚC 4: POLL READY — tối đa 10 lần, mỗi lần chưa READY thì await sleep(1500) rồi continue ──
    const maxPoll = 10;
    let readyRows: ShopeeWaybillOrderRow[] = [];
    let allReady = false;

    for (let attempt = 1; attempt <= maxPoll; attempt++) {
      console.log(`[Shopee Print] B4 POLL ${sn} lần ${attempt}/${maxPoll}`);

      let pollResult: any;
      try {
        pollResult = await shopeeGetShippingDocumentResult(
          shopId,
          accessToken,
          rows.map((r) => ({
            order_sn: r.order_sn,
            package_number: r.package_number,
            shipping_document_type: SHOPEE_SHIPPING_DOCUMENT_TYPE,
          })),
          opts?.signal,
        );
      } catch (pollErr: any) {
        if (isPackageShouldPrintFirstError(pollErr?.code, pollErr?.message)) {
          throw new PackageShouldPrintFirstError(String(pollErr?.message || pollErr));
        }
        throw pollErr;
      }

      if (isPackageShouldPrintFirstError(pollResult?.error, pollResult?.message)) {
        throw new PackageShouldPrintFirstError(
          String(pollResult?.message || pollResult?.error || "The package should print first"),
        );
      }

      const items: any[] = pollResult?.response?.result_list || pollResult?.result_list || [];
      const byKey = new Map(items.map((it: any) => [shippingDocRowKey(it), it]));
      let attemptReady = true;

      for (const row of rows) {
        const sameOrderItems = items.filter(
          (item: any) => String(item?.order_sn || "").trim() === row.order_sn,
        );
        const it =
          byKey.get(shippingDocRowKey(row)) ||
          (sameOrderItems.length === 1 ? sameOrderItems[0] : undefined);
        const st = String(it?.status || "").toUpperCase();

        if (isPackageShouldPrintFirstError(it?.fail_error, it?.fail_message)) {
          throw new PackageShouldPrintFirstError(
            String(it?.fail_message || it?.fail_error || "The package should print first"),
          );
        }

        if (st !== "READY") {
          attemptReady = false;
          console.log(
            `[Shopee Print] B4 POLL ${sn} chưa READY status=${st || "(empty)"} lần ${attempt}/${maxPoll}`,
          );
          break;
        }
      }

      if (attemptReady) {
        readyRows = rows;
        allReady = true;
        console.log(`[Shopee Print] B4 POLL ${sn} READY ở lần ${attempt}`);
        break;
      }

      if (attempt < maxPoll) {
        await sleepMs(1500);
        continue;
      }
    }

    if (!allReady) {
      return {
        success: false,
        orderSn: sn,
        error: "document_not_ready",
        message: "Shopee chưa tạo xong PDF sau khi đã polling chờ READY",
      };
    }

    // ── BƯỚC 5: DOWNLOAD & LƯU order_${orderSn}.pdf ──
    console.log(`[Shopee Print] B5 DOWNLOAD ${sn} → ${filename}`);
    let downloadResult: any;
    try {
      downloadResult = await shopeeDownloadShippingDocument(
        shopId,
        accessToken,
        readyRows.map((r) => ({
          order_sn: r.order_sn,
          package_number: r.package_number,
          shipping_document_type: SHOPEE_SHIPPING_DOCUMENT_TYPE,
        })),
        filename,
        opts?.signal,
      );
    } catch (dlErr: any) {
      if (isPackageShouldPrintFirstError(dlErr?.code, dlErr?.message)) {
        throw new PackageShouldPrintFirstError(String(dlErr?.message || dlErr));
      }
      throw dlErr;
    }

    if (isPackageShouldPrintFirstError(downloadResult?.error, downloadResult?.message)) {
      throw new PackageShouldPrintFirstError(
        String(downloadResult?.message || downloadResult?.error || "The package should print first"),
      );
    }
    if (!downloadResult?.filePath || !downloadResult?.filename || !downloadResult?.size) {
      return {
        success: false,
        orderSn: sn,
        error: downloadResult?.error || "download_failed",
        message: downloadResult?.message || "Không tải được PDF.",
      };
    }

    console.log(`[Shopee Print] B5 OK ${sn} size=${downloadResult.size}`);
    return {
      success: true,
      orderSn: sn,
      filename: downloadResult.filename,
      filePath: downloadResult.filePath,
      size: downloadResult.size,
      contentType: downloadResult.contentType || "application/pdf",
      cached: false,
    };
  };

  // B3 CREATE lần đầu (NORMAL_AIR_WAYBILL) — BẮT BUỘC trước Poll/Download; chờ 2s để Shopee tiếp nhận.
  const createFail = await runCreate("lần 1");
  if (createFail) {
    const errCode = String(createFail.error || "");
    if (
      errCode === "package_should_print_first" ||
      errCode === "fatal_error" ||
      /timeout/i.test(errCode) ||
      isPackageShouldPrintFirstError(createFail.error, createFail.message)
    ) {
      return fatalShopeePrintResult(sn);
    }
    return createFail;
  }
  console.log(
    `[Shopee Print] B3→B4 ${sn} đã create ${SHOPEE_SHIPPING_DOCUMENT_TYPE}, chờ Shopee tiếp nhận 2s rồi poll`,
  );
  await sleep(2000);

  // B4+B5: Poll/Download + self-heal Create khẩn cấp ĐÚNG 1 lần (không for(;;) vô hạn).
  // Create khẩn cấp fail / catch → fatal_error (cấm package_should_print_first / timeout).
  let selfHealUsed = false;
  try {
    return await runPollDownload();
  } catch (error: any) {
    const errText = `${String(error?.code || "")} ${String(error?.message || error || "")}`;
    const shouldSelfHeal =
      !selfHealUsed &&
      (error instanceof PackageShouldPrintFirstError ||
        isPackageShouldPrintFirstError(error?.code, error?.message) ||
        isPackageShouldPrintFirstError(errText, ""));

    if (!shouldSelfHeal) {
      console.error(
        `[Shopee Print] HARD STOP ${sn} (không self-heal):`,
        error?.message || error,
      );
      return fatalShopeePrintResult(sn);
    }

    selfHealUsed = true;
    console.warn(`Phát hiện lỗi chưa Create, tiến hành gọi Create khẩn cấp cho ${sn}`);

    // CÁCH LY: payload ĐỘC LẬP chỉ đúng 1 đơn hiện tại — KHÔNG tái dùng order_list batch.
    const healOrderList = rows
      .filter((r) => String(r.order_sn || "").replace(/^shopee-/i, "").trim() === sn)
      .map((r) => {
        const package_number = String(r.package_number || "").trim();
        const tracking_number = String(r.tracking_number || "").trim();
        return {
          order_sn: sn,
          package_number,
          shipping_document_type: SHOPEE_SHIPPING_DOCUMENT_TYPE,
          ...(tracking_number &&
          !/^0FG/i.test(tracking_number) &&
          !isShopeeInternalTrackingCode(tracking_number)
            ? { tracking_number }
            : {}),
        };
      })
      .filter((r) => r.order_sn && r.package_number);

    if (healOrderList.length === 0) {
      console.error(`[Shopee Print] Create khẩn cấp FAIL ${sn}: empty isolated payload`);
      return fatalShopeePrintResult(sn);
    }

    try {
      console.log(
        `[Shopee Print] B3 CREATE ${sn} (khẩn cấp self-heal #1) ISOLATED n=${healOrderList.length}:`,
        JSON.stringify({ order_list: healOrderList }),
      );
      const healCreateResult = await shopeeCreateShippingDocument(
        shopId,
        accessToken,
        healOrderList,
        opts?.signal,
      );
      const healTopError = String(healCreateResult?.error || "").trim();
      const healList: any[] =
        healCreateResult?.response?.result_list || healCreateResult?.result_list || [];
      const healFailed = healList.filter((item: any) => String(item?.fail_error || "").trim());
      if (
        healTopError ||
        (healList.length > 0 && healFailed.length === healList.length)
      ) {
        console.error(
          `[Shopee Print] Create khẩn cấp FAIL ${sn} — dừng luồng in đơn:`,
          healTopError || healFailed[0]?.fail_error || "create_shipping_document_failed",
        );
        return fatalShopeePrintResult(sn);
      }
    } catch (createErr: any) {
      console.error(
        `[Shopee Print] Create khẩn cấp FAIL ${sn} — dừng luồng in đơn:`,
        createErr?.message || createErr,
      );
      return fatalShopeePrintResult(sn);
    }

    await sleep(2000);

    // Create OK → Poll/Download đúng 1 lần nữa. Hết — KHÔNG self-heal thêm; lỗi → fatal_error.
    try {
      return await runPollDownload();
    } catch (retryErr: any) {
      console.error(
        `[Shopee Print] HARD STOP ${sn} sau Create khẩn cấp:`,
        retryErr?.message || retryErr,
      );
      return fatalShopeePrintResult(sn);
    }
  }
}

/**
 * Batch waybill — xử lý TỪNG ĐƠN theo 5 bước tuyến tính (không nhảy cóc, không skipCreate).
 */
async function batchDownloadShopeeWaybillPdf(
  shopId: string,
  orderList: ShopeeWaybillOrderRow[],
  opts?: BatchWaybillOptions,
): Promise<{
  success: boolean;
  filename?: string;
  filePath?: string;
  size?: number;
  contentType?: string;
  readyOrderSns: string[];
  readyOrderRows?: ShopeeWaybillOrderRow[];
  skippedOrders: Array<{ orderSn: string; error: string; message: string }>;
  error?: string;
  message?: string;
}> {
  const emptySkip: Array<{ orderSn: string; error: string; message: string }> = [];
  try {
    if (!orderList.length) {
      return {
        success: false,
        readyOrderSns: [],
        skippedOrders: emptySkip,
        error: "empty_order_list",
        message: "Không có đơn nào để tạo vận đơn hàng loạt.",
      };
    }

    let accessToken: string;
    try {
      accessToken = (await getValidShopeeAccessToken(shopId)) || "";
      if (!accessToken) {
        const fail = describeShopeeTokenFailure(shopId);
        return {
          success: false,
          readyOrderSns: [],
          skippedOrders: emptySkip,
          error: fail.error,
          message: fail.message,
        };
      }
    } catch (err: any) {
      const code = err instanceof ShopeeRefreshTokenExpiredError ? err.code : "token_error";
      return {
        success: false,
        readyOrderSns: [],
        skippedOrders: emptySkip,
        error: code,
        message: String(err?.message || err),
      };
    }

    const enriched = orderList
      .map((row) => {
        const entry: Partial<ShopeeWaybillOrderRow> = {
          order_sn: String(row.order_sn || "").trim(),
          shipping_document_type: SHOPEE_SHIPPING_DOCUMENT_TYPE,
        };
        const pkg = String(row.package_number || "").trim();
        const tn = String(row.tracking_number || "").trim();
        if (pkg) entry.package_number = pkg;
        if (tn && !/^0FG/i.test(tn) && !isShopeeInternalTrackingCode(tn)) {
          entry.tracking_number = tn;
        }
        return entry;
      })
      .filter(
        (r): r is ShopeeWaybillOrderRow =>
          Boolean(String(r.order_sn || "").trim() && String(r.package_number || "").trim()),
      );

    if (enriched.length !== orderList.length) {
      const missing = orderList
        .filter((row) => !String(row?.package_number || "").trim())
        .map((row) => String(row?.order_sn || "(missing_order_sn)"));
      return {
        success: false,
        readyOrderSns: [],
        skippedOrders: missing.map((orderSn) => ({
          orderSn,
          error: "missing_package_number",
          message: "Thiếu kiện hàng",
        })),
        error: "missing_package_number",
        message: `Thiếu kiện hàng: ${missing.join(", ")}`,
      };
    }

    const byOrder = new Map<string, ShopeeWaybillOrderRow[]>();
    for (const row of enriched) {
      const list = byOrder.get(row.order_sn) || [];
      list.push(row);
      byOrder.set(row.order_sn, list);
    }

    const readyOrderSns: string[] = [];
    const readyOrderRows: ShopeeWaybillOrderRow[] = [];
    const skippedOrders: Array<{ orderSn: string; error: string; message: string }> = [];
    let lastOk: SingleWaybillResult | null = null;

    for (const [sn, rows] of byOrder) {
      try {
        const result = await fetchSingleOrderWaybillFromRows(shopId, accessToken, sn, rows, opts);
        if (result.success && result.filename && result.filePath) {
          readyOrderSns.push(sn);
          readyOrderRows.push(...rows);
          lastOk = result;
        } else {
          skippedOrders.push({
            orderSn: sn,
            error: result.error || "waybill_failed",
            message: result.message || "Lấy PDF thất bại",
          });
        }
      } catch (orderErr: any) {
        // Create khẩn cấp / lỗi cứng → dừng đúng 1 đơn, không kéo sập cả batch.
        // Cấm package_should_print_first / timeout — trả fatal_error để FE không retry.
        skippedOrders.push({
          orderSn: sn,
          error: "fatal_error",
          message:
            "Shopee từ chối tạo file. Vui lòng kiểm tra lại trạng thái đơn trên Shopee.",
        });
        console.error(
          `[Shopee Batch Waybill] HARD STOP ${sn}:`,
          orderErr?.message || orderErr,
        );
      }
    }

    if (!lastOk || readyOrderSns.length === 0) {
      const first = skippedOrders[0];
      return {
        success: false,
        readyOrderSns: [],
        skippedOrders,
        error: first?.error || "waybill_failed",
        message: first?.message || "Không lấy được PDF nào.",
      };
    }

    return {
      success: true,
      filename: lastOk.filename,
      filePath: lastOk.filePath,
      size: lastOk.size,
      contentType: lastOk.contentType || "application/pdf",
      readyOrderSns,
      readyOrderRows,
      skippedOrders,
    };
  } catch (fatal: any) {
    console.error(`[Shopee Batch Waybill] FATAL:`, fatal?.stack || fatal);
    return {
      success: false,
      readyOrderSns: [],
      skippedOrders: emptySkip,
      error: "batch_fatal",
      message: String(fatal?.message || fatal),
    };
  }
}

// Normalize one line item from Shopee order item_list (includes variation/model fields).
function extractShopeeOrderModelName(it: any): string | undefined {
  const directCandidates = [
    it.model_name,
    it.variation_name,
    it.model_display_name,
    it.item_model_name,
    it.sku_model_name,
  ];
  for (const c of directCandidates) {
    const s = String(c || "").trim();
    if (s) return s;
  }

  const tierParts: string[] = [];
  const tierSources = [
    it.model_tier_variation,
    it.tier_variation,
    it.standardise_tier_variation,
  ];
  for (const src of tierSources) {
    if (!Array.isArray(src)) continue;
    for (const tier of src) {
      if (typeof tier === "string" && tier.trim()) tierParts.push(tier.trim());
      else if (tier?.option) tierParts.push(String(tier.option).trim());
      else if (tier?.variation_option_name) tierParts.push(String(tier.variation_option_name).trim());
    }
  }
  if (tierParts.length > 0) return tierParts.join(" / ");

  if (Array.isArray(it.variation_list)) {
    const parts = it.variation_list
      .map((v: any) => String(v?.variation_name || v?.option || v?.name || "").trim())
      .filter(Boolean);
    if (parts.length > 0) return parts.join(" / ");
  }

  return undefined;
}

function extractShopeeOrderModelId(it: any): string {
  const candidates = [it.model_id, it.variation_id, it.modelId, it.variationId];
  for (const raw of candidates) {
    if (raw != null && raw !== "" && Number(raw) !== 0) {
      return String(raw);
    }
  }
  return "0";
}

function extractShopeeOrderModelSku(it: any): string | undefined {
  const candidates = [
    it.model_sku,
    it.variation_sku,
    it.item_sku,
    it.sku,
    it.modelSku,
    it.variationSku,
  ];
  for (const raw of candidates) {
    const s = String(raw || "").trim();
    if (s) return s;
  }
  return undefined;
}

function extractShopeeOrderTierIndex(it: any): number[] | undefined {
  const raw = it?.tier_index ?? it?.tierIndex;
  if (!Array.isArray(raw)) return undefined;
  const tierIndex = raw
    .map((value: unknown) => Number(value))
    .filter((value: number) => Number.isInteger(value) && value >= 0);
  return tierIndex.length > 0 ? tierIndex : undefined;
}

/** Map thô Shopee order_status → tab nội bộ (API v2.2.9). */
const SHOPEE_ORDER_STATUS_MAP: Record<string, string> = {
  UNPAID: "pending_confirm",
  PENDING: "pending_confirm",
  IN_REVIEW: "pending_confirm",
  FRAUD_CHECK: "pending_confirm",
  INVOICE_PENDING: "pending_confirm",
  READY_TO_SHIP: "unprocessed",
  PROCESSED: "processed",
  RETRY_SHIP: "unprocessed",
  SHIPPED: "shipping",
  TO_CONFIRM_RECEIVE: "shipping",
  IN_CANCEL: "cancelled",
  CANCELLED: "cancelled",
  TO_RETURN: "return_pending",
  COMPLETED: "completed",
};

/**
 * logistics_status Shopee = ĐVVC đã lấy hàng / đang vận chuyển.
 * App Shopee quét "Giao cho đơn vị vận chuyển" thường cập nhật logistics TRƯỚC order_status.
 */
function isLogisticsHandedToCarrier(logisticsStatus?: string | null): boolean {
  const s = String(logisticsStatus || "").toUpperCase();
  if (!s) return false;
  if (s.includes("FAILED") || s.includes("CANCEL") || s.includes("RETURN")) return false;
  return (
    s.includes("PICKUP_DONE") ||
    s.includes("LOGISTICS_SHIPPED") ||
    s === "LOGISTICS_SHIPPED" ||
    s.includes("LOGISTICS_DELIVERY_DONE") ||
    s.includes("DELIVERY_DONE") ||
    s.includes("IN_TRANSIT") ||
    s.includes("TRANSPORTING") ||
    s.includes("LOGISTICS_PICKUP_DONE")
  );
}

/**
 * Khi logistics đã PICKUP_DONE/SHIPPED mà order_status còn PROCESSED/RTS —
 * promote raw → SHIPPED để tab Đang giao (SSOT UI) nhận đơn.
 */
function promoteRawStatusFromLogistics(
  order: any,
  logisticsStatus?: string | null,
): boolean {
  if (!order || !isLogisticsHandedToCarrier(logisticsStatus ?? order.logistics_status)) {
    return false;
  }
  const raw = String(order.shopee_order_status || "").toUpperCase();
  if (
    raw === "COMPLETED" ||
    raw === "CANCELLED" ||
    raw === "IN_CANCEL" ||
    raw === "TO_RETURN" ||
    raw === "SHIPPED" ||
    raw === "TO_CONFIRM_RECEIVE"
  ) {
    if (raw === "SHIPPED" || raw === "TO_CONFIRM_RECEIVE") {
      order.status = "shipping";
      order.isPrepared = true;
      order.is_pending_shopee_check = false;
    }
    return raw === "SHIPPED" || raw === "TO_CONFIRM_RECEIVE";
  }
  if (
    !raw ||
    raw === "READY_TO_SHIP" ||
    raw === "RETRY_SHIP" ||
    raw === "PROCESSED" ||
    raw === "UNPAID" ||
    raw === "PENDING"
  ) {
    const prev = raw || "(empty)";
    order.shopee_order_status = "SHIPPED";
    order.status = "shipping";
    order.isPrepared = true;
    order.is_pending_shopee_check = false;
    console.log(
      `[StateMachine] logistics→SHIPPED order_sn=${order.orderSn || "?"} prev_raw=${prev} logistics=${String(logisticsStatus || order.logistics_status || "")}`,
    );
    return true;
  }
  return false;
}

/**
 * Ánh xạ trạng thái Shopee API v2.2.9 → tab quản lý nội bộ.
 * - UNPAID/PENDING → Chờ xác nhận
 * - READY_TO_SHIP → Chưa xử lý / Đã xử lý (theo tracking)
 * - SHIPPED / TO_CONFIRM_RECEIVE / logistics PICKUP_DONE → Đang giao
 * - COMPLETED → Thành công
 */
function mapShopeeStatusToLocal(
  rawStatus: string,
  opts?: { hasTracking?: boolean; logisticsStatus?: string },
): string {
  const raw = String(rawStatus || "").toUpperCase();

  if (raw === "SHIPPED" || raw === "TO_CONFIRM_RECEIVE") return "shipping";
  if (raw === "COMPLETED") return "completed";
  // Carrier scan: logistics đã lấy hàng dù order_status còn PROCESSED/RTS.
  if (
    isLogisticsHandedToCarrier(opts?.logisticsStatus) &&
    (raw === "PROCESSED" ||
      raw === "READY_TO_SHIP" ||
      raw === "RETRY_SHIP" ||
      !raw)
  ) {
    return "shipping";
  }
  if (raw === "PROCESSED") return "processed";
  if (raw === "READY_TO_SHIP" || raw === "RETRY_SHIP") {
    return opts?.hasTracking ? "processed" : "unprocessed";
  }
  if (
    raw === "UNPAID" ||
    raw === "PENDING" ||
    raw === "IN_REVIEW" ||
    raw === "FRAUD_CHECK" ||
    raw === "INVOICE_PENDING"
  ) {
    return "pending_confirm";
  }
  if (raw === "CANCELLED" || raw === "IN_CANCEL") return "cancelled";
  if (raw === "TO_RETURN") return "return_pending";
  return SHOPEE_ORDER_STATUS_MAP[raw] || "unprocessed";
}

function extractShopeeWithholdingCitTax(source: any): number {
  const income = source?.order_income || source?.orderIncome || source;
  const raw = income?.withholding_cit_tax ?? source?.withholding_cit_tax ?? source?.withholdingCitTax;
  return Math.max(0, Number(raw) || 0);
}

function extractShopeeEscrowAmount(source: any): number | undefined {
  const payload = source?.response ?? source;
  const income = payload?.order_income || payload?.orderIncome || payload;
  const details = payload?.income_details || payload?.incomeDetails || income?.income_details || {};
  const raw =
    details?.escrow_amount ??
    income?.escrow_amount ??
    payload?.escrow_amount ??
    source?.escrow_amount ??
    source?.escrowAmount;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.round(n) : undefined;
}

function shopeeEscrowNum(raw: unknown): number {
  const n = Number(raw);
  return Number.isFinite(n) ? n : 0;
}

function shopeeEscrowPos(raw: unknown): number {
  const n = shopeeEscrowNum(raw);
  return n > 0 ? Math.round(n) : 0;
}

/** Map order_income + income_details từ get_escrow_detail — không tính thủ công 12%. */
function extractShopeeEscrowFinance(source: any): {
  itemAmount?: number;
  escrowAmount?: number;
  withholdingCitTax: number;
  shopeeFees: Record<string, number>;
  escrowSynced: boolean;
} {
  const payload = source?.response ?? source;
  const income = payload?.order_income || payload?.orderIncome || {};
  const details = payload?.income_details || payload?.incomeDetails || income?.income_details || {};

  const itemAmountRaw =
    details?.item_amount ??
    income?.cost_of_goods_sold ??
    income?.original_cost_of_goods_sold ??
    income?.order_selling_price ??
    income?.order_original_price;
  let itemAmount = shopeeEscrowPos(itemAmountRaw) || undefined;
  const sellerVoucher = shopeeEscrowPos(
    details?.voucher_from_seller ??
      income?.voucher_from_seller ??
      details?.seller_voucher ??
      income?.seller_voucher,
  );
  // Nếu thiếu item_amount nhưng có order_original_price: Base = gốc − mã Shop (không trừ Shopee Voucher).
  if (itemAmount == null) {
    const originalGoods = shopeeEscrowPos(
      income?.order_original_price ?? income?.original_price ?? details?.order_original_price,
    );
    if (originalGoods > 0) {
      itemAmount = Math.max(0, originalGoods - sellerVoucher) || undefined;
    }
  }

  const commissionFee = shopeeEscrowPos(details?.commission_fee ?? income?.commission_fee);
  const serviceFee = shopeeEscrowPos(details?.service_fee ?? income?.service_fee);
  const sellerTransactionFee = shopeeEscrowPos(details?.seller_transaction_fee ?? income?.seller_transaction_fee);
  const transactionFee = shopeeEscrowPos(
    details?.transaction_fee ??
      income?.transaction_fee ??
      income?.seller_transaction_fee ??
      details?.seller_transaction_fee,
  );
  const creditCardTransactionFee = shopeeEscrowPos(
    details?.credit_card_transaction_fee ?? income?.credit_card_transaction_fee,
  );
  const resolvedTransactionFee = sellerTransactionFee || transactionFee || creditCardTransactionFee;

  const commissionFeeTax = shopeeEscrowPos(details?.commission_fee_tax ?? income?.commission_fee_tax);
  const serviceFeeTax = shopeeEscrowPos(details?.service_fee_tax ?? income?.service_fee_tax);
  const transactionFeeTax = shopeeEscrowPos(details?.transaction_fee_tax ?? income?.transaction_fee_tax);
  const withholdingVatTax = shopeeEscrowPos(details?.withholding_vat_tax ?? income?.withholding_vat_tax);
  const withholdingPitTax = shopeeEscrowPos(details?.withholding_pit_tax ?? income?.withholding_pit_tax);
  const withholdingCitTax = shopeeEscrowPos(
    details?.withholding_cit_tax ?? income?.withholding_cit_tax ?? income?.withholdingCitTax,
  );
  const feeTaxTotal = commissionFeeTax + serviceFeeTax + transactionFeeTax;
  const withholdingTotal = withholdingVatTax + withholdingPitTax + withholdingCitTax;
  const totalTax = feeTaxTotal > 0 ? feeTaxTotal : withholdingTotal;

  const escrowAmount = extractShopeeEscrowAmount(payload);

  const fees: Record<string, number> = {};
  const setFee = (key: string, value: number) => {
    if (value > 0) fees[key] = value;
  };
  if (itemAmount != null) setFee("item_amount", itemAmount);
  if (sellerVoucher > 0) setFee("voucher_from_seller", sellerVoucher);
  setFee("commission_fee", commissionFee);
  setFee("service_fee", serviceFee);
  if (sellerTransactionFee > 0) setFee("seller_transaction_fee", sellerTransactionFee);
  if (transactionFee > 0) setFee("transaction_fee", transactionFee);
  else if (resolvedTransactionFee > 0) setFee("transaction_fee", resolvedTransactionFee);
  if (creditCardTransactionFee > 0) setFee("credit_card_transaction_fee", creditCardTransactionFee);
  setFee("commission_fee_tax", commissionFeeTax);
  setFee("service_fee_tax", serviceFeeTax);
  setFee("transaction_fee_tax", transactionFeeTax);
  setFee("withholding_vat_tax", withholdingVatTax);
  setFee("withholding_pit_tax", withholdingPitTax);
  setFee("withholding_cit_tax", withholdingCitTax);
  if (totalTax > 0) fees.total_tax = Math.round(totalTax);

  const totalSurcharge = commissionFee + serviceFee + resolvedTransactionFee;
  if (totalSurcharge > 0) fees.total_surcharge = Math.round(totalSurcharge);
  if (escrowAmount != null) fees.escrow_amount = escrowAmount;

  const escrowSynced =
    escrowAmount != null ||
    totalSurcharge > 0 ||
    totalTax > 0 ||
    (itemAmount != null && itemAmount > 0);

  return {
    itemAmount,
    escrowAmount,
    withholdingCitTax: withholdingCitTax || extractShopeeWithholdingCitTax(payload),
    shopeeFees: fees,
    escrowSynced,
  };
}

function computeShopeeOrderRevenue(escrowAmount?: number, customCosts = 0): number {
  if (escrowAmount == null || !Number.isFinite(Number(escrowAmount))) return 0;
  const costs = Math.max(0, Number(customCosts) || 0);
  return Math.max(0, Math.round(Number(escrowAmount) - costs));
}

function sumOrderCustomCosts(order: any): number {
  const items = Array.isArray(order?.custom_cost_items) ? order.custom_cost_items : [];
  if (items.length > 0) {
    return Math.round(
      items.reduce((sum: number, row: any) => sum + Math.max(0, Number(row?.amount) || 0), 0),
    );
  }
  return Math.max(0, Number(order?.custom_costs) || 0);
}

/**
 * Base Amount tính % phí = Tổng SP (giá gốc × SL) − mã giảm giá Shop.
 * Không dùng total_amount / totalAmount (đã trừ Shopee Voucher).
 */
function extractSellerVoucherAmount(...sources: any[]): number {
  for (const src of sources) {
    if (!src || typeof src !== "object") continue;
    const n = Number(
      src.voucher_from_seller ??
        src.seller_voucher ??
        src.seller_order_voucher ??
        src.voucher_from_seller_amount,
    );
    if (Number.isFinite(n) && n > 0) return Math.round(n);
  }
  return 0;
}

function resolveShopeeFeeBaseAmount(order: any, detail?: any): number {
  const sellerVoucher = extractSellerVoucherAmount(
    order,
    order?.shopee_fees,
    detail,
    detail?.estimated_income,
    detail?.estimatedIncome,
    detail?.order_income,
    detail?.income_details,
  );

  const sumFromRawItems = (itemList: any[]): number => {
    if (!Array.isArray(itemList) || itemList.length === 0) return 0;
    return itemList.reduce((sum: number, it: any) => {
      const purchased = Math.max(0, shopeeItemPurchasedQty(it));
      const cancelled = shopeeItemCancelledQty(it);
      const qty = Math.max(0, purchased - cancelled);
      if (qty <= 0) return sum;
      const original = Math.max(0, Number(it?.model_original_price) || 0);
      const discounted = Math.max(
        0,
        Number(it?.model_discounted_price || it?.model_original_price || it?.item_price) || 0,
      );
      // Đơn giá SP: giá sau KM shop/flash; thiếu thì dùng original.
      const unit = discounted > 0 ? discounted : original;
      return sum + unit * qty;
    }, 0);
  };

  const sumFromMappedItems = (items: any[]): number => {
    if (!Array.isArray(items) || items.length === 0) return 0;
    return items.reduce((sum: number, it: any) => {
      const qty = Math.max(0, Number(it?.quantity) || 0);
      const original = Math.max(0, Number(it?.originalPrice) || 0);
      const discounted = Math.max(0, Number(it?.price) || 0);
      const unit = discounted > 0 ? discounted : original;
      return sum + unit * qty;
    }, 0);
  };

  const rawList = Array.isArray(detail?.item_list) ? detail.item_list : [];
  const merchandise =
    sumFromRawItems(rawList) ||
    sumFromMappedItems(Array.isArray(order?.items) ? order.items : []);
  const fromItems = Math.max(0, Math.round(merchandise - sellerVoucher));
  if (fromItems > 0) return fromItems;

  const income =
    detail?.estimated_income ||
    detail?.estimatedIncome ||
    detail?.order_income ||
    detail?.income_details ||
    {};
  const fromIncome = Math.max(
    0,
    Number(
      income?.item_amount ??
        income?.cost_of_goods_sold ??
        income?.original_cost_of_goods_sold ??
        income?.order_selling_price ??
        income?.order_original_price,
    ) || 0,
  );
  if (fromIncome > 0) return Math.round(fromIncome);

  const stored = Math.max(
    0,
    Number(order?.item_amount || order?.shopee_fees?.item_amount) || 0,
  );
  const totalAmount = Math.max(0, Number(order?.totalAmount) || 0);
  // Từ chối fallback totalAmount (buyer paid sau Shopee Voucher).
  if (stored > 0 && !(totalAmount > 0 && stored === totalAmount)) return Math.round(stored);
  return 0;
}

function computeProvisionalShopeeRevenue(order: any, customCosts = 0): number {
  const itemAmount = resolveShopeeFeeBaseAmount(order);
  const estimatedItems = Array.isArray(order?.estimated_fee_items) ? order.estimated_fee_items : [];
  const dynamicFeeTotal =
    estimatedItems.length > 0
      ? estimatedItems.reduce((sum: number, fee: any) => sum + Math.max(0, Number(fee?.amount) || 0), 0)
      : 0;
  const shopeeFee =
    dynamicFeeTotal > 0
      ? dynamicFeeTotal
      : Math.max(0, Number(order?.shopee_fees?.total_surcharge) || 0);
  const tax = Math.max(0, Number(order?.shopee_fees?.total_tax) || 0);
  return Math.max(0, Math.round(itemAmount - shopeeFee - tax - Math.max(0, Number(customCosts) || 0)));
}

function getShopeeDefaultFeeRate(): number {
  const configured = Number(loadChannelSettings()?.shopeeDefaultFeeRate);
  return Number.isFinite(configured) ? Math.min(100, Math.max(0, configured)) : 12;
}

function getGlobalPackagingCostPerOrder(): number {
  // Chi phí đóng gói hiện được đưa vào systemFees để cùng hiển thị/tính toán
  // với các khoản phí động; không cộng thêm một lần nữa theo từng đơn.
  return 0;
}

function getActiveSystemFees(): Array<{
  id: string;
  name: string;
  calculationType: "percentage" | "fixed";
  value: number;
  active: boolean;
}> {
  const settings = loadChannelSettings();
  const configured = settings?.systemFees;
  const normalized = Array.isArray(configured)
    ? configured
    .map((fee: any, index: number) => ({
      id: String(fee?.id || `system-fee-${index}`),
      name: String(fee?.name || "").trim(),
      calculationType: fee?.calculationType === "percentage" ? "percentage" : "fixed",
      value: Math.max(0, Number(fee?.value) || 0),
      active: fee?.active !== false,
    }))
    .filter((fee: any) => fee.active && fee.name && fee.value > 0)
    : [];
  if (normalized.length > 0) return normalized;

  const legacyPackagingCost = Math.max(0, Number(settings?.packagingCostPerOrder) || 0);
  return legacyPackagingCost > 0
    ? [{
        id: "legacy-packaging-cost",
        name: "Chi phí vận hành/đóng gói",
        calculationType: "fixed" as const,
        value: legacyPackagingCost,
        active: true,
      }]
    : [];
}

function calculateSystemFeeEstimate(itemAmount: number) {
  const base = Math.max(0, Number(itemAmount) || 0);
  const items = getActiveSystemFees().map((fee) => ({
    ...fee,
    amount:
      fee.calculationType === "percentage"
        ? Math.round((base * fee.value) / 100)
        : Math.round(fee.value),
  }));
  const total = items.reduce((sum, fee) => sum + fee.amount, 0);
  console.log(
    `[Order Finance] Dynamic fees base=${base}:`,
    JSON.stringify({ items, total }),
  );
  return { items, total };
}

/** Lấy số liệu ước tính từ get_order_detail; nếu Shopee chưa trả thì dùng tỷ lệ cấu hình. */
function applyShopeeEstimatedFinance(order: any, detail: any): void {
  const estimatedIncome =
    detail?.estimated_income ??
    detail?.estimatedIncome ??
    detail?.income_details ??
    detail?.order_income ??
    {};
  const extracted = extractShopeeEscrowFinance({ order_income: estimatedIncome });
  const sellerVoucher = extractSellerVoucherAmount(
    order,
    extracted.shopeeFees,
    detail,
    estimatedIncome,
  );
  if (sellerVoucher > 0) {
    order.seller_voucher = sellerVoucher;
  }
  // Base = SP gốc − mã Shop; tuyệt đối không lấy totalAmount (đã trừ Shopee Voucher).
  const itemAmount =
    extracted.itemAmount ||
    resolveShopeeFeeBaseAmount(order, detail) ||
    0;
  const fees = { ...extracted.shopeeFees };
  delete fees.escrow_amount;
  if (itemAmount > 0) fees.item_amount = itemAmount;
  if (sellerVoucher > 0) fees.voucher_from_seller = sellerVoucher;

  const hasApiFees = Number(fees.total_surcharge) > 0 || Number(fees.total_tax) > 0;
  if (!hasApiFees) {
    const dynamicEstimate = calculateSystemFeeEstimate(itemAmount);
    const defaultRate = getShopeeDefaultFeeRate();
    fees.total_surcharge =
      dynamicEstimate.total > 0
        ? dynamicEstimate.total
        : Math.round((itemAmount * defaultRate) / 100);
    fees.default_fee_rate = defaultRate;
    fees.is_estimated = 1;
    order.estimated_fee_items =
      dynamicEstimate.items.length > 0
        ? dynamicEstimate.items
        : [{
            id: "legacy-shopee-default-fee",
            name: "Phí Shopee mặc định",
            amount: fees.total_surcharge,
            calculationType: "percentage",
            value: defaultRate,
          }];
  } else {
    fees.is_estimated = 1;
    order.estimated_fee_items = [];
  }

  applyShopeeOrderFinanceFields(order, {
    totalAmount: order.totalAmount,
    itemAmount,
    withholdingCitTax: extracted.withholdingCitTax,
    shopeeFees: fees,
    escrowSynced: false,
    customCosts: getGlobalPackagingCostPerOrder(),
    financeSource: hasApiFees ? "estimated_api" : "estimated_default",
  });
}

function applyShopeeOrderFinanceFields(
  order: any,
  opts: {
    totalAmount?: number;
    itemAmount?: number;
    withholdingCitTax?: number;
    escrowAmount?: number;
    shopeeFees?: Record<string, number>;
    escrowSynced?: boolean;
    customCosts?: number;
    financeSource?: "estimated_api" | "estimated_default" | "escrow";
  },
): void {
  const totalAmount = Number(opts.totalAmount ?? order.totalAmount ?? 0);
  const withholdingCitTax = Math.max(0, Number(opts.withholdingCitTax ?? order.withholdingCitTax ?? 0));
  const customCosts = Math.max(0, Number(opts.customCosts ?? getGlobalPackagingCostPerOrder()));
  const escrowAmount = opts.escrowAmount ?? order.escrowAmount;

  order.totalAmount = totalAmount;
  order.withholdingCitTax = withholdingCitTax;
  order.withholding_cit_tax = withholdingCitTax;
  order.custom_costs = customCosts;

  if (opts.itemAmount != null && Number(opts.itemAmount) > 0) {
    order.item_amount = Number(opts.itemAmount);
  } else if (opts.shopeeFees?.item_amount != null && Number(opts.shopeeFees.item_amount) > 0) {
    order.item_amount = Number(opts.shopeeFees.item_amount);
  }

  const sellerVoucher = extractSellerVoucherAmount(order, opts.shopeeFees);
  if (sellerVoucher > 0) {
    order.seller_voucher = sellerVoucher;
  }

  if (escrowAmount != null && Number.isFinite(Number(escrowAmount))) {
    order.escrowAmount = Number(escrowAmount);
  }

  if (opts.shopeeFees && Object.keys(opts.shopeeFees).length > 0) {
    order.shopee_fees = opts.shopeeFees;
  }

  if (opts.escrowSynced != null) {
    order.escrow_synced = Boolean(opts.escrowSynced);
  }
  if (opts.financeSource) {
    order.finance_source = opts.financeSource;
  }

  if (order.escrow_synced && order.escrowAmount != null && Number.isFinite(Number(order.escrowAmount))) {
    order.revenue = computeShopeeOrderRevenue(order.escrowAmount, customCosts);
  } else {
    order.revenue = computeProvisionalShopeeRevenue(order, customCosts);
  }
}

function shopeeItemCancelledQty(it: any): number {
  return Math.max(0, Number(it?.cancelled_qty ?? it?.cancelledQty) || 0);
}

function shopeeItemCancelRequestedQty(it: any): number {
  return Math.max(0, Number(it?.cancel_requested_qty ?? it?.cancelRequestedQty) || 0);
}

function shopeeItemPurchasedQty(it: any): number {
  return Math.max(0, Number(it?.model_quantity_purchased ?? it?.model_quantity ?? it?.quantity ?? 0));
}

function detectShopeePartialCancellation(rawOrder: any, activeItems: any[]): boolean {
  const rawStatus = String(rawOrder?.order_status || rawOrder?.status || "").toUpperCase();
  if (rawStatus === "CANCELLED") return false;
  const itemList = Array.isArray(rawOrder?.item_list) ? rawOrder.item_list : [];
  const cancelledUnits = itemList.reduce((sum: number, it: any) => sum + shopeeItemCancelledQty(it), 0);
  const purchasedUnits = itemList.reduce((sum: number, it: any) => sum + shopeeItemPurchasedQty(it), 0);
  if (cancelledUnits <= 0) return false;
  if (purchasedUnits > 0 && cancelledUnits >= purchasedUnits) return false;
  return activeItems.length > 0;
}

function applyShopeePartialCancelMeta(order: any, rawOrder: any, activeItems: any[]): void {
  const partialCancel = detectShopeePartialCancellation(rawOrder, activeItems);
  order.partialCancel = partialCancel;
  order.canPartialCancel = Boolean(rawOrder?.can_partial_cancel_order ?? order.canPartialCancel);
  if (partialCancel) {
    const recalcFromItems = activeItems.reduce(
      (sum: number, it: any) => sum + Math.max(0, Number(it.price) || 0) * Math.max(0, Number(it.quantity) || 0),
      0,
    );
    const shopeeTotal = Number(rawOrder?.total_amount ?? order.totalAmount ?? 0);
    if (shopeeTotal > 0) {
      order.totalAmount = shopeeTotal;
    } else if (recalcFromItems > 0) {
      order.totalAmount = Math.round(recalcFromItems);
    }
  }
}

async function enrichShopeeOrdersEscrowFinance(
  shopId: string,
  accessToken: string,
  orders: any[],
): Promise<void> {
  const targets = orders.filter(
    (o) =>
      o?.orderSn &&
      ["completed", "return_pending", "return_received"].includes(String(o.status)),
  );
  for (let i = 0; i < targets.length; i++) {
    const order = targets[i];
    const customCosts = getGlobalPackagingCostPerOrder();
    try {
      const escrow = await shopeeGetEscrowDetail(shopId, accessToken, order.orderSn);
      if (escrow?.error) {
        order.escrow_synced = false;
        applyShopeeOrderFinanceFields(order, {
          totalAmount: order.totalAmount,
          escrowSynced: false,
          customCosts,
        });
        console.warn(`[Shopee Finance] escrow ${order.orderSn}:`, escrow.message || escrow.error);
        continue;
      }
      const payload = escrow?.response ?? escrow;
      const finance = extractShopeeEscrowFinance(payload);
      applyShopeeOrderFinanceFields(order, {
        totalAmount: order.totalAmount,
        itemAmount: finance.itemAmount,
        withholdingCitTax: finance.withholdingCitTax,
        escrowAmount: finance.escrowAmount,
        shopeeFees: finance.shopeeFees,
        escrowSynced: finance.escrowSynced,
        customCosts,
        financeSource: finance.escrowSynced ? "escrow" : undefined,
      });
      if (finance.escrowSynced) {
        order.estimated_fee_items = [];
      }
    } catch (err) {
      order.escrow_synced = false;
      applyShopeeOrderFinanceFields(order, {
        totalAmount: order.totalAmount,
        escrowSynced: false,
        customCosts,
      });
      console.warn(`[Shopee Finance] escrow ${order.orderSn} failed:`, err);
    }
    if (i < targets.length - 1) await delay(ORDER_SYNC_SAVE_DELAY_MS);
  }
}

function findLinkedProductIdForShopeeLine(
  listings: any[],
  shopId: string | undefined,
  productId: string,
  modelId?: string,
): string | undefined {
  const pid = String(productId || "").trim();
  if (!pid) return undefined;
  const mid = String(modelId || "0").trim() || "0";
  const hit = listings.find((row) => {
    if (String(row?.itemId || "") !== pid) return false;
    const rowMid = String(row?.modelId || "0").trim() || "0";
    if (rowMid !== mid && rowMid !== "0" && mid !== "0") return false;
    if (shopId && row?.shopId && String(row.shopId) !== String(shopId)) return false;
    return Boolean(row?.linkedProductId);
  });
  return hit?.linkedProductId ? String(hit.linkedProductId) : undefined;
}

async function restoreLocalStockForPartialCancel(
  shopId: string | undefined,
  existing: any | undefined,
  incoming: any,
): Promise<void> {
  if (!incoming?.partialCancel) return;
  const prevItems = Array.isArray(existing?.items) ? existing.items : [];
  const nextItems = Array.isArray(incoming?.items) ? incoming.items : [];
  if (nextItems.length === 0 && prevItems.length === 0) return;

  let listings: any[] = [];
  try {
    listings = await readChannelListingsDb();
  } catch {
    return;
  }

  let products: any[] = [];
  try {
    products = await loadProductsFromStore();
  } catch {
    return;
  }

  let changed = false;
  const restoreByProduct = new Map<string, number>();

  const resolveRestoreQty = (productId: string, modelId: string | undefined, nextCancelled: number): number => {
    const prev = prevItems.find(
      (p: any) => String(p.productId) === productId && String(p.modelId || "0") === String(modelId || "0"),
    );
    const prevCancelled = Math.max(0, Number(prev?.cancelledQty) || 0);
    return Math.max(0, nextCancelled - prevCancelled);
  };

  for (const item of nextItems) {
    const productId = String(item?.productId || "");
    const modelId = item?.modelId ? String(item.modelId) : undefined;
    const restoreQty = resolveRestoreQty(productId, modelId, Math.max(0, Number(item?.cancelledQty) || 0));
    if (restoreQty <= 0) continue;
    const linkedId =
      findLinkedProductIdForShopeeLine(listings, shopId, productId, modelId) ||
      findLinkedProductIdForShopeeLine(listings, shopId, productId, undefined);
    if (!linkedId) continue;
    restoreByProduct.set(linkedId, (restoreByProduct.get(linkedId) || 0) + restoreQty);
  }

  for (const prev of prevItems) {
    const stillActive = nextItems.some(
      (n: any) =>
        String(n.productId) === String(prev.productId) &&
        String(n.modelId || "0") === String(prev.modelId || "0"),
    );
    if (stillActive) continue;
    const prevActiveQty = Math.max(
      0,
      Number(prev.originalQuantity ?? prev.quantity) - Math.max(0, Number(prev.cancelledQty) || 0),
    );
    if (prevActiveQty <= 0) continue;
    const linkedId = findLinkedProductIdForShopeeLine(
      listings,
      shopId,
      String(prev.productId),
      prev.modelId ? String(prev.modelId) : undefined,
    );
    if (!linkedId) continue;
    restoreByProduct.set(linkedId, (restoreByProduct.get(linkedId) || 0) + prevActiveQty);
  }

  for (const [linkedId, restoreQty] of restoreByProduct) {
    const idx = products.findIndex((p) => String(p?.id) === linkedId);
    if (idx < 0) continue;
    products[idx] = applyBulkProductUpdate(products[idx], { stock: { mode: "increase", value: restoreQty } });
    changed = true;
    console.log(
      `[Shopee Partial Cancel] Hoàn ${restoreQty} tồn kho cho ${linkedId} (order ${incoming.orderSn}).`,
    );
  }

  if (changed) {
    try {
      await saveProductsToStoreAsync(products);
      invalidateMasterSkuIndexCache("shopee_partial_cancel");
    } catch (err) {
      console.warn("[Shopee Partial Cancel] Lưu tồn kho thất bại:", err);
    }
  }
}

/**
 * Cộng lại tồn local khi quét nhận hủy/hoàn lần đầu (đơn đã ship / có mã VĐ / từng HANDED_OVER).
 * Idempotent qua stock_restored / stock_restored_at — không cộng 2 lần; không đẩy update_stock Shopee.
 */
async function restoreLocalStockOnCancelReturnScan(
  order: any,
  opts?: { wasHandedOver?: boolean },
): Promise<{ restored: boolean; skipped?: string; qty?: number }> {
  if (!order?.orderSn) return { restored: false, skipped: "no_order" };
  if (order.stock_restored === true || order.stock_restored_at) {
    return { restored: false, skipped: "already_restored" };
  }

  const hasTn = Boolean(
    String(
      order.trackingNumber ||
        order.tracking_no ||
        order.return_tracking_no ||
        order.shopee_tracking_number ||
        "",
    ).trim(),
  );
  const wasHandedOver =
    opts?.wasHandedOver === true ||
    order.is_handed_over === true ||
    order.isHandedOverToCarrier === true ||
    String(order.local_status || order.localStatus || "").toUpperCase() === "HANDED_OVER";

  // Hủy trước khi ship (chưa có TN, chưa bàn giao) → không cộng tồn.
  if (!hasTn && !wasHandedOver) {
    return { restored: false, skipped: "not_shipped" };
  }

  const items = Array.isArray(order.items) ? order.items : [];
  if (!items.length) return { restored: false, skipped: "no_items" };

  let listings: any[] = [];
  let products: any[] = [];
  try {
    listings = await readChannelListingsDb();
    products = await loadProductsFromStore();
  } catch {
    return { restored: false, skipped: "catalog_unavailable" };
  }

  const shopId = order.shopId ? String(order.shopId) : undefined;
  const restoreByProduct = new Map<string, number>();
  for (const item of items) {
    // Kiện về kho: cộng theo SL đã xuất trên dòng (không trừ cancelledQty — đơn full cancel thường cancelled=purchased).
    const restoreQty = Math.max(
      0,
      Number(item?.originalQuantity) || Number(item?.quantity) || 0,
    );
    if (restoreQty <= 0) continue;
    const productId = String(item?.productId || "");
    if (!productId) continue;
    const modelId = item?.modelId ? String(item.modelId) : undefined;
    const linkedId =
      findLinkedProductIdForShopeeLine(listings, shopId, productId, modelId) ||
      findLinkedProductIdForShopeeLine(listings, shopId, productId, undefined) ||
      (item?.linkedProductId ? String(item.linkedProductId) : "");
    if (!linkedId) continue;
    restoreByProduct.set(linkedId, (restoreByProduct.get(linkedId) || 0) + restoreQty);
  }

  if (restoreByProduct.size === 0) return { restored: false, skipped: "no_linked_products" };

  let changed = false;
  let totalQty = 0;
  for (const [linkedId, restoreQty] of restoreByProduct) {
    const idx = products.findIndex((p) => String(p?.id) === linkedId);
    if (idx < 0) continue;
    products[idx] = applyBulkProductUpdate(products[idx], { stock: { mode: "increase", value: restoreQty } });
    changed = true;
    totalQty += restoreQty;
    console.log(
      `[Scan Restock] +${restoreQty} tồn cho ${linkedId} (order ${order.orderSn})`,
    );
  }

  if (!changed) return { restored: false, skipped: "product_not_found" };

  try {
    await saveProductsToStoreAsync(products);
    invalidateMasterSkuIndexCache("scan_cancel_return_restock");
  } catch (err) {
    console.warn("[Scan Restock] Lưu tồn kho thất bại:", err);
    return { restored: false, skipped: "save_failed" };
  }

  const now = new Date().toISOString();
  order.stock_restored = true;
  order.stock_restored_at = now;
  return { restored: true, qty: totalQty };
}

function mapShopeeOrderLineItem(it: any, opts?: { orderStatus?: string }) {
  if (!it || typeof it !== "object") return null;
  try {
    const itemId = String(it?.item_id || "");
    const modelId = extractShopeeOrderModelId(it);
    const modelSku = extractShopeeOrderModelSku(it);
    const modelName = extractShopeeOrderModelName(it);
    const tierIndex = extractShopeeOrderTierIndex(it);
    const itemName = String(it?.item_name || "S\u1EA3n ph\u1EA9m Shopee").trim();
    const productTitle = modelName ? `${itemName} - ${modelName}` : itemName;
    const productImage =
      it?.image_info?.image_url ||
      it?.image_url ||
      it?.variation_image_url ||
      undefined;
    const purchasedQty = Math.max(1, shopeeItemPurchasedQty(it) || 1);
    const cancelledQty = shopeeItemCancelledQty(it);
    const cancelRequestedQty = shopeeItemCancelRequestedQty(it);
    const activeQty = Math.max(0, purchasedQty - cancelledQty);
    const rawStatus = String(opts?.orderStatus || "").toUpperCase();
    const isFullOrderCancel = rawStatus === "CANCELLED" || rawStatus === "IN_CANCEL";
    // Partial-cancel trên đơn còn sống: drop dòng đã hủy hết.
    // Đơn CANCELLED/IN_CANCEL: GIỮ line item (tránh "đơn ảo" trống sản phẩm).
    if (activeQty <= 0 && cancelledQty > 0 && !isFullOrderCancel) return null;

    const originalPrice = Math.max(0, Number(it?.model_original_price) || 0);
    const discountedPrice = Math.max(
      0,
      Number(it?.model_discounted_price || it?.model_original_price || it?.item_price) || 0,
    );
    const keepQty = isFullOrderCancel
      ? purchasedQty
      : activeQty > 0
        ? activeQty
        : purchasedQty;
    return {
      productId: itemId,
      productTitle,
      productImage,
      quantity: keepQty,
      originalQuantity: purchasedQty,
      cancelledQty: isFullOrderCancel ? Math.max(cancelledQty, purchasedQty) : cancelledQty,
      cancelRequestedQty,
      cancelled: isFullOrderCancel || (activeQty <= 0 && cancelledQty > 0),
      price: discountedPrice || originalPrice,
      originalPrice: originalPrice > 0 ? originalPrice : undefined,
      modelId: modelId === "0" ? undefined : modelId,
      modelSku,
      modelName,
      tierIndex,
    };
  } catch (err) {
    console.warn("[Shopee Sync] mapShopeeOrderLineItem failed:", err);
    return null;
  }
}

// --- Shopee tracking: carrier (SPXVN... / GHN GYAGLRYW...) vs internal sorting (0FG...) ---
const SHOPEE_TRACKING_KEY_RE =
  /^(tracking_number|tracking_no|trackingnumber|trackingno|last_mile_tracking_number|shopee_tracking_number|third_party_tracking_number|courier_tracking_number|logistics_tracking_number|plp_number|awb_tracking_number)$/i;

function isShopeeInternalTrackingCode(code: unknown): boolean {
  return /^0FG/i.test(String(code || "").trim());
}

function isCarrierTrackingCode(code: unknown): boolean {
  const k = String(code || "").trim().toUpperCase();
  if (!k || isShopeeInternalTrackingCode(k)) return false;
  if (k.length < 6 || k.length > 40) return false;
  // Mọi hãng: toàn số 6–40 (GHN/return_sn) hoặc alphanumeric — không bắt chữ cái / prefix.
  if (/^\d{6,40}$/.test(k)) return true;
  if (/^[A-Z0-9][A-Z0-9\-_./]{5,39}$/.test(k)) return true;
  return false;
}

/**
 * ĐÃ TẮT: không chặn/xóa mã vì lệch hãng. Mã Shopee trả về thì giữ nguyên.
 */
function isTrackingCompatibleWithCarrier(_trackingNo?: unknown, _carrier?: unknown): boolean {
  return true;
}

function applyShopeeTrackingCode(order: any, rawCode: unknown) {
  const code = String(rawCode || "").trim();
  if (!code) return;
  if (isShopeeInternalTrackingCode(code)) {
    order.internalTrackingCode = code;
    return;
  }
  // Mọi mã Shopee trả về (GHN số / GYA / SPX / …) — lưu nguyên, không reject lệch hãng.
  order.trackingNumber = code;
  order.tracking_no = code;
}

const TRACKING_ENRICH_COOLDOWN_MS = 8 * 60 * 60 * 1000; // 8h — hủy/hoàn reverse spam
/** GHN RTS/PROCESSED chưa có mã — cooldown ngắn để job bù mã chạy lại. */
const TRACKING_ENRICH_PICKUP_COOLDOWN_MS = 10 * 60 * 1000;

function isPickupAwaitingTrackingStatus(order: any): boolean {
  const raw = String(order?.shopee_order_status || "").toUpperCase();
  const st = String(order?.status || "").toLowerCase();
  if (
    raw === "CANCELLED" ||
    raw === "IN_CANCEL" ||
    raw === "TO_RETURN" ||
    st === "cancelled" ||
    st === "return_pending" ||
    st === "return_received"
  ) {
    return false;
  }
  return (
    raw === "UNPAID" ||
    raw === "PENDING" ||
    raw === "READY_TO_SHIP" ||
    raw === "RETRY_SHIP" ||
    raw === "PROCESSED" ||
    st === "pending_confirm" ||
    st === "unprocessed" ||
    st === "processed"
  );
}

function setTrackingEnrichCooldown(order: any, reason: string): void {
  if (!order || typeof order !== "object") return;
  const ms = isPickupAwaitingTrackingStatus(order)
    ? TRACKING_ENRICH_PICKUP_COOLDOWN_MS
    : TRACKING_ENRICH_COOLDOWN_MS;
  order.tracking_enrich_cooldown_until = new Date(Date.now() + ms).toISOString();
  order.tracking_enrich_cooldown_reason = reason;
}

function isTrackingEnrichOnCooldown(order: any): boolean {
  const raw = order?.tracking_enrich_cooldown_until;
  if (!raw) return false;
  const t = new Date(String(raw)).getTime();
  return Number.isFinite(t) && t > Date.now();
}

function repairMisassignedTracking(order: any): any {
  if (!order || typeof order !== "object") return order;
  // Chỉ đồng bộ mirror — CẤM xóa tracking_no vì lệch hãng.
  if (order.tracking_no && !order.trackingNumber) order.trackingNumber = order.tracking_no;
  if (order.trackingNumber && !order.tracking_no) order.tracking_no = order.trackingNumber;
  if (order.trackingNumber && isShopeeInternalTrackingCode(order.trackingNumber)) {
    if (!order.internalTrackingCode) order.internalTrackingCode = order.trackingNumber;
    order.trackingNumber = undefined;
    order.tracking_no = undefined;
  }
  return order;
}

/**
 * Deep fallback: quét payload Shopee tìm mã vận đơn.
 * BẮT BUỘC lọc theo order_sn khi payload có order_list — tuyệt đối không gán theo index mảng.
 */
function deepExtractShopeeTrackingCodes(
  payload: unknown,
  opts?: { orderSn?: string },
): {
  carrier?: string;
  internal?: string;
  sources: string[];
} {
  const wantSn = String(opts?.orderSn || "").replace(/^shopee-/i, "").trim();
  const sources: string[] = [];
  let carrier: string | undefined;
  let internal: string | undefined;

  const consider = (key: string, value: unknown, path: string) => {
    if (!SHOPEE_TRACKING_KEY_RE.test(key) && key.toLowerCase() !== "tracking_number" && key.toLowerCase() !== "tracking_no") {
      // vẫn nhận giá trị nếu key chứa "tracking" nhưng không phải boolean/object
      if (!/tracking/i.test(key) || /time|date|url|info|hint|status|type/i.test(key)) return;
    }
    const s = String(value || "").trim();
    if (!s || s.length < 6 || s.length > 40) return;
    if (!/^[A-Za-z0-9][A-Za-z0-9\-_./]*$/.test(s)) return;
    if (isShopeeInternalTrackingCode(s)) {
      if (!internal) {
        internal = s;
        sources.push(`${path}=${s}(internal)`);
      }
      return;
    }
    if (!carrier) {
      carrier = s;
      sources.push(`${path}=${s}`);
    } else if (isCarrierTrackingCode(s) && !isCarrierTrackingCode(carrier)) {
      carrier = s;
      sources.push(`${path}=${s}`);
    }
  };

  const walk = (node: unknown, path: string, depth: number) => {
    if (node == null || depth > 8) return;
    if (Array.isArray(node)) {
      node.forEach((item, i) => walk(item, `${path}[${i}]`, depth + 1));
      return;
    }
    if (typeof node !== "object") return;
    // Không đi vào subtree của đơn khác (tránh gán nhầm mã theo index order_list).
    if (wantSn) {
      const nodeSn = String((node as any).order_sn || "").replace(/^shopee-/i, "").trim();
      if (nodeSn && nodeSn !== wantSn) return;
    }
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      const childPath = path ? `${path}.${k}` : k;
      if (v != null && (typeof v === "string" || typeof v === "number")) {
        consider(k, v, childPath);
      } else {
        walk(v, childPath, depth + 1);
      }
    }
  };

  // Ưu tiên đường dẫn chuẩn trước khi deep-walk
  const root = payload as any;
  const resp = root?.response ?? root;
  const priorityPaths: Array<[string, unknown]> = [
    ["response.tracking_number", resp?.tracking_number],
    ["response.tracking_no", resp?.tracking_no],
    ["response.last_mile_tracking_number", resp?.last_mile_tracking_number],
    ["response.plp_number", resp?.plp_number],
    ["response.shopee_tracking_number", resp?.shopee_tracking_number],
    [
      "response.shipping_document_info.tracking_number",
      resp?.shipping_document_info?.tracking_number,
    ],
    [
      "response.shipping_document_info.tracking_no",
      resp?.shipping_document_info?.tracking_no,
    ],
    [
      "response.shipping_document_info.shopee_tracking_number",
      resp?.shipping_document_info?.shopee_tracking_number,
    ],
  ];
  // Single-order detail object (đã có order_sn) — lấy tracking trên chính object đó.
  const rootSn = String(root?.order_sn || "").replace(/^shopee-/i, "").trim();
  if (!wantSn || !rootSn || rootSn === wantSn) {
    priorityPaths.push(["root.tracking_no", root?.tracking_no]);
    priorityPaths.push(["root.tracking_number", root?.tracking_number]);
    priorityPaths.push(["root.package_list[0].tracking_number", root?.package_list?.[0]?.tracking_number]);
    priorityPaths.push(["root.package_list[0].tracking_no", root?.package_list?.[0]?.tracking_no]);
  }
  const orderList = Array.isArray(resp?.order_list)
    ? resp.order_list
    : Array.isArray(root?.order_list)
      ? root.order_list
      : [];
  // Map theo order_sn — bỏ qua phần tử lệch (API có thể trả lệch thứ tự).
  orderList.forEach((o: any, i: number) => {
    const sn = String(o?.order_sn || "").replace(/^shopee-/i, "").trim();
    if (wantSn && sn && sn !== wantSn) return;
    if (wantSn && !sn) return;
    priorityPaths.push([`order_list[${i}].tracking_no`, o?.tracking_no]);
    priorityPaths.push([`order_list[${i}].tracking_number`, o?.tracking_number]);
    priorityPaths.push([
      `order_list[${i}].package_list[0].tracking_number`,
      o?.package_list?.[0]?.tracking_number,
    ]);
    priorityPaths.push([
      `order_list[${i}].package_list[0].tracking_no`,
      o?.package_list?.[0]?.tracking_no,
    ]);
    priorityPaths.push([
      `order_list[${i}].shipping_document_info.tracking_number`,
      o?.shipping_document_info?.tracking_number,
    ]);
  });
  for (const [p, v] of priorityPaths) {
    if (v != null && String(v).trim()) consider("tracking_number", v, p);
  }

  walk(payload, "", 0);
  return { carrier, internal, sources };
}

function applyDeepShopeeTrackingPayload(order: any, payload: unknown, label = "payload"): boolean {
  const orderSn = String(order?.orderSn || "").replace(/^shopee-/i, "").trim();
  const extracted = deepExtractShopeeTrackingCodes(payload, { orderSn });
  if (extracted.internal) order.internalTrackingCode = extracted.internal;
  if (extracted.carrier) {
    applyShopeeTrackingCode(order, extracted.carrier);
    console.log(
      `[Shopee Tracking] Deep extract OK order_sn=${orderSn} from=${label} carrier=${extracted.carrier} sources=${extracted.sources.slice(0, 6).join(" | ")}`,
    );
    return true;
  }
  if (extracted.sources.length) {
    console.log(
      `[Shopee Tracking] Deep extract chỉ thấy internal/partial order_sn=${orderSn} from=${label}: ${extracted.sources.slice(0, 8).join(" | ")}`,
    );
  }
  repairMisassignedTracking(order);
  return false;
}

async function persistOrderTrackingToDb(order: any): Promise<void> {
  repairMisassignedTracking(order);
  const sn = String(order?.orderSn || "").trim();
  if (!sn) return;
  const pkg = String(order?.packageNumber || order?.package_number || "").trim();
  if (pkg) {
    order.packageNumber = pkg;
    order.package_number = pkg;
  }
  const tn = String(order?.trackingNumber || order?.tracking_no || "").trim();
  // Đơn hủy/hoàn: không bắt buộc tracking_code — vẫn persist được package_number.
  const isCancelReturn = isCancelOrReturnOrderStatus(order) || order?.return_sn;
  if ((!tn || isShopeeInternalTrackingCode(tn)) && pkg && isMongoReady()) {
    try {
      await updateOrderPackageNumberInStore(sn, pkg, {
        internalTrackingCode: order.internalTrackingCode,
        status: order.status != null ? String(order.status) : undefined,
        isPrepared: order.isPrepared === true,
        shopee_order_status:
          order.shopee_order_status != null ? String(order.shopee_order_status) : undefined,
        shopId: order.shopId != null ? String(order.shopId) : undefined,
      });
    } catch (err: any) {
      console.warn(`[Shopee Tracking] Mongo packageNumber-only failed ${sn}:`, err?.message || err);
    }
  }
  if (!tn || isShopeeInternalTrackingCode(tn)) {
    if (!isCancelReturn) return;
    // Đơn hủy/hoàn: không có outbound tracking nhưng có return_tracking_no.
    const rtn = distinctReturnTracking(
      order?.return_tracking_no || order?.returnTrackingNumber,
      "",
    );
    if (!rtn) return;
    if (isMongoReady()) {
      try {
        await updateOrderTrackingInStore(sn, "", {
          internalTrackingCode: order.internalTrackingCode,
          packageNumber: order.packageNumber || pkg || undefined,
          status: order.status != null ? String(order.status) : undefined,
          isPrepared: order.isPrepared === true,
          shopee_order_status:
            order.shopee_order_status != null ? String(order.shopee_order_status) : undefined,
          is_pending_shopee_check: order.is_pending_shopee_check === true,
          shopId: order.shopId != null ? String(order.shopId) : undefined,
          return_tracking_no: rtn,
        });
      } catch (err: any) {
        console.warn(`[Shopee Tracking] Mongo return-only failed ${sn}:`, err?.message || err);
      }
    }
    return;
  }
  order.trackingNumber = tn;
  order.tracking_no = tn;
  // JSON DB được saveOrders gọi từ caller; ở đây sync Mongo nếu có.
  if (isMongoReady()) {
    try {
      await updateOrderTrackingInStore(String(order.orderSn), tn, {
        internalTrackingCode: order.internalTrackingCode,
        packageNumber: order.packageNumber || pkg || undefined,
        status: order.status != null ? String(order.status) : undefined,
        isPrepared: order.isPrepared === true,
        shopee_order_status:
          order.shopee_order_status != null ? String(order.shopee_order_status) : undefined,
        is_pending_shopee_check: order.is_pending_shopee_check === true,
        shopId: order.shopId != null ? String(order.shopId) : undefined,
        return_tracking_no:
          distinctReturnTracking(
            order.return_tracking_no || order.returnTrackingNumber,
            tn,
          ) || undefined,
      });
    } catch (err: any) {
      console.warn(`[Shopee Tracking] Mongo findOneAndUpdate failed ${order.orderSn}:`, err?.message || err);
    }
  }
  console.log(
    `[Shopee Tracking] DB SET tracking_no=${tn} package=${pkg || "-"} status=${order.status || "-"} order_sn=${order.orderSn}`,
  );
}

function isCancelOrReturnOrderStatus(order: any): boolean {
  const status = String(order?.status || "").toLowerCase();
  const raw = String(order?.shopee_order_status || "").toUpperCase();
  if (
    status === "cancelled" ||
    status === "return_pending" ||
    status === "return_received"
  ) {
    return true;
  }
  return raw === "CANCELLED" || raw === "IN_CANCEL" || raw === "TO_RETURN";
}

/** Thiếu mã hoàn thật (trống hoặc đang bị copy nhầm mã chiều đi). */
function orderNeedsRealReturnTracking(order: any): boolean {
  if (!order) return false;
  if (String(order.return_status || "").toUpperCase() === "CANCELLED") return false;
  const hasReturnCtx = Boolean(order.return_sn) || isCancelOrReturnOrderStatus(order);
  if (!hasReturnCtx) return false;
  const ret = normalizeCarrierTrackingCode(
    order.return_tracking_no || order.returnTrackingNumber,
  );
  if (!ret) return true;
  const out = outboundTrackingOf(order);
  return Boolean(out && ret === out);
}

/** Giữ mã vận đơn cũ khi sàn trả về rỗng (đặc biệt đơn hủy/hoàn). */
function preserveExistingTrackingIfIncomingEmpty(target: any, existing: any | undefined): void {
  if (!target || !existing) return;
  const existingTn = String(existing.trackingNumber || existing.tracking_no || "").trim();
  const incomingTn = String(target.trackingNumber || target.tracking_no || "").trim();
  if (existingTn && !incomingTn) {
    target.trackingNumber = existingTn;
    target.tracking_no = existingTn;
  }
  const existingReturnTn = distinctReturnTracking(
    existing.return_tracking_no || existing.returnTrackingNumber,
    existing.trackingNumber || existing.tracking_no || target.trackingNumber || target.tracking_no,
  );
  const incomingReturnTn = distinctReturnTracking(
    target.return_tracking_no || target.returnTrackingNumber,
    target.trackingNumber || target.tracking_no || existing.trackingNumber || existing.tracking_no,
  );
  if (incomingReturnTn) {
    applyReturnTrackingAliases(target, incomingReturnTn);
  } else if (existingReturnTn) {
    applyReturnTrackingAliases(target, existingReturnTn);
  }
  const existingInternal = String(existing.internalTrackingCode || "").trim();
  const incomingInternal = String(target.internalTrackingCode || "").trim();
  if (existingInternal && !incomingInternal) {
    target.internalTrackingCode = existingInternal;
  }
  if (!target.packageNumber && !target.package_number) {
    const existingPkg = String(existing.packageNumber || existing.package_number || "").trim();
    if (existingPkg) {
      target.packageNumber = existingPkg;
      target.package_number = existingPkg;
    }
  }
}

function mergeShopeeTrackingFields(merged: any, existing: any, incoming: any) {
  // Snapshot mã cũ TRƯỚC repair — tránh CLEAR làm mất TN khi đơn chuyển hủy/hoàn.
  const existingTnBefore = String(existing?.trackingNumber || existing?.tracking_no || "").trim();
  const existingReturnBefore = String(existing?.return_tracking_no || "").trim();
  repairMisassignedTracking(merged);
  repairMisassignedTracking(existing);
  repairMisassignedTracking(incoming);
  const pickCarrier = (...candidates: unknown[]) => {
    for (const c of candidates) {
      const s = String(c || "").trim();
      if (!s || isShopeeInternalTrackingCode(s)) continue;
      if (isCarrierTrackingCode(s) || s.length >= 6) return s;
    }
    return undefined;
  };
  const pickInternal = (...candidates: unknown[]) => {
    for (const c of candidates) {
      const s = String(c || "").trim();
      if (s && isShopeeInternalTrackingCode(s)) return s;
    }
    return undefined;
  };

  // Outbound TN theo order_sn — không trộn return_tracking_no vào mã đi.
  const existingTn = String(
    existing?.trackingNumber || existing?.tracking_no || existingTnBefore || "",
  ).trim();
  const incomingTn = String(incoming?.trackingNumber || incoming?.tracking_no || "").trim();
  const cancelReturn = isCancelOrReturnOrderStatus(incoming) || isCancelOrReturnOrderStatus(merged);

  if (incoming?.return_sn) merged.return_sn = incoming.return_sn;
  else if (existing?.return_sn) merged.return_sn = existing.return_sn;
  if (incoming?.return_status) merged.return_status = incoming.return_status;
  else if (existing?.return_status) merged.return_status = existing.return_status;
  if (incoming?.refund_amount != null) merged.refund_amount = incoming.refund_amount;
  else if (existing?.refund_amount != null) merged.refund_amount = existing.refund_amount;
  if (incoming?.return_reason) merged.return_reason = incoming.return_reason;
  else if (existing?.return_reason) merged.return_reason = existing.return_reason;
  if (incoming?.text_reason) merged.text_reason = incoming.text_reason;
  else if (existing?.text_reason) merged.text_reason = existing.text_reason;
  if (incoming?.cancel_reason) merged.cancel_reason = incoming.cancel_reason;
  else if (existing?.cancel_reason) merged.cancel_reason = existing.cancel_reason;
  if (incoming?.buyer_cancel_reason) merged.buyer_cancel_reason = incoming.buyer_cancel_reason;
  else if (existing?.buyer_cancel_reason) merged.buyer_cancel_reason = existing.buyer_cancel_reason;
  if (incoming?.cancel_by) merged.cancel_by = incoming.cancel_by;
  else if (existing?.cancel_by) merged.cancel_by = existing.cancel_by;
  if (incoming?.logistics_status) merged.logistics_status = incoming.logistics_status;
  else if (existing?.logistics_status) merged.logistics_status = existing.logistics_status;
  applyShopeeCancelReturnClassification(merged);
  // return_tracking_no giữ riêng — không ghi đè tracking_no outbound, không copy mã đi.
  const nextReturnTn =
    distinctReturnTracking(
      incoming?.return_tracking_no || incoming?.returnTrackingNumber,
      incoming?.trackingNumber || incoming?.tracking_no || existingTn,
    ) ||
    distinctReturnTracking(
      existing?.return_tracking_no || existing?.returnTrackingNumber || existingReturnBefore,
      existingTn,
    );
  if (nextReturnTn) applyReturnTrackingAliases(merged, nextReturnTn);

  // BẮT BUỘC: đơn hủy/hoàn + sàn trả tracking rỗng → giữ mã cũ trong DB (quét barcode hoàn hàng).
  if (cancelReturn && existingTn && !incomingTn) {
    merged.trackingNumber = existingTn;
    merged.tracking_no = existingTn;
    if (nextReturnTn) applyReturnTrackingAliases(merged, nextReturnTn);
    const existingInternal = String(existing?.internalTrackingCode || "").trim();
    if (existingInternal) merged.internalTrackingCode = existingInternal;
    if (!merged.packageNumber && !merged.package_number) {
      const existingPkg = String(existing?.packageNumber || existing?.package_number || "").trim();
      if (existingPkg) {
        merged.packageNumber = existingPkg;
        merged.package_number = existingPkg;
      }
    }
    return;
  }

  // ƯU TIÊN outbound tracking theo order_sn (không lấy return_tracking_no làm mã đi).
  const nextTracking = pickCarrier(
    incoming.trackingNumber,
    incoming.tracking_no,
    incoming.lastMileTrackingNumber,
    existing.trackingNumber,
    existing.tracking_no,
    existing.lastMileTrackingNumber,
  );
  merged.trackingNumber =
    nextTracking || existingTn || incomingTn || undefined;
  merged.tracking_no = merged.trackingNumber;

  if (!merged.trackingNumber && existingTn) {
    merged.trackingNumber = existingTn;
    merged.tracking_no = existingTn;
  }

  const nextInternal = pickInternal(
    incoming.internalTrackingCode,
    existing.internalTrackingCode,
    incoming.trackingNumber,
    existing.trackingNumber,
    incoming.firstMileTrackingNumber,
    existing.firstMileTrackingNumber,
  );
  merged.internalTrackingCode =
    nextInternal || existing.internalTrackingCode || incoming.internalTrackingCode || undefined;
}

/**
 * Thứ bậc trạng thái Shopee — số cao hơn = mới hơn.
 * BẮT BUỘC: UNPAID < READY_TO_SHIP < PROCESSED < SHIPPED < COMPLETED.
 * SHIPPED phải > PROCESSED — nếu không webhook/sync SHIPPED bị state machine nuốt im lặng.
 */
function shopeeLifecycleRank(rawOrLocal: string): number {
  const s = String(rawOrLocal || "").toUpperCase();
  // COMPLETED
  if (s === "COMPLETED" || s === "completed") return 100;
  // SHIPPED / logistics đã lấy hàng (rank cao hơn PROCESSED)
  if (
    s === "SHIPPED" ||
    s === "TO_CONFIRM_RECEIVE" ||
    s === "shipping" ||
    s.includes("LOGISTICS_SHIPPED") ||
    s.includes("LOGISTICS_PICKUP_DONE") ||
    s.includes("PICKUP_DONE") ||
    s.includes("LOGISTICS_DELIVERY_DONE") ||
    s.includes("IN_TRANSIT") ||
    s.includes("TRANSPORTING")
  ) {
    return 90;
  }
  if (
    s === "TO_RETURN" ||
    s === "return_pending" ||
    s === "return_received" ||
    s === "CANCELLED" ||
    s === "IN_CANCEL" ||
    s === "cancelled"
  ) {
    return 80;
  }
  // PROCESSED < SHIPPED (50 < 90)
  if (s === "PROCESSED" || s === "processed") return 50;
  if (s === "READY_TO_SHIP" || s === "RETRY_SHIP" || s === "unprocessed") return 40;
  if (
    s === "UNPAID" ||
    s === "PENDING" ||
    s === "IN_REVIEW" ||
    s === "FRAUD_CHECK" ||
    s === "pending_confirm" ||
    s === "pending_verification"
  ) {
    return 20;
  }
  return 0;
}

function isShopeeTerminalRawStatus(raw: string): boolean {
  const r = String(raw || "").toUpperCase();
  return (
    r === "SHIPPED" ||
    r === "TO_CONFIRM_RECEIVE" ||
    r === "COMPLETED" ||
    r === "CANCELLED" ||
    r === "IN_CANCEL" ||
    r === "TO_RETURN"
  );
}

/**
 * SHIPPED / COMPLETED từ Shopee → BẮT BUỘC ghi đè tab local + EXIT ĐVVC.
 * State Machine: KHÔNG promote Đang giao khi raw còn READY_TO_SHIP|PROCESSED.
 */
/** Hủy/hoàn trên sàn → gỡ local HANDED_OVER (giữ handedOverAt để audit) để quét phân loại được. */
function clearHandedOverLocalForCancelReturn(order: any): void {
  if (!order || typeof order !== "object") return;
  const local = String(order.local_status || order.localStatus || order.internal_status || "").toUpperCase();
  // Không đụng đơn đã phân loại hủy/hoàn trong kho.
  if (local === "CANCELLED_STORED" || local === "RETURN_RECEIVED") return;
  if (order.handedOverAt == null && order.handed_over_at != null) {
    order.handedOverAt = order.handed_over_at;
  }
  order.is_handed_over = false;
  order.isHandedOverToCarrier = false;
  order.is_handed_over_to_carrier = false;
  order.is_handed_over_to_courier = false;
  if (local === "HANDED_OVER" || local === "NONE" || !local) {
    delete order.local_status;
    delete order.localStatus;
    delete order.internal_status;
  }
}

function isShopeeCancelOrReturnLikeOrder(order: any): boolean {
  const raw = String(order?.shopee_order_status || "").toUpperCase();
  if (raw === "CANCELLED" || raw === "IN_CANCEL" || raw === "TO_RETURN") return true;
  const kind = String(order?.shopee_cancel_return_kind || "");
  if (kind === "refund_return" || kind === "cancelled" || kind === "failed_delivery") return true;
  const logistics = String(order?.logistics_status || "").toUpperCase();
  if (
    /DELIVERY_FAILED|FAILED_DELIVERY|LOGISTICS_DELIVERY_FAILED|UNDELIVERABLE|PICKUP_FAILED|LOST/.test(
      logistics,
    )
  ) {
    return true;
  }
  if (order?.return_sn) return true;
  const status = String(order?.status || "");
  return status === "cancelled" || status === "return_pending" || status === "return_received";
}

function enforceShopeeTerminalLocalStatus(order: any): boolean {
  if (!order || String(order.channel || "") !== "shopee") return false;
  const raw = String(order.shopee_order_status || "").toUpperCase();

  if (raw === "COMPLETED") {
    order.status = "completed";
    order.shopee_order_status = "COMPLETED";
    order.isPrepared = true;
    order.is_pending_shopee_check = false;
    return true;
  }
  if (raw === "SHIPPED" || raw === "TO_CONFIRM_RECEIVE") {
    order.status = "shipping";
    order.shopee_order_status = raw;
    order.isPrepared = true;
    order.is_pending_shopee_check = false;
    return true;
  }
  if (raw === "CANCELLED" || raw === "IN_CANCEL") {
    order.status = "cancelled";
    order.shopee_order_status = raw;
    order.isPrepared = false;
    order.is_pending_shopee_check = false;
    clearHandedOverLocalForCancelReturn(order);
    return true;
  }
  if (raw === "TO_RETURN") {
    if (order.status !== "return_received") order.status = "return_pending";
    order.shopee_order_status = "TO_RETURN";
    order.isPrepared = false;
    order.is_pending_shopee_check = false;
    clearHandedOverLocalForCancelReturn(order);
    return true;
  }
  return false;
}

/**
 * Heal đơn kẹt tab "Chưa xử lý":
 * - Có tracking_no outbound (GHN GYA..., SPX...) → Đã xử lý
 * - Shopee PROCESSED (sau ship pickup/dropoff) → Đã xử lý
 * - fulfillment_type=dropoff + isPrepared → Đã xử lý (KHÔNG auto mọi READY_TO_SHIP)
 * - SHIPPED / COMPLETED luôn thắng (không downgrade về processed)
 * Manual Sync là nguồn chân lý — không chờ webhook.
 */
function forceHealPickupOrderIfHasTracking(order: any): boolean {
  if (!order || String(order.channel || "") !== "shopee") return false;
  repairMisassignedTracking(order);
  const tn = String(order.trackingNumber || order.tracking_no || "").trim();
  const hasTn = Boolean(tn && !isShopeeInternalTrackingCode(tn));
  if (hasTn) {
    order.trackingNumber = tn;
    order.tracking_no = tn;
  }

  // Terminal Shopee luôn ghi đè — không rơi xuống nhánh PROCESSED.
  if (enforceShopeeTerminalLocalStatus(order)) return true;

  const raw = String(order.shopee_order_status || "").toUpperCase();
  const fulfillment = String(
    order.fulfillment_type || order.ship_method || order.shipping_method || "",
  )
    .trim()
    .toLowerCase();
  const isDropoff =
    fulfillment === "dropoff" || fulfillment === "drop_off" || fulfillment === "drop-off";

  // Không kéo lùi đơn đã Đang giao / Hoàn thành.
  if (order.status === "shipping" || order.status === "completed") return hasTn;

  if (
    raw === "CANCELLED" ||
    raw === "IN_CANCEL" ||
    raw === "TO_RETURN" ||
    order.status === "cancelled" ||
    order.status === "return_pending" ||
    order.status === "return_received"
  ) {
    return hasTn;
  }

  // PROCESSED / có mã vận đơn outbound → Đã xử lý.
  // Drop-off: CHỈ khi đã có mã HOẶC user đã chuẩn bị (isPrepared) — KHÔNG auto-process mọi READY_TO_SHIP.
  const shouldProcess =
    hasTn ||
    raw === "PROCESSED" ||
    (isDropoff && (hasTn || order.isPrepared === true));

  if (!shouldProcess) return false;

  // Chỉ cập nhật local status — KHÔNG giả mạo shopee_order_status (raw = SSOT từ Shopee).
  order.status = "processed";
  order.isPrepared = true;
  order.is_pending_shopee_check = false;
  if (isDropoff) {
    order.fulfillment_type = "dropoff";
    order.ship_method = "dropoff";
  }
  return true;
}

/**
 * Sửa đơn READY_TO_SHIP bị đẩy nhầm sang "Đã xử lý" (bug dropoff auto-heal cũ):
 * raw vẫn RTS/RETRY, chưa có mã VĐ outbound, chưa in, CHƯA chuẩn bị hàng → về lại Chưa xử lý.
 * User đã ship_order (isPrepared=true) thì GIỮ Đã xử lý dù Shopee còn READY_TO_SHIP.
 */
function repairFalseProcessedReadyToShip(order: any): boolean {
  if (!order || String(order.channel || "") !== "shopee") return false;
  const raw = String(order.shopee_order_status || "").toUpperCase();
  if (raw !== "READY_TO_SHIP" && raw !== "RETRY_SHIP") return false;
  if (order.status === "shipping" || order.status === "completed") return false;
  const tn = String(order.trackingNumber || order.tracking_no || "").trim();
  if (tn && !isShopeeInternalTrackingCode(tn)) return false;
  if (order.isPrinted === true) return false;
  if (order.isPrepared === true) return false;
  if (order.status !== "processed") return false;
  order.status = "unprocessed";
  order.isPrepared = false;
  order.is_pending_shopee_check = false;
  return true;
}

/** Đơn local bị kẹt: chờ lấy hàng nhưng thiếu mã / sai tab — cần cưỡng chế sync lại. */
function isStuckShopeePickupOrder(order: any): boolean {
  if (!order || String(order.channel || "") !== "shopee") return false;
  const raw = String(order.shopee_order_status || "").toUpperCase();
  const status = String(order.status || "");
  if (
    raw === "SHIPPED" ||
    raw === "TO_CONFIRM_RECEIVE" ||
    raw === "COMPLETED" ||
    raw === "CANCELLED" ||
    raw === "IN_CANCEL" ||
    raw === "TO_RETURN" ||
    status === "shipping" ||
    status === "completed" ||
    status === "cancelled" ||
    status === "return_pending" ||
    status === "return_received"
  ) {
    return false;
  }
  // Đã bàn giao ĐVVC: không dùng force-resync-stuck (nặng / tryShip).
  // Status SHIPPED → Đang giao do reconcileHandedOverCarrierStatuses (cron + FE poll).
  const pickupLike =
    raw === "READY_TO_SHIP" ||
    raw === "RETRY_SHIP" ||
    raw === "PROCESSED" ||
    status === "unprocessed" ||
    status === "processed" ||
    !raw;
  if (!pickupLike) return false;
  // Đơn đã quét QR bàn giao: không inject vào heal stuck — dùng reconcile ĐVVC riêng.
  if (resolveOrderHandoverFlag(order)) return false;
  if (!hasUsableShopeeTrackingNumber(order)) return true;
  // Có mã nhưng vẫn tab Chưa xử lý → heal status
  if (status === "unprocessed" || status === "pending_verification") return true;
  // Local vẫn PROCESSED/processed — cưỡng chế get_order_detail để bắt SHIPPED/COMPLETED.
  if (status === "processed" || raw === "PROCESSED") return true;
  return false;
}

/**
 * Đơn hotfix bị kẹt "Chưa có mã vận đơn" — ép re-sync riêng từng mã.
 * Có thể gọi qua POST /api/orders/force-resync-stuck hoặc tự chạy sau boot.
 */
const FORCE_RESYNC_PINNED_ORDER_SNS = ["2607315FFJ7TDH", "26073155AN9G9B"];

type ForceResyncStuckResultItem = {
  orderSn: string;
  ok: boolean;
  steps: string[];
  trackingNo?: string;
  status?: string;
  shopee_order_status?: string;
  error?: string;
};

async function forceResyncStuckOrdersWithoutTracking(opts?: {
  orderSns?: string[];
  maxAutoDetect?: number;
  tryShip?: boolean;
  includePinned?: boolean;
  lookbackMs?: number;
}): Promise<{
  attempted: number;
  healed: number;
  results: ForceResyncStuckResultItem[];
}> {
  const normalizeSn = (s: unknown) =>
    String(s || "")
      .replace(/^#/, "")
      .replace(/^shopee-/i, "")
      .trim();

  const snSet = new Set<string>();
  if (opts?.includePinned !== false) {
    for (const sn of FORCE_RESYNC_PINNED_ORDER_SNS) {
      const n = normalizeSn(sn);
      if (n) snSet.add(n);
    }
  }
  for (const sn of Array.isArray(opts?.orderSns) ? opts!.orderSns : []) {
    const n = normalizeSn(sn);
    if (n) snSet.add(n);
  }

  const maxAuto = Math.min(Math.max(Number(opts?.maxAutoDetect ?? 30) || 0, 0), 200);
  const tryShip = opts?.tryShip !== false;
  const lookbackMs = Math.max(
    60_000,
    Number(opts?.lookbackMs) || 14 * 24 * 3600 * 1000,
  );

  if (isMongoReady() && maxAuto > 0) {
    try {
      const candidates = await loadShopeeTrackingEnrichCandidatesFromStore({
        lookbackMs,
        limit: Math.min(Math.max(maxAuto * 2, 20), 200),
        localStatuses: [
          "unprocessed",
          "processed",
          "pending_confirm",
          "pending_verification",
        ],
        shopeeStatuses: ["READY_TO_SHIP", "RETRY_SHIP", "PROCESSED", "PENDING", "UNPAID"],
      });
      for (const row of candidates) {
        if (snSet.size >= maxAuto + FORCE_RESYNC_PINNED_ORDER_SNS.length) break;
        if (!isStuckShopeePickupOrder(row) && !needsShopeeTrackingEnrichment(row)) continue;
        const sn = normalizeSn(row?.orderSn);
        if (sn) snSet.add(sn);
      }
    } catch (detectErr: any) {
      console.warn(
        "[Force Resync] auto-detect stuck orders failed:",
        detectErr?.message || detectErr,
      );
    }
  }

  const orderSns = [...snSet];
  const results: ForceResyncStuckResultItem[] = [];
  let healed = 0;

  console.log(
    `[Force Resync] START sns=${orderSns.length} tryShip=${tryShip} list=${orderSns.slice(0, 10).join(",")}${orderSns.length > 10 ? "…" : ""}`,
  );

  for (const orderSn of orderSns) {
    const item: ForceResyncStuckResultItem = { orderSn, ok: false, steps: [] };
    try {
      let orders: any[] = [];
      try {
        orders = await loadOrdersForShipScoped([`shopee-${orderSn}`], [orderSn]);
      } catch (loadErr: any) {
        item.steps.push(`load_err:${loadErr?.message || loadErr}`);
        orders = [];
      }

      let order =
        orders.find((o) => normalizeSn(o?.orderSn) === orderSn) ||
        orders[0] ||
        null;

      if (!order && isMongoReady()) {
        try {
          const mongoRows = await loadOrdersFromStore({ orderSns: [orderSn] });
          order = mongoRows[0] || null;
          if (order) orders = [order];
        } catch {
          /* ignore */
        }
      }

      if (!order) {
        item.error = "order_not_found_in_db";
        results.push(item);
        continue;
      }

      // Gỡ cờ treo từ lần lỗi trước để UI/API không bị chặn.
      order.is_pending_shopee_check = false;
      item.steps.push("clear_pending_flag");

      const shopId = String(order.shopId || resolveOrderShopId(order) || "").trim();
      if (!shopId) {
        item.error = "missing_shop_id";
        results.push(item);
        continue;
      }
      order.shopId = shopId;

      const auth = await getShopeeAccessTokenForApi(shopId);
      if (!auth?.token) {
        item.error = "no_access_token";
        results.push(item);
        continue;
      }

      // 1) get_order_detail → upsert trạng thái chuẩn
      try {
        const { normalized, errors } = await fetchNormalizeShopeeOrderChunk(
          auth.apiShopId,
          auth.token,
          auth.fileKey || shopId,
          [orderSn],
          { enrichTracking: true },
        );
        if (normalized.length > 0) {
          await persistShopeeOrderChunk(orders, normalized, {
            apiShopId: auth.apiShopId,
            accessToken: auth.token,
            skipTracking: true,
          });
          order =
            orders.find((o) => normalizeSn(o?.orderSn) === orderSn) ||
            normalized[0] ||
            order;
          order.is_pending_shopee_check = false;
          item.steps.push("get_order_detail");
        } else {
          item.steps.push(
            `get_order_detail_empty:${errors?.[0]?.error || errors?.[0]?.message || "empty"}`,
          );
        }
      } catch (detailErr: any) {
        item.steps.push(`get_order_detail_err:${detailErr?.message || detailErr}`);
      }

      // 2) Nếu vẫn READY_TO_SHIP / chưa prepared → ép ship_order (create shipment)
      if (
        tryShip &&
        !hasUsableShopeeTrackingNumber(order) &&
        !isShopeeOrderPreparedForPrint(order)
      ) {
        const raw = String(order.shopee_order_status || "").toUpperCase();
        if (raw === "READY_TO_SHIP" || raw === "RETRY_SHIP" || raw === "PENDING" || !raw) {
          try {
            const method = resolveAutoShipMethodForPrint(order);
            const shipResult = await arrangeShipment(order, method);
            if (shipResult.success || isAlreadyShippedError(shipResult)) {
              order.isPrepared = true;
              order.is_pending_shopee_check = false;
              if (
                !order.shopee_order_status ||
                String(order.shopee_order_status).toUpperCase() === "READY_TO_SHIP" ||
                String(order.shopee_order_status).toUpperCase() === "RETRY_SHIP"
              ) {
                order.shopee_order_status = "PROCESSED";
              }
              if (
                order.status === "unprocessed" ||
                order.status === "pending_confirm" ||
                order.status === "pending_verification"
              ) {
                order.status = "processed";
              }
              item.steps.push("ship_order");
            } else {
              item.steps.push(
                `ship_order_fail:${shipResult.error || shipResult.message || "unknown"}`,
              );
            }
          } catch (shipErr: any) {
            item.steps.push(`ship_order_err:${shipErr?.message || shipErr}`);
          }
        }
      }

      // 3) Ép get_tracking_number (+ retry)
      try {
        const tnOk = await fetchAndForceSaveTrackingNumber(
          auth.apiShopId,
          auth.token,
          order,
          { retries: 4 },
        );
        item.steps.push(tnOk ? "get_tracking_number_ok" : "get_tracking_number_empty");
      } catch (tnErr: any) {
        item.steps.push(`get_tracking_number_err:${tnErr?.message || tnErr}`);
      }

      forceHealPickupOrderIfHasTracking(order);
      promoteOrderStatusWhenTrackingReady(order);
      enforceShopeeTerminalLocalStatus(order);
      order.is_pending_shopee_check = false;

      // 4) Ghi DB
      if (isMongoReady()) {
        try {
          await bulkUpsertOrdersToStore([order]);
          item.steps.push("mongo_upsert");
          queueOrdersJsonMirrorFromMongo();
        } catch (mongoErr: any) {
          item.steps.push(`mongo_upsert_err:${mongoErr?.message || mongoErr}`);
        }
      }

      item.trackingNo =
        String(order.trackingNumber || order.tracking_no || "").trim() || undefined;
      item.status = String(order.status || "");
      item.shopee_order_status = String(order.shopee_order_status || "");
      item.ok =
        hasUsableShopeeTrackingNumber(order) ||
        item.steps.includes("get_order_detail") ||
        item.steps.includes("ship_order");
      if (hasUsableShopeeTrackingNumber(order)) healed += 1;

      console.log(
        `[Force Resync] ${orderSn} ok=${item.ok} status=${item.shopee_order_status || item.status || "?"} tn=${item.trackingNo || "—"} steps=${item.steps.join("|")}`,
      );
    } catch (err: any) {
      item.error = err?.message || String(err);
      console.error(`[Force Resync] ${orderSn} FAILED:`, err?.stack || err);
    }
    results.push(item);
    await sleep(SHOPEE_TRACKING_FETCH_DELAY_MS);
  }

  console.log(
    `[Force Resync] DONE attempted=${results.length} healed=${healed} ok=${results.filter((r) => r.ok).length}`,
  );
  return { attempted: results.length, healed, results };
}

/**
 * Endpoint tạm: quét DB đơn thiếu tracking_no / kẹt unprocessed → get_order_detail cập nhật ngay.
 * POST /api/orders/trigger-fix-stuck-orders  hoặc  POST /trigger-fix-stuck-orders
 */
async function triggerFixStuckOrders(opts?: {
  orderSns?: string[];
  maxAutoDetect?: number;
  tryShip?: boolean;
  lookbackMs?: number;
}): Promise<{
  attempted: number;
  healed: number;
  results: ForceResyncStuckResultItem[];
}> {
  const maxAutoDetect = Math.min(
    Math.max(Number(opts?.maxAutoDetect ?? 100) || 100, 1),
    200,
  );
  console.log(
    `[Trigger Fix Stuck] START max=${maxAutoDetect} tryShip=${opts?.tryShip !== false}`,
  );
  const result = await forceResyncStuckOrdersWithoutTracking({
    orderSns: opts?.orderSns,
    maxAutoDetect,
    tryShip: opts?.tryShip !== false,
    includePinned: true,
    lookbackMs: opts?.lookbackMs ?? 30 * 24 * 3600 * 1000,
  });
  console.log(
    `[Trigger Fix Stuck] DONE attempted=${result.attempted} healed=${result.healed}`,
  );
  return result;
}

function applyShopeeGetTrackingResponse(order: any, trackResult: any): void {
  const sn = String(order?.orderSn || "").trim();
  // Bắt buộc log cấu trúc thật từ Shopee (GHN thường khác SPX).
  console.log(`GHN_API_RESPONSE for order [${sn}]:`, JSON.stringify(trackResult));

  const resp = trackResult?.response ?? trackResult ?? {};
  // package_number thường đi kèm get_tracking_number — lưu ngay để create_shipping_document.
  const pkg = String(
    resp?.package_number ||
      resp?.package_no ||
      resp?.packageNumber ||
      trackResult?.package_number ||
      "",
  ).trim();
  if (pkg) {
    applyShopeePackageNumbers(order, [pkg]);
  }
  // GHN/J&T: ưu tiên last_mile / tracking_number; SPX: tracking_number; nội bộ: first_mile (0FG...).
  const candidates = [
    resp?.tracking_number,
    resp?.tracking_no,
    resp?.last_mile_tracking_number,
    resp?.third_party_tracking_number,
    resp?.courier_tracking_number,
    resp?.plp_number,
    resp?.first_mile_tracking_number,
  ];
  for (const c of candidates) {
    applyShopeeTrackingCode(order, c);
    if (hasUsableShopeeTrackingNumber(order)) break;
  }
  applyDeepShopeeTrackingPayload(order, trackResult, "get_tracking_number");
  // Deep walk có thể chứa package_number trong nested object.
  if (!String(order.packageNumber || "").trim()) {
    const deepPkg = extractShopeePackageNumberFromPayload(trackResult, sn);
    if (deepPkg) {
      applyShopeePackageNumbers(order, [deepPkg]);
    }
  }
  repairMisassignedTracking(order);
}

/**
 * Đồng bộ local status khi Shopee raw SHIPPED/COMPLETED
 * HOẶC logistics_status = PICKUP_DONE / LOGISTICS_SHIPPED (App quét ĐVVC).
 */
function promoteOrderStatusWhenTrackingReady(order: any): boolean {
  if (!order) return false;
  const status = String(order.status || "");
  if (
    status === "completed" ||
    status === "cancelled" ||
    status === "return_pending" ||
    status === "return_received"
  ) {
    return false;
  }
  const raw = String(order.shopee_order_status || "").toUpperCase();
  // COMPLETED / hủy / hoàn thắng logistics DELIVERY_DONE — không kẹt tab Đang giao.
  if (raw === "COMPLETED") {
    order.status = "completed";
    order.isPrepared = true;
    order.is_pending_shopee_check = false;
    return true;
  }
  if (raw === "CANCELLED" || raw === "IN_CANCEL") {
    order.status = "cancelled";
    order.isPrepared = false;
    order.is_pending_shopee_check = false;
    return true;
  }
  if (raw === "TO_RETURN") {
    if (order.status !== "return_received") order.status = "return_pending";
    order.isPrepared = false;
    order.is_pending_shopee_check = false;
    return true;
  }
  // logistics PICKUP_DONE / SHIPPED → promote raw + local (trước check status shipping).
  if (promoteRawStatusFromLogistics(order)) {
    return true;
  }
  if (status === "shipping") {
    return false;
  }
  if (raw === "SHIPPED" || raw === "TO_CONFIRM_RECEIVE") {
    order.status = "shipping";
    order.isPrepared = true;
    order.is_pending_shopee_check = false;
    return true;
  }
  return false;
}

function trackingForShopeeShippingDoc(order: any): string | undefined {
  // Chỉ gửi mã carrier thật cho create_shipping_document — KHÔNG gửi 0FG (Shopee báo invalid).
  const tn = String(order?.trackingNumber || order?.tracking_no || "").trim();
  if (tn && !isShopeeInternalTrackingCode(tn)) return tn;
  return undefined;
}

/** Bóc package_number từ payload Shopee (order detail / tracking / shipping_document). */
function extractShopeePackageNumbersFromPayload(payload: any, orderSn?: string): string[] {
  if (!payload || typeof payload !== "object") return [];
  const wantSn = String(orderSn || "").replace(/^shopee-/i, "").trim();
  const tryVal = (v: unknown): string => {
    const s = String(v || "").trim();
    return s || "";
  };
  const found = new Set<string>();
  const add = (value: unknown) => {
    const normalized = tryVal(value);
    if (normalized) found.add(normalized);
  };
  const addPackage = (pkg: any) => {
    add(pkg?.package_number || pkg?.package_no || pkg?.packageNumber);
  };
  const resp = payload?.response ?? payload;
  add(
    resp?.package_number ||
      resp?.package_no ||
      resp?.packageNumber ||
      payload?.package_number ||
      payload?.packageNumber,
  );

  const packages = Array.isArray(resp?.package_list)
    ? resp.package_list
    : Array.isArray(payload?.package_list)
      ? payload.package_list
      : [];
  for (const pkg of packages) {
    addPackage(pkg);
  }

  const orderList = Array.isArray(resp?.order_list)
    ? resp.order_list
    : Array.isArray(payload?.order_list)
      ? payload.order_list
      : Array.isArray(resp?.result_list)
        ? resp.result_list
        : Array.isArray(resp?.shipping_document_info_list)
          ? resp.shipping_document_info_list
          : [];
  for (const o of orderList) {
    const sn = String(o?.order_sn || "").replace(/^shopee-/i, "").trim();
    if (wantSn && sn && sn !== wantSn) continue;
    add(o?.package_number || o?.package_no || o?.shipping_document_info?.package_number);
    const nestedPackages = Array.isArray(o?.package_list) ? o.package_list : [];
    nestedPackages.forEach(addPackage);
  }

  const info = resp?.shipping_document_info || payload?.shipping_document_info;
  add(info?.package_number || info?.package_no);
  return [...found];
}

function extractShopeePackageNumberFromPayload(payload: any, orderSn?: string): string {
  return extractShopeePackageNumbersFromPayload(payload, orderSn)[0] || "";
}

function applyShopeePackageNumbers(order: any, packageNumbers: unknown[]): string[] {
  const unique = [
    ...new Set(
      packageNumbers
        .map((value) => String(value || "").trim())
        .filter(Boolean),
    ),
  ];
  if (unique.length === 0) return [];
  order.packageNumbers = unique;
  order.package_numbers = unique;
  order.packageNumber = unique[0];
  order.package_number = unique[0];
  return unique;
}

/** Build đầy đủ order_list cho create/get/download — mỗi package_number là một row riêng. */
function buildShopeeShippingDocOrderRows(order: any): ShopeeWaybillOrderRow[] {
  const orderSn = String(order?.orderSn || order?.order_sn || "").trim();
  if (!orderSn) return [];
  const packageNumbers = [
    ...(Array.isArray(order?.packageNumbers) ? order.packageNumbers : []),
    ...(Array.isArray(order?.package_numbers) ? order.package_numbers : []),
    ...(Array.isArray(order?.data?.packageNumbers) ? order.data.packageNumbers : []),
    ...(Array.isArray(order?.data?.package_numbers) ? order.data.package_numbers : []),
    order?.packageNumber,
    order?.package_number,
  ]
    .map((value) => String(value || "").trim())
    .filter(Boolean);
  const uniquePackages = [...new Set(packageNumbers)];
  if (uniquePackages.length === 0) return [];
  const tn = trackingForShopeeShippingDoc(order);
  return uniquePackages.map((packageNumber) => ({
    order_sn: orderSn,
    package_number: packageNumber,
    shipping_document_type: SHOPEE_SHIPPING_DOCUMENT_TYPE,
    ...(tn ? { tracking_number: tn } : {}),
  }));
}

/**
 * Trước create_shipping_document: bắt buộc cố lấy package_number (+ tracking_number)
 * qua get_order_detail / get_tracking_number / get_shipping_document_data_info.
 * Sau mỗi lần lấy được → ghi Mongo ngay (tránh mất package_number lần in sau).
 * get_order_detail "not found" → đánh dấu order.__shopeeOrderNotFound (cấm bước tiếp theo).
 */
async function enrichOrdersPackageAndTrackingForPrint(
  shopId: string,
  accessToken: string,
  orders: any[],
): Promise<void> {
  if (!orders.length) return;

  // Luôn lấy order detail để phát hiện đầy đủ đơn nhiều package; không dựa vào package đầu đã cache.
  const needDetail = orders;
  if (needDetail.length > 0) {
    const sns = [
      ...new Set(needDetail.map((o) => String(o.orderSn || "").trim()).filter(Boolean)),
    ];
    for (let i = 0; i < sns.length; i += SHOPEE_ORDER_DETAIL_MAX_ORDER_SNS) {
      const chunk = sns.slice(i, i + SHOPEE_ORDER_DETAIL_MAX_ORDER_SNS);
      try {
        const detailResult = await shopeeGetOrderDetail(shopId, accessToken, chunk);
        console.log(
          `[Shopee Print Enrich] get_order_detail shop=${shopId} n=${chunk.length} response=`,
          JSON.stringify(detailResult),
        );
        if (isShopeeOrderNotFoundError(detailResult?.error, detailResult?.message)) {
          console.warn(
            `[Shopee Print Enrich] get_order_detail NOT FOUND shop=${shopId} sns=${chunk.join(",")}`,
          );
          for (const sn of chunk) {
            const order = orders.find((o) => String(o.orderSn) === sn);
            if (order) order.__shopeeOrderNotFound = true;
          }
          continue;
        }
        const detailList: any[] =
          detailResult?.response?.order_list || detailResult?.order_list || [];
        for (const detail of detailList) {
          const sn = String(detail?.order_sn || "").trim();
          const order = orders.find((o) => String(o.orderSn) === sn);
          if (!order) continue;
          applyShopeePackageListTracking(order, detail);
          applyShopeePackageNumbers(order, extractShopeePackageNumbersFromPayload(detail, sn));
          const pkgs = Array.isArray(detail?.package_list) ? detail.package_list : [];
          const pkgTn = pickBestTrackingNumber(
            pkgs[0]?.tracking_number,
            pkgs[0]?.tracking_no,
            detail?.tracking_number,
            detail?.tracking_no,
          );
          if (pkgTn && !isShopeeInternalTrackingCode(pkgTn)) {
            order.trackingNumber = pkgTn;
            order.tracking_no = pkgTn;
          }
        }
      } catch (err: any) {
        if (isShopeeOrderNotFoundError(err?.code || err?.error, err?.message || err)) {
          for (const sn of chunk) {
            const order = orders.find((o) => String(o.orderSn) === sn);
            if (order) order.__shopeeOrderNotFound = true;
          }
          console.warn(
            `[Shopee Print Enrich] get_order_detail NOT FOUND (throw) shop=${shopId}:`,
            err?.message || err,
          );
        } else {
          console.warn(
            `[Shopee Print Enrich] get_order_detail fail shop=${shopId}:`,
            err?.message || err,
          );
        }
      }
      if (i + SHOPEE_ORDER_DETAIL_MAX_ORDER_SNS < sns.length) await sleep(PRINT_API_DELAY_MS);
    }
  }

  let nextOrderIndex = 0;
  const enrichWorker = async () => {
    while (nextOrderIndex < orders.length) {
    const i = nextOrderIndex++;
    const order = orders[i];
    const sn = String(order?.orderSn || "").trim();
    if (!sn) continue;
    if (order.__shopeeOrderNotFound) continue;
    const needPkg = !String(order.packageNumber || order.package_number || "").trim();
    const needTn = !trackingForShopeeShippingDoc(order);
    if (!needPkg && !needTn) {
      // Đã đủ → vẫn sync Mongo nếu có package vừa hydrate từ DB cũ thiếu root field.
      await persistOrderTrackingToDb(order).catch(() => {});
      continue;
    }

    try {
      // Đơn vừa xác nhận: get_tracking_number thường trả kèm package_number.
      const tnRes = await shopeeGetTrackingNumber(
        shopId,
        accessToken,
        sn,
        String(order.packageNumber || order.package_number || "").trim() || undefined,
      );
      console.log(
        `[Shopee Print Enrich] get_tracking_number order_sn=${sn} response=`,
        JSON.stringify(tnRes),
      );
      applyShopeeGetTrackingResponse(order, tnRes);
    } catch (err: any) {
      console.warn(`[Shopee Print Enrich] get_tracking_number ${sn}:`, err?.message || err);
    }

    if (!String(order.packageNumber || order.package_number || "").trim()) {
      try {
        const docInfo = await shopeeGetShippingDocumentDataInfo(
          shopId,
          accessToken,
          sn,
          String(order.packageNumber || order.package_number || "").trim() || undefined,
        );
        console.log(
          `[Shopee Print Enrich] get_shipping_document_data_info order_sn=${sn} response=`,
          JSON.stringify(docInfo),
        );
        applyDeepShopeeTrackingPayload(order, docInfo, "get_shipping_document_data_info");
        applyShopeePackageNumbers(order, extractShopeePackageNumbersFromPayload(docInfo, sn));
        const list =
          docInfo?.response?.shipping_document_info_list ||
          docInfo?.response?.order_list ||
          docInfo?.response?.result_list ||
          [];
        const first = Array.isArray(list) ? list[0] : null;
        const tn = pickBestTrackingNumber(
          first?.tracking_number,
          first?.tracking_no,
          docInfo?.response?.shipping_document_info?.tracking_number,
        );
        if (tn && !isShopeeInternalTrackingCode(tn)) {
          order.trackingNumber = tn;
          order.tracking_no = tn;
        }
      } catch (err: any) {
        console.warn(
          `[Shopee Print Enrich] get_shipping_document_data_info ${sn}:`,
          err?.message || err,
        );
      }
    }

    // Vẫn thiếu package_number → get_order_detail 1 đơn lẻ lần nữa (đơn mới xác nhận).
    if (!String(order.packageNumber || order.package_number || "").trim()) {
      try {
        const detailResult = await shopeeGetOrderDetail(shopId, accessToken, [sn]);
        if (isShopeeOrderNotFoundError(detailResult?.error, detailResult?.message)) {
          order.__shopeeOrderNotFound = true;
          console.warn(`[Shopee Print Enrich] get_order_detail retry NOT FOUND ${sn}`);
          continue;
        }
        const detailList: any[] =
          detailResult?.response?.order_list || detailResult?.order_list || [];
        const detail = detailList.find((d: any) => String(d?.order_sn || "") === sn) || detailList[0];
        if (detail) {
          applyShopeePackageListTracking(order, detail);
          applyShopeePackageNumbers(order, extractShopeePackageNumbersFromPayload(detail, sn));
        }
      } catch (err: any) {
        if (isShopeeOrderNotFoundError(err?.code || err?.error, err?.message || err)) {
          order.__shopeeOrderNotFound = true;
          console.warn(`[Shopee Print Enrich] get_order_detail retry NOT FOUND ${sn}:`, err?.message || err);
          continue;
        }
        console.warn(`[Shopee Print Enrich] get_order_detail retry ${sn}:`, err?.message || err);
      }
    }

    // Đồng bộ package/tracking vừa lấy về Mongo trước khi create_shipping_document.
    await persistOrderTrackingToDb(order).catch((err: any) => {
      console.warn(`[Shopee Print Enrich] persist ${sn}:`, err?.message || err);
    });

    console.log(
      `[Shopee Print Enrich] order_sn=${sn} package_numbers=${buildShopeeShippingDocOrderRows(order).map((row) => row.package_number).join(",") || "(empty)"} tracking=${trackingForShopeeShippingDoc(order) || "(empty)"}`,
    );
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(3, orders.length) }, () => enrichWorker()),
  );
}

function orderHasPrintableTracking(order: any): boolean {
  const tn = String(trackingForShopeeShippingDoc(order) || "").trim();
  return Boolean(tn);
}

function applyShopeePackageListTracking(order: any, shopeeOrder: any): void {
  // Deep parse toàn bộ order detail (tracking_no / package_list / shipping_document_info)
  applyDeepShopeeTrackingPayload(order, shopeeOrder, "get_order_detail");

  const sn = String(order?.orderSn || shopeeOrder?.order_sn || "").trim();
  applyShopeePackageNumbers(order, extractShopeePackageNumbersFromPayload(shopeeOrder, sn));

  const packages = Array.isArray(shopeeOrder?.package_list) ? shopeeOrder.package_list : [];
  if (!order.packageNumber) {
    const withPkg = packages.find((p: any) => p?.package_number);
    if (withPkg?.package_number) {
      order.packageNumber = String(withPkg.package_number);
      order.package_number = String(withPkg.package_number);
    }
  }
  for (const pkg of packages) {
    if (pkg?.package_number && !order.packageNumber) {
      order.packageNumber = String(pkg.package_number);
      order.package_number = String(pkg.package_number);
    }
    const pkgTn = pickBestTrackingNumber(pkg?.tracking_number, pkg?.tracking_no);
    if (pkgTn && !hasUsableShopeeTrackingNumber(order)) {
      order.trackingNumber = pkgTn;
      order.tracking_no = pkgTn;
    }
    const logisticsStatus = String(pkg?.logistics_status || "").toUpperCase();
    if (logisticsStatus) {
      const prev = String(order.logistics_status || "").toUpperCase();
      const prevIsRts =
        prev.includes("LOGISTICS_DELIVERY_FAILED") ||
        prev.includes("LOGISTICS_LOST") ||
        prev.includes("LOGISTICS_COD_REJECTED");
      if (!prevIsRts) order.logistics_status = logisticsStatus;
    }
    if (isLogisticsHandedToCarrier(logisticsStatus)) {
      // App quét ĐVVC: LOGISTICS_PICKUP_DONE / LOGISTICS_SHIPPED → SHIPPED + Đang giao
      promoteRawStatusFromLogistics(order, logisticsStatus);
    }
  }
  repairMisassignedTracking(order);
}

/** Các tab local cần có mã vận đơn để quét QR. */
const SHOPEE_TRACKING_ENRICH_STATUSES = new Set([
  "pending_confirm",
  "unprocessed",
  "processed",
  "shipping",
  "completed",
  "cancelled",
  "return_pending",
  "return_received",
]);

/**
 * Trạng thái Shopee CÓ THỂ đã có mã vận đơn → bắt buộc gọi get_tracking_number nếu DB trống.
 * Chuẩn: READY_TO_SHIP, SHIPPED, TO_CONFIRM_RECEIVE, COMPLETED, CANCELLED, INVOICE_PENDING
 * (+ PROCESSED/RETRY_SHIP/IN_CANCEL/TO_RETURN — App Shopee / hoàn hàng).
 */
const SHOPEE_RAW_STATUSES_MAY_HAVE_TRACKING = new Set([
  "READY_TO_SHIP",
  "PROCESSED",
  "RETRY_SHIP",
  "SHIPPED",
  "TO_CONFIRM_RECEIVE",
  "COMPLETED",
  "CANCELLED",
  "IN_CANCEL",
  "TO_RETURN",
  "INVOICE_PENDING",
]);

function hasUsableShopeeTrackingNumber(order: any): boolean {
  const tn = String(
    order?.return_tracking_no ||
      order?.trackingNumber ||
      order?.tracking_no ||
      order?.shopee_tracking_number ||
      "",
  ).trim();
  if (tn && !isShopeeInternalTrackingCode(tn)) {
    // Đồng bộ mirror fields để UI/quét barcode nhận cùng một mã.
    if (!order.trackingNumber) order.trackingNumber = tn;
    if (!order.tracking_no) order.tracking_no = tn;
    return true;
  }
  return false;
}

/** Đơn có thể đã có tracking_no trên Shopee (kể cả Hủy / Đang giao / App). */
function orderMayHaveShopeeTrackingNumber(order: any): boolean {
  if (!order || String(order.channel || "") !== "shopee") return false;
  const status = String(order.status || "");
  const raw = String(order.shopee_order_status || "").toUpperCase();
  if (SHOPEE_TRACKING_ENRICH_STATUSES.has(status)) return true;
  if (SHOPEE_RAW_STATUSES_MAY_HAVE_TRACKING.has(raw)) return true;
  // Giao không thành công / hoàn hàng
  if (order.shopee_cancel_return_kind || order.return_sn) return true;
  return false;
}

function needsShopeeTrackingEnrichment(order: any): boolean {
  if (order.channel !== "shopee") return false;
  if (orderNeedsRealReturnTracking(order)) return true;
  if (hasUsableShopeeTrackingNumber(order)) return false;
  return orderMayHaveShopeeTrackingNumber(order);
}

/**
 * Gọi ĐỘC LẬP v2.logistics.get_tracking_number → ép ghi tracking_no vào DB (updateOne).
 * Bọc try/catch: lỗi 1 đơn (CANCELLED chưa có mã, error code Shopee…) KHÔNG làm sập vòng lặp.
 */
async function fetchAndForceSaveTrackingNumber(
  apiShopId: string,
  accessToken: string,
  order: any,
  opts?: { retries?: number },
): Promise<boolean> {
  if (!order?.orderSn) return false;
  if (!needsShopeeTrackingEnrichment(order)) return hasUsableShopeeTrackingNumber(order);

  try {
    // Đơn hủy/hoàn: full enrich (get_return_detail / reverse_tracking) — light bỏ qua returns API.
    const useLight = !(isCancelOrReturnOrderStatus(order) || order.return_sn);
    await enrichShopeeOrderTrackingFromApi(apiShopId, accessToken, order, {
      light: useLight,
      retries: opts?.retries ?? 2,
    });
    promoteOrderStatusWhenTrackingReady(order);
    enforceShopeeTerminalLocalStatus(order);

    if (hasUsableShopeeTrackingNumber(order)) {
      // Cưỡng chế ghi đè tracking_no thẳng DB (độc lập, không phụ thuộc bulkWrite).
      await persistOrderTrackingToDb(order);
      return true;
    }
    return false;
  } catch (err: any) {
    console.warn(
      `[Shopee Tracking] get_tracking_number skip order_sn=${order.orderSn} status=${order.shopee_order_status || order.status}:`,
      err?.message || err,
    );
    return false;
  }
}

/** Sau sync: cưỡng bức gọi get_tracking_number cho mọi đơn thiếu mã ở tab Chờ lấy hàng / Đang giao / Hủy. */
/** Gọi get_tracking_number kèm retry (rate-limit / delay Shopee). */
async function shopeeGetTrackingNumberWithRetry(
  shopId: string,
  accessToken: string,
  orderSn: string,
  packageNumber?: string,
  retries = 3,
): Promise<any> {
  let last: any = null;
  const maxAttempts = Math.max(1, retries);
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      last = await shopeeGetTrackingNumber(shopId, accessToken, orderSn, packageNumber);
      const extracted = deepExtractShopeeTrackingCodes(last);
      const tn = String(extracted.carrier || last?.response?.tracking_number || "").trim();
      if (tn) {
        if (attempt > 1) {
          console.log(`[Shopee Tracking] Retry OK order_sn=${orderSn} attempt=${attempt} tn=${tn}`);
        }
        return last;
      }
      const errBlob = `${last?.error || ""} ${last?.message || ""}`.toLowerCase();
      // GHN chưa sẵn mã (empty / not ready) = trạng thái thường — KHÔNG retry trong sync.
      const retriable =
        errBlob.includes("rate") ||
        errBlob.includes("too many") ||
        errBlob.includes("timeout") ||
        errBlob.includes("busy") ||
        errBlob.includes("try again");
      // Chỉ log lần cuối — "chưa có mã" là trạng thái thường gặp, không spam warn.
      if (attempt >= maxAttempts) {
        console.log(
          `[Shopee Tracking] attempt ${attempt}/${maxAttempts} order_sn=${orderSn} chưa có mã — error="${last?.error || ""}" message="${last?.message || ""}"`,
        );
      }
      if (!retriable || attempt >= maxAttempts) return last;
    } catch (err: any) {
      console.warn(
        `[Shopee Tracking] attempt ${attempt}/${maxAttempts} order_sn=${orderSn} exception:`,
        err?.message || err,
      );
      last = { error: "exception", message: err?.message || String(err) };
      if (attempt >= maxAttempts) return last;
    }
    await sleep(300);
  }
  return last;
}

/**
 * Fallback đa lớp mã vận đơn:
 * 1) tracking đã có từ get_order_detail
 * 2) v2.logistics.get_tracking_number (+ shipping_document)
 * 3) v2.returns.get_return_detail / get_reverse_tracking_info (đơn hoàn)
 * 4) escrow deep-scan
 * Cuối cùng: giữ mã cũ trong DB; nếu vẫn trống → log cảnh báo + payload.
 */
async function enrichShopeeOrderTrackingFromApi(
  shopId: string,
  accessToken: string,
  order: any,
  opts?: { retries?: number; light?: boolean },
): Promise<any> {
  repairMisassignedTracking(order);
  const light = opts?.light === true;
  const retries = opts?.retries ?? (light ? 2 : 3);
  const existingTn = String(
    order?.trackingNumber || order?.tracking_no || order?.shopee_tracking_number || "",
  ).trim();
  if (!needsShopeeTrackingEnrichment(order) && hasUsableShopeeTrackingNumber(order)) {
    return order;
  }

  const applyTn = (code: string | undefined, source: string) => {
    const tn = String(code || "").trim();
    if (!tn) return false;
    const isReturnSource =
      source === "get_return_detail" || source === "get_reverse_tracking_info";
    if (isReturnSource) {
      const distinct = distinctReturnTracking(
        tn,
        order.trackingNumber || order.tracking_no || existingTn,
      );
      if (distinct) applyReturnTrackingAliases(order, distinct);
      console.log(`[Shopee Tracking] Fallback OK order_sn=${order.orderSn} source=${source} tn=${tn}`);
      return Boolean(distinct);
    }
    order.trackingNumber = tn;
    order.tracking_no = tn;
    console.log(`[Shopee Tracking] Fallback OK order_sn=${order.orderSn} source=${source} tn=${tn}`);
    return true;
  };

  try {
    // Nguồn 1: đã có outbound và đã có mã hoàn thật → không gọi API thêm.
    if (hasUsableShopeeTrackingNumber(order) && !orderNeedsRealReturnTracking(order)) {
      await persistOrderTrackingToDb(order);
      return order;
    }

    // Nguồn 2: logistics.get_tracking_number (caller PHẢI await tuần tự từng đơn)
    const pkgNum = String(order.packageNumber || "").trim() || undefined;
    if (!hasUsableShopeeTrackingNumber(order)) {
      let result = await shopeeGetTrackingNumberWithRetry(
        shopId,
        accessToken,
        order.orderSn,
        pkgNum,
        retries,
      );
      console.log(
        "=== KẾT QUẢ API TRACKING ===",
        "Đơn:",
        order.orderSn,
        "Response:",
        JSON.stringify(result),
      );
      applyShopeeGetTrackingResponse(order, result);

      // Retry không kèm package_number — bỏ qua khi light (print) để tránh +1–2 API/đơn.
      if (!light && !hasUsableShopeeTrackingNumber(order) && pkgNum) {
        result = await shopeeGetTrackingNumberWithRetry(
          shopId,
          accessToken,
          order.orderSn,
          undefined,
          Math.max(2, retries),
        );
        applyShopeeGetTrackingResponse(order, result);
      }

      if (!hasUsableShopeeTrackingNumber(order)) {
        // light/print: bỏ get_shipping_document_data_info — chỉ cần get_tracking_number.
        if (!light) {
          try {
            const docInfo = await shopeeGetShippingDocumentDataInfo(
              shopId,
              accessToken,
              order.orderSn,
              order.packageNumber,
            );
            applyDeepShopeeTrackingPayload(order, docInfo, "get_shipping_document_data_info");
          } catch (docErr: any) {
            console.warn(
              `[Shopee Tracking] shipping_document_data_info ${order.orderSn}:`,
              docErr?.message || docErr,
            );
          }
        }
      }
    }

    // Nguồn 3: mã chiều hoàn — gọi reverse kể cả khi đã có outbound.
    if (!light && orderNeedsRealReturnTracking(order)) {
      await fillReturnTrackingFromShopee(shopId, accessToken, order);
    }

    // Nguồn 4: escrow — bỏ qua khi light (rất nặng khi bulk sync)
    if (!light && !hasUsableShopeeTrackingNumber(order) && order.orderSn) {
      try {
        const escrow = await shopeeGetEscrowDetail(shopId, accessToken, order.orderSn);
        if (!escrow?.error) {
          const tn = extractTrackingFromReturnPayload(escrow);
          if (tn) applyTn(tn, "get_escrow_detail");
          else applyDeepShopeeTrackingPayload(order, escrow, "get_escrow_detail");
        }
      } catch {
        /* escrow không bắt buộc */
      }
    }

    // Giữ mã cũ nếu mọi nguồn rỗng
    if (!hasUsableShopeeTrackingNumber(order) && existingTn) {
      order.trackingNumber = existingTn;
      order.tracking_no = existingTn;
    }

    if (hasUsableShopeeTrackingNumber(order)) {
      promoteOrderStatusWhenTrackingReady(order);
      await persistOrderTrackingToDb(order);
    } else {
      setTrackingEnrichCooldown(order, "missing_tracking_after_fallback");
      console.log(
        `[Shopee Tracking] THIẾU MÃ sau mọi fallback — order_sn=${order.orderSn} return_sn=${order.return_sn || ""} status=${order.status} raw=${order.shopee_order_status || ""} existingTn=${existingTn || "(empty)"} cooldown=${isPickupAwaitingTrackingStatus(order) ? "10m" : "8h"}`,
      );
    }
  } catch (err) {
    console.warn(`[Shopee Tracking] enrich ${order.orderSn} failed:`, err);
    setTrackingEnrichCooldown(order, "enrich_exception");
    if (existingTn && !hasUsableShopeeTrackingNumber(order)) {
      order.trackingNumber = existingTn;
      order.tracking_no = existingTn;
    }
  }
  if (hasUsableShopeeTrackingNumber(order)) {
    promoteOrderStatusWhenTrackingReady(order);
  }
  // Đơn hủy/hoàn không có tracking_code: vẫn persist được package_number / return_tracking_no.
  if (!hasUsableShopeeTrackingNumber(order) && (isCancelOrReturnOrderStatus(order) || order.return_sn)) {
    try {
      await persistOrderTrackingToDb(order);
    } catch {
      /* không throw — cancelled order thiếu tracking là expected */
    }
  }
  return order;
}

const SHOPEE_TRACKING_ENRICH_INTERVAL_MS = 10 * 60 * 1000;
const SHOPEE_TRACKING_ENRICH_LOOKBACK_MS = 14 * 24 * 60 * 60 * 1000;
const SHOPEE_TRACKING_ENRICH_BATCH_LIMIT = 40;
const SHOPEE_TRACKING_ENRICH_BATCH_SIZE = 10;
let shopeeTrackingEnrichInFlight = false;
let shopeeTrackingEnrichTimer: ReturnType<typeof setInterval> | undefined;
let shopeeTrackingEnrichBootTimer: ReturnType<typeof setTimeout> | undefined;
let shopeeCancelReturnCronTimer: ReturnType<typeof setInterval> | undefined;
let ghnBackfillInFlight = false;

/** Lấy mã GHN/SPX thô từ get_tracking_number — không Regex bắt chữ cái, không check hãng. */
function extractRawGhnTrackingNumber(payload: any): string {
  const resp = payload?.response ?? payload ?? {};
  const candidates = [
    resp?.tracking_number,
    resp?.tracking_no,
    resp?.last_mile_tracking_number,
    resp?.third_party_tracking_number,
    resp?.courier_tracking_number,
    resp?.plp_number,
    payload?.tracking_number,
    payload?.tracking_no,
  ];
  for (const c of candidates) {
    const s = String(c ?? "").trim();
    if (!s || s.length < 6 || s.length > 40) continue;
    if (/^0FG/i.test(s)) continue;
    return s;
  }
  return "";
}

function formatShopeeLogisticsBackfillError(result: any): string {
  const error = String(result?.error || "").trim();
  const message = String(result?.message || result?.msg || "").trim();
  const blob = `${error} ${message}`.toLowerCase();
  if (
    blob.includes("shipping document") ||
    blob.includes("create_shipping_document") ||
    blob.includes("document_not") ||
    blob.includes("need to create")
  ) {
    return `chưa create shipping document (${error || "error"}: ${message || "-"})`;
  }
  if (
    blob.includes("arrange") ||
    blob.includes("ship_order") ||
    blob.includes("not ready") ||
    blob.includes("package_number") ||
    blob.includes("logistics.invalid")
  ) {
    return `chưa xác nhận đơn / Arrange Shipment (${error || "error"}: ${message || "-"})`;
  }
  if (!error && !message) return "empty_tracking (Shopee chưa cấp mã)";
  return `${error || "error"}: ${message || "-"}`;
}

/**
 * Job bù mã GHN: quét READY_TO_SHIP / PROCESSED (tracking_no rỗng) → get_tracking_number
 * → bulkWrite $set thẳng DB. Không Regex kén chọn, không isTrackingCompatibleWithCarrier.
 */
async function backfillMissingGhnTrackingNumbers(): Promise<{
  skipped?: boolean;
  message?: string;
  candidates: number;
  filled: number;
  errors: number;
}> {
  if (ghnBackfillInFlight) {
    console.log("[GHN Backfill] SKIPPED — job đang chạy (mutex busy).");
    return { skipped: true, message: "busy", candidates: 0, filled: 0, errors: 0 };
  }
  if (!isMongoReady()) {
    console.warn("[GHN Backfill] SKIPPED — Mongo chưa sẵn sàng.");
    return { skipped: true, message: "mongo_not_ready", candidates: 0, filled: 0, errors: 0 };
  }

  ghnBackfillInFlight = true;
  let candidatesCount = 0;
  let filled = 0;
  let errors = 0;
  const pendingWrites: Array<{
    orderSn: string;
    trackingNo: string;
    packageNumber?: string;
    shopId?: string;
  }> = [];

  try {
    const orders = await loadGhnBackfillCandidatesFromStore({
      lookbackMs: SHOPEE_TRACKING_ENRICH_LOOKBACK_MS,
      limit: SHOPEE_TRACKING_ENRICH_BATCH_LIMIT,
    });
    const candidates = orders.filter((order: any) => {
      if (!order?.orderSn) return false;
      if (hasUsableOutboundShopeeTracking(order)) return false;
      const raw = String(order?.shopee_order_status || "").toUpperCase();
      const st = String(order?.status || "").toLowerCase();
      return (
        raw === "READY_TO_SHIP" ||
        raw === "PROCESSED" ||
        raw === "RETRY_SHIP" ||
        st === "unprocessed" ||
        st === "processed"
      );
    });
    candidatesCount = candidates.length;
    if (candidates.length === 0) {
      console.log("[GHN Backfill] Không có đơn READY_TO_SHIP/PROCESSED thiếu mã.");
      return { candidates: 0, filled: 0, errors: 0 };
    }

    console.log(`[GHN Backfill] START candidates=${candidates.length}`);
    const byShop = new Map<string, any[]>();
    for (const order of candidates) {
      const shopId = resolveOrderShopId(order);
      if (!shopId) {
        errors += 1;
        console.warn(`[GHN Backfill] Skip order_sn=${order.orderSn} — thiếu shop_id.`);
        continue;
      }
      const group = byShop.get(shopId) || [];
      group.push(order);
      byShop.set(shopId, group);
    }

    for (const [shopId, shopOrders] of byShop) {
      let accessToken: string | null = null;
      try {
        accessToken = await getValidShopeeAccessToken(shopId);
      } catch (tokenErr: any) {
        errors += shopOrders.length;
        console.warn(
          `[GHN Backfill] Shop ${shopId} access_token exception:`,
          tokenErr?.message || tokenErr,
        );
        continue;
      }
      if (!accessToken) {
        errors += shopOrders.length;
        console.warn(`[GHN Backfill] Shop ${shopId}: không lấy được access_token.`);
        continue;
      }

      for (const order of shopOrders) {
        const orderSn = String(order.orderSn || "").trim();
        console.log("[GHN Backfill] Syncing order: " + orderSn);
        try {
          const pkgNum = String(order.packageNumber || order.package_number || "").trim() || undefined;
          let result: any = null;
          try {
            result = await shopeeGetTrackingNumber(shopId, accessToken, orderSn, pkgNum);
          } catch (apiErr: any) {
            console.warn(
              `[GHN Backfill] get_tracking_number exception order_sn=${orderSn}:`,
              apiErr?.message || apiErr,
            );
            errors += 1;
            await sleep(SHOPEE_TRACKING_FETCH_DELAY_MS);
            continue;
          }

          let tn = extractRawGhnTrackingNumber(result);
          if (!tn) {
            try {
              applyShopeeGetTrackingResponse(order, result);
              tn = extractRawGhnTrackingNumber({
                response: {
                  tracking_number: order.trackingNumber || order.tracking_no,
                },
              });
              if (hasUsableOutboundShopeeTracking(order)) {
                tn = String(order.trackingNumber || order.tracking_no || "").trim();
              }
            } catch (parseErr: any) {
              console.warn(
                `[GHN Backfill] parse response order_sn=${orderSn}:`,
                parseErr?.message || parseErr,
              );
            }
          }

          if (tn && !/^0FG/i.test(tn)) {
            order.trackingNumber = tn;
            order.tracking_no = tn;
            const pkg = String(order.packageNumber || order.package_number || pkgNum || "").trim();
            pendingWrites.push({
              orderSn,
              trackingNo: tn,
              packageNumber: pkg || undefined,
              shopId,
            });
            filled += 1;
            console.log(`[GHN Backfill] OK order_sn=${orderSn} tracking_no=${tn}`);
          } else {
            const reason = formatShopeeLogisticsBackfillError(result);
            console.log(
              `[GHN Backfill] CHƯA CÓ MÃ order_sn=${orderSn} raw=${order.shopee_order_status || "-"} reason=${reason}`,
            );
          }
        } catch (orderErr: any) {
          errors += 1;
          console.warn(
            `[GHN Backfill] order_sn=${orderSn} failed (không sập job):`,
            orderErr?.message || orderErr,
          );
        }
        await sleep(SHOPEE_TRACKING_FETCH_DELAY_MS);
      }
    }

    if (pendingWrites.length > 0) {
      try {
        await bulkSetTrackingNumbersInStore(pendingWrites);
        const pdfReady = candidates.filter((o: any) => {
          const sn = String(o?.orderSn || "").trim();
          return pendingWrites.some((w) => w.orderSn === sn) && String(o?.packageNumber || o?.package_number || "").trim();
        });
        if (pdfReady.length > 0) {
          try {
            enqueueLabelPdfDownload(pdfReady);
          } catch {
            /* PDF queue không chặn bù mã */
          }
        }
      } catch (writeErr: any) {
        errors += pendingWrites.length;
        console.warn("[GHN Backfill] bulkWrite failed:", writeErr?.message || writeErr);
      }
    }

    console.log(
      `[GHN Backfill] DONE candidates=${candidatesCount} filled=${filled} errors=${errors}`,
    );
    return { candidates: candidatesCount, filled, errors };
  } catch (err: any) {
    console.error("[GHN Backfill] FAILED:", err?.stack || err?.message || err);
    return { candidates: candidatesCount, filled, errors: errors + 1 };
  } finally {
    ghnBackfillInFlight = false;
  }
}

function getShopeeTrackingCandidateTime(order: any): number {
  const raw =
    order?.last_shopee_update_at ||
    order?.lastSynced ||
    order?.last_synced_at ||
    order?.updatedAt ||
    order?.date;
  const value = raw instanceof Date ? raw.getTime() : new Date(String(raw || "")).getTime();
  return Number.isFinite(value) ? value : 0;
}

function hasUsableOutboundShopeeTracking(order: any): boolean {
  const tracking = String(
    order?.trackingNumber || order?.tracking_no || order?.shopee_tracking_number || "",
  ).trim();
  return Boolean(tracking && !isShopeeInternalTrackingCode(tracking));
}

function needsBackgroundShopeeTrackingEnrichment(order: any, cutoffMs: number): boolean {
  if (!order) return false;
  const channel = String(order.channel || "").trim();
  // Legacy thiếu channel vẫn coi là Shopee; chỉ loại sàn khác.
  if (channel && channel !== "shopee") return false;
  if (isTrackingEnrichOnCooldown(order)) return false;
  if (getShopeeTrackingCandidateTime(order) < cutoffMs) return false;

  const isReturn = Boolean(order.return_sn) || isCancelOrReturnOrderStatus(order);
  const missingOutbound = !hasUsableOutboundShopeeTracking(order);
  if (isReturn) return missingOutbound || orderNeedsRealReturnTracking(order);
  return missingOutbound && orderMayHaveShopeeTrackingNumber(order);
}

/**
 * Bù mã vận đơn bị webhook/pull nhanh bỏ lỡ. Chạy tuần tự theo shop để giữ
 * rate-limit Shopee ổn định; mutex riêng không ảnh hưởng luồng pull đơn.
 */
async function enrichMissingShopeeTracking(): Promise<{
  skipped?: boolean;
  candidates: number;
  filled: number;
  returnFilled: number;
  errors: number;
}> {
  // Bù mã GHN (RTS/PROCESSED) trước — job riêng, bulkWrite $set, không Regex kén chọn.
  try {
    const ghn = await backfillMissingGhnTrackingNumbers();
    if (!ghn?.skipped) {
      console.log(
        `[Shopee Tracking Enrich] GHN backfill candidates=${ghn?.candidates || 0} filled=${ghn?.filled || 0}`,
      );
    }
  } catch (ghnErr: any) {
    console.warn("[Shopee Tracking Enrich] GHN backfill:", ghnErr?.message || ghnErr);
  }

  if (shopeeTrackingEnrichInFlight) {
    console.log("[Shopee Tracking Enrich] SKIPPED — job đang chạy (mutex busy).");
    return { skipped: true, candidates: 0, filled: 0, returnFilled: 0, errors: 0 };
  }
  if (!isMongoReady()) {
    console.warn("[Shopee Tracking Enrich] SKIPPED — Mongo chưa sẵn sàng.");
    return { skipped: true, candidates: 0, filled: 0, returnFilled: 0, errors: 0 };
  }

  shopeeTrackingEnrichInFlight = true;
  const retryBefore = snapshotShopeeRetryTelemetry();
  let jobId = "";
  let filled = 0;
  let returnFilled = 0;
  let errors = 0;
  let candidatesCount = 0;
  try {
    const cutoffMs = Date.now() - SHOPEE_TRACKING_ENRICH_LOOKBACK_MS;
    // Query Mongo có filter + limit — không full-scan toàn bộ collection (tránh làm chậm refresh UI).
    const orders = await loadShopeeTrackingEnrichCandidatesFromStore({
      lookbackMs: SHOPEE_TRACKING_ENRICH_LOOKBACK_MS,
      limit: SHOPEE_TRACKING_ENRICH_BATCH_LIMIT * 2,
      localStatuses: [...SHOPEE_TRACKING_ENRICH_STATUSES],
      shopeeStatuses: [...SHOPEE_RAW_STATUSES_MAY_HAVE_TRACKING],
    });
    const candidates = orders
      .filter((order: any) => needsBackgroundShopeeTrackingEnrichment(order, cutoffMs))
      .sort((a: any, b: any) => {
        const priorityScore = (o: any): number => {
          const s = String(o?.status || "").toLowerCase();
          const raw = String(o?.shopee_order_status || "").toUpperCase();
          if (
            s === "cancelled" ||
            s === "return_pending" ||
            s === "return_received" ||
            raw === "CANCELLED" ||
            raw === "IN_CANCEL" ||
            raw === "TO_RETURN" ||
            Boolean(o?.return_sn)
          ) {
            return 3;
          }
          if (
            s === "shipping" ||
            s === "processed" ||
            s === "unprocessed" ||
            raw === "SHIPPED" ||
            raw === "PROCESSED" ||
            raw === "READY_TO_SHIP" ||
            raw === "RETRY_SHIP" ||
            raw === "TO_CONFIRM_RECEIVE"
          ) {
            return 2;
          }
          return 1;
        };
        const d = priorityScore(b) - priorityScore(a);
        if (d !== 0) return d;
        return getShopeeTrackingCandidateTime(b) - getShopeeTrackingCandidateTime(a);
      })
      .slice(0, SHOPEE_TRACKING_ENRICH_BATCH_LIMIT);
    candidatesCount = candidates.length;
    if (candidates.length === 0) {
      console.log("[Shopee Tracking Enrich] Không có đơn thiếu mã trong 14 ngày.");
      return { candidates: 0, filled: 0, returnFilled: 0, errors: 0 };
    }

    const job = await createSyncJob("shopee_tracking_enrich", "scheduler");
    jobId = job.id;
    const byShop = new Map<string, any[]>();
    for (const order of candidates) {
      const shopId = resolveOrderShopId(order);
      if (!shopId) {
        errors += 1;
        console.warn(`[Shopee Tracking Enrich] Skip order_sn=${order.orderSn} — thiếu shop_id.`);
        continue;
      }
      const group = byShop.get(shopId) || [];
      group.push(order);
      byShop.set(shopId, group);
    }

    for (const [shopId, shopOrders] of byShop) {
      try {
        const accessToken = await getValidShopeeAccessToken(shopId);
        if (!accessToken) {
          errors += shopOrders.length;
          console.warn(`[Shopee Tracking Enrich] Shop ${shopId}: không lấy được access_token.`);
          continue;
        }

        let shopFilled = 0;
        let shopReturnFilled = 0;
        await runInShopeeBatches(
          shopOrders,
          async (order) => {
            const outboundBefore = String(order.trackingNumber || order.tracking_no || "").trim();
            const returnBefore = String(order.return_tracking_no || "").trim();
            const cooldownBefore = String(order.tracking_enrich_cooldown_until || "");
            try {
              // Full enrich cho đơn hoàn để chạy cả returns API; khôi phục outbound
              // sau đó vì mã chiều về luôn phải nằm riêng trong return_tracking_no.
              const isReturnLike = isCancelOrReturnOrderStatus(order) || Boolean(order.return_sn);
              await enrichShopeeOrderTrackingFromApi(shopId, accessToken, order, {
                light: !isReturnLike,
                retries: 1,
              });
              // Giữ outbound cũ nếu enrich không trả mã mới — không CLEAR vì lệch hãng.
              if (outboundBefore && !String(order.trackingNumber || order.tracking_no || "").trim()) {
                order.trackingNumber = outboundBefore;
                order.tracking_no = outboundBefore;
              }

              const outboundAfter = hasUsableOutboundShopeeTracking(order);
              const returnAfter = distinctReturnTracking(
                order.return_tracking_no || order.returnTrackingNumber,
                order.trackingNumber || order.tracking_no,
              );
              if (outboundAfter && !outboundBefore) {
                filled += 1;
                shopFilled += 1;
                const hasPkg = Boolean(
                  String(order.packageNumber || order.package_number || "").trim(),
                );
                if (hasPkg) {
                  try {
                    enqueueLabelPdfDownload([order]);
                  } catch {
                    /* PDF queue không chặn bù mã */
                  }
                }
              }
              if (returnAfter && normalizeCarrierTrackingCode(returnBefore) !== returnAfter) {
                returnFilled += 1;
                shopReturnFilled += 1;
              }
              const cooldownChanged =
                String(order.tracking_enrich_cooldown_until || "") !== cooldownBefore;
              // Upsert khi có mã mới HOẶC đã ghi cooldown (tránh CLEAR→enrich lặp mỗi 10 phút).
              if (outboundAfter || returnAfter || cooldownChanged) {
                await bulkUpsertOrdersToStore([order]);
              }
            } catch (error: any) {
              errors += 1;
              setTrackingEnrichCooldown(order, "enrich_batch_exception");
              try {
                await bulkUpsertOrdersToStore([order]);
              } catch {
                /* ignore persist cooldown failure */
              }
              console.warn(
                `[Shopee Tracking Enrich] order_sn=${order.orderSn} shop=${shopId} failed:`,
                error?.message || error,
              );
            }
          },
          {
            batchSize: SHOPEE_TRACKING_ENRICH_BATCH_SIZE,
            itemDelayMs: SHOPEE_TRACKING_FETCH_DELAY_MS,
            batchPauseMs: SHOPEE_SYNC_CHUNK_DELAY_MS,
          },
        );
        console.log(
          `[Shopee Tracking Enrich] shop=${shopId} candidates=${shopOrders.length} ` +
            `outbound_filled=${shopFilled} return_filled=${shopReturnFilled}`,
        );
      } catch (shopError: any) {
        errors += shopOrders.length;
        console.warn(
          `[Shopee Tracking Enrich] Shop ${shopId} failed; tiếp tục shop khác:`,
          shopError?.message || shopError,
        );
      }
    }

    await finishSyncJob(jobId, "succeeded", {
      candidates: candidatesCount,
      filled,
      return_filled: returnFilled,
      errors,
      retry: diffShopeeRetryTelemetry(retryBefore),
    });
    console.log(
      `[Shopee Tracking Enrich] DONE candidates=${candidatesCount} filled=${filled} ` +
        `return_filled=${returnFilled} errors=${errors}`,
    );
    return { candidates: candidatesCount, filled, returnFilled, errors };
  } catch (error: any) {
    console.error("[Shopee Tracking Enrich] FAILED:", error?.stack || error?.message || error);
    if (jobId) {
      await finishSyncJob(
        jobId,
        "failed",
        {
          candidates: candidatesCount,
          filled,
          return_filled: returnFilled,
          errors,
          retry: diffShopeeRetryTelemetry(retryBefore),
        },
        error?.message || String(error),
      );
    }
    return { candidates: candidatesCount, filled, returnFilled, errors: errors + 1 };
  } finally {
    shopeeTrackingEnrichInFlight = false;
  }
}

/** Job bù mã GHN — setInterval (Passenger-safe) + boot kick. Tắt: AUTO_TRACKING_ENRICH_CRON=0 */
function scheduleMissingShopeeTrackingEnrichment(): void {
  if (shopeeTrackingEnrichTimer) {
    clearInterval(shopeeTrackingEnrichTimer);
    shopeeTrackingEnrichTimer = undefined;
  }
  if (shopeeTrackingEnrichBootTimer) {
    clearTimeout(shopeeTrackingEnrichBootTimer);
    shopeeTrackingEnrichBootTimer = undefined;
  }

  const disabled =
    String(process.env.AUTO_TRACKING_ENRICH_CRON || "1").trim() === "0" ||
    String(process.env.AUTO_TRACKING_ENRICH_CRON || "").toLowerCase() === "off" ||
    String(process.env.AUTO_TRACKING_ENRICH_CRON || "").toLowerCase() === "false";
  if (disabled) {
    console.log("[GHN Backfill] Scheduler OFF (AUTO_TRACKING_ENRICH_CRON=0).");
    return;
  }

  const intervalMs = Math.max(
    60_000,
    Number(process.env.AUTO_TRACKING_ENRICH_MS) || SHOPEE_TRACKING_ENRICH_INTERVAL_MS,
  );
  const run = (trigger: string) => {
    console.log(`[GHN Backfill] Tick trigger=${trigger}`);
    void backfillMissingGhnTrackingNumbers()
      .then((r) => {
        if (r?.skipped) {
          console.log(`[GHN Backfill] skipped: ${r.message || "busy"}`);
          return;
        }
        console.log(
          `[GHN Backfill] tick done candidates=${r?.candidates || 0} filled=${r?.filled || 0} errors=${r?.errors || 0}`,
        );
      })
      .catch((err: any) => {
        console.warn("[GHN Backfill] tick failed:", err?.message || err);
      });
  };

  shopeeTrackingEnrichTimer = setInterval(() => run("interval"), intervalMs);
  if (typeof shopeeTrackingEnrichTimer.unref === "function") {
    shopeeTrackingEnrichTimer.unref();
  }
  shopeeTrackingEnrichBootTimer = setTimeout(() => run("boot"), 25_000);
  if (typeof shopeeTrackingEnrichBootTimer.unref === "function") {
    shopeeTrackingEnrichBootTimer.unref();
  }
  console.log(
    `[GHN Backfill] Scheduler ON — every ${Math.round(intervalMs / 1000)}s + boot kick 25s.`,
  );
}

/** TẮT hẳn — không setInterval cancel/return reconcile. */
function scheduleShopeeCancelReturnReconcile(): void {
  if (shopeeCancelReturnCronTimer) {
    clearInterval(shopeeCancelReturnCronTimer);
    shopeeCancelReturnCronTimer = undefined;
  }
  console.log("[CancelReturn Cron] Scheduler OFF — chỉ webhook + nút Làm mới.");
}

/** Auto incremental cron — node-cron mỗi 5 phút (lookback ~2h). Tắt: AUTO_ORDER_SYNC_CRON=0 */
function scheduleAutoIncrementalOrdersSyncSafe(): void {
  scheduleAutoIncrementalOrdersSync({
    lookbackSec: Number(process.env.AUTO_ORDER_SYNC_LOOKBACK_SEC) || 2 * 60 * 60,
  });
}

/** Vét READY_TO_SHIP 7 ngày — miss webhook. Tắt: AUTO_RTS_BACKFILL_CRON=0 */
function scheduleReadyToShipBackfillSafe(): void {
  scheduleReadyToShipBackfill({
    runSync: (opts: any) =>
      pullReadyToShipBackfillFromShopee({
        lookbackSec: Number(opts?.lookbackSec) || READY_TO_SHIP_BACKFILL_LOOKBACK_SEC,
        trigger: opts?.trigger || "cron",
      }),
    lookbackSec: READY_TO_SHIP_BACKFILL_LOOKBACK_SEC,
    cronExpr: process.env.AUTO_RTS_BACKFILL_CRON_EXPR || "*/10 * * * *",
  });
}

/** Cron đồng bộ Yêu cầu trả hàng (Shopee Return APIs) — mặc định 30 phút. */
function scheduleShopeeReturnRequestsSyncSafe(): void {
  scheduleShopeeReturnRequestsSync({
    runSync: async (opts) => {
      const result = await syncShopeeReturnRequests({
        mode: opts?.mode === "full" ? "full" : "incremental",
      });
      let retry = { attempted: 0, filled: 0, errors: 0 };
      try {
        retry = await retryPendingReturnTracking({
          limit: 30,
          trigger: opts?.trigger || "cron",
        });
      } catch (retryErr: any) {
        console.warn("[ReturnTracking Retry] tick failed:", retryErr?.message || retryErr);
      }
      return {
        ...result,
        updated: (result?.updated || 0) + (retry.filled || 0),
        retryAttempted: retry.attempted,
        retryFilled: retry.filled,
        message: `${result?.message || "Return requests"} | retry TN attempted=${retry.attempted} filled=${retry.filled}`,
      };
    },
    cronExpr: process.env.AUTO_RETURN_REQUESTS_CRON_EXPR || "*/30 * * * *",
  });
}

/** Dò SHIPPED cho ĐVVC + READY_TO_SHIP/PROCESSED — cron 5 phút + setInterval. Tắt: AUTO_HANDED_OVER_RECONCILE_CRON=0 */
function scheduleHandedOverStatusReconcileSafe(): void {
  scheduleHandedOverStatusReconcile({
    reconcileHandedOverCarrierStatuses: (opts) =>
      reconcileHandedOverCarrierStatuses({ ...opts, trigger: opts?.trigger || "cron" }),
    cronExpr: process.env.AUTO_HANDED_OVER_RECONCILE_CRON_EXPR || "*/5 * * * *",
    intervalMs: Number(process.env.AUTO_HANDED_OVER_RECONCILE_MS) || 5 * 60 * 1000,
  });
}

/**
 * Scanner chuyên trị mã vận đơn:
 * Query mọi đơn READY_TO_SHIP / SHIPPING / CANCELLED / TO_RETURN (và PROCESSED…) thiếu tracking_no,
 * gọi v2.logistics.get_tracking_number + retry.
 */
/** Bắt buộc có mã vận đơn trước khi render PDF in đơn — fetch ngay nếu thiếu. */
/** Bắt buộc có mã vận đơn THẬT (không phải 0FG) trước khi in PDF. */
async function ensureTrackingBeforePrint(
  orders: any[],
  targetOrders: any[],
  opts?: { retries?: number },
): Promise<number> {
  // Print path: 1 lần get_tracking (light) — không escrow/returns; retry ở lớp create nếu cần.
  const retries = opts?.retries ?? 1;
  let filled = 0;
  const groups: Record<string, any[]> = {};
  for (const o of targetOrders) {
    if (o.channel !== "shopee") continue;
    if (!o.shopId) {
      const resolved = resolveOrderShopId(o);
      if (resolved) o.shopId = resolved;
    }
    if (!o.shopId) continue;
    // Chỉ skip khi đã có mã carrier hợp lệ — KHÔNG coi 0FG là đủ để in.
    if (hasUsableShopeeTrackingNumber(o)) continue;
    groups[o.shopId] = groups[o.shopId] || [];
    groups[o.shopId].push(o);
  }

  // Batch tracking gate — concurrency thấp, độc lập sync nền.
  for (const [shopId, groupOrders] of Object.entries(groups)) {
    const accessToken = await getValidShopeeAccessToken(shopId);
    if (!accessToken) {
      console.error(`[Shopee Print Gate] Không có access_token shop_id=${shopId}`);
      continue;
    }
    for (let i = 0; i < groupOrders.length; i += PRINT_TRACKING_CHUNK_SIZE) {
      const chunk = groupOrders.slice(i, i + PRINT_TRACKING_CHUNK_SIZE);

      await mapWithConcurrency(chunk, PRINT_TRACKING_CONCURRENCY, async (o) => {
        try {
          console.log(
            `[Shopee Print Gate] Đơn ${o.orderSn} thiếu tracking_no — gọi get_tracking_number (light, retries=${retries})...`,
          );
          await enrichShopeeOrderTrackingFromApi(shopId, accessToken, o, {
            retries,
            light: true,
          });
          const idx = orders.findIndex((x: any) => String(x.orderSn) === String(o.orderSn));
          if (idx >= 0) {
            orders[idx].trackingNumber = o.trackingNumber;
            orders[idx].tracking_no = o.tracking_no || o.trackingNumber;
            orders[idx].internalTrackingCode = o.internalTrackingCode;
            orders[idx].packageNumber = o.packageNumber || orders[idx].packageNumber;
          }
          if (hasUsableShopeeTrackingNumber(o)) {
            filled++;
            await persistOrderTrackingToDb(o);
            console.log(
              `[Shopee Print Gate] OK order_sn=${o.orderSn} tracking_no=${o.trackingNumber}`,
            );
          } else {
            console.error(
              `[Shopee Print Gate] VẪN thiếu tracking_no order_sn=${o.orderSn} sau ${retries} lần thử`,
            );
          }
        } catch (error) {
          console.error("Lỗi 1 đơn:", error);
        }
      });

      if (i + PRINT_TRACKING_CHUNK_SIZE < groupOrders.length) {
        await sleep(PRINT_TRACKING_CHUNK_PAUSE_MS);
      }
    }
  }
  if (filled > 0) {
    try {
      await persistChangedOrdersPatch(targetOrders.filter((o) => hasUsableShopeeTrackingNumber(o)));
    } catch (err: any) {
      console.warn("[Shopee Print Gate] persistChangedOrdersPatch:", err?.message || err);
      // Không gọi saveOrders(orders) khi `orders` là scoped — sẽ ghi đè mất toàn bộ JSON.
    }
  }
  return filled;
}

/** Đơn đã Init/ship_order trên Shopee (hoặc local đã chuẩn bị). */
function isShopeeOrderPreparedForPrint(order: any): boolean {
  if (order?.isPrepared === true) return true;
  const status = String(order?.status || "").toLowerCase();
  if (
    status === "processed" ||
    status === "shipping" ||
    status === "completed" ||
    status === "handed_over"
  ) {
    return true;
  }
  const raw = String(order?.shopee_order_status || "").toUpperCase();
  return (
    raw === "PROCESSED" ||
    raw === "SHIPPED" ||
    raw === "TO_CONFIRM_RECEIVE" ||
    raw === "COMPLETED" ||
    raw === "RETRY_SHIP"
  );
}

function resolveAutoShipMethodForPrint(order: any): ShipMethod {
  const raw = String(order?.fulfillment_type || order?.ship_method || order?.shipping_method || "pickup").toLowerCase();
  return raw === "dropoff" ? "dropoff" : "pickup";
}

/** Debug NDJSON — DISABLED on hot path (was writing disk + localhost ingest). */
function agentDebugLogAc966f(_payload: {
  hypothesisId: string;
  location: string;
  message: string;
  data?: Record<string, unknown>;
  runId?: string;
}) {
  /* no-op — print/tracking path must stay fast */
}

/**
 * Chốt chặn 1 đơn trước khi in:
 * - Thiếu tracking_no → tự động ship_order → chờ → get_tracking_number → ghi DB
 * - Vẫn không có mã → ném lỗi rõ cho Frontend
 */
async function ensureOrderTrackingNoForPrint(
  order: any,
  ordersStore: any[],
): Promise<{ trackingNo: string; shopeeResponse?: any }> {
  repairMisassignedTracking(order);
  if (hasUsableShopeeTrackingNumber(order)) {
    return {
      trackingNo: String(order.trackingNumber || order.tracking_no || "").trim(),
    };
  }

  if (!order.shopId) {
    const resolved = resolveOrderShopId(order);
    if (resolved) order.shopId = resolved;
  }
  if (!order.shopId) {
    throw new Error("Lỗi tự động lấy mã từ Shopee: " + JSON.stringify({ error: "missing_shop_id" }));
  }

  const accessToken = await getValidShopeeAccessToken(String(order.shopId));
  if (!accessToken) {
    throw new Error("Lỗi tự động lấy mã từ Shopee: " + JSON.stringify({ error: "no_valid_access_token" }));
  }

  try {
    // Đơn vừa xác nhận đã ở trạng thái prepared. Không gọi ship_order thêm lần
    // nữa vì chỉ làm tăng thời gian chờ và có thể bị Shopee rate-limit.
    let shipResult: Awaited<ReturnType<typeof arrangeShipment>> | undefined;
    if (!isShopeeOrderPreparedForPrint(order)) {
      const method = resolveAutoShipMethodForPrint(order);
      agentDebugLogAc966f({
        hypothesisId: "B",
        location: "server.ts:ensureOrderTrackingNoForPrint:ship",
        message: "auto ship_order before get_tracking",
        data: { orderSn: order.orderSn, method, wasPrepared: false },
      });
      shipResult = await arrangeShipment(order, method);
      if (!shipResult.success && !isAlreadyShippedError(shipResult)) {
        throw new Error("Lỗi tự động lấy mã từ Shopee: " + JSON.stringify(shipResult));
      }
      order.isPrepared = true;
    }

    // Không sleep giả — gọi get_tracking_number ngay (Shopee trả rỗng thì retry 300ms bên trong).
    console.log(
      `[Shopee Print Gate] get_tracking_number order_sn=${order.orderSn} package=${order.packageNumber || "-"}`,
    );
    const shopeeResponse = await shopeeGetTrackingNumberWithRetry(
      String(order.shopId),
      accessToken,
      String(order.orderSn),
      order.packageNumber,
      1,
    );
    console.log(
      "=== KẾT QUẢ API TRACKING ===",
      "Đơn:",
      order.orderSn,
      "Response:",
      JSON.stringify(shopeeResponse),
    );

    applyShopeeGetTrackingResponse(order, shopeeResponse);
    const resp = shopeeResponse?.response ?? shopeeResponse ?? {};
    const candidates = [
      resp?.tracking_number,
      resp?.tracking_no,
      resp?.last_mile_tracking_number,
      resp?.third_party_tracking_number,
      order.trackingNumber,
      order.tracking_no,
      shipResult?.trackingNumber,
    ];
    let tn = "";
    for (const c of candidates) {
      const s = String(c || "").trim();
      if (s && !isShopeeInternalTrackingCode(s)) {
        tn = s;
        break;
      }
    }

    if (tn) {
      order.trackingNumber = tn;
      order.tracking_no = tn;
      const idx = ordersStore.findIndex((x: any) => String(x.orderSn) === String(order.orderSn));
      if (idx >= 0) {
        ordersStore[idx].trackingNumber = tn;
        ordersStore[idx].tracking_no = tn;
        ordersStore[idx].isPrepared = true;
        ordersStore[idx].internalTrackingCode = order.internalTrackingCode;
        ordersStore[idx].packageNumber = order.packageNumber || ordersStore[idx].packageNumber;
      }
      await persistOrderTrackingToDb(order);
      saveOrders(ordersStore);
      agentDebugLogAc966f({
        hypothesisId: "D",
        location: "server.ts:ensureOrderTrackingNoForPrint:ok",
        message: "auto fetch tracking success",
        data: { orderSn: order.orderSn, tn },
      });
      return { trackingNo: tn, shopeeResponse };
    }

    throw new Error("Lỗi tự động lấy mã từ Shopee: " + JSON.stringify(shopeeResponse ?? {}));
  } catch (error: any) {
    const msg = String(error?.message || error || "");
    if (msg.startsWith("Lỗi tự động lấy mã từ Shopee:")) throw error;
    throw new Error(
      "Lỗi tự động lấy mã từ Shopee: " + JSON.stringify(error?.response?.data || error?.message || msg),
    );
  }
}

async function enrichShopeeOrdersTrackingBatch(
  shopId: string,
  accessToken: string,
  orders: any[],
): Promise<void> {
  for (const order of orders) {
    if (!needsShopeeTrackingEnrichment(order)) continue;
    try {
      await enrichShopeeOrderTrackingFromApi(shopId, accessToken, order, {
        light: true,
        retries: 2,
      });
      promoteOrderStatusWhenTrackingReady(order);
      if (hasUsableShopeeTrackingNumber(order)) {
        await persistOrderTrackingToDb(order);
      }
    } catch (err) {
      console.warn(`[Shopee Tracking] batch enrich ${order?.orderSn}:`, err);
    } finally {
      await sleep(SHOPEE_TRACKING_FETCH_DELAY_MS);
    }
  }
}

/** Bù get_tracking_number — STRICT for...of tuần tự + try/catch từng đơn (không treo process). */
async function repairMissingShopeeTrackingInOrders(
  orders: any[],
  opts?: { max?: number; retries?: number },
): Promise<number> {
  // Cap cao hơn — đủ bù đơn PROCESSED/SHIPPED/CANCELLED thiếu mã sau App Shopee.
  const max = Math.max(1, Math.min(opts?.max ?? 80, 200));
  const retries = opts?.retries ?? 2;
  let attempted = 0;
  let filled = 0;
  const authCache = new Map<string, { token: string; apiShopId: string } | null>();

  // Ưu tiên đơn đã xử lý / hủy / đang giao thiếu mã (đúng bug quét đơn hủy).
  const prioritized = [...orders].sort((a, b) => {
    const score = (o: any) => {
      const raw = String(o?.shopee_order_status || "").toUpperCase();
      const st = String(o?.status || "");
      if (st === "cancelled" || raw === "CANCELLED" || raw === "IN_CANCEL") return 0;
      if (st === "return_pending" || st === "return_received" || raw === "TO_RETURN") return 1;
      if (st === "processed" || raw === "PROCESSED") return 2;
      if (raw === "READY_TO_SHIP" || raw === "RETRY_SHIP" || st === "unprocessed") return 3;
      if (st === "shipping" || raw === "SHIPPED" || raw === "TO_CONFIRM_RECEIVE") return 4;
      return 5;
    };
    return score(a) - score(b);
  });

  for (const o of prioritized) {
    if (attempted >= max) break;
    if (!needsShopeeTrackingEnrichment(o) || !o.shopId) continue;
    const shopKey = String(o.shopId);
    try {
      if (!authCache.has(shopKey)) {
        const auth = await getShopeeAccessTokenForApi(shopKey);
        authCache.set(
          shopKey,
          auth?.token ? { token: auth.token, apiShopId: auth.apiShopId } : null,
        );
      }
      const auth = authCache.get(shopKey);
      if (!auth?.token) continue;
      const before = hasUsableShopeeTrackingNumber(o);
      // BẮT BUỘC dùng apiShopId (không dùng fileKey) cho get_tracking_number.
      const ok = await fetchAndForceSaveTrackingNumber(auth.apiShopId, auth.token, o, {
        retries,
      });
      attempted++;
      if (!before && ok) filled++;
    } catch (error) {
      console.error("Lỗi 1 đơn:", error);
      attempted++;
      continue;
    } finally {
      await sleep(SHOPEE_TRACKING_FETCH_DELAY_MS);
    }
  }
  if (attempted > 0) {
    saveOrders(orders);
    console.log(
      `[Shopee Tracking] repairMissingShopeeTrackingInOrders: attempted=${attempted} filled=${filled} delay=${SHOPEE_TRACKING_FETCH_DELAY_MS}ms`,
    );
  }
  return filled;
}

/**
 * Heal 1 lần: đơn Hủy/Hoàn trong Mongo thiếu tracking_no → deep fetch Shopee (light:false)
 * → ghi lại tracking_no + return_tracking_no. Dùng cho data cũ đã bị ghi đè null.
 * Chạy nền từ route — có mutex + delay 800ms giữa mỗi đơn (tránh rate-limit Shopee).
 */
let healCancelledReturnTrackingInFlight = false;

async function healCancelledReturnTrackingOrders(opts?: {
  max?: number;
  lookbackDays?: number;
  retries?: number;
}): Promise<{
  candidates: number;
  attempted: number;
  filled: number;
  stillEmpty: number;
  errors: number;
  skipped?: boolean;
  samples: Array<{ orderSn: string; trackingNo?: string; returnTrackingNo?: string; ok: boolean }>;
}> {
  const HEAL_ITEM_DELAY_MS = 800; // 500–1000ms: tránh spam / treo rate-limit Shopee
  const max = Math.min(Math.max(1, Math.floor(Number(opts?.max) || 100)), 500);
  const lookbackDays = Math.min(
    Math.max(1, Math.floor(Number(opts?.lookbackDays) || 30)),
    30,
  );
  const retries = Math.min(Math.max(1, Math.floor(Number(opts?.retries) || 2)), 3);
  const empty = {
    candidates: 0,
    attempted: 0,
    filled: 0,
    stillEmpty: 0,
    errors: 0,
    samples: [] as Array<{
      orderSn: string;
      trackingNo?: string;
      returnTrackingNo?: string;
      ok: boolean;
    }>,
  };

  if (healCancelledReturnTrackingInFlight) {
    console.log("[Heal CancelReturn Tracking] SKIPPED — job đang chạy (mutex busy).");
    return { ...empty, skipped: true };
  }
  if (!isMongoReady()) {
    console.warn("[Heal CancelReturn Tracking] SKIPPED — Mongo chưa sẵn sàng.");
    return empty;
  }

  healCancelledReturnTrackingInFlight = true;
  try {
    const candidates = await loadCancelReturnMissingTrackingFromStore({
      lookbackMs: lookbackDays * 24 * 60 * 60 * 1000,
      limit: max,
    });
    empty.candidates = candidates.length;
    if (candidates.length === 0) {
      console.log("[Heal CancelReturn Tracking] Không có đơn hủy/hoàn thiếu mã trong cửa sổ quét.");
      return empty;
    }

    console.log(
      `[Heal CancelReturn Tracking] Bắt đầu deep heal ${candidates.length} đơn` +
        ` (lookback=${lookbackDays}d, light=false, delay=${HEAL_ITEM_DELAY_MS}ms)...`,
    );

    const authCache = new Map<string, { token: string; apiShopId: string } | null>();
    let attempted = 0;
    let filled = 0;
    let stillEmpty = 0;
    let errors = 0;
    const samples: Array<{
      orderSn: string;
      trackingNo?: string;
      returnTrackingNo?: string;
      ok: boolean;
    }> = [];

    for (const order of candidates) {
      const sn = String(order?.orderSn || "").trim();
      if (!sn) continue;
      const shopKey = String(order.shopId || "").trim();
      if (!shopKey) {
        errors += 1;
        samples.push({ orderSn: sn, ok: false });
        continue;
      }

      // Xóa cooldown cũ để ép fetch lại (data đã bị null từ trước).
      delete order.tracking_enrich_cooldown_until;
      delete order.tracking_enrich_cooldown_reason;

      try {
        if (!authCache.has(shopKey)) {
          const auth = await getShopeeAccessTokenForApi(shopKey);
          authCache.set(
            shopKey,
            auth?.token ? { token: auth.token, apiShopId: auth.apiShopId } : null,
          );
        }
        const auth = authCache.get(shopKey);
        if (!auth?.token) {
          errors += 1;
          samples.push({ orderSn: sn, ok: false });
          continue;
        }

        attempted += 1;
        // Deep sync — TUYỆT ĐỐI light:false (get_tracking_number + shipping_document + returns API).
        await enrichShopeeOrderTrackingFromApi(auth.apiShopId, auth.token, order, {
          light: false,
          retries,
        });

        if (hasUsableShopeeTrackingNumber(order) || distinctReturnTracking(order.return_tracking_no, order.trackingNumber || order.tracking_no)) {
          await persistOrderTrackingToDb(order);
          try {
            await bulkUpsertOrdersToStore([order]);
          } catch (upErr: any) {
            console.warn(
              `[Heal CancelReturn Tracking] bulkUpsert ${sn}:`,
              upErr?.message || upErr,
            );
          }
          filled += 1;
          samples.push({
            orderSn: sn,
            trackingNo: String(order.trackingNumber || order.tracking_no || "").trim() || undefined,
            returnTrackingNo: String(order.return_tracking_no || "").trim() || undefined,
            ok: true,
          });
          console.log(
            `[Heal CancelReturn Tracking] OK order_sn=${sn}` +
              ` tn=${order.tracking_no || order.trackingNumber || "—"}` +
              ` rtn=${order.return_tracking_no || "—"}`,
          );
        } else {
          stillEmpty += 1;
          samples.push({ orderSn: sn, ok: false });
          console.log(
            `[Heal CancelReturn Tracking] VẪN TRỐNG order_sn=${sn}` +
              ` status=${order.status} raw=${order.shopee_order_status || "—"}` +
              ` return_sn=${order.return_sn || "—"}`,
          );
          // Đơn hủy/hoàn không có tracking_code vẫn upsert để cập nhật các field khác.
          // bulkUpsertOrdersToStore an toàn với tracking_code rỗng — không throw.
          try {
            await bulkUpsertOrdersToStore([order]);
          } catch (upErr: any) {
            console.warn(
              `[Heal CancelReturn Tracking] bulkUpsert stillEmpty ${sn}:`,
              upErr?.message || upErr,
            );
          }
        }
      } catch (err: any) {
        errors += 1;
        samples.push({ orderSn: sn, ok: false });
        console.warn(
          `[Heal CancelReturn Tracking] Lỗi order_sn=${sn}:`,
          err?.message || err,
        );
      } finally {
        // Bắt buộc nghỉ giữa mỗi đơn — tránh Shopee rate-limit / treo request.
        await sleep(HEAL_ITEM_DELAY_MS);
      }
    }

    try {
      queueOrdersJsonMirrorFromMongo();
    } catch {
      /* ignore */
    }

    const result = {
      candidates: candidates.length,
      attempted,
      filled,
      stillEmpty,
      errors,
      samples: samples.slice(0, 40),
    };
    console.log(
      `[Heal CancelReturn Tracking] DONE candidates=${result.candidates}` +
        ` attempted=${result.attempted} filled=${result.filled}` +
        ` stillEmpty=${result.stillEmpty} errors=${result.errors}`,
    );
    return result;
  } finally {
    healCancelledReturnTrackingInFlight = false;
  }
}

/** Tự động gọi get_tracking_number khi sync — STRICT tuần tự for...of + delay + updateOne độc lập. */
async function ensureShopeeTrackingForBatch(
  apiShopId: string,
  accessToken: string,
  batch: any[],
): Promise<number> {
  let fetched = 0;
  const needFetch: any[] = [];
  for (const order of batch) {
    if (String(order?.channel) !== "shopee") continue;
    if (!needsShopeeTrackingEnrichment(order)) continue;
    needFetch.push(order);
  }
  if (needFetch.length === 0) return 0;

  console.log(
    `[Shopee Tracking] ensureShopeeTrackingForBatch: ${needFetch.length}/${batch.length} đơn thiếu tracking_no → gọi get_tracking_number tuần tự (delay=${SHOPEE_TRACKING_FETCH_DELAY_MS}ms)`,
  );

  for (const order of needFetch) {
    try {
      const ok = await fetchAndForceSaveTrackingNumber(apiShopId, accessToken, order, {
        retries: 2,
      });
      if (ok) fetched++;
    } catch (error) {
      // CANCELLED / API error → bỏ qua, KHÔNG dừng vòng lặp các đơn khác.
      console.error(
        `[Shopee Tracking] Lỗi 1 đơn (tracking skip) order_sn=${order?.orderSn}:`,
        error,
      );
      continue;
    } finally {
      await sleep(SHOPEE_TRACKING_FETCH_DELAY_MS);
    }
  }

  if (fetched > 0) {
    console.log(
      `[Shopee Tracking] ensureShopeeTrackingForBatch: đã lấy ${fetched}/${needFetch.length} đơn (shop=${apiShopId}).`,
    );
  }
  return fetched;
}

// Normalize one item from get_order_detail's `order_list` into this project's Order shape.
function normalizeShopeeOrderDetail(shopId: string, shopName: string, item: any): any | null {
  if (!item || !item.order_sn) {
    console.warn("[Shopee Sync] Bỏ qua order detail thiếu order_sn:", item);
    return null;
  }
  try {
    const rawStatus = String(item?.order_status || "READY_TO_SHIP").toUpperCase();
    const pkg = Array.isArray(item?.package_list) ? item.package_list[0] : undefined;
    const itemList = Array.isArray(item?.item_list) ? item.item_list : [];
    const mappedItems = itemList
      .map((it: any) => mapShopeeOrderLineItem(it, { orderStatus: rawStatus }))
      .filter(Boolean);
    const pkgTracking = pickBestTrackingNumber(pkg?.tracking_number, pkg?.tracking_no, item?.tracking_no);
    const logisticsStatus = String(pkg?.logistics_status || "").toUpperCase();
    const mappedStatus = mapShopeeStatusToLocal(rawStatus, {
      hasTracking: Boolean(pkgTracking),
      logisticsStatus,
    });
    const order: any = {
      id: `shopee-${item.order_sn}`,
      orderSn: String(item.order_sn),
      channel: "shopee",
      shopId: String(shopId),
      shopName: resolveConnectedShopDisplayName(shopId, shopName) || `Shop ${shopId}`,
      totalAmount: Number(item?.total_amount || 0),
      withholdingCitTax: 0,
      withholding_cit_tax: 0,
      revenue: 0,
      shopee_order_status: rawStatus,
      status: mappedStatus,
      date: item?.create_time ? new Date(Number(item.create_time) * 1000).toISOString() : new Date().toISOString(),
      // Watermark của Shopee, KHÔNG phải giờ server nhận payload. Mongo dùng field
      // này để chặn webhook/pull đến trễ ghi đè snapshot mới hơn.
      last_shopee_update_at: item?.update_time
        ? new Date(Number(item.update_time) * 1000).toISOString()
        : undefined,
      packageNumber: pkg?.package_number || item?.package_number || undefined,
      package_number: pkg?.package_number || item?.package_number || undefined,
      isPrepared:
        mappedStatus === "processed" ||
        mappedStatus === "shipping" ||
        rawStatus === "PROCESSED" ||
        rawStatus === "SHIPPED" ||
        rawStatus === "TO_CONFIRM_RECEIVE",
      isPrinted: false,
      is_pending_shopee_check: false,
      items: mappedItems,
      shipping_carrier: (() => {
        const v = String(
          item?.shipping_carrier ||
            pkg?.shipping_carrier ||
            item?.checkout_shipping_carrier ||
            pkg?.checkout_shipping_carrier ||
            "",
        ).trim();
        return v || undefined;
      })(),
      checkout_shipping_carrier: (() => {
        const v = String(
          item?.checkout_shipping_carrier || pkg?.checkout_shipping_carrier || "",
        ).trim();
        return v || undefined;
      })(),
      logistics_channel_id: (() => {
        const n = Number(pkg?.logistics_channel_id ?? item?.logistics_channel_id);
        return Number.isFinite(n) && n > 0 ? n : undefined;
      })(),
    };
    if (logisticsStatus) order.logistics_status = logisticsStatus;
    if (item?.cancel_reason) order.cancel_reason = String(item.cancel_reason);
    if (item?.buyer_cancel_reason) order.buyer_cancel_reason = String(item.buyer_cancel_reason);
    if (item?.cancel_by) order.cancel_by = String(item.cancel_by);
    applyShopeePartialCancelMeta(order, item, mappedItems);
    applyShopeeEstimatedFinance(order, item);
    applyShopeePackageListTracking(order, item);
    // logistics PICKUP_DONE/SHIPPED (App quét) → promote raw SHIPPED trước khi ép tab.
    promoteRawStatusFromLogistics(order, logisticsStatus);
    // Cưỡng bức lại sau package_list: trạng thái terminal từ Shopee luôn thắng.
    const finalRaw = String(order.shopee_order_status || rawStatus).toUpperCase();
    if (finalRaw === "CANCELLED" || finalRaw === "IN_CANCEL") {
      order.status = "cancelled";
      order.shopee_order_status = finalRaw;
      order.isPrepared = false;
      order.is_pending_shopee_check = false;
    } else if (finalRaw === "COMPLETED") {
      order.status = "completed";
      order.shopee_order_status = "COMPLETED";
      order.isPrepared = true;
      order.is_pending_shopee_check = false;
    } else if (finalRaw === "SHIPPED" || finalRaw === "TO_CONFIRM_RECEIVE") {
      order.status = "shipping";
      order.isPrepared = true;
      order.is_pending_shopee_check = false;
    } else if (finalRaw === "UNPAID" || finalRaw === "PENDING") {
      order.status = "pending_confirm";
      order.isPrepared = false;
    } else if (finalRaw === "READY_TO_SHIP" || finalRaw === "RETRY_SHIP" || finalRaw === "PROCESSED") {
      // Bắt buộc lưu raw Shopee + map local: RTS/RETRY chưa mã → unprocessed; PROCESSED/có mã → processed.
      order.shopee_order_status = finalRaw;
      if (order.status !== "shipping" && order.status !== "completed") {
        if (finalRaw === "PROCESSED" || hasUsableShopeeTrackingNumber(order)) {
          order.status = "processed";
          order.isPrepared = true;
        } else {
          order.status = "unprocessed";
          order.isPrepared = false;
        }
      }
    }
    // Suy luận dropoff từ logistics_status (không có pickup_time).
    const logisticsBlob = `${logisticsStatus} ${JSON.stringify(pkg || {})}`.toUpperCase();
    if (/DROPOFF|DROP_OFF|DROP-OFF|SELF_DELIVER|SELF_SEND/.test(logisticsBlob)) {
      order.fulfillment_type = "dropoff";
      order.ship_method = "dropoff";
    }
    repairMisassignedTracking(order);
    // Heal ĐVVC khi API thiếu shipping_carrier nhưng có mã SPXVN/GHN.
    if (!order.shipping_carrier) {
      const inferredCarrier = inferShippingCarrierLabel(order);
      if (inferredCarrier) order.shipping_carrier = inferredCarrier;
    }
    // Heal ngay khi normalize — Drop-off/PROCESSED/tracking.
    forceHealPickupOrderIfHasTracking(order);
    repairFalseProcessedReadyToShip(order);
    promoteOrderStatusWhenTrackingReady(order);
    enforceShopeeTerminalLocalStatus(order);
    applyShopeeCancelReturnClassification(order, item);
    return order;
  } catch (err: any) {
    console.error(
      "LỖI SYNC SHOPEE:",
      `normalizeShopeeOrderDetail order_sn=${item?.order_sn}`,
      err?.message || err,
      err?.stack || "",
    );
    return null;
  }
}

// Upsert one Shopee order from get_order_detail — trust Shopee status for tab
// placement while preserving local print flags and non-empty item snapshots.
function orderItemsHaveVariationData(items: any[] | undefined): boolean {
  return Array.isArray(items) && items.some(
    (i) => i?.modelId || i?.modelName || i?.modelSku || (Array.isArray(i?.tierIndex) && i.tierIndex.length > 0),
  );
}

/** Cờ trạng thái nội bộ kho — SSOT: src/utils/orderWarehouseStatus.ts */
type OrderLocalStatus = "NONE" | "HANDED_OVER" | "CANCELLED_STORED" | "RETURN_RECEIVED";

function resolveOrderLocalStatus(order: any): OrderLocalStatus {
  return resolveOrderLocalStatusShared(order) as OrderLocalStatus;
}

function setOrderLocalStatus(order: any, status: OrderLocalStatus): void {
  const now = new Date().toISOString();
  if (status === ORDER_LOCAL_STATUS.HANDED_OVER) {
    Object.assign(order, buildHandedOverWritePatch(now));
    return;
  }
  // Tab "Đã nhận đơn hủy, đơn hoàn" lọc theo local_status / localStatus / internal_status.
  order.local_status = status;
  order.localStatus = status;
  order.internal_status = status;
  order.local_status_updated_at = now;
  order.localStatusAt = now;
  if (status === "CANCELLED_STORED" || status === "RETURN_RECEIVED") {
    order.is_local_return_archived = false;
  }
  if (status === "RETURN_RECEIVED") {
    order.status = "return_received";
  }
}

function resolveOrderHandoverFlag(order: any): boolean {
  return isOrderHandedOverShared(order);
}

function setOrderHandoverFlag(order: any, value: boolean): void {
  if (value) {
    Object.assign(order, buildHandedOverWritePatch());
  } else if (resolveOrderLocalStatus(order) === "HANDED_OVER" || resolveOrderHandoverFlag(order)) {
    Object.assign(order, buildClearHandedOverPatch());
  }
}

/**
 * Sync Shopee KHÔNG clear/ghi đè is_handed_over — giữ nguyên thao tác QR.
 * (Tab ĐVVC tự loại SHIPPED bằng filter status.)
 */
function healInvalidHandedOverFlags(_orders: any[]): any[] {
  return [];
}

function isOrderAwaitingCarrierPickupStatus(status: unknown): boolean {
  const s = String(status || "");
  return s === "processed" || s === "unprocessed";
}

/** READ = WRITE — cùng matchesHandedOverCarrierTab (SSOT). */
function matchesHandedOverCarrierTabOrder(order: any): boolean {
  return matchesHandedOverCarrierTab(order);
}

function resolveLocalStatusUpdatedAt(order: any): number {
  const raw = order?.local_status_updated_at || order?.localStatusAt || order?.handedOverAt;
  const t = raw ? Date.parse(String(raw)) : NaN;
  return Number.isFinite(t) ? t : 0;
}

function matchesReceivedCancelReturnTabOrder(order: any): boolean {
  if (order?.is_local_return_archived) return false;
  const local = resolveOrderLocalStatus(order);
  return local === "RETURN_RECEIVED" || local === "CANCELLED_STORED";
}

// archiveStale / purgeClosed / schedules / persist — services/orders.js (Phase 5)

function isOrderAlreadyScanProcessed(order: any): boolean {
  const local = resolveOrderLocalStatus(order);
  if (local === "CANCELLED_STORED" || local === "RETURN_RECEIVED") return true;
  if (local === "HANDED_OVER") {
    // Cho quét phân loại hủy/hoàn sau khi đã bàn giao ĐVVC.
    if (isShopeeCancelOrReturnLikeOrder(order)) return false;
    return true;
  }
  return false;
}

function getScanProcessedReason(order: any): string {
  const local = resolveOrderLocalStatus(order);
  if (local === "HANDED_OVER") return "Đơn đã được quét/bàn giao ĐVVC trước đó";
  if (local === "CANCELLED_STORED") return "Đơn hủy đã được phân loại trước đó";
  if (local === "RETURN_RECEIVED") return "Đơn đã nhận hàng hoàn trước đó";
  return "Đơn đã được xử lý trước đó";
}

function mergeShopeeOrderOnSync(existing: any | undefined, incoming: any): any {
  if (!existing) {
    if (incoming) enforceShopeeTerminalLocalStatus(incoming);
    return incoming;
  }

  // Spread có thể đưa tracking rỗng từ sàn — sẽ khôi phục ở mergeShopeeTrackingFields.
  const merged = { ...existing, ...incoming, id: existing.id };
  // Luôn ghi đè trạng thái từ Shopee (shipping / cancelled / ...) — không giữ status local cũ.
  merged.status = incoming.status;
  merged.isPrepared =
    incoming.status === "processed" ||
    incoming.status === "shipping" ||
    incoming.status === "completed" ||
    incoming.status === "return_pending";
  if (incoming.status === "cancelled") {
    merged.isPrepared = false;
  }
  // CỜ NỘI BỘ — tuyệt đối KHÔNG ghi đè từ Shopee sync:
  // Nếu DB local đã isPrinted=true thì giữ vĩnh viễn (kể cả incoming.isPrinted=false/undefined).
  // Chỉ cho phép false→true (user vừa in trong cùng phiên), KHÔNG bao giờ true→false từ sync.
  merged.isPrinted = Boolean(existing.isPrinted) || Boolean(incoming?.isPrinted);
  // Giữ printedAt nếu đã có (sync Shopee không đụng).
  if (existing.printedAt || existing.printed_at) {
    merged.printedAt = existing.printedAt || existing.printed_at;
    merged.printed_at = existing.printedAt || existing.printed_at;
  } else if (incoming?.printedAt || incoming?.printed_at) {
    merged.printedAt = incoming.printedAt || incoming.printed_at;
    merged.printed_at = incoming.printedAt || incoming.printed_at;
  }

  const incomingItems = Array.isArray(incoming.items) ? incoming.items : [];
  const existingItems = Array.isArray(existing.items) ? existing.items : [];
  if (incomingItems.length > 0) {
    if (
      orderItemsHaveVariationData(incomingItems) ||
      !existingItems.length ||
      !orderItemsHaveVariationData(existingItems)
    ) {
      merged.items = incomingItems;
    } else {
      merged.items = existingItems;
    }
  } else if (existingItems.length) {
    merged.items = existingItems;
  }
  if (!incoming.packageNumber && !incoming.package_number && (existing.packageNumber || existing.package_number)) {
    const existingPkg = String(existing.packageNumber || existing.package_number || "").trim();
    if (existingPkg) {
      merged.packageNumber = existingPkg;
      merged.package_number = existingPkg;
    }
  }
  // Giữ ĐVVC đã biết — sync thiếu field không được xoá.
  if (!merged.shipping_carrier && existing.shipping_carrier) {
    merged.shipping_carrier = existing.shipping_carrier;
  }
  if (!merged.checkout_shipping_carrier && existing.checkout_shipping_carrier) {
    merged.checkout_shipping_carrier = existing.checkout_shipping_carrier;
  }
  if (!merged.logistics_channel_id && existing.logistics_channel_id) {
    merged.logistics_channel_id = existing.logistics_channel_id;
  }
  if (incoming.shopId) {
    merged.shopId = normalizeShopIdKey(incoming.shopId) || String(incoming.shopId);
  } else if (existing.shopId) {
    merged.shopId = existing.shopId;
  }
  merged.shopName =
    resolveConnectedShopDisplayName(merged.shopId, incoming.shopName) ||
    resolveConnectedShopDisplayName(merged.shopId, existing.shopName) ||
    merged.shopName;
  mergeShopeeTrackingFields(merged, existing, incoming);
  // Giữ fulfillment_type (pickup/dropoff) — không mất khi sync lại.
  if (!merged.fulfillment_type && existing?.fulfillment_type) {
    merged.fulfillment_type = existing.fulfillment_type;
  }
  if (!merged.ship_method && existing?.ship_method) {
    merged.ship_method = existing.ship_method;
  }
  if (incoming?.fulfillment_type) merged.fulfillment_type = incoming.fulfillment_type;
  if (incoming?.ship_method) merged.ship_method = incoming.ship_method;

  const incomingRaw = String(incoming.shopee_order_status || "").toUpperCase();
  const existingRaw = String(existing?.shopee_order_status || "").toUpperCase();
  const incomingLogistics = String(
    incoming.logistics_status || merged.logistics_status || "",
  ).toUpperCase();
  const existingLogistics = String(existing?.logistics_status || "").toUpperCase();
  const incomingIsCancellation = incomingRaw === "CANCELLED" || incomingRaw === "IN_CANCEL";
  const existingIsCancellation = existingRaw === "CANCELLED" || existingRaw === "IN_CANCEL";
  const incomingIsReturn = incomingRaw === "TO_RETURN";
  // Rank gồm raw + local status + logistics (PICKUP_DONE ≡ SHIPPED).
  const existingStatusRank = Math.max(
    shopeeLifecycleRank(existingRaw),
    shopeeLifecycleRank(String(existing?.status || "")),
    shopeeLifecycleRank(existingLogistics),
  );
  const incomingStatusRank = Math.max(
    shopeeLifecycleRank(incomingRaw),
    shopeeLifecycleRank(String(incoming?.status || "")),
    shopeeLifecycleRank(incomingLogistics),
  );

  // State machine một chiều: trạng thái chỉ tiến về phía trước.
  // CANCELLED / IN_CANCEL / TO_RETURN / COMPLETED luôn ghi đè SHIPPED (không bị logistics DELIVERY_DONE kéo về Đang giao).
  // UNPAID < READY_TO_SHIP < PROCESSED < SHIPPED < COMPLETED — SHIPPED luôn thắng PROCESSED.
  if (incomingIsCancellation) {
    merged.status = "cancelled";
    merged.shopee_order_status = incomingRaw;
    merged.isPrepared = false;
    merged.is_pending_shopee_check = false;
  } else if (incomingIsReturn) {
    merged.status = existing?.status === "return_received" ? "return_received" : "return_pending";
    merged.shopee_order_status = "TO_RETURN";
    merged.isPrepared = false;
    merged.is_pending_shopee_check = false;
    clearHandedOverLocalForCancelReturn(merged);
  } else if (incomingRaw === "COMPLETED") {
    merged.status = "completed";
    merged.shopee_order_status = "COMPLETED";
    merged.isPrepared = true;
    merged.is_pending_shopee_check = false;
  } else if (existingIsCancellation || incomingStatusRank < existingStatusRank) {
    console.error(
      `[StateMachine] REJECTED ${existingIsCancellation ? "after_CANCELLED" : "downgrade"} ` +
        `order_sn=${merged.orderSn || "?"} ` +
        `incoming=${incomingRaw || "(empty)"}/${incomingLogistics || "-"}(rank=${incomingStatusRank}) ` +
        `< existing=${existingRaw || "(empty)"}/${existingLogistics || "-"}(rank=${existingStatusRank}) ` +
        `— giữ status=${existing.status} raw=${existing.shopee_order_status}`,
    );
    merged.status = existing.status;
    merged.shopee_order_status = existing.shopee_order_status;
    merged.isPrepared = Boolean(existing.isPrepared);
    merged.is_pending_shopee_check = Boolean(existing.is_pending_shopee_check);
    if (existingLogistics && !merged.logistics_status) {
      merged.logistics_status = existingLogistics;
    }
  } else if (incomingRaw === "SHIPPED" || incomingRaw === "TO_CONFIRM_RECEIVE") {
    merged.status = "shipping";
    merged.shopee_order_status = incomingRaw;
    if (incomingLogistics) merged.logistics_status = incomingLogistics;
    merged.isPrepared = true;
    merged.is_pending_shopee_check = false;
    console.log(
      `[StateMachine] ACCEPT SHIPPED order_sn=${merged.orderSn || "?"} ` +
        `raw=${merged.shopee_order_status} logistics=${incomingLogistics || "-"} ` +
        `(prev=${existingRaw || "(empty)"})`,
    );
  } else if (
    isLogisticsHandedToCarrier(incomingLogistics) &&
    incomingRaw !== "COMPLETED" &&
    incomingRaw !== "CANCELLED" &&
    incomingRaw !== "IN_CANCEL" &&
    incomingRaw !== "TO_RETURN"
  ) {
    merged.status = "shipping";
    merged.shopee_order_status = "SHIPPED";
    if (incomingLogistics) merged.logistics_status = incomingLogistics;
    merged.isPrepared = true;
    merged.is_pending_shopee_check = false;
    console.log(
      `[StateMachine] ACCEPT SHIPPED order_sn=${merged.orderSn || "?"} ` +
        `raw=${merged.shopee_order_status} logistics=${incomingLogistics || "-"} ` +
        `(prev=${existingRaw || "(empty)"})`,
    );
  } else if (incomingRaw === "PROCESSED") {
    // Drop-off/Pickup đã arrange — Đã xử lý (chỉ khi chưa SHIPPED/COMPLETED).
    if (merged.status !== "shipping" && merged.status !== "completed") {
      merged.status = "processed";
      merged.isPrepared = true;
      merged.is_pending_shopee_check = false;
      merged.shopee_order_status = "PROCESSED";
    }
  } else if (incomingRaw === "UNPAID" || incomingRaw === "PENDING") {
    // Webhook Code 4 thiếu status từng bị default PENDING — không được kéo lùi đơn đã PROCESSED/GHN.
    const existingFurther =
      existingRaw === "READY_TO_SHIP" ||
      existingRaw === "RETRY_SHIP" ||
      existingRaw === "PROCESSED" ||
      existingRaw === "SHIPPED" ||
      existingRaw === "TO_CONFIRM_RECEIVE" ||
      existingRaw === "COMPLETED" ||
      hasUsableShopeeTrackingNumber(existing) ||
      hasUsableShopeeTrackingNumber(merged);
    const incomingLooksShallow =
      !Array.isArray(incoming?.items) || incoming.items.length === 0;
    if (existingFurther && incomingLooksShallow) {
      merged.status = existing.status || merged.status;
      merged.shopee_order_status = existing.shopee_order_status || merged.shopee_order_status;
      merged.is_pending_shopee_check = false;
    } else if (
      !isShopeeTerminalRawStatus(existingRaw) &&
      merged.status !== "shipping" &&
      merged.status !== "completed"
    ) {
      merged.status = "pending_confirm";
      merged.is_pending_shopee_check = false;
    }
  } else if (existing?.is_pending_shopee_check === true || incoming.is_pending_shopee_check === true) {
    const clearedByShipProgress =
      incomingRaw === "PROCESSED" ||
      incomingRaw === "SHIPPED" ||
      incomingRaw === "TO_CONFIRM_RECEIVE" ||
      incomingRaw === "COMPLETED" ||
      incomingRaw === "CANCELLED" ||
      incomingRaw === "IN_CANCEL" ||
      incomingRaw === "TO_RETURN" ||
      incoming.isPrepared === true;
    if (clearedByShipProgress) {
      merged.is_pending_shopee_check = false;
    } else {
      // Giữ flag lỗi nhưng ở lại Chờ lấy hàng (Chưa xử lý) — không tạo tab riêng.
      merged.is_pending_shopee_check = true;
      if (merged.status === "pending_verification") {
        merged.status = incomingRaw === "UNPAID" || incomingRaw === "PENDING" ? "pending_confirm" : "unprocessed";
      }
    }
  } else {
    merged.is_pending_shopee_check = false;
    if (merged.status === "pending_verification") {
      merged.status =
        incomingRaw === "UNPAID" || incomingRaw === "PENDING" ? "pending_confirm" : "unprocessed";
    }
  }

  // READY_TO_SHIP / PROCESSED + đã có tracking → Đã xử lý
  // KHÔNG áp dụng khi đã/đang SHIPPED/COMPLETED.
  if (
    (incomingRaw === "READY_TO_SHIP" ||
      incomingRaw === "RETRY_SHIP" ||
      incomingRaw === "PROCESSED") &&
    hasUsableShopeeTrackingNumber(merged) &&
    merged.status !== "shipping" &&
    merged.status !== "completed" &&
    !isShopeeTerminalRawStatus(String(merged.shopee_order_status || ""))
  ) {
    merged.status = "processed";
    merged.isPrepared = true;
    merged.is_pending_shopee_check = false;
  }

  // CƯỠNG CHẾ heal: tracking_no | PROCESSED | dropoff — không downgrade terminal.
  forceHealPickupOrderIfHasTracking(merged);
  repairFalseProcessedReadyToShip(merged);
  // logistics PICKUP_DONE sau merge — luôn promote SHIPPED (không bị nhánh PROCESSED kéo lùi).
  promoteRawStatusFromLogistics(merged);

  const mergedCustomCosts = getGlobalPackagingCostPerOrder();
  merged.custom_costs = mergedCustomCosts;
  delete merged.custom_cost_items;
  if (incoming.item_amount != null) merged.item_amount = incoming.item_amount;
  else if (existing?.item_amount != null) merged.item_amount = existing.item_amount;
  if (incoming.escrow_synced != null) merged.escrow_synced = incoming.escrow_synced;
  else if (existing?.escrow_synced != null) merged.escrow_synced = existing.escrow_synced;
  if (incoming.withholdingCitTax != null || incoming.withholding_cit_tax != null) {
    applyShopeeOrderFinanceFields(merged, {
      totalAmount: merged.totalAmount,
      itemAmount: incoming.item_amount ?? existing?.item_amount,
      withholdingCitTax: extractShopeeWithholdingCitTax(incoming),
      escrowAmount: incoming.escrowAmount ?? existing?.escrowAmount,
      shopeeFees: incoming.shopee_fees ?? existing?.shopee_fees,
      escrowSynced: incoming.escrow_synced ?? existing?.escrow_synced,
      customCosts: mergedCustomCosts,
    });
  } else if (existing?.escrow_synced || existing?.escrowAmount != null) {
    applyShopeeOrderFinanceFields(merged, {
      totalAmount: merged.totalAmount,
      itemAmount: existing?.item_amount,
      withholdingCitTax: extractShopeeWithholdingCitTax(existing),
      escrowAmount: existing?.escrowAmount,
      shopeeFees: existing?.shopee_fees,
      escrowSynced: existing?.escrow_synced,
      customCosts: mergedCustomCosts,
    });
  } else {
    applyShopeeOrderFinanceFields(merged, {
      totalAmount: merged.totalAmount,
      shopeeFees: incoming.shopee_fees ?? existing?.shopee_fees,
      escrowSynced: false,
      customCosts: mergedCustomCosts,
    });
  }
  if (incoming.shopee_fees && Object.keys(incoming.shopee_fees).length > 0) {
    merged.shopee_fees = incoming.shopee_fees;
  } else if (existing?.shopee_fees && !merged.shopee_fees) {
    merged.shopee_fees = existing.shopee_fees;
  }
  if (incoming.partialCancel != null) merged.partialCancel = incoming.partialCancel;
  if (incoming.canPartialCancel != null) merged.canPartialCancel = incoming.canPartialCancel;

  // Sync Shopee: giữ HANDED_OVER khi còn chờ lấy; khi sàn đã hủy/hoàn → gỡ local HANDED_OVER
  // (giữ handedOverAt) để quét QR phân loại hủy/hoàn được.
  const existingLocalForHandover = resolveOrderLocalStatus(existing);
  const alreadyStoredCancelReturn =
    existingLocalForHandover === "CANCELLED_STORED" ||
    existingLocalForHandover === "RETURN_RECEIVED";
  if (alreadyStoredCancelReturn) {
    // Giữ nguyên nhánh RETURN_RECEIVED / CANCELLED_STORED bên dưới.
  } else if (
    resolveOrderHandoverFlag(existing) &&
    isShopeeCancelOrReturnLikeOrder(merged)
  ) {
    if (existing.handedOverAt) merged.handedOverAt = existing.handedOverAt;
    if (existing.handed_over_source != null) merged.handed_over_source = existing.handed_over_source;
    if (existing.handedOverSource != null) merged.handedOverSource = existing.handedOverSource;
    clearHandedOverLocalForCancelReturn(merged);
  } else if (resolveOrderHandoverFlag(existing)) {
    merged.is_handed_over = true;
    merged.isHandedOverToCarrier = true;
    merged.is_handed_over_to_carrier = true;
    merged.is_handed_over_to_courier = true;
    merged.local_status = "HANDED_OVER";
    merged.localStatus = "HANDED_OVER";
    merged.internal_status = "HANDED_OVER";
    if (existing.handedOverAt) merged.handedOverAt = existing.handedOverAt;
    if (existing.handed_over_source != null) merged.handed_over_source = existing.handed_over_source;
    if (existing.handedOverSource != null) merged.handedOverSource = existing.handedOverSource;
    if (existing.localStatusAt) merged.localStatusAt = existing.localStatusAt;
    if (existing.local_status_updated_at) {
      merged.local_status_updated_at = existing.local_status_updated_at;
    }
  } else {
    delete merged.is_handed_over;
    delete merged.isHandedOverToCarrier;
    delete merged.is_handed_over_to_carrier;
    delete merged.is_handed_over_to_courier;
    delete merged.handedOverAt;
    delete merged.handed_over_source;
    delete merged.handedOverSource;
    if (String(merged.local_status || "").toUpperCase() === "HANDED_OVER") {
      delete merged.local_status;
      delete merged.localStatus;
      delete merged.internal_status;
    }
  }

  // Giữ RETURN_RECEIVED / CANCELLED_STORED nội bộ (không liên quan ĐVVC).
  if (existing?.is_local_return_archived != null) {
    merged.is_local_return_archived = existing.is_local_return_archived;
  }
  const existingLocal = resolveOrderLocalStatus(existing);
  if (existingLocal === "RETURN_RECEIVED" || existingLocal === "CANCELLED_STORED") {
    merged.local_status = existingLocal;
    merged.localStatus = existingLocal;
    if (existing?.localStatusAt) merged.localStatusAt = existing.localStatusAt;
    if (existing?.local_status_updated_at) {
      merged.local_status_updated_at = existing.local_status_updated_at;
    }
    if (
      existingLocal === "RETURN_RECEIVED" &&
      incomingRaw !== "SHIPPED" &&
      incomingRaw !== "TO_CONFIRM_RECEIVE" &&
      incomingRaw !== "COMPLETED" &&
      merged.status !== "shipping" &&
      merged.status !== "completed" &&
      !isShopeeTerminalRawStatus(String(merged.shopee_order_status || ""))
    ) {
      merged.status = "return_received";
    }
  }

  // Shopee ẩn PII — chỉ xóa customer fields khi channel = shopee.
  // WooCommerce / web orders BẮT BUỘC giữ customerName/Phone/Address để giao hàng ngoài.
  const mergeChannel = String(merged.channel || merged.source || existing?.channel || incoming?.channel || "").toLowerCase();
  if (mergeChannel === "shopee" || mergeChannel === "") {
    delete merged.customerName;
    delete merged.customerPhone;
    delete merged.customerAddress;
  }
  enforceShopeeTerminalLocalStatus(merged);
  return merged;
}

/** Tránh gọi Shopee backfill ĐVVC liên tục mỗi lần refresh trang. */
let lastShippingCarrierBackfillAt = 0;
const SHIPPING_CARRIER_BACKFILL_COOLDOWN_MS = 60 * 1000;

/**
 * Backfill shipping_carrier từ get_order_detail cho đơn READY_TO_SHIP thiếu ĐVVC.
 * Giới hạn số đơn/lần để không block API quá lâu.
 */
async function backfillMissingShippingCarriersFromShopee(
  orders: any[],
  limit = 40,
): Promise<number> {
  const need = orders.filter((o) => {
    if (String(o?.channel || "") !== "shopee") return false;
    if (String(o?.shipping_carrier || "").trim()) return false;
    const status = String(o?.status || "");
    const raw = String(o?.shopee_order_status || "").toUpperCase();
    return (
      status === "unprocessed" ||
      status === "processed" ||
      raw === "READY_TO_SHIP" ||
      raw === "RETRY_SHIP" ||
      raw === "PROCESSED"
    );
  });
  if (need.length === 0) return 0;

  const byShop = new Map<string, string[]>();
  for (const o of need.slice(0, Math.max(1, limit))) {
    const shopKey = String(o.shopId || "").trim();
    const sn = String(o.orderSn || "").trim();
    if (!shopKey || !sn) continue;
    if (!byShop.has(shopKey)) byShop.set(shopKey, []);
    byShop.get(shopKey)!.push(sn);
  }

  let filled = 0;
  for (const [shopKey, sns] of byShop) {
    const auth = await getShopeeAccessTokenForApi(shopKey);
    if (!auth?.token) continue;
    for (let i = 0; i < sns.length; i += SHOPEE_SYNC_CHUNK_SIZE) {
      const chunk = sns.slice(i, i + SHOPEE_SYNC_CHUNK_SIZE);
      try {
        const { normalized } = await fetchNormalizeShopeeOrderChunk(
          auth.apiShopId,
          auth.token,
          auth.fileKey || shopKey,
          chunk,
          { enrichTracking: false },
        );
        for (const n of normalized) {
          const idx = orders.findIndex((o) => String(o.orderSn) === String(n.orderSn));
          if (idx < 0) continue;
          let changed = false;
          if (n.shipping_carrier && !orders[idx].shipping_carrier) {
            orders[idx].shipping_carrier = String(n.shipping_carrier);
            changed = true;
          }
          if (n.checkout_shipping_carrier) {
            orders[idx].checkout_shipping_carrier = String(n.checkout_shipping_carrier);
            changed = true;
          }
          if (n.logistics_channel_id) {
            orders[idx].logistics_channel_id = Number(n.logistics_channel_id);
            changed = true;
          }
          if (!orders[idx].shipping_carrier) {
            const inferred = inferShippingCarrierLabel(orders[idx]);
            if (inferred) {
              orders[idx].shipping_carrier = inferred;
              changed = true;
            }
          }
          if (changed) filled++;
        }
      } catch (err: any) {
        console.warn(
          `[Carrier Backfill] shop=${shopKey} lỗi:`,
          err?.message || err,
        );
      }
      if (i + SHOPEE_SYNC_CHUNK_SIZE < sns.length) {
        await shopeeSyncDelay(SHOPEE_SYNC_CHUNK_DELAY_MS);
      }
    }
  }
  if (filled > 0) {
    console.log(`[Carrier Backfill] đã điền shipping_carrier cho ${filled} đơn.`);
  }
  return filled;
}

let cancelledEmptyItemsBackfillInFlight = false;

/**
 * Backfill CANCELLED items=[] (30 ngày) — get_order_detail, CHỈ $set data.items.
 * Limit + delay + deadline cứng — không vòng lặp vô tận.
 */
async function backfillCancelledEmptyItems(opts?: {
  limit?: number;
  lookbackDays?: number;
  trigger?: string;
}): Promise<{ attempted: number; filled: number; errors: number; skipped?: boolean }> {
  const empty = { attempted: 0, filled: 0, errors: 0 };
  if (cancelledEmptyItemsBackfillInFlight) {
    return { ...empty, skipped: true };
  }
  if (!isMongoReady()) return { ...empty, skipped: true };
  cancelledEmptyItemsBackfillInFlight = true;
  const startedAt = Date.now();
  const deadlineAt = startedAt + 75_000;
  const limit = Math.max(1, Math.min(40, Number(opts?.limit) || 20));
  let attempted = 0;
  let filled = 0;
  let errors = 0;
  try {
    const candidates = await findCancelledEmptyItemsFromStore({
      limit,
      lookbackDays: opts?.lookbackDays || 30,
    });
    if (!candidates.length) {
      console.log(
        `[CancelledItems Backfill] trigger=${opts?.trigger || "manual"} candidates=0`,
      );
      return empty;
    }
    console.log(
      `[CancelledItems Backfill] trigger=${opts?.trigger || "manual"} candidates=${candidates.length} limit=${limit}`,
    );
    for (const row of candidates) {
      if (Date.now() >= deadlineAt) break;
      if (attempted >= limit) break;
      const orderSn = String(row.orderSn || "").trim();
      const shopId = String(row.shopId || "").trim();
      if (!orderSn || !shopId) continue;
      attempted += 1;
      try {
        const accessToken = await getValidShopeeAccessToken(shopId);
        if (!accessToken) {
          errors += 1;
          continue;
        }
        const detailResult = await shopeeGetOrderDetail(shopId, accessToken, [orderSn]);
        if (detailResult?.error) {
          errors += 1;
          continue;
        }
        const detailList = detailResult?.response?.order_list ?? detailResult?.order_list ?? [];
        const detail = Array.isArray(detailList)
          ? detailList.find((d: any) => String(d?.order_sn || "").trim() === orderSn) || detailList[0]
          : null;
        if (!detail) {
          errors += 1;
          continue;
        }
        const rawStatus = String(detail?.order_status || "CANCELLED").toUpperCase();
        const itemList = Array.isArray(detail?.item_list) ? detail.item_list : [];
        const items = itemList
          .map((it: any) => mapShopeeOrderLineItem(it, { orderStatus: rawStatus }))
          .filter(Boolean);
        if (!items.length) {
          continue;
        }
        const ok = await patchOrderItemsOnlyInStore(orderSn, items, { shopId });
        if (ok) filled += 1;
      } catch (rowErr: any) {
        errors += 1;
        console.warn(
          `[CancelledItems Backfill] skip order_sn=${orderSn}:`,
          rowErr?.message || rowErr,
        );
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    console.log(
      `[CancelledItems Backfill] trigger=${opts?.trigger || "manual"} attempted=${attempted} filled=${filled} errors=${errors} ${Date.now() - startedAt}ms`,
    );
    try {
      invalidateOrdersRefreshCache();
    } catch {
      /* ignore */
    }
    return { attempted, filled, errors };
  } catch (err: any) {
    console.warn("[CancelledItems Backfill] failed:", err?.message || err);
    return { attempted, filled, errors };
  } finally {
    cancelledEmptyItemsBackfillInFlight = false;
  }
}

/**
 * Lấy chi tiết + chuẩn hóa theo BATCH (không tuần tự từng đơn).
 * - Mỗi mẻ ≤20 order_sn → 1 lần get_order_detail (Shopee hỗ trợ tối đa 50).
 * - Normalize tuần tự for...of; lỗi 1 đơn không làm sập cả mẻ.
 * - Nghỉ ORDER_DETAIL_BATCH_DELAY_MS giữa các mẻ để tránh rate-limit.
 * - Nếu cả mẻ API fail → fallback for...of gọi lẻ từng đơn (CẤM Promise.all).
 */
async function fetchNormalizeShopeeOrderChunk(
  apiShopId: string,
  accessToken: string,
  fileKey: string,
  orderSns: string[],
  opts?: { enrichTracking?: boolean; skipEscrow?: boolean },
): Promise<{ normalized: any[]; errors: any[]; failed_orders: string[] }> {
  const normalized: any[] = [];
  const errors: any[] = [];
  const failed_orders: string[] = [];
  const notFoundSns = new Set<string>();
  const enrichTracking = opts?.enrichTracking !== false;
  void enrichTracking; // tracking chạy ở persistShopeeOrderChunk — không gọi x2 ở đây
  const skipEscrow = opts?.skipEscrow === true;
  const snList = orderSns.map((sn) => String(sn || "").trim()).filter(Boolean);
  if (snList.length === 0) return { normalized, errors, failed_orders };

  // Ép kiểu String cho shop_id — tránh lệch Number/String khi gọi API (shop 831052930…).
  const shopApiId = String(normalizeShopIdKey(apiShopId) || apiShopId || "").trim();
  const shopFileKey = String(normalizeShopIdKey(fileKey) || fileKey || shopApiId).trim();
  if (!shopApiId) {
    console.error(
      `[Sync Shop ${fileKey}] Lỗi: fetchNormalizeShopeeOrderChunk thiếu shop_id hợp lệ` +
        ` (apiShopId=${String(apiShopId)} typeof=${typeof apiShopId})`,
    );
    for (const sn of snList) {
      failed_orders.push(sn);
      errors.push({
        shopId: fileKey,
        error: "invalid_shop_id",
        message: `Thiếu shop_id hợp lệ khi get_order_detail`,
        orderSn: sn,
      });
    }
    return { normalized, errors, failed_orders };
  }

  const batchSize = Math.min(ORDER_DETAIL_FETCH_BATCH_SIZE, SHOPEE_ORDER_DETAIL_MAX_ORDER_SNS);
  console.log(
    `[Shopee Sync] get_order_detail BATCH ${snList.length} đơn (shop=${shopFileKey} apiShopId=${shopApiId}) — size=${batchSize}, delay=${ORDER_DETAIL_BATCH_DELAY_MS}ms/mẻ`,
  );

  const pushFail = (
    orderSn: string,
    error: string,
    message: string,
    httpStatus?: number,
  ) => {
    failed_orders.push(orderSn);
    errors.push({ shopId: shopFileKey, error, message, orderSn, httpStatus });
    if (
      isShopeeOrderNotFoundError(error, message) ||
      isShopeeWrongShopError(error, message)
    ) {
      notFoundSns.add(orderSn);
    }
  };

  const normalizeOne = (orderSn: string, detail: any): any | null => {
    try {
      const norm = normalizeShopeeOrderDetail(shopFileKey, detail?.shop_name, detail);
      if (!norm) {
        console.error("Lỗi ở đơn:", orderSn, "normalize trả null (thiếu field)");
        pushFail(orderSn, "normalize_null", "normalizeShopeeOrderDetail trả null");
        return null;
      }
      return norm;
    } catch (mapErr: any) {
      console.error("Lỗi ở đơn:", orderSn, mapErr?.message || mapErr);
      pushFail(orderSn, "normalize_failed", mapErr?.message || String(mapErr));
      return null;
    }
  };

  /** Fallback tuần tự: CẤM Promise.all — 1 request/lần + sleep 500ms (CageFS nproc). */
  const fetchBatchIndividually = async (batch: string[], token: string) => {
    let tok = token;
    for (const orderSn of batch) {
      try {
        let detailResult = await shopeeGetOrderDetail(shopApiId, tok, [orderSn]);
        if (
          detailResult?.httpStatus === 401 ||
          detailResult?.httpStatus === 403 ||
          isShopeeInvalidTokenError(detailResult?.error, detailResult?.message)
        ) {
          try {
            const refreshed = await refreshShopeeAccessTokenLocked(shopFileKey, { force: true });
            if (refreshed) {
              tok = refreshed;
              accessToken = refreshed;
              detailResult = await shopeeGetOrderDetail(shopApiId, tok, [orderSn]);
            }
          } catch (refreshErr: any) {
            console.error(
              `[Sync Shop ${shopFileKey}] Lỗi: token_refresh order=${orderSn}:`,
              refreshErr?.message || refreshErr,
            );
            await delay(1000);
          }
        }
        if (isShopeeRateLimited(detailResult?.httpStatus, detailResult)) {
          await delay(SHOPEE_ORDER_LIST_PAGE_DELAY_MS);
          detailResult = await shopeeGetOrderDetail(shopApiId, tok, [orderSn]);
        }
        if (detailResult?.error) {
          const message =
            detailResult.message || formatShopeeApiError(detailResult, detailResult.httpStatus);
          console.error(`[Sync Shop ${shopFileKey}] Lỗi ở đơn ${orderSn}:`, message);
          pushFail(orderSn, String(detailResult.error), message, detailResult.httpStatus);
        } else {
          const detailList = detailResult?.response?.order_list ?? detailResult?.order_list ?? [];
          const detail = Array.isArray(detailList)
            ? detailList.find((d: any) => String(d?.order_sn || "").trim() === orderSn) || detailList[0]
            : null;
          if (!detail) {
            console.error(
              `[Sync Shop ${shopFileKey}] Lỗi ở đơn ${orderSn}: get_order_detail rỗng → treat NOT FOUND`,
            );
            pushFail(
              orderSn,
              "order_not_found",
              `get_order_detail không trả order_sn=${orderSn}`,
            );
          } else {
            const norm = normalizeOne(orderSn, detail);
            if (norm) {
              norm._shop_owner_verified = true;
              normalized.push(norm);
            }
          }
        }
      } catch (err: any) {
        const msg = err?.message || String(err);
        console.error(`[Sync Shop ${shopFileKey}] Lỗi ở đơn ${orderSn}:`, msg);
        if (isShopeeOrderNotFoundError(err?.code || err?.error, msg)) {
          pushFail(orderSn, "order_not_found", msg);
        } else {
          pushFail(orderSn, "order_detail_exception", msg);
        }
      }
      await shopeeSyncDelay(SHOPEE_ORDER_LIST_PAGE_DELAY_MS);
    }
  };

  for (let i = 0; i < snList.length; i += batchSize) {
    const batch = snList.slice(i, i + batchSize);
    const batchNo = Math.floor(i / batchSize) + 1;
    const totalBatches = Math.ceil(snList.length / batchSize);
    try {
      console.log(
        `[Shopee Sync] get_order_detail mẻ ${batchNo}/${totalBatches} — ${batch.length} đơn (shop=${shopFileKey})`,
      );
      let detailResult = await shopeeGetOrderDetail(shopApiId, accessToken, batch);

      if (
        detailResult?.httpStatus === 401 ||
        detailResult?.httpStatus === 403 ||
        isShopeeInvalidTokenError(detailResult?.error, detailResult?.message)
      ) {
        console.warn(
          `[Sync Shop ${shopFileKey}] Lỗi: get_order_detail AUTH FAIL — force refresh token + retry 1 lần`,
        );
        try {
          const refreshed = await refreshShopeeAccessTokenLocked(shopFileKey, { force: true });
          if (refreshed) {
            accessToken = refreshed;
            detailResult = await shopeeGetOrderDetail(shopApiId, accessToken, batch);
          }
        } catch (refreshErr: any) {
          console.error(
            `[Sync Shop ${shopFileKey}] Lỗi: Token refresh sau GetOrderDetail:`,
            refreshErr?.message || refreshErr,
          );
          await delay(1000);
        }
      }

      if (isShopeeRateLimited(detailResult?.httpStatus, detailResult)) {
        console.warn(
          `[Sync Shop ${shopFileKey}] Lỗi: get_order_detail RATE LIMIT — chờ ${ORDER_DETAIL_BATCH_DELAY_MS * 2}ms rồi retry`,
        );
        await delay(ORDER_DETAIL_BATCH_DELAY_MS * 2);
        try {
          detailResult = await shopeeGetOrderDetail(shopApiId, accessToken, batch);
        } catch (rlErr: any) {
          console.error(
            `[Sync Shop ${shopFileKey}] Lỗi: get_order_detail rate-limit retry:`,
            rlErr?.message || rlErr,
          );
        }
      }

      if (detailResult?.error) {
        const message =
          detailResult.message || formatShopeeApiError(detailResult, detailResult.httpStatus);
        // Batch not-found / sai shop — probe lẻ, KHÔNG đánh CANCELLED.
        if (isShopeeOrderNotFoundError(detailResult.error, message) && batch.length === 1) {
          pushFail(batch[0], String(detailResult.error), message, detailResult.httpStatus);
        } else if (isShopeeOrderNotFoundError(detailResult.error, message) && batch.length > 1) {
          console.error(
            `[Sync Shop ${shopFileKey}] Lỗi: batch not-found — probe từng đơn, KHÔNG hủy: ${message}`,
          );
          await fetchBatchIndividually(batch, accessToken);
        } else {
          console.warn(
            `[Sync Shop ${shopFileKey}] Lỗi: get_order_detail batch ${message} — fallback từng đơn`,
          );
          await fetchBatchIndividually(batch, accessToken);
        }
      } else {
        const detailList = detailResult?.response?.order_list ?? detailResult?.order_list ?? [];
        if (!Array.isArray(detailList) || detailList.length === 0) {
          console.warn(
            `[Sync Shop ${shopFileKey}] Lỗi: get_order_detail trả rỗng lô ${batch.length} — fallback từng đơn`,
          );
          await fetchBatchIndividually(batch, accessToken);
        } else {
          const detailBySn = new Map<string, any>();
          for (const detail of detailList) {
            const sn = String(detail?.order_sn || "").trim();
            if (sn) detailBySn.set(sn, detail);
          }
          const missingSns: string[] = [];
          for (const orderSn of batch) {
            const detail = detailBySn.get(orderSn);
            if (!detail) {
              missingSns.push(orderSn);
              continue;
            }
            const norm = normalizeOne(orderSn, detail);
            if (norm) {
              norm._shop_owner_verified = true;
              normalized.push(norm);
            }
          }
          // Thiếu trong batch response → probe lẻ tuần tự; KHÔNG đánh CANCELLED.
          if (missingSns.length > 0) {
            console.warn(
              `[Sync Shop ${shopFileKey}] ${missingSns.length} đơn thiếu trong batch → probe lẻ: ${missingSns.slice(0, 5).join(",")}`,
            );
            await fetchBatchIndividually(missingSns, accessToken);
          }
        }
      }
    } catch (err: any) {
      console.error(
        `[Sync Shop ${shopFileKey}] Lỗi: Exception get_order_detail batch:`,
        err?.message || err,
        "— fallback tuần tự từng đơn",
      );
      await fetchBatchIndividually(batch, accessToken);
    }

    if (i + batchSize < snList.length) {
      await delay(ORDER_DETAIL_BATCH_DELAY_MS);
    }
  }

  // Escrow (skip trên fast path pull).
  if (normalized.length > 0 && !skipEscrow) {
    try {
      await enrichShopeeOrdersEscrowFinance(shopApiId, accessToken, normalized);
    } catch (escrowErr: any) {
      console.error(
        `[Sync Shop ${shopFileKey}] Lỗi: enrich escrow skip:`,
        escrowErr?.message || escrowErr,
      );
    }
  }

  if (notFoundSns.size > 0) {
    const sns = [...notFoundSns];
    console.error(
      `[Sync Shop ${shopFileKey}] get_order_detail lỗi ${sns.length} đơn — GIỮ NGUYÊN status DB, KHÔNG đánh CANCELLED.` +
        ` sns=${sns.slice(0, 8).join(",")}${sns.length > 8 ? "…" : ""}`,
    );
    await markLocalOrdersCancelledForShopeeNotFound(
      sns,
      shopApiId,
      "get_order_detail_not_found",
    );
    let probed = 0;
    for (const sn of sns) {
      if (probed >= MAX_CROSS_SHOP_PROBE_PER_CHUNK) break;
      probed += 1;
      const hit = await probeOrderDetailOnOtherShops(sn, shopApiId);
      if (!hit) {
        console.error(
          `[Sync Shop ${shopFileKey}] order_sn=${sn} sai shop/token/not-found — không tìm thấy shop khác, giữ trạng thái cũ.`,
        );
        continue;
      }
      try {
        const ownerName =
          resolveConnectedShopDisplayName(hit.shopId) || `Shop ${hit.shopId}`;
        const norm = normalizeShopeeOrderDetail(hit.shopId, ownerName, hit.detail);
        if (norm) {
          norm._shop_owner_verified = true;
          normalized.push(norm);
          const failIdx = failed_orders.indexOf(sn);
          if (failIdx >= 0) failed_orders.splice(failIdx, 1);
          for (let ei = errors.length - 1; ei >= 0; ei -= 1) {
            if (String(errors[ei]?.orderSn || "") === sn) errors.splice(ei, 1);
          }
          console.log(
            `[Sync Shop ${shopFileKey}] REMAP order_sn=${sn} → shop=${hit.shopId} raw=${norm.shopee_order_status || "-"}`,
          );
        }
      } catch (probeMapErr: any) {
        console.error(
          `[Sync Shop ${shopFileKey}] remap normalize fail order_sn=${sn}:`,
          probeMapErr?.message || probeMapErr,
        );
      }
      await shopeeSyncDelay(SHOPEE_ORDER_LIST_PAGE_DELAY_MS);
    }
  }

  return { normalized, errors, failed_orders };
}

/** Tracking sau persist — KHÔNG chặn pull/chunk. Lỗi 1 đơn không lan. */
function scheduleDeferredTrackingEnrich(
  apiShopId: string,
  accessToken: string,
  orders: any[],
): void {
  const list = Array.isArray(orders) ? orders.filter((o) => o?.orderSn) : [];
  if (!list.length || !apiShopId || !accessToken) return;
  setImmediate(() => {
    void (async () => {
      for (const row of list) {
        try {
          await fetchAndForceSaveTrackingNumber(apiShopId, accessToken, row, { retries: 1 });
          promoteOrderStatusWhenTrackingReady(row);
          enforceShopeeTerminalLocalStatus(row);
        } catch (error: any) {
          console.error(
            `[Shopee Tracking] Deferred 1 đơn (không dừng) order_sn=${row?.orderSn}:`,
            error?.message || error,
          );
        }
        await sleep(SHOPEE_TRACKING_FETCH_DELAY_MS);
      }
      try {
        queueOrdersJsonMirrorFromMongo();
      } catch {
        /* ignore */
      }
    })();
  });
}

function kickMissingShopeeTrackingEnrichment(reason: string): void {
  setImmediate(() => {
    void backfillMissingGhnTrackingNumbers()
      .then((r) => {
        if (r?.skipped) return;
        console.log(
          `[GHN Backfill] Deferred (${reason}) candidates=${r?.candidates || 0} filled=${r?.filled || 0}`,
        );
      })
      .catch((err: any) => {
        console.warn(
          `[GHN Backfill] Deferred (${reason}) failed:`,
          err?.message || err,
        );
      });
  });
}

/** Upsert lô đơn vào store JSON + Mongo bulkWrite (1 lần / lô). */
/**
 * Upsert lô đơn — map SHIPPED→shipping (Đang giao) / COMPLETED→completed (Đã giao) in-memory,
 * rồi 1 lần Mongo bulkWrite cho cả lô. CẤM update/upsert từng đơn + CẤM Promise.all.
 * Tracking/PDF không await — GHN chưa có mã không được chặn vòng pull.
 */
async function persistShopeeOrderChunk(
  orders: any[],
  batchNormalized: any[],
  syncCtx?: { apiShopId: string; accessToken: string; skipTracking?: boolean },
): Promise<{ added: number; updated: number }> {
  let added = 0;
  let updated = 0;
  if (!Array.isArray(batchNormalized) || batchNormalized.length === 0) {
    return { added, updated };
  }

  // Quá 20 đơn → chia sub-batch, nghỉ 1s giữa các sub-batch (GC).
  const MAX_BATCH = 20;
  if (batchNormalized.length > MAX_BATCH) {
    for (let i = 0; i < batchNormalized.length; i += MAX_BATCH) {
      const sub = batchNormalized.slice(i, i + MAX_BATCH);
      const part = await persistShopeeOrderChunk(orders, sub, syncCtx);
      added += part.added;
      updated += part.updated;
      if (i + MAX_BATCH < batchNormalized.length) {
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
    return { added, updated };
  }

  // ——— BƯỚC 1: Lưu thông tin cơ bản từ get_order_detail (chưa gọi logistics) ———
  const touched: any[] = [];

  // Preload bản ghi Mongo theo order_sn của batch — đảm bảo giữ tracking_no khi hủy/hoàn
  // dù mảng `orders` in-memory thiếu (full-scan timeout / webhook working-set).
  if (isMongoReady()) {
    try {
      const snNeed = batchNormalized
        .map((o) => String(o?.orderSn || "").trim())
        .filter(Boolean)
        .filter((sn) => !orders.some((o: any) => String(o?.orderSn || "") === sn));
      if (snNeed.length > 0) {
        const mongoExisting = await loadOrdersFromStore({ orderSns: snNeed });
        for (const row of mongoExisting || []) {
          if (!row?.orderSn) continue;
          orders.push(row);
        }
      }
    } catch (preloadErr: any) {
      console.warn(
        `[Orders Sync] preload existing tracking failed:`,
        preloadErr?.message || preloadErr,
      );
    }
  }

  for (const normalized of batchNormalized) {
    try {
      if (!normalized?.orderSn) {
        console.warn("[Orders Sync] SKIP đơn thiếu orderSn — không phải do cờ ĐVVC.");
        continue;
      }
      // ĐA SHOP: đơn thuộc shop nào thì CHỐT shopId/shopName shop đó.
      // Ưu tiên shop đã xác thực từ get_order_detail thành công (kể cả probe shop khác).
      // Fallback = shop đang chạy cron/webhook (syncCtx.apiShopId).
      const verifiedShop =
        normalized._shop_owner_verified === true
          ? String(normalizeShopIdKey(normalized.shopId) || normalized.shopId || "").trim()
          : "";
      const ownerShop =
        verifiedShop ||
        (syncCtx?.apiShopId
          ? normalizeShopIdKey(syncCtx.apiShopId) || String(syncCtx.apiShopId)
          : "") ||
        normalizeShopIdKey(normalized.shopId) ||
        String(normalized.shopId || "").trim();
      if (!ownerShop) {
        console.warn(
          `[Orders Sync] SKIP order_sn=${normalized.orderSn} — thiếu shop_id (multi-shop bắt buộc)`,
        );
        continue;
      }
      const prevShop = normalizeShopIdKey(normalized.shopId) || String(normalized.shopId || "");
      if (prevShop && prevShop !== ownerShop) {
        console.warn(
          `[Orders Sync] CORRECT shopId order_sn=${normalized.orderSn} ${prevShop} → ${ownerShop}`,
        );
      }
      normalized.shopId = ownerShop;
      normalized.shopName =
        resolveConnectedShopDisplayName(ownerShop, normalized.shopName) || `Shop ${ownerShop}`;
      // KHÔNG skip theo is_handed_over / internal_status — mọi đơn Shopee đều được upsert.
      const existing = orders.find(
        (o: any) => String(o.orderSn || "") === String(normalized.orderSn || ""),
      );
      if (existing) {
        preserveExistingTrackingIfIncomingEmpty(normalized, existing);
      }
      forceHealPickupOrderIfHasTracking(normalized);
      repairFalseProcessedReadyToShip(normalized);
      enforceShopeeTerminalLocalStatus(normalized);

      // Đảm bảo READY_TO_SHIP/RETRY_SHIP luôn có raw + local status trước khi ghi Mongo.
      {
        const raw = String(normalized.shopee_order_status || "").toUpperCase();
        if (raw === "READY_TO_SHIP" || raw === "RETRY_SHIP") {
          normalized.shopee_order_status = raw;
          if (
            normalized.status !== "shipping" &&
            normalized.status !== "completed" &&
            !hasUsableShopeeTrackingNumber(normalized)
          ) {
            const alreadyPrepared =
              existing?.isPrepared === true ||
              existing?.status === "processed" ||
              normalized.isPrepared === true ||
              normalized.status === "processed";
            if (alreadyPrepared) {
              normalized.status = "processed";
              normalized.isPrepared = true;
            } else {
              normalized.status = "unprocessed";
              normalized.isPrepared = false;
            }
          }
        }
      }

      if (normalized.partialCancel) {
        await restoreLocalStockForPartialCancel(
          normalized.shopId || existing?.shopId,
          existing,
          normalized,
        );
      }

      const existingIndex = orders.findIndex(
        (o: any) => String(o.orderSn || "") === String(normalized.orderSn || ""),
      );
      let row: any;
      if (existingIndex >= 0) {
        const existingShop =
          normalizeShopIdKey(orders[existingIndex]?.shopId) ||
          String(orders[existingIndex]?.shopId || "");
        if (existingShop && existingShop !== ownerShop) {
          console.warn(
            `[Orders Sync] CORRECT shopId (DB) order_sn=${normalized.orderSn} ${existingShop} → ${ownerShop}`,
          );
        }
        orders[existingIndex] = mergeShopeeOrderOnSync(orders[existingIndex], normalized);
        row = orders[existingIndex];
        updated++;
      } else {
        // INSERT: raw Shopee — không gán cờ ĐVVC.
        orders.unshift(normalized);
        row = orders[0];
        added++;
      }
      row.shopId = ownerShop;
      row.shopName =
        resolveConnectedShopDisplayName(ownerShop, row.shopName) || `Shop ${ownerShop}`;
      row._shop_owner_verified = true;
      forceHealPickupOrderIfHasTracking(row);
      promoteOrderStatusWhenTrackingReady(row);
      enforceShopeeTerminalLocalStatus(row);
      applyShopeeCancelReturnClassification(row);

      console.log("Dữ liệu chuẩn bị lưu DB:", {
        orderSn: row.orderSn,
        shopId: row.shopId,
        shopName: row.shopName,
        status: row.status,
        shopee_order_status: row.shopee_order_status,
        tracking_no: row.trackingNumber || row.tracking_no || null,
        return_tracking_no: row.return_tracking_no || row.returnTrackingNumber || null,
        packageNumber: row.packageNumber || row.package_number || null,
        action: existingIndex >= 0 ? "update" : "insert",
        note: "ROLLBACK: raw Shopee $set only",
      });

      touched.push(row);
    } catch (e: any) {
      console.error(
        "LỖI SYNC SHOPEE:",
        `persist 1 đơn order_sn=${normalized?.orderSn}:`,
        e?.message || e,
        e?.stack || "",
      );
      continue;
    }
  }

  // Mongo bulkWrite hoàn tất trước; orders.json mirror từ Mongo (tránh webhook
  // truyền working-set 1 đơn rồi ghi đè mất toàn bộ JSON).
  // CẤM for...await save/findOneAndUpdate từng đơn — chỉ bulkWrite 1 lần / lô.
  const newlyAddedForPdf: any[] = [];
  if (touched.length > 0) {
    if (!isMongoReady()) throw new Error("mongodb_not_ready");
    console.log(`[Orders Sync] Trạng thái chạy BulkWrite — ops=${touched.length}`);
    const mongoN = await bulkUpsertOrdersToStore(touched);
    try {
      invalidateOrdersRefreshCache();
    } catch {
      /* ignore */
    }
    queueOrdersJsonMirrorFromMongo();
    console.log(
      `[DB UPDATED] Mongo bulkWrite OK — batch=${touched.length} written=${mongoN} (+${added}/~${updated}) order_sn=${touched.map((o) => o.orderSn).join(",")}`,
    );

    // PDF chỉ khi đã có tracking_no + package_number (GHN chưa mã → create_shipping_document fail).
    for (const row of touched) {
      const sn = String(row?.orderSn || "").trim();
      if (!sn) continue;
      const hasTn = hasUsableShopeeTrackingNumber(row);
      const hasPkg = Boolean(String(row?.packageNumber || row?.package_number || "").trim());
      const hasPdfAlready =
        row?.hasPdf === true ||
        Boolean(
          String(
            row?.waybill_url || row?.labelUrl || row?.pdfUrl || row?.pdfFilename || "",
          ).trim(),
        );
      if (hasTn && hasPkg && !hasPdfAlready) {
        newlyAddedForPdf.push(row);
      }
    }
    if (newlyAddedForPdf.length > 0) {
      console.log(
        `[Orders Sync] Đẩy vào hàng đợi tải PDF — n=${newlyAddedForPdf.length}` +
          ` sns=[${newlyAddedForPdf.map((o) => o.orderSn).join(",")}]`,
      );
      enqueueLabelPdfDownload(newlyAddedForPdf);
    }
  }

  // Tracking SAU persist. Fail chỉ log — không throw, không drop đơn đã lưu.
  try {
    if (syncCtx && touched.length > 0 && syncCtx.skipTracking !== true) {
      const needTn = touched.filter((o) => needsShopeeTrackingEnrichment(o));
      if (needTn.length > 0) {
        syncDiag(
          "Tracking enrich DEFERRED",
          `${needTn.length} đơn → get_tracking_number (không chặn persist)`,
        );
        scheduleDeferredTrackingEnrich(syncCtx.apiShopId, syncCtx.accessToken, needTn);
      }
    } else if (syncCtx?.skipTracking === true && touched.length > 0) {
      syncDiag("Tracking enrich SKIPPED", "fast-path — bù mã sau pull, không chặn chunk");
    }
  } catch (trackGateErr: any) {
    console.warn(
      "[Orders Sync] logistics AFTER persist failed (đơn đã lưu, không drop):",
      trackGateErr?.message || trackGateErr,
    );
  }

  return { added, updated };
}

const CONFIRM_SYNC_SHOP_DELAY_MS = ORDER_DETAIL_BATCH_DELAY_MS;

function buildConfirmedShipMongoPatches(orders: any[], shipMethod?: string) {
  return (Array.isArray(orders) ? orders : [])
    .filter((o) => o && (o.isPrepared === true || String(o.status || "") === "processed"))
    .map((o) => {
      const sn = String(o.orderSn || o.order_sn || "")
        .replace(/^shopee-/i, "")
        .trim();
      const raw = String(o.shopee_order_status || "").trim().toUpperCase();
      const pickup =
        !raw ||
        raw === "READY_TO_SHIP" ||
        raw === "RETRY_SHIP" ||
        raw === "PROCESSED";
      return {
        orderSn: sn,
        shopId: o.shopId != null ? String(o.shopId) : undefined,
        status: pickup ? "processed" : o.status,
        shopee_order_status:
          pickup && (!raw || raw === "READY_TO_SHIP" || raw === "RETRY_SHIP")
            ? "PROCESSED"
            : raw || undefined,
        ship_method: o.ship_method || shipMethod,
        fulfillment_type: o.fulfillment_type || shipMethod,
        tracking_no: String(o.tracking_no || o.trackingNumber || "").trim() || undefined,
        isPrepared: true,
      };
    })
    .filter((p) => p.orderSn);
}

/** Ghi isPrepared + status processed ngay sau ship_order — không chờ bulkUpsert (bỏ cờ nội bộ). */
async function persistConfirmedShipOrdersToMongo(
  orders: any[],
  shipMethod?: string,
): Promise<number> {
  const patches = buildConfirmedShipMongoPatches(orders, shipMethod);
  if (!patches.length) return 0;
  try {
    const n = await bulkUpdateShippedOrdersBySn(patches);
    console.log(
      `[Confirm Persist] bulkUpdateShippedOrdersBySn n=${n} sns=${patches
        .map((p) => p.orderSn)
        .join(",")}`,
    );
    return n;
  } catch (err: any) {
    console.warn("[Confirm Persist] bulkUpdateShippedOrdersBySn:", err?.message || err);
    return 0;
  }
}

/**
 * Sau xác nhận thành công: kéo get_order_detail (trạng thái + mã VĐ) rồi khóa lại isPrepared.
 * Có delay giữa shop để chống rate-limit Shopee.
 */
async function syncConfirmedOrdersFromShopee(
  orders: any[],
  shipMethod?: string,
): Promise<void> {
  const list = (Array.isArray(orders) ? orders : []).filter(
    (o) => o && String(o.orderSn || o.order_sn || "").trim(),
  );
  if (!list.length) return;
  await delay(CONFIRM_SYNC_SHOP_DELAY_MS);
  const byShop = new Map<string, any[]>();
  for (const o of list) {
    const shopId = String(o.shopId || o.shop_id || "").trim();
    if (!shopId) continue;
    const bucket = byShop.get(shopId) || [];
    bucket.push(o);
    byShop.set(shopId, bucket);
  }
  let shopIdx = 0;
  for (const [shopId, shopOrders] of byShop) {
    if (shopIdx > 0) await delay(CONFIRM_SYNC_SHOP_DELAY_MS);
    shopIdx += 1;
    const sns = [
      ...new Set(
        shopOrders
          .map((o) =>
            String(o.orderSn || o.order_sn || "")
              .replace(/^shopee-/i, "")
              .trim(),
          )
          .filter(Boolean),
      ),
    ];
    if (!sns.length) continue;
    try {
      const auth = await getShopeeAccessTokenForApi(shopId);
      if (!auth?.token) {
        console.warn(`[Confirm Sync] no token shopId=${shopId}`);
        continue;
      }
      const working: any[] = [...shopOrders];
      const { normalized } = await fetchNormalizeShopeeOrderChunk(
        auth.apiShopId,
        auth.token,
        auth.fileKey || shopId,
        sns,
        { enrichTracking: true },
      );
      if (normalized.length > 0) {
        for (const row of normalized) {
          row.isPrepared = true;
          const raw = String(row.shopee_order_status || "").toUpperCase();
          if (
            raw === "READY_TO_SHIP" ||
            raw === "RETRY_SHIP" ||
            raw === "PROCESSED" ||
            !raw
          ) {
            row.status = "processed";
          }
        }
        await persistShopeeOrderChunk(working, normalized, {
          apiShopId: auth.apiShopId,
          accessToken: auth.token,
          skipTracking: false,
        });
      }
    } catch (err: any) {
      console.warn(`[Confirm Sync] shopId=${shopId}:`, err?.message || err);
    }
  }
  await persistConfirmedShipOrdersToMongo(list, shipMethod);
}

let forceRescueShopeeOrderSnsOnce = false;

/**
 * Ép get_order_detail + bulkUpsert theo danh sách order_sn — không cần tracking/package_number.
 * Dùng cứu đơn bị rớt (chưa Arrange Shipment). CHỈ 1 LẦN / process — không lọt cron/lookback.
 */
async function forceUpsertShopeeOrderSns(orderSns: string[]): Promise<{
  saved: string[];
  failed: string[];
  skipped?: boolean;
}> {
  const saved: string[] = [];
  const failed: string[] = [];
  if (forceRescueShopeeOrderSnsOnce) {
    console.log("[Force Rescue] SKIPPED — đã chạy 1 lần (mutex once).");
    return { saved, failed, skipped: true };
  }
  forceRescueShopeeOrderSnsOnce = true;
  const sns = [...new Set(orderSns.map((s) => String(s || "").trim()).filter(Boolean))];
  if (sns.length === 0) return { saved, failed };

  ensureShopeeLinkedShopTokenKeys();
  const shopIds: string[] = [];
  const seen = new Set<string>();
  for (const raw of listShopeeSyncShopIds()) {
    try {
      const resolved = resolveShopeeTokenShopId(raw) || normalizeShopIdKey(raw);
      if (resolved && !seen.has(resolved)) {
        seen.add(resolved);
        shopIds.push(resolved);
      }
    } catch {
      /* skip */
    }
  }

  for (const sn of sns) {
    let ok = false;
    for (const shopId of shopIds) {
      try {
        const accessToken = await getValidShopeeAccessToken(shopId);
        if (!accessToken) continue;
        const { normalized } = await fetchNormalizeShopeeOrderChunk(
          shopId,
          accessToken,
          shopId,
          [sn],
          { enrichTracking: false, skipEscrow: true },
        );
        if (!Array.isArray(normalized) || normalized.length === 0) {
          await shopeeSyncDelay(SHOPEE_ORDER_LIST_PAGE_DELAY_MS);
          continue;
        }
        await persistShopeeOrderChunk([], normalized, {
          apiShopId: shopId,
          accessToken,
          skipTracking: true,
        });
        saved.push(sn);
        ok = true;
        console.log(
          `[Force Rescue] UPSERT OK order_sn=${sn} shop=${shopId}` +
            ` raw=${normalized[0]?.shopee_order_status || "-"} tn=${normalized[0]?.tracking_no || "—"}`,
        );
        break;
      } catch (err: any) {
        console.warn(
          `[Force Rescue] shop=${shopId} order_sn=${sn}:`,
          err?.message || err,
        );
      }
      await shopeeSyncDelay(SHOPEE_ORDER_LIST_PAGE_DELAY_MS);
    }
    if (!ok) {
      failed.push(sn);
      console.error(`[Force Rescue] KHÔNG lưu được order_sn=${sn} (mọi shop fail / not found)`);
    }
    await shopeeSyncDelay(SHOPEE_ORDER_LIST_PAGE_DELAY_MS);
  }
  return { saved, failed };
}

let rtsBackfillInFlight = false;

/**
 * Background vét READY_TO_SHIP (+ RETRY_SHIP) lookback ≥ 7 ngày — miss webhook.
 * Persist trước, logistics sau (skipTracking). Fail tracking không drop đơn.
 */
async function pullReadyToShipBackfillFromShopee(opts?: {
  lookbackSec?: number;
  trigger?: string;
}): Promise<{
  success: boolean;
  pulled: number;
  added: number;
  updated: number;
  skipped?: boolean;
  message: string;
}> {
  const trigger = String(opts?.trigger || "cron");
  if (rtsBackfillInFlight || isOrdersPullLocked()) {
    return {
      success: true,
      pulled: 0,
      added: 0,
      updated: 0,
      skipped: true,
      message: "RTS backfill skip — pull đang chạy",
    };
  }
  rtsBackfillInFlight = true;
  const startedAt = Date.now();
  let pulled = 0;
  let added = 0;
  let updated = 0;
  const lookbackSec = Math.max(
    READY_TO_SHIP_BACKFILL_LOOKBACK_SEC,
    Number(opts?.lookbackSec) || READY_TO_SHIP_BACKFILL_LOOKBACK_SEC,
  );
  try {
    ensureShopeeLinkedShopTokenKeys();
    const shopIds: string[] = [];
    const seen = new Set<string>();
    for (const raw of listShopeeSyncShopIds()) {
      try {
        const resolved = resolveShopeeTokenShopId(raw) || normalizeShopIdKey(raw);
        if (resolved && !seen.has(resolved)) {
          seen.add(resolved);
          shopIds.push(resolved);
        }
      } catch {
        /* skip */
      }
    }
    console.log(
      `[RTS Backfill] START trigger=${trigger} shops=${shopIds.length} lookbackSec=${lookbackSec}`,
    );

    for (const shopId of shopIds) {
      const shopDeadlineAt = Date.now() + ORDERS_PULL_PER_SHOP_MS;
      let accessToken: string | null = null;
      try {
        accessToken = await getValidShopeeAccessToken(shopId);
      } catch (tokenErr: any) {
        console.warn(`[RTS Backfill] token shop=${shopId}:`, tokenErr?.message || tokenErr);
        continue;
      }
      if (!accessToken) continue;

      const snSet = new Set<string>();
      const statusBudget = Math.max(
        1,
        Math.floor(SHOPEE_ORDER_LIST_LOOP_SAFETY_CAP / 2),
      );
      for (const status of ["READY_TO_SHIP", "RETRY_SHIP"] as const) {
        try {
          const sns = await collectShopeeOrderSnsByStatus(shopId, accessToken, status, {
            lookbackSec,
            deadlineAt: shopDeadlineAt,
            timeRangeField: "create_time",
            allowShortLookback: true,
            pageHardCap: statusBudget,
          });
          for (const sn of sns) snSet.add(sn);
        } catch (listErr: any) {
          console.warn(
            `[RTS Backfill] get_order_list ${status} shop=${shopId}:`,
            listErr?.message || listErr,
          );
        }
        await shopeeSyncDelay(SHOPEE_ORDER_LIST_PAGE_DELAY_MS);
      }

      const orderSnList = [...snSet];
      console.log(`[RTS Backfill] shop=${shopId} sn=${orderSnList.length}`);
      if (!orderSnList.length) continue;

      const working: any[] = [];
      for (let i = 0; i < orderSnList.length; i += SHOPEE_SYNC_CHUNK_SIZE) {
        if (Date.now() >= shopDeadlineAt) break;
        const chunkSns = orderSnList.slice(i, i + SHOPEE_SYNC_CHUNK_SIZE);
        try {
          const fresh = await getValidShopeeAccessToken(shopId);
          if (fresh) accessToken = fresh;
          const { normalized } = await fetchNormalizeShopeeOrderChunk(
            shopId,
            accessToken,
            shopId,
            chunkSns,
            { enrichTracking: false, skipEscrow: true },
          );
          if (!Array.isArray(normalized) || normalized.length === 0) continue;
          const upsert = await persistShopeeOrderChunk(working, normalized, {
            apiShopId: shopId,
            accessToken,
            skipTracking: true,
          });
          added += upsert.added;
          updated += upsert.updated;
          pulled += normalized.length;
        } catch (chunkErr: any) {
          console.error(
            `[RTS Backfill] persist chunk shop=${shopId} sns=${chunkSns.join(",")}:`,
            chunkErr?.message || chunkErr,
          );
        }
        if (i + SHOPEE_SYNC_CHUNK_SIZE < orderSnList.length) {
          await shopeeSyncDelay(SHOPEE_SYNC_CHUNK_DELAY_MS);
        }
      }
      await shopeeSyncDelay(SHOPEE_ORDER_LIST_PAGE_DELAY_MS);
    }

    if (pulled > 0 || added > 0) {
      try {
        kickMissingShopeeTrackingEnrichment("after_rts_backfill");
      } catch (tnErr: any) {
        console.warn(
          "[RTS Backfill] tracking after persist failed (đơn đã lưu):",
          tnErr?.message || tnErr,
        );
      }
    }

    const message =
      `RTS backfill xong pulled=${pulled} +${added}/~${updated} elapsed=${Date.now() - startedAt}ms`;
    console.log(`[RTS Backfill] ${message}`);
    return { success: true, pulled, added, updated, message };
  } catch (err: any) {
    console.error("[RTS Backfill] FATAL:", err?.message || err);
    return {
      success: false,
      pulled,
      added,
      updated,
      message: err?.message || String(err),
    };
  } finally {
    rtsBackfillInFlight = false;
  }
}

/**
 * Manual Sync heal: đơn local kẹt (thiếu mã / sai tab) — gọi lại get_order_detail + get_tracking_number
 * dù ngoài cửa sổ 24 giờ update_time. Đây là bước chữa cháy GHN không phụ thuộc webhook.
 */
// Pull orders from every connected Shopee shop — tuần tự + chunk delay, save orders.json sau mỗi chunk.
// ORDERS_DB_PATH / lookup index / loadOrders — services/orders.js (Phase 5)

/**
 * Local DB timeout guard — CHỈ dùng cho các route đọc MongoDB nội bộ
 * (/api/dashboard, /api/products...). KHÔNG liên quan Shopee API.
 * Mục đích: nếu Mongo bị chậm/mất kết nối, route vẫn trả JSON trong
 * `timeoutMs` thay vì treo request → tránh 502 Bad Gateway trên cPanel.
 */
function withLocalDbTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label}_timeout_${timeoutMs}ms`)), timeoutMs);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timer));
}

// loadOrdersForApi / saveOrders / purgeHandedOver — services/orders.js (Phase 5)

let lastMongoOrderReconcileAt = 0;
const MONGO_ORDER_RECONCILE_COOLDOWN_MS = 5 * 60 * 1000;
const MONGO_ORDER_RECONCILE_LIMIT = 50;

/**
 * Mongo-only orders and records stuck at pending_confirm are refreshed from Shopee
 * before a write-capable API flow proceeds. Shopee's detail response is authoritative
 * and persistShopeeOrderChunk writes the healed state to both JSON and Mongo.
 */
async function reconcileMongoOrdersWithShopee(jsonOrders: any[], mongoOrders: any[]): Promise<number> {
  if (Date.now() - lastMongoOrderReconcileAt < MONGO_ORDER_RECONCILE_COOLDOWN_MS) return 0;

  const jsonSns = new Set(
    jsonOrders
      .map((order) => String(order?.orderSn || "").replace(/^shopee-/i, "").trim())
      .filter(Boolean),
  );
  const candidates = mongoOrders
    .filter((order) => {
      const sn = String(order?.orderSn || "").replace(/^shopee-/i, "").trim();
      const shopId = String(order?.shopId || "").trim();
      const status = String(order?.status || "").trim();
      return (
        String(order?.channel || "") === "shopee" &&
        Boolean(sn && shopId) &&
        (!jsonSns.has(sn) || status === "pending_confirm" || status === "pending_verification")
      );
    })
    .slice(0, MONGO_ORDER_RECONCILE_LIMIT);
  if (candidates.length === 0) return 0;

  lastMongoOrderReconcileAt = Date.now();
  const byShop = new Map<string, string[]>();
  for (const order of candidates) {
    const shopId = String(order.shopId).trim();
    const sn = String(order.orderSn).replace(/^shopee-/i, "").trim();
    const sns = byShop.get(shopId) || [];
    sns.push(sn);
    byShop.set(shopId, sns);
  }

  let reconciled = 0;
  for (const [shopId, orderSns] of byShop) {
    const auth = await getShopeeAccessTokenForApi(shopId);
    if (!auth?.token) continue;
    const { normalized } = await fetchNormalizeShopeeOrderChunk(
      auth.apiShopId,
      auth.token,
      auth.fileKey || shopId,
      orderSns,
    );
    if (normalized.length === 0) continue;
    const result = await persistShopeeOrderChunk(jsonOrders, normalized, {
      apiShopId: auth.apiShopId,
      accessToken: auth.token,
    });
    reconciled += result.added + result.updated;
  }

  if (reconciled > 0) {
    console.log(`[Shopee Reconcile] Mongo-only/stuck orders healed=${reconciled}`);
  }
  return reconciled;
}


// toDateKey / getDashboardDateRange / buildDashboardChart — utils/dashboard.js (Phase 2)

const PRODUCTS_DB_PATH = path.join(APP_ROOT, "data", "products.json"); // Kho Gốc khi PRODUCTS_STORAGE=disk
const LOCAL_INVENTORY_CACHE_PATH = path.join(APP_ROOT, "data", "local_inventory.json"); // legacy
const SQLITE_LEGACY_PATH = path.join(APP_ROOT, "database.sqlite"); // legacy — không dùng runtime

/** Lấy children nếu đã có (không gom nhóm nặng). */
function getProductChildrenList(p: any): any[] {
  try {
    if (Array.isArray(p?.children) && p.children.length > 0) return p.children;
    if (Array.isArray(p?.children_models) && p.children_models.length > 0) return p.children_models;
  } catch {
    /* ignore */
  }
  return [];
}

/** Đọc products — disk (hosting) hoặc Mongo tùy PRODUCTS_STORAGE. */
async function loadProducts(): Promise<any[]> {
  try {
    return await loadProductsFromStore();
  } catch (error) {
    console.error("[Products DB] Failed to read products:", error);
    throw error instanceof Error ? error : new Error(String(error));
  }
}

async function loadProductById(productId: string): Promise<any | null> {
  try {
    return await loadProductByIdFromStore(productId);
  } catch (error) {
    console.error(`[Products DB] loadProductById failed id=${productId}:`, error);
    return null;
  }
}

function collectCatalogLookupKeysFromOrders(orders: any[]): { productIds: string[]; shopeeItemIds: string[] } {
  const productIds = new Set<string>();
  const shopeeItemIds = new Set<string>();
  for (const order of Array.isArray(orders) ? orders : []) {
    for (const item of Array.isArray(order?.items) ? order.items : []) {
      const pid = String(item?.productId || "").trim();
      if (pid) {
        shopeeItemIds.add(pid);
        productIds.add(pid);
        productIds.add(`shopee-item-${pid}`);
      }
      const modelId = String(item?.modelId || item?.shopeeModelId || "").trim();
      if (modelId) {
        shopeeItemIds.add(modelId);
        productIds.add(modelId);
      }
      const sku = String(item?.modelSku || item?.sku || "").trim();
      if (sku) productIds.add(sku);
    }
  }
  return { productIds: [...productIds], shopeeItemIds: [...shopeeItemIds] };
}

/** Chỉ tải catalog cho các SKU/item có trong lô đơn — tránh ProductModel.find({}). */
async function loadProductsForOrders(orders: any[]): Promise<any[]> {
  const { productIds, shopeeItemIds } = collectCatalogLookupKeysFromOrders(orders);
  if (productIds.length === 0 && shopeeItemIds.length === 0) return [];
  try {
    const rows = await loadProductsByIdsFromStore(productIds, shopeeItemIds);
    console.log(
      `[Products DB] loadProductsForOrders — ${orders.length} đơn → query ${productIds.length} id / ${shopeeItemIds.length} itemId → ${rows.length} sản phẩm`,
    );
    return rows;
  } catch (error) {
    console.error("[Products DB] loadProductsForOrders failed:", error);
    return [];
  }
}

/**
 * Local Cache Master — luôn query MongoDB.
 */
async function refreshCache(): Promise<LocalInventoryCache> {
  ensureDataDirs();
  const payload = await buildLocalInventoryCacheFromStore();
  console.log(
    `[Local Cache] refreshCache OK (MongoDB find) — products=${payload.products.length}, listings=${payload.listings.length}`
  );
  return payload;
}

/** Đọc Local Cache từ MongoDB. */
async function loadLocalInventoryCache(): Promise<LocalInventoryCache> {
  try {
    return await buildLocalInventoryCacheFromStore();
  } catch (error) {
    console.error("[Local Cache] Đọc MongoDB thất bại:", error);
    throw error instanceof Error ? error : new Error(String(error));
  }
}

/**
 * Đảm bảo Mongo sẵn sàng + migrate legacy nếu cần.
 */
async function initLocalInventoryIfNeeded(_force = false): Promise<LocalInventoryCache> {
  ensureDataDirs();
  await maybeMigrateJsonToMongoOnBoot();
  return await loadLocalInventoryCache();
}

/** Ghi products — disk (PRODUCTS_STORAGE=disk) hoặc Mongo. */
async function saveProducts(products: any[]): Promise<void> {
  try {
    ensureDataDirs();
    const list = Array.isArray(products)
      ? products.filter((p) => p != null && typeof p === "object")
      : [];
    await saveProductsToStoreAsync(list);
    invalidateMasterSkuIndexCache("saveProducts");
    console.log(
      `[Products DB] WRITE OK — ${isProductsDiskMode() ? "disk" : "mongo"} count=${list.length} path=${isProductsDiskMode() ? getProductsDiskPath() : getMongoUriMasked()}`,
    );
  } catch (error) {
    console.error("[Products DB] Failed to write products:", error);
    throw error instanceof Error ? error : new Error(String(error));
  }
}

async function saveProductsAsync(products: any[]): Promise<void> {
  await saveProducts(products);
}

const INVENTORY_AUDIT_PATH = path.join(APP_ROOT, "data", "inventory_audit.json");
const INVENTORY_BACKUP_DIR = path.join(APP_ROOT, "data", "inventory_backups");

function writeInventoryAudit(event: string, details: Record<string, unknown> = {}): void {
  try {
    ensureDataDirs();
    let existing: any[] = [];
    if (fs.existsSync(INVENTORY_AUDIT_PATH)) {
      const parsed = JSON.parse(fs.readFileSync(INVENTORY_AUDIT_PATH, "utf-8"));
      if (Array.isArray(parsed)) existing = parsed;
    }
    const entry = { id: `inventory-audit-${Date.now()}`, event, at: new Date().toISOString(), ...details };
    fs.writeFileSync(INVENTORY_AUDIT_PATH, JSON.stringify([...existing.slice(-199), entry], null, 2), "utf-8");
    console.warn(`[Inventory Audit] ${event}`, details);
  } catch (error) {
    console.error("[Inventory Audit] Không thể ghi audit:", error);
  }
}

async function backupInventoryBeforeDestructiveAction(reason: string): Promise<string> {
  ensureDataDirs();
  fs.mkdirSync(INVENTORY_BACKUP_DIR, { recursive: true });
  const [products, listings] = await Promise.all([loadProducts(), readChannelListingsDb()]);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const fileName = `inventory-${reason}-${stamp}.json`;
  fs.writeFileSync(
    path.join(INVENTORY_BACKUP_DIR, fileName),
    JSON.stringify({ createdAt: new Date().toISOString(), reason, products, listings }, null, 2),
    "utf-8",
  );
  writeInventoryAudit("backup_created", { reason, fileName, productCount: products.length, listingCount: listings.length });
  return fileName;
}

/** Alias nhẹ — giữ tương thích chỗ gọi cũ (không còn regroup). */
function groupProductsByItemId(products: any[]): any[] {
  return Array.isArray(products) ? products : [];
}

function groupFlatProductsToParents(products: any[]): any[] {
  return Array.isArray(products) ? products : [];
}

const CHANNEL_LISTINGS_DB_PATH = path.join(APP_ROOT, "data", "channel_listings.json"); // legacy
const SHOPEE_SYNC_ERRORS_DB_PATH = path.join(APP_ROOT, "data", "shopee_sync_errors.json");
const SHOPEE_SYNC_ERRORS_MAX_ROWS = 500;

function renameLegacyJsonIfExists(filePath: string): void {
  if (!fs.existsSync(filePath)) return;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dest = `${filePath}.migrated.${stamp}`;
  try {
    fs.renameSync(filePath, dest);
    console.log(`[Mongo Migrate] Renamed ${path.basename(filePath)} → ${path.basename(dest)}`);
  } catch (err) {
    console.warn(`[Mongo Migrate] Không rename được ${filePath}:`, err);
  }
}

function readLegacyJsonArray(filePath: string): any[] {
  try {
    if (!fs.existsSync(filePath)) return [];
    const raw = fs.readFileSync(filePath, "utf-8");
    if (!raw || !raw.trim()) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** Tìm file backup migrate mới nhất (products.json.migrated.*) */
function findLatestMigratedJson(baseName: string): string | null {
  const dataDir = path.join(APP_ROOT, "data");
  if (!fs.existsSync(dataDir)) return null;
  const prefix = `${baseName}.migrated.`;
  const matches = fs
    .readdirSync(dataDir)
    .filter((f) => f.startsWith(prefix))
    .sort();
  if (matches.length === 0) return null;
  return path.join(dataDir, matches[matches.length - 1]);
}

/** Boot-time: nếu Mongo trống mà còn JSON/legacy → migrate lên Atlas.
 *  Khi Kho Gốc = disk: TUYỆT ĐỐI không rename/xóa data/products.json (đó là SSOT). */
async function maybeMigrateJsonToMongoOnBoot(): Promise<void> {
  if (isProductsDiskMode()) {
    // Khôi phục nếu boot migrate cũ từng rename products.json → .migrated.*
    try {
      const existing = fs.existsSync(getProductsDiskPath())
        ? JSON.parse(fs.readFileSync(getProductsDiskPath(), "utf-8") || "[]")
        : [];
      if (!Array.isArray(existing) || existing.length === 0) {
        const dataDir = path.join(APP_ROOT, "data");
        if (fs.existsSync(dataDir)) {
          const migrated = fs
            .readdirSync(dataDir)
            .filter((n) => /^products\.json\.migrated\./i.test(n))
            .sort();
          const latest = migrated[migrated.length - 1];
          if (latest) {
            const src = path.join(dataDir, latest);
            const dest = getProductsDiskPath();
            fs.copyFileSync(src, dest);
            console.log(`[Products Disk] Khôi phục Kho Gốc từ ${latest} → products.json`);
          }
        }
      }
    } catch (restoreErr: any) {
      console.warn("[Products Disk] restore migrated:", restoreErr?.message || restoreErr);
    }
    const diskCount = await countProducts().catch(() => 0);
    console.log(
      `[Products Disk] Bỏ qua migrate JSON→Mongo — Kho Gốc trên disk (${diskCount} SP) @ ${getProductsDiskPath()}`,
    );
    return;
  }
  try {
    const productCount = await countProducts();
    const listingCount = await countChannelListings();
    const legacyProducts =
      PRODUCTS_DB_PATH && fs.existsSync(PRODUCTS_DB_PATH)
        ? PRODUCTS_DB_PATH
        : findLatestMigratedJson("products.json");
    const legacyListings = fs.existsSync(CHANNEL_LISTINGS_DB_PATH)
      ? CHANNEL_LISTINGS_DB_PATH
      : findLatestMigratedJson("channel_listings.json");
    const hasLegacy =
      !!legacyProducts ||
      !!legacyListings ||
      fs.existsSync(LOCAL_INVENTORY_CACHE_PATH) ||
      !!findLatestMigratedJson("local_inventory.json");

    if (!hasLegacy) {
      console.log(
        `[MongoDB] Ready — products=${productCount}, listings=${listingCount} @ ${getMongoUriMasked()} (ready=${isMongoReady()})`
      );
      return;
    }

    if (productCount > 0 || listingCount > 0) {
      console.log(
        `[MongoDB] Đã có dữ liệu (products=${productCount}, listings=${listingCount}) — archive JSON legacy.`
      );
      renameLegacyJsonIfExists(PRODUCTS_DB_PATH);
      renameLegacyJsonIfExists(CHANNEL_LISTINGS_DB_PATH);
      renameLegacyJsonIfExists(LOCAL_INVENTORY_CACHE_PATH);
      return;
    }

    console.log("[Mongo Migrate] Mongo trống + còn JSON legacy — bắt đầu migrate...");
    let products = legacyProducts ? readLegacyJsonArray(legacyProducts) : [];
    let listings = legacyListings ? readLegacyJsonArray(legacyListings) : [];

    const invPath = fs.existsSync(LOCAL_INVENTORY_CACHE_PATH)
      ? LOCAL_INVENTORY_CACHE_PATH
      : findLatestMigratedJson("local_inventory.json");
    if (invPath) {
      try {
        const inv = JSON.parse(fs.readFileSync(invPath, "utf-8"));
        const invProducts = Array.isArray(inv?.products) ? inv.products : [];
        const invListings = Array.isArray(inv?.listings) ? inv.listings : [];
        const byId = new Map<string, any>();
        for (const p of [...invProducts, ...products]) {
          const id = String(p?.id || "").trim();
          if (id) byId.set(id, p);
        }
        products = Array.from(byId.values());
        const byListingId = new Map<string, any>();
        for (const r of [...invListings, ...listings]) {
          const id = String(r?.id || "").trim();
          if (id) byListingId.set(id, r);
        }
        listings = Array.from(byListingId.values());
      } catch (err) {
        console.warn("[Mongo Migrate] Không đọc được local_inventory:", err);
      }
    }

    await seedStoreFromArrays(products, listings);

    console.log(
      `[Mongo Migrate] Xong — products=${await countProducts()}, listings=${await countChannelListings()} (mongoReady=${isMongoReady()})`
    );
    renameLegacyJsonIfExists(PRODUCTS_DB_PATH);
    renameLegacyJsonIfExists(CHANNEL_LISTINGS_DB_PATH);
    renameLegacyJsonIfExists(LOCAL_INVENTORY_CACHE_PATH);
    if (fs.existsSync(SQLITE_LEGACY_PATH)) {
      try {
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        fs.renameSync(SQLITE_LEGACY_PATH, `${SQLITE_LEGACY_PATH}.legacy.${stamp}`);
        console.log("[Mongo Migrate] Archived database.sqlite (không còn dùng)");
      } catch {
        /* ignore */
      }
    }
  } catch (err) {
    console.error("[Mongo Migrate] Boot migrate thất bại:", err);
  }
}

function readShopeeSyncErrorsDb(): any[] {
  try {
    if (!fs.existsSync(SHOPEE_SYNC_ERRORS_DB_PATH)) return [];
    const raw = fs.readFileSync(SHOPEE_SYNC_ERRORS_DB_PATH, "utf-8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    console.error("[Shopee Sync Errors DB] Failed to read:", err);
    return [];
  }
}

async function appendShopeeSyncErrorToDb(entry: {
  itemId?: number | string;
  modelId?: number | string;
  sku?: string;
  shopId?: string;
  action: string;
  error: string;
  productId?: string;
}): Promise<void> {
  const row = {
    id: `se-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: new Date().toISOString(),
    platform: "shopee",
    itemId: entry.itemId != null ? String(entry.itemId) : undefined,
    modelId: entry.modelId != null ? String(entry.modelId) : undefined,
    sku: entry.sku ? String(entry.sku) : undefined,
    shopId: entry.shopId ? String(entry.shopId) : undefined,
    action: entry.action,
    error: String(entry.error || "unknown_error").slice(0, 500),
    productId: entry.productId ? String(entry.productId) : undefined,
  };

  try {
    const prev = readShopeeSyncErrorsDb();
    const next = [row, ...prev].slice(0, SHOPEE_SYNC_ERRORS_MAX_ROWS);
    fs.mkdirSync(path.dirname(SHOPEE_SYNC_ERRORS_DB_PATH), { recursive: true });
    fs.writeFileSync(SHOPEE_SYNC_ERRORS_DB_PATH, JSON.stringify(next, null, 2), "utf-8");
  } catch (err) {
    console.error("[Shopee Sync Errors DB] Failed to write:", err);
  }

  const channelId = row.modelId && row.itemId ? `${row.itemId}:${row.modelId}` : row.itemId;
  if (!channelId) return;

  try {
    const listings = await readChannelListingsDb();
    const key = `shopee::${channelId}`;
    let changed = false;
    const nextListings = listings.map((listing: any) => {
      if (`${listing.platform}::${listing.channelId}` !== key) return listing;
      changed = true;
      return {
        ...sanitizeChannelListingRow(listing),
        status: "failed",
        syncError: row.error,
        updatedAt: row.timestamp,
      };
    });
    if (changed) await writeChannelListingsDb(nextListings);
  } catch (err) {
    console.error("[Shopee Sync Errors DB] Failed to update channel_listings:", err);
  }
}

async function readChannelListingsDb(): Promise<any[]> {
  try {
    return await loadChannelListingsFromStore();
  } catch (error) {
    console.error("[Channel Listings DB] Failed to read from MongoDB:", error);
    throw error instanceof Error ? error : new Error(String(error));
  }
}

async function writeChannelListingsDb(rows: any[]): Promise<void> {
  await writeChannelListingsDbAsync(rows);
}

async function writeChannelListingsDbAsync(rows: any[]): Promise<void> {
  ensureDataDirs();
  const payload = Array.isArray(rows) ? rows.filter((r) => r != null && typeof r === "object") : [];
  await saveChannelListingsToStoreAsync(payload);
  console.log(
    `Đã lưu DB thành công — channel_listings ${isProductsDiskMode() ? "disk" : "MongoDB"}: ${payload.length} dòng`,
  );
}

/** Sản phẩm kéo từ Shopee dạng shopee-item-* — KHÔNG phải Kho gốc thủ công. */
function isSyntheticShopeePullProduct(p: any): boolean {
  const id = String(p?.id || "");
  return id.startsWith("shopee-item-");
}

function sanitizeChannelListingRow(row: any): any {
  const platform = String(row?.platform || "shopee").trim() || "shopee";
  const channelId = String(row?.channelId || "").trim();
  const statusRaw = String(row?.status || "unlinked");
  const status = ["success", "failed", "unlinked", "invalid"].includes(statusRaw) ? statusRaw : "unlinked";
  const linkedProductId =
    row?.linkedProductId != null && String(row.linkedProductId).trim() !== ""
      ? String(row.linkedProductId)
      : undefined;
  return {
    id: String(row?.id || `cl-${platform}-${channelId || "unknown"}`),
    title: String(row?.title ?? ""),
    sku: String(row?.sku ?? ""),
    imageUrl: row?.imageUrl ? String(row.imageUrl) : undefined,
    channelId,
    platform,
    shopName: String(row?.shopName ?? ""),
    shopId: row?.shopId != null && String(row.shopId).trim() !== "" ? String(row.shopId) : undefined,
    status,
    linkedProductId,
    // Snapshot tên/SKU kho gốc — dùng khi JOIN miss (pagination / file lệch).
    linkedProductTitle:
      row?.linkedProductTitle != null && String(row.linkedProductTitle).trim() !== ""
        ? String(row.linkedProductTitle).trim()
        : undefined,
    linkedProductSku:
      row?.linkedProductSku != null && String(row.linkedProductSku).trim() !== ""
        ? String(row.linkedProductSku).trim()
        : undefined,
    itemId: row?.itemId != null && String(row.itemId).trim() !== "" ? String(row.itemId) : undefined,
    modelId: row?.modelId != null && String(row.modelId).trim() !== "" ? String(row.modelId) : undefined,
    price: Math.max(0, Math.round(Number(row?.price ?? row?.sellingPrice) || 0)),
    weight: Math.max(0, Number(row?.weight) || 0),
    stock: Math.max(0, Math.round(Number(row?.stock) || 0)),
    syncError: row?.syncError ? String(row.syncError).slice(0, 500) : undefined,
    updatedAt: String(row?.updatedAt || new Date().toISOString()),
  };
}

/** Index id → product (parent + children) để JOIN mapping ↔ kho gốc. */
function buildMasterProductLookupById(products?: any[]): Map<string, any> {
  const index = new Map<string, any>();
  for (const p of Array.isArray(products) ? products : []) {
    if (!p) continue;
    if (p.id != null) index.set(String(p.id), p);
    for (const c of getProductChildrenList(p)) {
      if (c?.id != null) index.set(String(c.id), c);
    }
  }
  return index;
}

/**
 * JOIN mapping ↔ Kho gốc — lookup BẮT BUỘC theo record.linkedProductId trong DATA,
 * không phụ thuộc UI có render ID hay không.
 * Phòng thủ: mọi truy cập linkedProduct dùng ?. ; lỗi 1 dòng không crash toàn bộ.
 */
function enrichChannelListingsWithMaster(listings: any[], products?: any[]): any[] {
  try {
    const safeListings = Array.isArray(listings) ? listings : [];
    let lookup: Map<string, any>;
    try {
      const sourceProducts = Array.isArray(products) ? products : [];
      lookup = buildMasterProductLookupById(sourceProducts);
    } catch (lookupErr: unknown) {
      console.error("[Mapping Products] buildMasterProductLookupById failed:", lookupErr);
      lookup = new Map();
    }
    let brokenCount = 0;

    const enriched = safeListings.map((row) => {
      try {
        if (!row || typeof row !== "object") {
          return sanitizeChannelListingRow({ status: "unlinked" });
        }
        const base = sanitizeChannelListingRow(row);
        const linkedId =
          base.linkedProductId ||
          (row?.linkedProduct?.id != null ? String(row.linkedProduct.id) : undefined);

        if (!linkedId) {
          if (base.status === "success") {
            brokenCount++;
            return {
              ...base,
              status: "unlinked",
              linkedProductId: undefined,
              linkedProductTitle: undefined,
              linkedProductSku: undefined,
              linkedProduct: undefined,
              syncError: "Lỗi liên kết (Mất dữ liệu): thiếu linkedProductId trong record",
              linkBroken: true,
            };
          }
          return {
            ...base,
            linkedProductTitle: undefined,
            linkedProductSku: undefined,
            linkedProduct: undefined,
          };
        }

        const master = lookup.get(String(linkedId));
        if (!master) {
          brokenCount++;
          const snapTitle =
            base.linkedProductTitle ||
            String(row?.linkedProduct?.title || "").trim() ||
            undefined;
          const snapSku =
            base.linkedProductSku ||
            String(row?.linkedProduct?.sku || "").trim() ||
            undefined;
          if (base.status === "success") {
            return {
              ...base,
              status: "unlinked",
              linkedProductId: undefined,
              linkedProductTitle: undefined,
              linkedProductSku: undefined,
              linkedProduct: undefined,
              syncError: `Lỗi liên kết (Mất dữ liệu): không tìm thấy SP id=${linkedId}${snapTitle ? ` (trước đó: ${snapTitle})` : ""}`,
              linkBroken: true,
              previousLinkedProductId: linkedId,
              previousLinkedTitle: snapTitle,
              previousLinkedSku: snapSku,
            };
          }
          return {
            ...base,
            linkedProductTitle: undefined,
            linkedProductSku: undefined,
            linkedProduct: undefined,
            linkBroken: true,
          };
        }

        const title = String(master?.title || base.linkedProductTitle || "").trim();
        const sku = String(master?.sku || base.linkedProductSku || "").trim();
        if (base.status === "success" && !title && !sku) {
          brokenCount++;
          return {
            ...base,
            status: "unlinked",
            linkedProductId: undefined,
            linkedProduct: undefined,
            linkedProductTitle: undefined,
            linkedProductSku: undefined,
            syncError: `Lỗi liên kết (Mất dữ liệu): SP id=${linkedId} thiếu title/sku`,
            linkBroken: true,
          };
        }

        return {
          ...base,
          linkedProductId: String(linkedId),
          linkedProductTitle: title || undefined,
          linkedProductSku: sku || undefined,
          linkedProduct: {
            id: String(master?.id ?? linkedId),
            title: title || String(master?.id ?? linkedId),
            sku: sku || "—",
          },
          syncError: base.status === "success" ? undefined : base.syncError,
          linkBroken: false,
        };
      } catch (rowErr: unknown) {
        console.error("[Mapping Products] enrich row skip:", rowErr);
        try {
          return sanitizeChannelListingRow({
            ...(row && typeof row === "object" ? row : {}),
            status: "unlinked",
            linkedProductId: undefined,
            syncError: "enrich_row_error",
            linkBroken: true,
          });
        } catch {
          return {
            id: `cl-error-${Date.now()}`,
            title: "",
            sku: "",
            channelId: "",
            platform: "shopee",
            shopName: "",
            status: "unlinked",
            updatedAt: new Date().toISOString(),
            linkBroken: true,
          };
        }
      }
    });

    if (brokenCount > 0) {
      console.warn(
        `[Mapping Products] Có ${brokenCount} dòng status=success nhưng linkedProduct null/mất — đã hạ về unlinked (in-memory)`
      );
    }
    return enriched;
  } catch (err: unknown) {
    console.error("[Mapping Products] enrichChannelListingsWithMaster failed:", err);
    return (Array.isArray(listings) ? listings : []).map((row) => {
      try {
        return sanitizeChannelListingRow(row);
      } catch {
        return {
          id: `cl-fallback-${Date.now()}`,
          title: "",
          sku: "",
          channelId: "",
          platform: "shopee",
          shopName: "",
          status: "unlinked",
          updatedAt: new Date().toISOString(),
        };
      }
    });
  }
}

/**
 * Heal liên kết hỏng — CHỈ gọi chủ động qua POST /api/mapping-products/heal.
 * KHÔNG gọi trên GET (tránh OOM / crash cPanel khi ghi file lớn).
 * @returns số dòng đã ghi DB
 */
async function persistHealedBrokenMappingLinks(enriched: any[]): Promise<number> {
  try {
    const broken = Array.isArray(enriched) ? enriched.filter((r) => r?.linkBroken === true) : [];
    if (broken.length === 0) return 0;

    const existing = await readChannelListingsDb();
    const byId = new Map(
      (Array.isArray(existing) ? existing : [])
        .filter((r: any) => r?.id != null)
        .map((r: any) => [String(r.id), r])
    );
    let changed = 0;
    for (const row of broken) {
      const id = String(row?.id || "");
      if (!id) continue;
      const prev = byId.get(id);
      if (!prev) continue;
      byId.set(
        id,
        sanitizeChannelListingRow({
          ...prev,
          status: "unlinked",
          linkedProductId: undefined,
          linkedProductTitle: undefined,
          linkedProductSku: undefined,
          syncError: row?.syncError,
        })
      );
      changed++;
    }
    if (changed > 0) {
      await writeChannelListingsDb(Array.from(byId.values()));
      console.log(`[Mapping Products] Đã heal ${changed} liên kết hỏng → unlinked trong DB`);
    }
    return changed;
  } catch (err: unknown) {
    console.error("[Mapping Products] persistHealedBrokenMappingLinks failed:", err);
    throw err instanceof Error ? err : new Error(String(err));
  }
}

/**
 * Xóa orphan mapping một cách bảo thủ:
 * - Giữ nguyên mọi dòng chưa từng liên kết.
 * - Chỉ xóa dòng có linkedProductId/linkedProduct.id hoặc status=success,
 *   nhưng không còn trỏ tới sản phẩm parent/child trong Kho gốc.
 * - Hàm này chỉ ghi channel_listings (MongoDB), tuyệt đối không gọi (await saveProducts()).
 */
async function purgeBrokenChannelListings(): Promise<{
  scanned: number;
  purged: number;
  remaining: number;
  missingLinkedId: number;
  missingMasterProduct: number;
  malformed: number;
  masterProductCount: number;
}> {
  const listings = await readChannelListingsDb();
  const masterProducts = await loadProducts();
  const masterLookup = buildMasterProductLookupById(masterProducts);
  const kept: any[] = [];
  let missingLinkedId = 0;
  let missingMasterProduct = 0;
  let malformed = 0;

  for (const row of listings) {
    if (!row || typeof row !== "object") {
      malformed++;
      continue;
    }

    const linkedId =
      row?.linkedProductId != null && String(row.linkedProductId).trim() !== ""
        ? String(row.linkedProductId).trim()
        : row?.linkedProduct?.id != null && String(row.linkedProduct.id).trim() !== ""
          ? String(row.linkedProduct.id).trim()
          : "";
    const claimsLink = row?.status === "success" || linkedId !== "";

    // Dòng chưa liên kết là dữ liệu sàn hợp lệ, không phải orphan.
    if (!claimsLink) {
      kept.push(row);
      continue;
    }
    if (!linkedId) {
      missingLinkedId++;
      continue;
    }
    if (!masterLookup.has(linkedId)) {
      missingMasterProduct++;
      continue;
    }

    kept.push(row);
  }

  const purged = listings.length - kept.length;
  if (purged > 0) {
    await writeChannelListingsDb(kept);
  }
  console.log(
    `[Mapping Purge] scanned=${listings.length}, purged=${purged}, remaining=${kept.length}, missingLinkedId=${missingLinkedId}, missingMaster=${missingMasterProduct}, malformed=${malformed}, masterUntouched=${masterProducts.length}`,
  );

  return {
    scanned: listings.length,
    purged,
    remaining: kept.length,
    missingLinkedId,
    missingMasterProduct,
    malformed,
    masterProductCount: masterProducts.length,
  };
}

async function upsertChannelListingsFromShopeeSync(
  syncedProducts: any[],
  shopId: string,
  shopName: string,
): Promise<any[]> {
  // Reuse UPSERT batch (item_id + model_id) rồi gắn lại linkedProductId theo SKU/kho.
  await upsertChannelListingsBatch(asShopeeArray(syncedProducts), shopId, shopName);

  const existing = await readChannelListingsDb();
  const masterProducts = await loadProducts();
  const byKey = new Map<string, any>();

  for (const listing of existing) {
    const ids = resolveUpsertItemModelFromRow(listing);
    if (!ids) continue;
    byKey.set(channelListingUpsertKey(ids.itemId, ids.modelId), listing);
  }

  for (const item of asShopeeArray(syncedProducts)) {
    try {
      const ids = resolveUpsertItemModelFromRow(item);
      if (!ids) continue;

      const key = channelListingUpsertKey(ids.itemId, ids.modelId);
      const prev = byKey.get(key);

      const matchedMaster =
        masterProducts.find(
          (p) =>
            (p?.shopeeId && String(p.shopeeId) === ids.channelId) ||
            (item?.shopeeItemId &&
              p?.shopeeItemId &&
              String(p.shopeeItemId) === String(item.shopeeItemId) &&
              (!item?.sku ||
                normalizeSkuKey(p?.sku) === normalizeSkuKey(item?.sku))) ||
            (item?.sku &&
              normalizeSkuKey(p?.sku) === normalizeSkuKey(item?.sku)),
        ) || (item?.id ? item : undefined);

      const status =
        matchedMaster?.id || prev?.linkedProductId
          ? "success"
          : prev?.status === "failed"
            ? "failed"
            : "unlinked";

      byKey.set(
        key,
        sanitizeChannelListingRow({
          id: prev?.id || `cl-shopee-${ids.channelId}`,
          title: String(item?.title || prev?.title || ""),
          sku: String(item?.sku || prev?.sku || ""),
          imageUrl: item?.avatarUrl || item?.imageUrl || prev?.imageUrl,
          channelId: ids.channelId,
          platform: "shopee",
          shopName,
          shopId: String(shopId),
          itemId: ids.itemId,
          modelId: ids.modelId || prev?.modelId,
          status,
          linkedProductId: matchedMaster?.id || prev?.linkedProductId,
        })
      );
    } catch (rowErr: unknown) {
      console.error("DB Save Error: (sync upsert skip)", rowErr);
    }
  }

  const merged = Array.from(byKey.values());
  console.log(`[Mapping Save] Chuẩn bị UPSERT ${merged.length} dòng -> MongoDB @ ${getMongoUriMasked()}`);
  try {
    await writeChannelListingsDbAsync(merged);
  } catch (err: any) {
    const errMsg = err?.message || String(err);
    console.error(`[Mapping Save] Lỗi lưu Database: ${errMsg}`);
    throw new Error(`Lỗi lưu Database: ${errMsg}`);
  }
  console.log(`[Channel Listings] Đã UPSERT ${merged.length} liên kết sàn sau đồng bộ Shopee shop_id=${shopId}`);
  return merged;
}

/** Chỉ lưu sản phẩm sàn từ Shopee — UPSERT theo item_id + model_id, KHÔNG auto-map SKU. */
async function upsertChannelListingsFromShopeeFetch(
  syncedProducts: any[],
  shopId: string,
  shopName: string,
): Promise<any[]> {
  await upsertChannelListingsBatch(asShopeeArray(syncedProducts), shopId, shopName);
  const merged = await readChannelListingsDb();
  console.log(`[Shopee Channel Fetch] Đã UPSERT ${merged.length} sản phẩm sàn shop_id=${shopId}`);
  return merged;
}

/**
 * Đọc Local Cache Master từ MongoDB (`products` + `channel_listings`).
 */
async function readLocalInventoryFileSync(): LocalInventoryCache {
  const cache = await loadLocalInventoryCache();
  if (!Array.isArray(cache.products) || cache.products.length === 0) {
    throw new Error(
      "MongoDB không có sản phẩm Kho gốc (products=[]). Hãy khởi tạo/sync dữ liệu trước."
    );
  }
  console.log(
    `[Local Cache] MongoDB OK — masterData(products)=${cache.products.length}, listings=${cache.listings.length}`
  );
  return cache;
}

/**
 * SKU khớp tuyệt đối — CHỈ trim + toUpperCase.
 * Cấm includes / regex / cắt tiền tố một phần (tránh M15 ↔ 1).
 */
function normalizeSkuKey(sku: unknown): string {
  return String(sku ?? "").trim().toUpperCase();
}

function skusExactMatch(listingSku: unknown, masterSku: unknown): boolean {
  const a = normalizeSkuKey(listingSku);
  const b = normalizeSkuKey(masterSku);
  return a !== "" && b !== "" && a === b;
}

/** @deprecated tên cũ — luôn exact match */
function skusLooselyMatch(listingSku: unknown, masterSku: unknown): boolean {
  return skusExactMatch(listingSku, masterSku);
}

/**
 * Index SKU từ .products (Kho gốc) — khóa = trim().toUpperCase() tuyệt đối.
 * Gồm sản phẩm mẹ + children/variants/models. Query 1 lần → Map in-memory.
 */
function buildMasterSkuIndex(masterData: any[]): Map<string, any> {
  const index = new Map<string, any>();
  if (!Array.isArray(masterData)) return index;

  const addSku = (row: any) => {
    if (!row || typeof row !== "object") return;
    // Cho phép mọi SP có SKU trong Kho Gốc (kể cả id shopee-item-*) để liên kết trang 2+.
    const key = normalizeSkuKey(row.sku);
    if (key && !index.has(key)) index.set(key, row);
  };

  for (const masterItem of masterData) {
    if (!masterItem) continue;
    addSku(masterItem);
    for (const child of getProductChildrenList(masterItem)) addSku(child);
    if (Array.isArray(masterItem.variants)) {
      for (const v of masterItem.variants) addSku(v);
    }
    if (Array.isArray(masterItem.models)) {
      for (const m of masterItem.models) addSku(m);
    }
  }
  return index;
}

/** Cache Hash Map SKU — tránh loadProducts + rebuild mỗi chunk bulk-auto-link. */
let cachedMasterSkuIndex: Map<string, any> | null = null;
let cachedMasterProductsRef: any[] | null = null;
let cachedMasterSkuIndexBuiltAt = 0;

function invalidateMasterSkuIndexCache(reason = "products_write"): void {
  cachedMasterSkuIndex = null;
  cachedMasterProductsRef = null;
  cachedMasterSkuIndexBuiltAt = 0;
  console.log(`[SKU Index Cache] invalidated — ${reason}`);
}

async function getCachedMasterSkuIndex(): Promise<{
  index: Map<string, any>;
  products: any[];
  fromCache: boolean;
}> {
  if (cachedMasterSkuIndex && cachedMasterProductsRef) {
    return {
      index: cachedMasterSkuIndex,
      products: cachedMasterProductsRef,
      fromCache: true,
    };
  }
  const products = await loadProducts();
  const index = buildMasterSkuIndex(products);
  cachedMasterSkuIndex = index;
  cachedMasterProductsRef = products;
  cachedMasterSkuIndexBuiltAt = Date.now();
  console.log(
    `[SKU Index Cache] built — products=${products.length} skuKeys=${index.size} at=${cachedMasterSkuIndexBuiltAt}`,
  );
  return { index, products, fromCache: false };
}

/** Tìm sản phẩm kho theo SKU sàn — CHỈ exact match. */
function findMasterProductBySku(
  masterSkuIndex: Map<string, any>,
  listingSku: unknown,
  _masterData?: any[]
): any | null {
  const key = normalizeSkuKey(listingSku);
  if (!key) return null;
  return masterSkuIndex.get(key) || null;
}

/** Đã có liên kết → BẢO VỆ, tuyệt đối không ghi đè. */
function isListingAlreadyLinkedProtected(listing: any): boolean {
  if (!listing || typeof listing !== "object") return false;
  if (listing.linkBroken === true) return false;
  const linkedId =
    listing.linkedProductId != null && String(listing.linkedProductId).trim() !== ""
      ? String(listing.linkedProductId).trim()
      : listing.linkedProduct?.id != null && String(listing.linkedProduct.id).trim() !== ""
        ? String(listing.linkedProduct.id).trim()
        : "";
  if (linkedId) return true;
  if (listing.status === "success" && listing.linkedProduct != null) return true;
  return false;
}

/** Ghi products MongoDB 1 lần — không cần refresh file cache. */
async function writeProductsFileOnly(products: any[]): Promise<void> {
  ensureDataDirs();
  const list = Array.isArray(products)
    ? products.filter((p) => p != null && typeof p === "object")
    : [];
  await saveProductsToStoreAsync(list);
  invalidateMasterSkuIndexCache("writeProductsFileOnly");
  console.log(`[Batch Auto-link] Ghi MongoDB products xong — ${list.length} dòng.`);
}

function persistBatchAutoLinkListingUpdate(
  dbListings: any[],
  rowIndex: number,
  nextRow: any
): any {
  const patched = sanitizeChannelListingRow(nextRow);
  dbListings[rowIndex] = patched;
  return patched;
}

function findChannelListingRowIndex(
  rows: any[],
  opts?: { id?: unknown; listingId?: unknown; channelId?: unknown; platform?: unknown }
): number {
  const listingId = String(opts?.id || opts?.listingId || "").trim();
  const channelId = String(opts?.channelId || "").trim();
  const platform = String(opts?.platform || "").trim().toLowerCase();

  if (listingId) {
    const byId = rows.findIndex((row) => String(row?.id || "").trim() === listingId);
    if (byId !== -1) return byId;
  }

  if (channelId) {
    return rows.findIndex((row) => {
      const safe = sanitizeChannelListingRow(row);
      if (String(safe.channelId || "").trim() !== channelId) return false;
      if (!platform) return true;
      return String(safe.platform || "").trim().toLowerCase() === platform;
    });
  }

  return -1;
}

async function autoLinkSingleListingFromDatabase(opts?: {
  id?: unknown;
  listingId?: unknown;
  channelId?: unknown;
  platform?: unknown;
}): Promise<{
  success: boolean;
  listing?: any;
  message: string;
  matchedProductId?: string;
}> {
  const dbListings = await readChannelListingsDb();
  if (!Array.isArray(dbListings) || dbListings.length === 0) {
    throw new Error("Không có dữ liệu channel_listings để liên kết.");
  }

  const rowIndex = findChannelListingRowIndex(dbListings, opts);
  if (rowIndex === -1) {
    throw new Error("Không tìm thấy sản phẩm sàn cần liên kết.");
  }

  const current = sanitizeChannelListingRow(dbListings[rowIndex]);
  const { index: masterSkuIndex, products: masterProducts } = await getCachedMasterSkuIndex();
  if (!Array.isArray(masterProducts) || masterProducts.length === 0) {
    throw new Error("Kho sản phẩm chính đang trống. Hãy khởi tạo/sync dữ liệu trước.");
  }

  if (isListingAlreadyLinkedProtected(current)) {
    const enrichedExisting = enrichChannelListingsWithMaster([current], masterProducts)[0];
    return {
      success: true,
      listing: enrichedExisting,
      matchedProductId:
        current.linkedProductId != null && String(current.linkedProductId).trim() !== ""
          ? String(current.linkedProductId).trim()
          : undefined,
      message: "Sản phẩm này đã được liên kết trước đó.",
    };
  }

  const normalizedSku = normalizeSkuKey(current?.sku);
  if (!normalizedSku) {
    return {
      success: false,
      listing: enrichChannelListingsWithMaster([current], masterProducts)[0],
      message: "SKU sản phẩm sàn đang trống hoặc không hợp lệ.",
    };
  }

  const masterItem = findMasterProductBySku(masterSkuIndex, current?.sku, masterProducts);
  if (!masterItem) {
    return {
      success: false,
      listing: enrichChannelListingsWithMaster([current], masterProducts)[0],
      message: `Không tìm thấy SKU khớp trong Kho gốc cho "${normalizedSku}" (gốc: "${String(current?.sku || "").trim()}").`,
    };
  }

  const linkedProductId =
    masterItem?.id != null && String(masterItem.id).trim() !== ""
      ? String(masterItem.id).trim()
      : undefined;

  const patched = persistBatchAutoLinkListingUpdate(dbListings, rowIndex, {
    ...current,
    status: "success",
    linkedProductId,
    linkedProductTitle: String(masterItem?.title || "").trim() || undefined,
    linkedProductSku: String(masterItem?.sku || "").trim() || undefined,
    linkedProduct: linkedProductId
      ? {
          id: linkedProductId,
          title: String(masterItem?.title || "").trim(),
          sku: String(masterItem?.sku || "").trim(),
        }
      : undefined,
    syncError: undefined,
    linkBroken: false,
  });

  // Ghi DB ngay — không refreshCache toàn bộ (tránh nghẽn khi gọi hàng loạt).
  await upsertChannelListingToStore(patched);
  await flushDbWrites();

  const verifiedListing = enrichChannelListingsWithMaster([patched], masterProducts)[0];

  return {
    success: true,
    listing: verifiedListing,
    matchedProductId: linkedProductId,
    message: "Liên kết tự động thành công.",
  };
}

/**
 * Batch Auto-link — chỉ dùng Database hiện tại:
 * 1) Lấy channel_listings chưa liên kết
 * 2) Lấy toàn bộ Kho gốc từ products DB
 * 3) So khớp SKU đã chuẩn hóa
 * 4) Ghi DB tuần tự bằng for...of, tuyệt đối không Promise.all
 */
async function batchAutoLinkFromDatabase(opts?: {
  cursor?: number;
  limit?: number;
}): Promise<{
  linkedCount: number;
  listings: any[];
  alreadyLinked: number;
  unlinkedRemaining: number;
  cacheUpdatedAt: string;
  masterProductCount: number;
  skuIndexSize: number;
  scannedCount: number;
  requestedLimit: number;
  nextCursor: number;
  hasMore: boolean;
}> {
  try {
    console.log("[Batch Auto-link] Bắt đầu đối chiếu từ Database hiện tại...");

    // ===== 2) LỌC DỮ LIỆU CŨ — CHỈ LẤY "CHƯA LIÊN KẾT" =====
    const dbListings = await readChannelListingsDb();
    if (!Array.isArray(dbListings) || dbListings.length === 0) {
      throw new Error("Không có dữ liệu channel_listings để liên kết.");
    }
    const { index: masterSkuIndex, products: masterProducts, fromCache } =
      await getCachedMasterSkuIndex();
    if (!Array.isArray(masterProducts) || masterProducts.length === 0) {
      throw new Error("Kho sản phẩm chính đang trống. Hãy khởi tạo/sync dữ liệu trước.");
    }

    const requestedCursor = Number.isFinite(Number(opts?.cursor))
      ? Math.max(0, Math.floor(Number(opts?.cursor)))
      : 0;
    const requestedLimitRaw = Number.isFinite(Number(opts?.limit))
      ? Math.floor(Number(opts?.limit))
      : AUTO_LINK_BATCH_LIMIT_DEFAULT;
    const requestedLimit = Math.min(AUTO_LINK_BATCH_LIMIT_MAX, Math.max(1, requestedLimitRaw));

    let alreadyLinked = 0;
    let linkedCount = 0;
    let unlinkedTotal = 0;
    let scannedCount = 0;
    let nextCursor = dbListings.length;
    let wroteChanges = false;
    const newlyLinkedRows: any[] = [];
    // Hash Map SKU (trim + toUpperCase) — so khớp O(1), dùng cache in-memory.
    console.log(
      `[Batch Auto-link] DB loaded: masterProducts=${masterProducts.length}, skuIndex=${masterSkuIndex.size}, listings=${dbListings.length}, cursor=${requestedCursor}, limit=${requestedLimit}, skuCache=${fromCache}`
    );

    // ===== 3, 4) SO KHỚP SÂU + GHI DB TUẦN TỰ THEO BATCH NHỎ =====
    for (let rowIndex = requestedCursor; rowIndex < dbListings.length; rowIndex += 1) {
      const item = sanitizeChannelListingRow(dbListings[rowIndex]);
      // Retry cả failed (SKU trước đó không khớp / lỗi tạm) — không chỉ unlinked.
      if (
        (item.status !== "unlinked" && item.status !== "failed") ||
        isListingAlreadyLinkedProtected(item)
      ) {
        alreadyLinked += 1;
        continue;
      }

      unlinkedTotal += 1;
      scannedCount += 1;
      nextCursor = rowIndex + 1;

      const targetSku = normalizeSkuKey(item?.sku);
      if (targetSku) {
        const masterItem = findMasterProductBySku(masterSkuIndex, item?.sku, masterProducts);
        if (masterItem) {
          const patched = persistBatchAutoLinkListingUpdate(dbListings, rowIndex, {
            ...item,
            status: "success",
            linkedProductId:
              masterItem?.id != null && String(masterItem.id).trim() !== ""
                ? String(masterItem.id).trim()
                : undefined,
            linkedProductTitle: String(masterItem?.title || "").trim() || undefined,
            linkedProductSku: String(masterItem?.sku || "").trim() || undefined,
            syncError: undefined,
          });
          newlyLinkedRows.push(patched);
          linkedCount += 1;
          wroteChanges = true;
          console.log(`[Batch Auto-link] Đã xử lý tuần tự thành công: ${linkedCount}`);
        }
      }

      if (scannedCount >= requestedLimit) {
        break;
      }
    }

    if (wroteChanges) {
      // 1 lệnh bulkWrite / lô — cấm vòng await upsert từng dòng (NPROC).
      await bulkUpsertChannelListingsToStore(newlyLinkedRows);
      await flushDbWrites();
      await sleep(200); // Event loop breathe — giải phóng CPU/GC trên AZDIGI
    }

    const unlinkedRemaining = dbListings.filter((row) => {
      const safeRow = sanitizeChannelListingRow(row);
      return (
        (safeRow.status === "unlinked" || safeRow.status === "failed") &&
        !isListingAlreadyLinkedProtected(safeRow)
      );
    }).length;
    const hasMore = nextCursor < dbListings.length;
    console.log(
      `[Batch Auto-link] Hoàn tất — linked=${linkedCount}, protected=${alreadyLinked}, scanned=${scannedCount}, unlinked=${unlinkedTotal}, remaining=${unlinkedRemaining}, nextCursor=${nextCursor}, hasMore=${hasMore}`
    );

    return {
      linkedCount,
      listings: newlyLinkedRows,
      alreadyLinked,
      unlinkedRemaining,
      cacheUpdatedAt: new Date().toISOString(),
      masterProductCount: masterProducts.length,
      skuIndexSize: masterSkuIndex.size,
      scannedCount,
      requestedLimit,
      nextCursor,
      hasMore,
    };
  } catch (error: unknown) {
    console.error("[Batch Auto-link] Matching failed:", error);
    throw error instanceof Error ? error : new Error(String(error));
  }
}

const BULK_AUTO_LINK_CHUNK_MAX = 50;

/**
 * Auto-link theo lô ID từ Frontend (≤50).
 * Hash Map SKU từ cache in-memory → bulkWrite 1 lần (không reload products mỗi chunk).
 */
async function bulkAutoLinkListingsByIds(rawIds: unknown[]): Promise<{
  linkedCount: number;
  failedCount: number;
  skippedCount: number;
  listings: any[];
  results: Array<{ id: string; success: boolean; listing: any; message: string }>;
  skuIndexSize: number;
  masterProductCount: number;
}> {
  const ids = (Array.isArray(rawIds) ? rawIds : [])
    .map((id) => String(id ?? "").trim())
    .filter(Boolean)
    .slice(0, BULK_AUTO_LINK_CHUNK_MAX);

  if (ids.length === 0) {
    throw new Error("Thiếu danh sách id sản phẩm sàn cần liên kết (tối đa 50/lô).");
  }

  const dbListings = await readChannelListingsDb();
  if (!Array.isArray(dbListings) || dbListings.length === 0) {
    throw new Error("Không có dữ liệu channel_listings để liên kết.");
  }
  const { index: masterSkuIndex, products: masterProducts, fromCache } =
    await getCachedMasterSkuIndex();
  if (!Array.isArray(masterProducts) || masterProducts.length === 0) {
    throw new Error("Kho sản phẩm chính đang trống. Hãy khởi tạo/sync dữ liệu trước.");
  }

  const byId = new Map<string, { index: number; row: any }>();
  for (let i = 0; i < dbListings.length; i += 1) {
    const safe = sanitizeChannelListingRow(dbListings[i]);
    const id = String(safe?.id || "").trim();
    if (id && !byId.has(id)) byId.set(id, { index: i, row: safe });
  }

  const results: Array<{ id: string; success: boolean; listing: any; message: string }> = [];
  const toWrite: any[] = [];
  let linkedCount = 0;
  let failedCount = 0;
  let skippedCount = 0;

  for (const id of ids) {
    const found = byId.get(id);
    if (!found) {
      failedCount += 1;
      results.push({
        id,
        success: false,
        listing: { id, status: "failed", syncError: "Không tìm thấy listing trên Database." },
        message: "Không tìm thấy sản phẩm sàn cần liên kết.",
      });
      continue;
    }

    const current = found.row;
    if (isListingAlreadyLinkedProtected(current)) {
      skippedCount += 1;
      const enriched = enrichChannelListingsWithMaster([current], masterProducts)[0];
      results.push({
        id,
        success: true,
        listing: enriched,
        message: "Sản phẩm này đã được liên kết trước đó.",
      });
      continue;
    }

    const normalizedSku = normalizeSkuKey(current?.sku);
    if (!normalizedSku) {
      failedCount += 1;
      const failedRow = sanitizeChannelListingRow({
        ...current,
        status: "failed",
        syncError: "SKU sản phẩm sàn đang trống hoặc không hợp lệ.",
      });
      dbListings[found.index] = failedRow;
      toWrite.push(failedRow);
      results.push({
        id,
        success: false,
        listing: enrichChannelListingsWithMaster([failedRow], masterProducts)[0],
        message: "SKU sản phẩm sàn đang trống hoặc không hợp lệ.",
      });
      continue;
    }

    const masterItem = findMasterProductBySku(masterSkuIndex, current?.sku, masterProducts);
    if (!masterItem) {
      failedCount += 1;
      const failedRow = sanitizeChannelListingRow({
        ...current,
        status: "failed",
        syncError: `Không tìm thấy SKU khớp trong Kho gốc: ${normalizedSku}`,
      });
      dbListings[found.index] = failedRow;
      toWrite.push(failedRow);
      results.push({
        id,
        success: false,
        listing: enrichChannelListingsWithMaster([failedRow], masterProducts)[0],
        message: `Không tìm thấy SKU khớp trong Kho gốc cho "${normalizedSku}".`,
      });
      continue;
    }

    const linkedProductId =
      masterItem?.id != null && String(masterItem.id).trim() !== ""
        ? String(masterItem.id).trim()
        : undefined;
    const patched = sanitizeChannelListingRow({
      ...current,
      status: "success",
      linkedProductId,
      linkedProductTitle: String(masterItem?.title || "").trim() || undefined,
      linkedProductSku: String(masterItem?.sku || "").trim() || undefined,
      linkedProduct: linkedProductId
        ? {
            id: linkedProductId,
            title: String(masterItem?.title || "").trim(),
            sku: String(masterItem?.sku || "").trim(),
          }
        : undefined,
      syncError: undefined,
      linkBroken: false,
    });
    dbListings[found.index] = patched;
    toWrite.push(patched);
    linkedCount += 1;
    results.push({
      id,
      success: true,
      listing: enrichChannelListingsWithMaster([patched], masterProducts)[0],
      message: "Liên kết tự động thành công.",
    });
  }

  if (toWrite.length > 0) {
    await bulkUpsertChannelListingsToStore(toWrite);
    await flushDbWrites();
  }

  console.log(
    `[Bulk Auto-link] chunk=${ids.length} linked=${linkedCount} failed=${failedCount} skipped=${skippedCount} wrote=${toWrite.length} skuIndex=${masterSkuIndex.size} skuCache=${fromCache}`
  );

  return {
    linkedCount,
    failedCount,
    skippedCount,
    listings: results.map((r) => r.listing).filter(Boolean),
    results,
    skuIndexSize: masterSkuIndex.size,
    masterProductCount: masterProducts.length,
  };
}

/**
 * Liên kết toàn bộ listing unlinked|failed trên server (1 lần dựng Map, ghi theo chunk).
 */
async function bulkAutoLinkAllPending(opts?: { limit?: number }): Promise<{
  linkedCount: number;
  failedCount: number;
  skippedCount: number;
  processed: number;
  listings: any[];
  results: Array<{ id: string; success: boolean; listing: any; message: string }>;
  skuIndexSize: number;
  masterProductCount: number;
}> {
  const dbListings = await readChannelListingsDb();
  if (!Array.isArray(dbListings) || dbListings.length === 0) {
    throw new Error("Không có dữ liệu channel_listings để liên kết.");
  }

  const pendingIds: string[] = [];
  for (const row of dbListings) {
    const safe = sanitizeChannelListingRow(row);
    const id = String(safe?.id || "").trim();
    if (!id) continue;
    if (isListingAlreadyLinkedProtected(safe)) continue;
    if (safe.status === "unlinked" || safe.status === "failed") pendingIds.push(id);
  }

  const maxTotal = Math.min(
    pendingIds.length,
    Math.max(1, Math.floor(Number(opts?.limit) || pendingIds.length || 1)),
  );
  const idsToProcess = pendingIds.slice(0, maxTotal);

  let linkedCount = 0;
  let failedCount = 0;
  let skippedCount = 0;
  const allResults: Array<{ id: string; success: boolean; listing: any; message: string }> = [];
  let skuIndexSize = 0;
  let masterProductCount = 0;

  for (let i = 0; i < idsToProcess.length; i += BULK_AUTO_LINK_CHUNK_MAX) {
    const chunk = idsToProcess.slice(i, i + BULK_AUTO_LINK_CHUNK_MAX);
    const part = await bulkAutoLinkListingsByIds(chunk);
    linkedCount += part.linkedCount;
    failedCount += part.failedCount;
    skippedCount += part.skippedCount;
    skuIndexSize = part.skuIndexSize;
    masterProductCount = part.masterProductCount;
    allResults.push(...part.results);
  }

  return {
    linkedCount,
    failedCount,
    skippedCount,
    processed: idsToProcess.length,
    listings: allResults.map((r) => r.listing).filter(Boolean),
    results: allResults,
    skuIndexSize,
    masterProductCount,
  };
}
const CHANNEL_SETTINGS_PATH = path.join(APP_ROOT, "data", "channel_settings.json");

const DEFAULT_CHANNEL_SETTINGS: Record<string, any> = {
  shopeeConnected: false,
  shopeeShopId: "",
  shopeeApiKey: "",
  tiktokConnected: false,
  tiktokShopId: "",
  tiktokApiKey: "",
  shopeeDefaultFeeRate: 12,
  packagingCostPerOrder: 0,
  systemFees: [],
  shops: [],
};

const GENERIC_SHOPEE_SHOP_LABELS = new Set(["shopee shop", "gian hàng"]);

function isGenericShopeeShopLabel(name: string | undefined): boolean {
  const label = String(name || "").trim();
  if (!label) return true;
  if (GENERIC_SHOPEE_SHOP_LABELS.has(label.toLowerCase())) return true;
  if (/^shopee\s+\d+$/i.test(label)) return true;
  return false;
}

function getConnectedShopNameMap(): Map<string, string> {
  const settings = loadChannelSettings();
  const map = new Map<string, string>();
  for (const shop of settings.shops || []) {
    const id = normalizeShopIdKey(shop.shopId || shop.id);
    const name = String(shop.shopName || "").trim();
    if (id && name && !isGenericShopeeShopLabel(name)) {
      map.set(id, name);
    }
  }
  // Canonical — chốt tên 2 shop vận hành (không để channel_settings đảo AuDIO↔LKAT).
  map.set("4127421", "LKAT");
  map.set("831052930", "AuDIO");
  return map;
}

function resolveConnectedShopDisplayName(
  shopId: string | number | undefined,
  fallbackName?: string,
): string | undefined {
  const sid = normalizeShopIdKey(shopId);
  if (sid) {
    const fromSettings = getConnectedShopNameMap().get(sid);
    if (fromSettings) return fromSettings;
  }
  const fallback = String(fallbackName || "").trim();
  if (fallback && !isGenericShopeeShopLabel(fallback)) return fallback;
  return sid ? `Shop ${sid}` : undefined;
}

/** Chỉ ĐỌC mapping từ MongoDB — tuyệt đối không ghi / không rebuild / không auto-link. */
async function readChannelListingsForGet(): any[] {
  const existing = await readChannelListingsDb();
  console.log(
    `[Mapping GET] Đọc DB (read-only): ${existing.length} dòng từ MongoDB @ ${getMongoUriMasked()}`
  );
  return existing;
}

async function hydrateChannelListingsOnBoot(): Promise<void> {
  try {
    ensureDataDirs();
    const cache = await initLocalInventoryIfNeeded(true);
    console.log(
      `[Boot] MongoDB sẵn sàng: products=${cache.products.length}, listings=${cache.listings.length} @ ${getMongoUriMasked()} (ready=${isMongoReady()})`
    );
  } catch (err: any) {
    console.error(`[Boot] Không thể khởi tạo MongoDB mapping/cache:`, err?.message || err);
  }
}

function enrichOrderShopName(order: any): any {
  if (!order || order.channel !== "shopee") return order;
  const resolved = resolveConnectedShopDisplayName(order.shopId, order.shopName);
  if (!resolved || order.shopName === resolved) return order;
  return { ...order, shopName: resolved };
}

function enrichOrdersWithShopNames(orders: any[]): any[] {
  return orders.map(enrichOrderShopName);
}

function logOAuthSaveError(context: string, error: any): void {
  const detail = error?.response?.data ?? error?.message ?? String(error);
  console.error(`Lỗi chi tiết khi lưu shop/OAuth (${context}):`, detail);
}

function normalizeConnectedShop(raw: any): Record<string, any> | null {
  if (!raw || typeof raw !== "object") return null;
  const platform = String(raw?.platform || raw?.type || "").trim().toLowerCase();
  if (!["shopee", "tiktok", "woocommerce"].includes(platform)) return null;
  const shopId = String(raw?.shopId ?? raw?.shop_id ?? "").trim();
  const shopName = String(raw?.shopName ?? raw?.shop_name ?? raw?.name ?? "").trim();
  const apiKey = String(raw?.apiKey ?? raw?.api_key ?? raw?.partner_id ?? "").trim();
  if (!shopId || !shopName || !apiKey) {
    console.warn(
      "[Channel Settings] Shop thiếu trường bắt buộc:",
      JSON.stringify({ platform, shopId: shopId || null, shopName: shopName || null, hasApiKey: Boolean(apiKey) }),
    );
    return null;
  }
  const shop: Record<string, any> = {
    id: String(raw?.id || `shop-${platform}-${shopId}`),
    platform,
    shopId,
    shopName,
    apiKey,
    connected: Boolean(raw?.connected),
    lastSynced: raw?.lastSynced ? String(raw.lastSynced) : undefined,
  };
  if (raw?.apiSecret) shop.apiSecret = String(raw.apiSecret).trim();
  if (raw?.wooUrl) shop.wooUrl = String(raw.wooUrl).trim();
  return shop;
}

function shopListKey(shop: Record<string, any>): string {
  const platform = String(shop?.platform || "").trim().toLowerCase();
  const shopId = normalizeShopIdKey(shop?.shopId) || String(shop?.shopId ?? "").trim();
  return `${platform}:${shopId}`;
}

/** UPSERT danh sách shop — giữ metadata cũ (id, shopName, apiKey) khi OAuth cập nhật token. */
function upsertShopsInChannelSettings(
  existing: Record<string, any>[] = [],
  incoming: Record<string, any>[] = [],
): Record<string, any>[] {
  const map = new Map<string, Record<string, any>>();

  for (const raw of existing) {
    const normalized = normalizeConnectedShop(raw);
    if (!normalized) continue;
    map.set(shopListKey(normalized), normalized);
  }

  for (const raw of incoming) {
    const normalized = normalizeConnectedShop(raw);
    if (!normalized) continue;
    const key = shopListKey(normalized);
    const prev = map.get(key);
    if (prev) {
      const incomingName = String(normalized.shopName || "").trim();
      const prevName = String(prev.shopName || "").trim();
      const incomingIsGeneric =
        !incomingName ||
        /^shopee\s+\d+$/i.test(incomingName) ||
        incomingName.toLowerCase() === "shopee shop" ||
        incomingName.toLowerCase() === "gian hàng";
      map.set(key, {
        ...prev,
        ...normalized,
        id: prev.id || normalized.id,
        // Giữ tên user (VD: AuDIO) — không bị "Shopee 831052930" ghi đè.
        shopName: (!incomingIsGeneric && incomingName) || prevName || incomingName,
        apiKey: normalized.apiKey || prev.apiKey,
        apiSecret: normalized.apiSecret ?? prev.apiSecret,
        wooUrl: normalized.wooUrl ?? prev.wooUrl,
        connected: normalized.connected ?? prev.connected,
        lastSynced: normalized.lastSynced || prev.lastSynced,
      });
    } else {
      map.set(key, normalized);
    }
  }

  return dedupeShopsByPlatformId([...map.values()]);
}

function dedupeShopsByPlatformId(shops: Record<string, any>[]): Record<string, any>[] {
  const map = new Map<string, Record<string, any>>();
  for (const shop of shops) {
    if (!shop) continue;
    const key = `${shop.platform}:${normalizeShopIdKey(shop.shopId) || String(shop.shopId)}`;
    map.set(key, shop);
  }
  return [...map.values()];
}

function loadChannelSettings(): Record<string, any> {
  try {
    if (!fs.existsSync(CHANNEL_SETTINGS_PATH)) return { ...DEFAULT_CHANNEL_SETTINGS, shops: [] };
    const raw = fs.readFileSync(CHANNEL_SETTINGS_PATH, "utf-8");
    const parsed = raw.trim() ? JSON.parse(raw) : {};
    const rawShops = Array.isArray(parsed?.shops) ? parsed.shops : [];
    const shops = upsertShopsInChannelSettings([], rawShops);
    if (rawShops.length > shops.length) {
      console.warn(
        `[Channel Settings] ${rawShops.length - shops.length} shop bị loại khi đọc file (schema cũ/lỗi)`,
      );
    }
    return { ...DEFAULT_CHANNEL_SETTINGS, ...parsed, shops };
  } catch (error: any) {
    logOAuthSaveError("loadChannelSettings", error);
    return { ...DEFAULT_CHANNEL_SETTINGS, shops: [] };
  }
}

function saveChannelSettings(settings: Record<string, any>): boolean {
  try {
    ensureDataDirs();
    const onDisk = loadChannelSettings();
    const incoming = Array.isArray(settings?.shops) ? settings.shops : [];
    const shops = upsertShopsInChannelSettings(onDisk.shops || [], incoming);
    const payload = { ...DEFAULT_CHANNEL_SETTINGS, ...onDisk, ...settings, shops };
    fs.writeFileSync(CHANNEL_SETTINGS_PATH, JSON.stringify(payload, null, 2), "utf-8");
    console.log(
      `[Channel Settings] UPSERT ${shops.length} shop(s) → ${CHANNEL_SETTINGS_PATH}`,
      shops.map((s) => s.shopId).join(", "),
    );
    return true;
  } catch (error: any) {
    logOAuthSaveError("saveChannelSettings", error);
    return false;
  }
}

/** Sau OAuth — UPSERT shop theo shop_id, giữ tên/API key người dùng đã nhập. */
function syncOAuthShopsToChannelSettings(
  savedShopIds: string[],
  opts?: { expectedShopId?: string },
): void {
  if (!savedShopIds.length && !opts?.expectedShopId) return;
  try {
    const settings = loadChannelSettings();
    const now = new Date().toISOString();
    const incoming: Record<string, any>[] = [];

    const ids = new Set<string>(savedShopIds.map((id) => normalizeShopIdKey(id)).filter(Boolean));
    const expected = normalizeShopIdKey(opts?.expectedShopId);
    if (expected) ids.add(expected);

    for (const key of ids) {
      incoming.push({
        platform: "shopee",
        shopId: key,
        shopName: `Shopee ${key}`,
        apiKey: SHOPEE_PARTNER_ID || "oauth",
        connected: savedShopIds.some((id) => normalizeShopIdKey(id) === key),
        lastSynced: now,
        id: `shop-shopee-${key}`,
      });
    }

    const shops = upsertShopsInChannelSettings(settings.shops || [], incoming);
    if (!saveChannelSettings({ ...settings, shops })) {
      console.error("[Shopee OAuth] syncOAuthShopsToChannelSettings: ghi channel_settings.json thất bại");
      return;
    }

    const verify = loadChannelSettings();
    const verifyIds = (verify.shops || []).map((s: any) => String(s.shopId));
    for (const key of ids) {
      if (!verifyIds.includes(key)) {
        console.error(`[Shopee OAuth] UPSERT xong nhưng shop_id=${key} KHÔNG có trong file sau khi đọc lại`);
      }
    }
  } catch (error: any) {
    logOAuthSaveError("syncOAuthShopsToChannelSettings", error);
  }
}

// loadImports / saveImports — controllers/importsController.js (Phase 2)

function applyBulkProductUpdate(
  product: any,
  opts: { stock?: { mode: string; value: number }; price?: { mode: string; value: number } }
): any {
  let stock = Number(product.stock) || 0;
  let sellingPrice = Number(product.sellingPrice) || 0;

  if (opts.stock) {
    const v = Number(opts.stock.value) || 0;
    if (opts.stock.mode === "set") stock = v;
    else if (opts.stock.mode === "delta") stock = stock + v;
    else if (opts.stock.mode === "increase") stock = stock + v;
    else if (opts.stock.mode === "decrease") stock = stock - v;
  }

  if (opts.price) {
    const v = Number(opts.price.value) || 0;
    switch (opts.price.mode) {
      case "set":
        sellingPrice = v;
        break;
      case "percent_up":
        sellingPrice = Math.round(sellingPrice * (1 + v / 100));
        break;
      case "percent_down":
        sellingPrice = Math.round(sellingPrice * (1 - v / 100));
        break;
      case "fixed_up":
        sellingPrice = sellingPrice + v;
        break;
      case "fixed_down":
        sellingPrice = Math.max(Number(product.importPrice) || 0, sellingPrice - v);
        break;
    }
  }

  stock = Math.max(0, Math.round(stock));
  sellingPrice = Math.max(0, Math.round(sellingPrice));

  return {
    ...product,
    stock,
    sellingPrice,
    status: stock <= 0 ? "out_of_stock" : product.status === "draft" ? "draft" : "active",
    lastSynced: new Date().toISOString(),
  };
}

function mergeProductPatch(product: any, patch: any): any {
  const merged = { ...product };
  if (patch.title !== undefined) merged.title = String(patch.title);
  if (patch.sku !== undefined) merged.sku = String(patch.sku);
  if (patch.stock !== undefined) merged.stock = Math.max(0, Math.round(Number(patch.stock)));
  if (patch.sellingPrice !== undefined) merged.sellingPrice = Math.max(0, Math.round(Number(patch.sellingPrice)));
  if (patch.wholesalePrice !== undefined) merged.wholesalePrice = Math.max(0, Math.round(Number(patch.wholesalePrice)));
  if (patch.importPrice !== undefined) {
    merged.importPrice = Math.max(0, Math.round(Number(patch.importPrice)));
    merged.last_import_price = merged.importPrice;
  }
  if (patch.weight !== undefined) merged.weight = Math.max(0, Number(patch.weight));
  if (patch.brand !== undefined) merged.brand = String(patch.brand);
  if (patch.supplierId !== undefined) merged.supplierId = patch.supplierId ? String(patch.supplierId) : undefined;
  if (patch.barcode !== undefined) merged.barcode = String(patch.barcode);
  if (patch.stockMin !== undefined) merged.stockMin = Math.max(0, Math.round(Number(patch.stockMin)));
  if (patch.stockMax !== undefined) merged.stockMax = Math.max(0, Math.round(Number(patch.stockMax)));
  if (patch.description !== undefined) merged.description = String(patch.description);
  if (patch.category !== undefined) merged.category = String(patch.category);
  if (patch.unit !== undefined) merged.unit = String(patch.unit).trim();
  if (patch.status !== undefined) merged.status = patch.status;
  if (patch.channels !== undefined && Array.isArray(patch.channels)) merged.channels = patch.channels;
  if (patch.shopeeId !== undefined) merged.shopeeId = patch.shopeeId ? String(patch.shopeeId) : undefined;
  if (patch.shopeeItemId !== undefined) merged.shopeeItemId = patch.shopeeItemId ? String(patch.shopeeItemId) : undefined;
  if (patch.shopeeModelId !== undefined) merged.shopeeModelId = patch.shopeeModelId ? String(patch.shopeeModelId) : undefined;
  if (patch.tiktokId !== undefined) merged.tiktokId = patch.tiktokId ? String(patch.tiktokId) : undefined;
  if (patch.wooId !== undefined) merged.wooId = patch.wooId ? String(patch.wooId) : undefined;
  if (merged.stock <= 0 && merged.status !== "draft") merged.status = "out_of_stock";
  else if (merged.stock > 0 && merged.status === "out_of_stock") merged.status = "active";
  merged.lastSynced = new Date().toISOString();
  return merged;
}

// Some orders inserted purely from an older buggy webhook normalization never
// got a shop_id recorded (see normalizeShopeeOrder fix above). Self-heal them
// on read: if the order itself lacks shop_id but exactly one Shopee shop is
// connected in this project, that's unambiguously the right shop — use it
// instead of letting a missing field wrongly block real ship_order/print calls.
function resolveOrderShopId(order: any): string | undefined {
  if (order?.shopId) return normalizeShopIdKey(order.shopId) || undefined;
  if (order?.channel !== "shopee") return undefined;
  const shopIds = listShopeeOAuthShopIds();
  if (shopIds.length === 1) return shopIds[0];
  // Multi-shop: cố gắng khớp theo tên gian hàng đã cache trên đơn.
  const name = String(order?.shopName || order?.shop_name || "")
    .trim()
    .toLowerCase();
  if (name) {
    try {
      const channelSettings = loadChannelSettings();
      const match = asShopeeArray(channelSettings?.shops).find((shop: any) => {
        if (!shop || shop.connected === false) return false;
        if (String(shop.platform || "").toLowerCase() !== "shopee") return false;
        return String(shop.shopName || "")
          .trim()
          .toLowerCase() === name;
      });
      const matchedId = normalizeShopIdKey(match?.shopId);
      if (matchedId) return matchedId;
    } catch {
      /* ignore */
    }
  }
  return undefined;
}

/** Lấy shopId từ đơn (DB) — cho phép xuyên shop, không block mismatch. */
function validateOrderShopForShipment(order: any): {
  ok: boolean;
  shopId?: string;
  error?: string;
  message?: string;
} {
  if (order?.channel !== "shopee") {
    return { ok: true, shopId: resolveOrderShopId(order) };
  }

  const shopId =
    resolveOrderShopId(order) ||
    (order?.shopId ? normalizeShopIdKey(order.shopId) : "") ||
    undefined;

  if (!shopId) {
    const oauthShops = listShopeeOAuthShopIds();
    if (oauthShops.length === 1) {
      return { ok: true, shopId: oauthShops[0] };
    }
    return {
      ok: false,
      error: "missing_shop_id",
      message: "Đơn hàng thiếu shop_id, không xác định được shop Shopee.",
    };
  }

  return { ok: true, shopId };
}

// findOrderRecord / resolveOrdersFromRequest — services/orders.js (Phase 5)

// Shopee trả lỗi kiểu "already shipped / order_status_invalid" khi ship_order được
// gọi lại trên đơn đã chuẩn bị (đặc biệt GHN/J&T đã có mã vận đơn). Coi là thành công.
function isAlreadyShippedError(result: any): boolean {
  const error = String(result?.error || "").toLowerCase();
  const message = String(result?.message || result?.msg || "").toLowerCase();
  const blob = `${error} ${message}`;
  if (!blob.trim()) return false;

  // Mã lỗi Shopee thường gặp khi đơn đã arrange / đã có tracking.
  if (
    error.includes("package_can_not_ship") ||
    error.includes("order_has_shipped") ||
    error.includes("logistics_order_completed") ||
    error.includes("ship_order_limit") ||
    error.includes("order_status_error") ||
    error.includes("order_status_invalid") ||
    error.includes("package_number_not_found") ||
    error.includes("logistics.order_status")
  ) {
    return true;
  }

  return (
    blob.includes("already") ||
    blob.includes("has been shipped") ||
    blob.includes("has been arranged") ||
    blob.includes("already arranged") ||
    blob.includes("already been processed") ||
    blob.includes("logistics order is completed") ||
    blob.includes("order status does not support") ||
    blob.includes("order_status does not support") ||
    blob.includes("không thể giao") ||
    blob.includes("da duoc xu ly") ||
    blob.includes("đã được xử lý") ||
    blob.includes("đã chuẩn bị") ||
    blob.includes("da chuan bi") ||
    blob.includes("đã sắp xếp") ||
    blob.includes("da sap xep")
  );
}

/**
 * Khi ship_order / get_shipping_parameter fail vì đơn ĐÃ chuẩn bị trên Shopee:
 * kiểm tra nhanh order detail (+ 1 lần get_tracking_number, KHÔNG retry/escrow).
 * Confirm hàng loạt không được chờ enrich tracking nặng.
 */
async function tryRecoverAlreadyShippedShopeeOrder(
  shopId: string,
  accessToken: string,
  order: any,
  signal?: AbortSignal,
): Promise<{ ok: boolean; trackingNumber?: string; shopeeStatus?: string }> {
  try {
    if (signal?.aborted) return { ok: false };

    const detailResult = await shopeeGetOrderDetail(shopId, accessToken, [String(order.orderSn)]);
    const detailList = detailResult?.response?.order_list ?? detailResult?.order_list ?? [];
    const detail = Array.isArray(detailList) ? detailList[0] : null;
    if (detail) {
      applyShopeePackageListTracking(order, detail);
      const raw = String(detail.order_status || detail.status || "").toUpperCase();
      if (raw) order.shopee_order_status = raw;
      const pkg = Array.isArray(detail.package_list) ? detail.package_list[0] : null;
      if (pkg?.package_number) order.packageNumber = String(pkg.package_number);
    }

    const decide = (): { ok: boolean; trackingNumber?: string; shopeeStatus?: string } => {
      repairMisassignedTracking(order);
      const tn = String(order.trackingNumber || order.tracking_no || "").trim();
      const rawStatus = String(order.shopee_order_status || "").toUpperCase();
      const alreadyOnShopee =
        Boolean(tn && !isShopeeInternalTrackingCode(tn)) ||
        rawStatus === "PROCESSED" ||
        rawStatus === "SHIPPED" ||
        rawStatus === "TO_CONFIRM_RECEIVE" ||
        rawStatus === "COMPLETED";
      if (alreadyOnShopee) {
        return { ok: true, trackingNumber: tn || undefined, shopeeStatus: rawStatus || undefined };
      }
      return { ok: false, trackingNumber: tn || undefined, shopeeStatus: rawStatus || undefined };
    };

    let verdict = decide();
    if (verdict.ok) {
      console.log(
        `[Shopee Ship Recover] order_sn=${order.orderSn} OK(fast) status=${verdict.shopeeStatus || "?"} tn=${verdict.trackingNumber || "—"}`,
      );
      return verdict;
    }

    // Một shot get_tracking_number — không sleep/retry/escrow (tracking đầy đủ lo lúc in đơn).
    if (!signal?.aborted) {
      const pkgNum = String(order.packageNumber || "").trim() || undefined;
      const track = await shopeeGetTrackingNumber(shopId, accessToken, order.orderSn, pkgNum);
      applyShopeeGetTrackingResponse(order, track);
      verdict = decide();
    }

    if (verdict.ok) {
      console.log(
        `[Shopee Ship Recover] order_sn=${order.orderSn} OK status=${verdict.shopeeStatus || "?"} tn=${verdict.trackingNumber || "—"}`,
      );
      return { ok: true, trackingNumber: verdict.trackingNumber, shopeeStatus: verdict.shopeeStatus };
    }

    console.warn(
      `[Shopee Ship Recover] order_sn=${order.orderSn} chưa recover được (status=${verdict.shopeeStatus || "?"} tn=${verdict.trackingNumber || "—"})`,
    );
    return { ok: false };
  } catch (err: any) {
    console.error(`[Shopee Ship Recover] exception order_sn=${order?.orderSn}:`, err?.message || err);
    return { ok: false };
  }
}

/** Bẫy lỗi "đang kiểm tra bởi Shopee" khi gọi ship_order / chuẩn bị hàng. */
function isShopeePendingVerificationError(result: any): boolean {
  // Đã arrange / đã có mã → KHÔNG coi là pending (tránh kẹt GHN ở "Chưa xử lý").
  if (isAlreadyShippedError(result)) return false;

  const blob = `${result?.error || ""} ${result?.message || ""} ${result?.msg || ""} ${result?.stack || ""}`.toLowerCase();
  if (!blob.trim()) return false;
  return (
    blob.includes("pending verification") ||
    blob.includes("pending_verification") ||
    blob.includes("order_is_under_status") ||
    blob.includes("order status is not ready") ||
    blob.includes("order is pending") ||
    blob.includes("order not ready") ||
    blob.includes("not ready to ship") ||
    blob.includes("not ready for shipment") ||
    blob.includes("system_pending") ||
    blob.includes("kyc_pending") ||
    blob.includes("arrange_shipment_pending") ||
    blob.includes("under shopee") ||
    blob.includes("being processed by shopee") ||
    blob.includes("processed by shopee") ||
    blob.includes("shopee is reviewing") ||
    blob.includes("under review") ||
    blob.includes("fraud") ||
    blob.includes("unpaid") ||
    blob.includes("đang được kiểm tra") ||
    blob.includes("đang kiểm tra") ||
    blob.includes("chưa sẵn sàng") ||
    blob.includes("chua san sang") ||
    (blob.includes("pending") && (blob.includes("order") || blob.includes("status") || blob.includes("ship") || blob.includes("logistic")))
  );
}

function markOrderPendingShopeeCheck(order: any, reason?: string): any {
  // Tab "Đang kiểm tra bởi Shopee" đã bỏ — giữ đơn ở Chờ lấy hàng (Chưa xử lý).
  const next = {
    ...order,
    is_pending_shopee_check: true,
    status: "unprocessed" as const,
    isPrepared: false,
    shopeeSyncPending: false,
    shopeeSyncError: reason || "Đơn chưa sẵn sàng / lỗi Shopee khi ship_order",
  };
  console.log(
    `[Shopee Trap] SET is_pending_shopee_check=true | order_sn=${order?.orderSn || "?"} | status→unprocessed (skip bulk) | reason=${reason || ""}`,
  );
  return next;
}

/** Persist pending flag to Mongo only; orders.json is not part of order state. */
async function persistPendingShopeeCheckFlag(
  orders: any[],
  index: number,
  reason?: string,
): Promise<any> {
  if (index < 0 || index >= orders.length) return null;
  orders[index] = markOrderPendingShopeeCheck(orders[index], reason);
  const orderSn = String(orders[index].orderSn || "");
  console.log(
    `[Shopee Trap] Mongo updateOne | order_sn=${orderSn} | is_pending_shopee_check=${orders[index].is_pending_shopee_check}`,
  );
  if (isMongoReady() && orderSn) {
    try {
      await updateOrderPendingShopeeCheckInStore(
        orderSn,
        true,
        {
          status: "unprocessed",
          isPrepared: false,
          shopeeSyncPending: false,
          shopeeSyncError: reason || "Đơn chưa sẵn sàng / lỗi Shopee khi ship_order",
        },
        orders[index].shopId != null ? String(orders[index].shopId) : undefined,
      );
    } catch (err: any) {
      console.warn(`[Shopee Trap] Mongo updateOne failed order_sn=${orderSn}:`, err?.message || err);
    }
  }
  return orders[index];
}

type ShipOrderJobStatus = "pending" | "running" | "printing" | "done" | "failed";

type ShipOrderJob = {
  id: string;
  status: ShipOrderJobStatus;
  /** pending | loading | optimistic_persist | calling_shopee_pickup | calling_shopee_dropoff | persisting | done | failed */
  phase?: string;
  total: number;
  completed: number;
  successCount: number;
  failCount?: number;
  failedCount?: number;
  successfulOrderIds?: string[];
  failedOrderDetails?: { orderSn: string; orderId: string; error: string; message: string }[];
  failedOrders?: { orderSn: string; orderId: string; error: string; message: string }[];
  message?: string;
  results: any[];
  printDocument: any | null;
  /** Không trả full list — FE dùng optimistic + refetch (tránh ghi đè toàn bộ đơn). */
  orders: any[] | null;
  error?: string;
  createdAt: number;
  updatedAt: number;
};

/** Chuẩn hóa payload tóm tắt sau xác nhận hàng loạt (FE modal summary). */
function buildShipConfirmSummaryPayload(
  total: number,
  batch: {
    successCount: number;
    failedCount: number;
    failedOrders?: { orderSn: string; orderId: string; error: string; message: string }[];
    results?: any[];
  },
): {
  total: number;
  successCount: number;
  failCount: number;
  successfulOrderIds: string[];
  failedOrderDetails: { orderSn: string; orderId: string; error: string; message: string }[];
} {
  const results = Array.isArray(batch.results) ? batch.results : [];
  const successfulOrderIds = [
    ...new Set(
      results
        .filter((r) => r?.success)
        .map((r) => String(r.orderId || r.orderSn || "").trim())
        .filter(Boolean),
    ),
  ];
  const failedOrderDetails =
    Array.isArray(batch.failedOrders) && batch.failedOrders.length > 0
      ? batch.failedOrders
      : results
          .filter((r) => !r?.success)
          .map((r) => ({
            orderSn: String(r.orderSn || ""),
            orderId: String(r.orderId || ""),
            error: String(r.error || "ship_failed"),
            message: String(r.message || r.error || "Xác nhận thất bại"),
          }));
  return {
    total,
    successCount: Number(batch.successCount) || successfulOrderIds.length,
    failCount: Number(batch.failedCount) || failedOrderDetails.length,
    successfulOrderIds,
    failedOrderDetails,
  };
}

const shipOrderJobs = new Map<string, ShipOrderJob>();
const SHIP_JOB_TTL_MS = 30 * 60 * 1000;

function createShipOrderJobId(): string {
  return `ship-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function pruneOldShipOrderJobs(): void {
  const cutoff = Date.now() - SHIP_JOB_TTL_MS;
  for (const [id, job] of shipOrderJobs) {
    if (job.updatedAt < cutoff) shipOrderJobs.delete(id);
  }
}

// In vận đơn (create_shipping_document + poll + download Shopee) có thể mất
// 30–120s khi Shopee chậm/GHN-J&T cần retry — chạy NGẦM thay vì giữ HTTP request
// của FE treo suốt thời gian đó (nguyên nhân chính của "API ~2 phút").
type PrintDocumentJobStatus = "pending" | "running" | "done" | "failed";

type PrintDocumentJob = {
  id: string;
  status: PrintDocumentJobStatus;
  phase?: "tracking" | "creating" | "done" | "failed";
  message?: string;
  httpStatus?: number;
  result?: any;
  error?: string;
  createdAt: number;
  updatedAt: number;
};

const printDocumentJobs = new Map<string, PrintDocumentJob>();
const PRINT_JOB_TTL_MS = 30 * 60 * 1000;

/** Task in Batch (create → FE poll status) — không giữ HTTP chờ Shopee. */
type PrintBatchTask = {
  taskId: string;
  shopId: string;
  orderList: ShopeeWaybillOrderRow[];
  orderIds: string[];
  orderSns: string[];
  createResponse?: any;
  status: "CREATED" | "PROCESSING" | "READY" | "FAILED";
  url?: string;
  pdfFilename?: string;
  readyOrderSns?: string[];
  skippedOrders?: Array<{ orderSn: string; error: string; message: string }>;
  error?: string;
  message?: string;
  createdAt: number;
  updatedAt: number;
};

const printBatchTasks = new Map<string, PrintBatchTask>();
const PRINT_BATCH_TASK_TTL_MS = 30 * 60 * 1000;

function createPrintBatchTaskId(): string {
  return `pbt-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function pruneOldPrintBatchTasks(): void {
  const cutoff = Date.now() - PRINT_BATCH_TASK_TTL_MS;
  for (const [id, task] of printBatchTasks) {
    if (task.updatedAt < cutoff) printBatchTasks.delete(id);
  }
}

function createPrintDocumentJobId(): string {
  return `print-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function pruneOldPrintDocumentJobs(): void {
  const cutoff = Date.now() - PRINT_JOB_TTL_MS;
  for (const [id, job] of printDocumentJobs) {
    if (job.updatedAt < cutoff) printDocumentJobs.delete(id);
  }
}

// Broken/mock orders (0đ total AND no items) or ghost webhook rows with no
// real product snapshot — leftovers from older test/config attempts.
// Đơn hủy/hoàn/return LUÔN giữ lại — kể cả stub từ Returns API (tránh lệch 163→60).
function isValidOrder(order: any): boolean {
  const status = String(order?.status || "").toLowerCase();
  const raw = String(order?.shopee_order_status || "").toUpperCase();
  const local = String(order?.local_status || order?.localStatus || "").toUpperCase();
  if (
    order?.return_sn ||
    order?.shopee_cancel_return_kind ||
    status === "cancelled" ||
    status === "return_pending" ||
    status === "return_received" ||
    raw === "CANCELLED" ||
    raw === "IN_CANCEL" ||
    raw === "TO_RETURN" ||
    local === "CANCELLED_STORED" ||
    local === "RETURN_RECEIVED"
  ) {
    return Boolean(order?.orderSn || order?.id);
  }
  // Webhook có thể đến trước get_order_detail. Giữ stub Shopee có orderSn + raw
  // status để lần refresh kế tiếp không làm đơn mới biến mất khỏi giao diện.
  if (
    String(order?.channel || "").toLowerCase() === "shopee" &&
    Boolean(order?.orderSn || order?.id)
  ) {
    return true;
  }
  const hasAmount = Number(order?.totalAmount) > 0;
  const hasItems = Array.isArray(order?.items) && order.items.length > 0;
  if (!hasAmount && !hasItems) return false;
  const sn = String(order?.orderSn || "");
  if (sn.startsWith("260709") && !hasItems && Number(order?.totalAmount) === 0) return false;
  return true;
}

// Normalize a raw Shopee push-notification payload into this project's Order shape.
// IMPORTANT: Shopee's push envelope is { shop_id, code, timestamp, data: {...} } —
// `shop_id` lives at the TOP LEVEL, sibling to `data`, never inside `data` itself.
// Reading `data.shop_id` (the inner object) always returns undefined and was the
// root cause of orders silently losing their shop_id in the local database.
//
// Push Code 4 (Order TrackingNo) thường CHỈ có ordersn + tracking_no — KHÔNG có status.
// Tuyệt đối KHÔNG default status = PENDING (sẽ kéo đơn GHN đã có mã về "Chưa xử lý").
function normalizeShopeeOrder(payload: any): any | null {
  const data = payload?.data || payload || {};
  const orderSn = data.ordersn || data.order_sn || data.orderSn;
  if (!orderSn) return null;
  const shopId = payload?.shop_id ?? data.shop_id;

  const webhookTracking = pickBestTrackingNumber(
    data.tracking_no,
    data.tracking_number,
    data.last_mile_tracking_number,
    data.forder_id,
  );
  const hasExplicitStatus = Boolean(data.status || data.order_status);
  // Code 4 TrackingNo: có mã vận đơn (GHN/SPX/...) → coi như PROCESSED (Chờ lấy hàng).
  const rawStatus = hasExplicitStatus
    ? String(data.status || data.order_status).toUpperCase()
    : webhookTracking
      ? "PROCESSED"
      : "";
  const itemList = Array.isArray(data.item_list) ? data.item_list : [];
  const mappedItems = itemList.length
    ? itemList.map((it: any) => mapShopeeOrderLineItem(it, { orderStatus: rawStatus })).filter(Boolean)
    : [];
  const mappedStatus = rawStatus
    ? mapShopeeStatusToLocal(rawStatus, { hasTracking: Boolean(webhookTracking) })
    : webhookTracking
      ? "processed"
      : "unprocessed";

  const order: any = {
    id: `shopee-${orderSn}`,
    orderSn: String(orderSn),
    channel: "shopee",
    shopId: shopId ? String(shopId) : undefined,
    shopName: resolveConnectedShopDisplayName(shopId, data.shop_name) || (shopId ? `Shop ${shopId}` : "Gian hàng"),
    totalAmount: Number(data.total_amount || 0),
    withholdingCitTax: 0,
    withholding_cit_tax: 0,
    revenue: 0,
    shopee_order_status: rawStatus || (webhookTracking ? "PROCESSED" : undefined),
    status: mappedStatus,
    date: data.create_time ? new Date(data.create_time * 1000).toISOString() : new Date().toISOString(),
    packageNumber: data.package_number || undefined,
    isPrepared: mappedStatus === "processed" || mappedStatus === "shipping" || Boolean(webhookTracking),
    isPrinted: false,
    items: mappedItems,
  };
  if (itemList.length > 0) {
    applyShopeePartialCancelMeta(order, data, mappedItems);
  }
  applyShopeeEstimatedFinance(order, data);
  if (Array.isArray(data.package_list) && data.package_list.length > 0) {
    applyShopeePackageListTracking(order, data);
  }
  if (webhookTracking) applyShopeeTrackingCode(order, webhookTracking);
  repairMisassignedTracking(order);
  return order;
}

/** Parse Shopee Push envelope theo Open Platform Push Mechanism:
 *  Code 3 = Order Status Update, Code 4 = TrackingNo, Code 15 = Shipping Document Status.
 *  @see https://open.shopee.com/push-mechanism/2
 *  @see https://open.shopee.com/developer-guide/18
 */
function parseShopeePushEvent(body: any): {
  shopId: string;
  orderSn: string;
  eventKind:
    | "order_status_update"
    | "tracking_no_update"
    | "shipping_document"
    | "return_refund"
    | "package_update"
    | "other";
  status: string;
  trackingNo: string;
  packageNumber: string;
  returnSn: string;
  code: string | number;
  logisticsStatus: string;
} {
  const data = body?.data || body || {};
  const code = body?.code ?? body?.msg_id ?? data?.code ?? "";
  const action = String(body?.action || body?.msg || data?.action || data?.msg || "").toLowerCase();
  const codeNum = Number(code);
  const codeStr = String(code).toLowerCase();
  const status = String(
    data.status || data.order_status || data.fulfillment_status || data.package_status || "",
  ).toUpperCase();
  const returnSn = String(data.return_sn || data.returnSn || "").trim();
  const pkg0 = Array.isArray(data.package_list) ? data.package_list[0] : undefined;
  const orderSn = String(
    data.ordersn ||
      data.order_sn ||
      data.orderSn ||
      body?.ordersn ||
      body?.order_sn ||
      body?.orderSn ||
      pkg0?.ordersn ||
      pkg0?.order_sn ||
      "",
  ).trim();
  const shopId = String(
    body?.shop_id ?? body?.shopId ?? data.shop_id ?? data.shopId ?? "",
  ).trim();
  const trackingNo = pickBestTrackingNumber(
    data.tracking_no,
    data.tracking_number,
    data.last_mile_tracking_number,
    data.third_party_tracking_number,
    pkg0?.tracking_no,
    pkg0?.tracking_number,
  );
  const packageNumber = String(
    data.package_number || data.packageNumber || pkg0?.package_number || "",
  ).trim();
  const logisticsStatus = String(
    data.logistics_status ||
      data.logisticsStatus ||
      data.fulfillment_status ||
      pkg0?.logistics_status ||
      "",
  )
    .trim()
    .toUpperCase();

  let eventKind:
    | "order_status_update"
    | "tracking_no_update"
    | "shipping_document"
    | "return_refund"
    | "package_update"
    | "other" = "other";
  if (
    codeNum === 3 ||
    codeStr.includes("order_status") ||
    action.includes("order_status") ||
    // Booking status cũng map về order lifecycle để real-time upsert.
    codeStr.includes("booking_status") ||
    action.includes("booking_status")
  ) {
    eventKind = "order_status_update";
  } else if (
    codeNum === 4 ||
    codeStr.includes("tracking") ||
    action.includes("tracking_no") ||
    action.includes("booking_tracking")
  ) {
    eventKind = "tracking_no_update";
  } else if (
    codeNum === 15 ||
    codeStr.includes("shipping_document") ||
    action.includes("shipping_document")
  ) {
    eventKind = "shipping_document";
  } else if (
    codeStr.includes("package") ||
    action.includes("package_fulfillment") ||
    action.includes("package_info") ||
    action.includes("courier_delivery")
  ) {
    eventKind = "package_update";
  } else if (
    returnSn ||
    status === "TO_RETURN" ||
    codeStr.includes("return") ||
    action.includes("return")
  ) {
    // Chỉ gắn return_refund khi có return_sn / TO_RETURN / keyword return.
    // CẤM dò chữ "refund" — hủy đã thanh toán bị refund tiền ≠ trả hàng.
    eventKind = "return_refund";
  } else if (trackingNo && orderSn) {
    // Có tracking_no trong payload → ưu tiên Code 4 semantics (GHN/SPX).
    eventKind = "tracking_no_update";
  } else if (orderSn) {
    // Đơn mới / mọi push còn lại có order_sn → coi như status update real-time.
    eventKind = "order_status_update";
  }

  return {
    shopId,
    orderSn,
    eventKind,
    status,
    trackingNo,
    packageNumber,
    returnSn,
    code,
    logisticsStatus,
  };
}

const SHOPEE_WEBHOOK_ORDER_STATUSES = new Set([
  "UNPAID",
  "PENDING",
  "IN_REVIEW",
  "FRAUD_CHECK",
  "INVOICE_PENDING",
  "READY_TO_SHIP",
  "PROCESSED",
  "RETRY_SHIP",
  "SHIPPED",
  "TO_CONFIRM_RECEIVE",
  "COMPLETED",
  "IN_CANCEL",
  "CANCELLED",
  "TO_RETURN",
]);

/**
 * Áp dụng field từ Push (Code 3/4/15) lên đơn trong DB — BẮT BUỘC cho GHN.
 * Code 4 chỉ gửi tracking_no; nếu bỏ qua sẽ mãi "Chưa có mã vận đơn".
 */
function applyShopeePushFieldsToOrder(order: any, parsed: {
  status?: string;
  trackingNo?: string;
  packageNumber?: string;
  eventKind?: string;
  logisticsStatus?: string;
}): void {
  if (!order) return;
  if (parsed.packageNumber) order.packageNumber = parsed.packageNumber;
  if (parsed.trackingNo) {
    applyShopeeTrackingCode(order, parsed.trackingNo);
    order.trackingNumber = String(parsed.trackingNo).trim();
    order.tracking_no = order.trackingNumber;
  }
  if (parsed.logisticsStatus) {
    order.logistics_status = String(parsed.logisticsStatus).toUpperCase();
  }
  if (parsed.status) {
    order.shopee_order_status = String(parsed.status).toUpperCase();
  }

  const tn = String(order.trackingNumber || order.tracking_no || "").trim();
  const hasTn = Boolean(tn && !isShopeeInternalTrackingCode(tn));
  let raw = String(order.shopee_order_status || "").toUpperCase();
  const pushStatus = String(parsed.status || "").toUpperCase();

  // Code 3: status từ Push — COMPLETED / hủy / hoàn luôn ghi đè trước logistics.
  if (pushStatus === "COMPLETED") {
    order.shopee_order_status = "COMPLETED";
    order.status = "completed";
    order.isPrepared = true;
    order.is_pending_shopee_check = false;
    enforceShopeeTerminalLocalStatus(order);
    repairMisassignedTracking(order);
    return;
  }
  if (pushStatus === "CANCELLED" || pushStatus === "IN_CANCEL") {
    order.shopee_order_status = pushStatus;
    order.status = "cancelled";
    order.isPrepared = false;
    order.is_pending_shopee_check = false;
    clearHandedOverLocalForCancelReturn(order);
    enforceShopeeTerminalLocalStatus(order);
    repairMisassignedTracking(order);
    return;
  }
  if (pushStatus === "TO_RETURN") {
    order.shopee_order_status = "TO_RETURN";
    if (order.status !== "return_received") order.status = "return_pending";
    order.isPrepared = false;
    order.is_pending_shopee_check = false;
    clearHandedOverLocalForCancelReturn(order);
    enforceShopeeTerminalLocalStatus(order);
    repairMisassignedTracking(order);
    return;
  }
  if (pushStatus === "SHIPPED" || pushStatus === "TO_CONFIRM_RECEIVE") {
    order.shopee_order_status = pushStatus;
    order.status = "shipping";
    order.isPrepared = true;
    order.is_pending_shopee_check = false;
    console.log(
      `[StateMachine] Webhook ACCEPT SHIPPED order_sn=${order.orderSn || "?"} push=${pushStatus}`,
    );
    enforceShopeeTerminalLocalStatus(order);
    repairMisassignedTracking(order);
    return;
  }
  // Push có thể mang logistics_status (hoặc order đã có từ get_order_detail).
  if (promoteRawStatusFromLogistics(order)) {
    console.log(
      `[StateMachine] Webhook ACCEPT logistics→SHIPPED order_sn=${order.orderSn || "?"} logistics=${order.logistics_status || "-"}`,
    );
    repairMisassignedTracking(order);
    return;
  }

  // Đã terminal trên DB → Code 4 / shallow push không được kéo về PROCESSED.
  if (isShopeeTerminalRawStatus(raw) || order.status === "shipping" || order.status === "completed") {
    enforceShopeeTerminalLocalStatus(order);
    repairMisassignedTracking(order);
    return;
  }

  // Code 4 TrackingNo / có mã: đơn đã được chuẩn bị trên Shopee (mọi ĐVVC).
  if (hasTn && (!raw || raw === "PENDING" || raw === "UNPAID" || raw === "READY_TO_SHIP" || raw === "RETRY_SHIP")) {
    order.shopee_order_status = "PROCESSED";
    raw = "PROCESSED";
  }

  if (hasTn && (raw === "PROCESSED" || raw === "READY_TO_SHIP" || raw === "RETRY_SHIP" || !raw)) {
    order.status = "processed";
    order.isPrepared = true;
    order.is_pending_shopee_check = false;
    if (!order.shopee_order_status || order.shopee_order_status === "PENDING") {
      order.shopee_order_status = "PROCESSED";
    }
  } else if (parsed.status) {
    order.status = mapShopeeStatusToLocal(raw, { hasTracking: hasTn });
    if (order.status === "processed" || order.status === "shipping" || order.status === "completed") {
      order.isPrepared = true;
      order.is_pending_shopee_check = false;
    }
  }
  enforceShopeeTerminalLocalStatus(order);
  repairMisassignedTracking(order);
}

/** Tìm return_sn theo order_sn qua get_return_list (ưu tiên không time-filter). */
async function findReturnSnForOrderWebhook(
  shopId: string,
  accessToken: string,
  orderSn: string,
): Promise<string> {
  let pageNo = 1;
  while (pageNo <= 3) {
    const listResult = await shopeeGetReturnList(shopId, accessToken, {
      pageNo,
      pageSize: SHOPEE_RETURN_LIST_PAGE_SIZE,
    });
    if (listResult?.error) {
      console.warn(
        `[Shopee Webhook] get_return_list page=${pageNo}:`,
        listResult.error,
        listResult.message || "",
      );
      break;
    }
    const rows = extractShopeeReturnListRows(listResult);
    for (const row of rows) {
      const safeRow = normalizeShopeeReturnDetail(row) || row;
      if (toShopeeSn(safeRow?.order_sn ?? safeRow?.orderSn) === orderSn) {
        return extractReturnRequestCode(safeRow) || "";
      }
    }
    if (!parseShopeeReturnListMore(listResult) || rows.length === 0) break;
    pageNo += 1;
    await sleep(150);
  }
  return "";
}

/** Return/Refund fallback: get_return_list → get_return_detail → update tracking vào DB. */
async function applyWebhookReturnFallback(
  shopId: string,
  accessToken: string,
  orderSn: string,
  orders: any[],
  hintReturnSn?: string,
): Promise<void> {
  let returnSn = String(hintReturnSn || "").trim();
  const existingBefore = orders.find((o: any) => String(o.orderSn) === orderSn);
  if (existingBefore && !shouldApplyShopeeReturnOverlay(existingBefore)) {
    applyShopeeCancelReturnClassification(existingBefore);
    if (!returnSn) {
      returnSn = await findReturnSnForOrderWebhook(shopId, accessToken, orderSn);
    }
    if (!returnSn) {
      console.warn(`[Shopee Webhook] Return fallback: không tìm thấy return_sn cho ${orderSn}`);
      return;
    }
    if (!String(existingBefore.return_sn || "").trim()) existingBefore.return_sn = returnSn;
    const { tracking } = await fetchReturnShippingTrackingNumber(
      shopId,
      accessToken,
      returnSn,
      undefined,
      outboundTrackingOf(existingBefore),
    );
    await shopeeSyncDelay(300);
    if (tracking) {
      applyReturnTrackingAliases(existingBefore, tracking);
      applyShopeeCancelReturnClassification(existingBefore);
      console.log(
        `[Shopee Webhook] Return fallback RTS/Hủy order_sn=${orderSn} return_sn=${returnSn} rtn=${tracking}`,
      );
    }
    return;
  }
  if (!returnSn) {
    returnSn = await findReturnSnForOrderWebhook(shopId, accessToken, orderSn);
  }
  if (!returnSn) {
    console.warn(`[Shopee Webhook] Return fallback: không tìm thấy return_sn cho ${orderSn}`);
    return;
  }

  const detailResult = await shopeeGetReturnDetail(shopId, accessToken, returnSn);
  if (detailResult?.error) {
    console.warn(
      `[Shopee Webhook] get_return_detail shop_id=${shopId} return_sn=${returnSn} error=${detailResult.error || "unknown"} message=${detailResult.message || ""}`,
    );
    if (isShopeeReturnsAuthError(detailResult)) return;
    const idxOnErr = orders.findIndex((o: any) => String(o.orderSn) === orderSn);
    const existingOnErr = idxOnErr >= 0 ? orders[idxOnErr] : undefined;
    const { tracking } = await fetchReturnShippingTrackingNumber(
      shopId,
      accessToken,
      returnSn,
      undefined,
      existingOnErr?.trackingNumber || existingOnErr?.tracking_no,
    );
    await shopeeSyncDelay(300);
    const returnTnOnly = distinctReturnTracking(
      tracking,
      existingOnErr?.trackingNumber || existingOnErr?.tracking_no,
    );
    if (returnTnOnly && existingOnErr) {
      applyReturnTrackingAliases(existingOnErr, returnTnOnly);
      if (!String(existingOnErr.return_sn || "").trim()) existingOnErr.return_sn = returnSn;
      console.log(
        `[Shopee Webhook] Return fallback reverse-only order_sn=${orderSn} return_sn=${returnSn} rtn=${returnTnOnly}`,
      );
    }
    return;
  }

  const detail = detailResult?.response ?? detailResult ?? {};
  const kind = mapShopeeReturnKind(detail);
  const returnStatus = String(detail.status || "").toUpperCase();
  const mappedReturnSn = extractReturnRequestCode(detail) || returnSn;
  let idx = orders.findIndex((o: any) => String(o.orderSn) === orderSn);
  let existing = idx >= 0 ? orders[idx] : undefined;
  if (!existing && isMongoReady()) {
    try {
      const loaded = await loadOrdersFromStore({ orderSns: [orderSn], limit: 1 });
      existing = loaded?.[0];
      if (existing) {
        orders.unshift(existing);
        idx = 0;
      }
    } catch (loadErr: any) {
      console.warn(
        `[Shopee Webhook] load order for return alert ${orderSn}:`,
        loadErr?.message || loadErr,
      );
    }
  }
  if (returnStatus === "CANCELLED") {
    if (existing) {
      existing.return_status = "CANCELLED";
      if (stripCancelledReturnOnDelivered(existing)) {
        await clearCancelledDeliveredReturnInStore(orderSn, shopId);
      }
    }
    return;
  }
  const outboundExisting = existing?.trackingNumber || existing?.tracking_no;
  const { tracking: returnShipTn } = await fetchReturnShippingTrackingNumber(
    shopId,
    accessToken,
    mappedReturnSn,
    detailResult,
    outboundExisting,
  );
  const returnTn = distinctReturnTracking(returnShipTn, outboundExisting);

  const existingRaw = String(existing?.shopee_order_status || "").toUpperCase();
  const alreadyCancelled = existingRaw === "CANCELLED" || existingRaw === "IN_CANCEL"
    || existing?.status === "cancelled";
  // Đơn đã CANCELLED trên Shopee: chỉ bổ sung return_sn/tracking nếu có —
  // KHÔNG ghi đè status → return_pending (bug cũ khiến hủy bị lệch tab / mất cancelled).
  const patch: any = alreadyCancelled
    ? {
        return_sn: mappedReturnSn,
        return_status: returnStatus,
        return_refund_request_type: Number(detail.return_refund_request_type ?? 0),
        shopee_cancel_return_kind: "refund_return",
        sub_status: "RETURN",
        status: "cancelled",
        shopee_order_status: existingRaw === "IN_CANCEL" ? "IN_CANCEL" : "CANCELLED",
        isPrepared: false,
        is_pending_shopee_check: false,
      }
    : {
        return_sn: mappedReturnSn,
        return_status: returnStatus,
        return_refund_request_type: Number(detail.return_refund_request_type ?? 0),
        shopee_cancel_return_kind: "refund_return",
        sub_status: "RETURN",
        status:
          existing?.status === "return_received" || existing?.local_status === "RETURN_RECEIVED"
            ? "return_received"
            : "return_pending",
        shopee_order_status: existing?.shopee_order_status || "TO_RETURN",
      };
  if (returnTn) {
    applyReturnTrackingAliases(patch, returnTn);
  }

  if (Number.isFinite(Number(detail.refund_amount))) {
    patch.refund_amount = Number(detail.refund_amount);
  }
  if (detail.reason) patch.return_reason = String(detail.reason);
  if (detail.text_reason) patch.text_reason = String(detail.text_reason);

  if (idx >= 0) {
    if (!returnTn) {
      delete patch.return_tracking_no;
      delete patch.returnTrackingNumber;
    }
    preserveExistingTrackingIfIncomingEmpty(patch, existing);
    const merged = mergeShopeeOrderOnSync(existing, { ...existing, ...patch });
    merged.return_sn = patch.return_sn;
    merged.return_status = patch.return_status;
    merged.return_refund_request_type = patch.return_refund_request_type;
    merged.shopee_cancel_return_kind = kind;
    merged.is_return = true;
    if (patch.refund_amount != null) merged.refund_amount = patch.refund_amount;
    if (patch.return_reason) merged.return_reason = patch.return_reason;
    if (patch.text_reason) merged.text_reason = patch.text_reason;
    if (patch.status === "return_received") merged.status = "return_received";
    else if (merged.status !== "return_received" && merged.status !== "cancelled") {
      merged.status = "return_pending";
    }
    const mergedReturn = distinctReturnTracking(
      patch.return_tracking_no || merged.return_tracking_no || existing?.return_tracking_no,
      merged.trackingNumber || merged.tracking_no || existing?.trackingNumber || existing?.tracking_no,
    );
    if (mergedReturn) applyReturnTrackingAliases(merged, mergedReturn);
    markNewReturnRequestAlert(merged, existing);
    orders[idx] = merged;
  } else {
    orders.unshift({
      id: `shopee-${orderSn}`,
      orderSn,
      channel: "shopee",
      shopId,
      revenue: 0,
      date: new Date().toISOString(),
      totalAmount: Math.max(1, Number(detail.refund_amount || 0) || 1),
      items: [
        {
          productId: "return-placeholder",
          productTitle: `Đơn hoàn ${orderSn}`,
          quantity: 1,
          price: Number(detail.refund_amount || 1) || 1,
        },
      ],
      ...patch,
    });
    markNewReturnRequestAlert(orders[0], undefined);
  }

  console.log(
    `[Shopee Webhook] Return fallback OK order_sn=${orderSn} return_sn=${mappedReturnSn} tn=${returnTn || "(empty)"} kind=${kind}`,
  );
}

/** Fallback cũ: normalize payload push thô khi chưa gọi được get_order_detail. */
async function upsertShopeeWebhookShallow(body: any, orders: any[]): Promise<string | null> {
  const normalized = normalizeShopeeOrder(body);
  if (!normalized) return null;

  const existingIndex = orders.findIndex((o: any) => o.orderSn === normalized.orderSn);
  const existing = existingIndex >= 0 ? orders[existingIndex] : undefined;
  if (normalized.partialCancel) {
    await restoreLocalStockForPartialCancel(normalized.shopId || existing?.shopId, existing, normalized);
  }
  let merged = existingIndex >= 0 ? mergeShopeeOrderOnSync(existing, normalized) : normalized;
  if (existingIndex >= 0) {
    orders[existingIndex] = merged;
  } else {
    orders.unshift(merged);
  }
  // Persist TRƯỚC logistics — đơn mới tinh (chưa Arrange) vẫn vào Mongo.
  if (isMongoReady() && merged?.orderSn) {
    try {
      await bulkUpsertOrdersToStore([merged]);
      try {
        invalidateOrdersRefreshCache();
      } catch {
        /* ignore */
      }
      queueOrdersJsonMirrorFromMongo();
      console.log(
        `[DB UPDATED] (webhook-shallow) order_sn=${merged.orderSn} shop_id=${merged.shopId || "?"} — upsert OK`,
      );
    } catch (mongoErr: any) {
      console.error(
        `[Shopee Webhook] shallow Mongo upsert FAILED order_sn=${merged.orderSn}:`,
        mongoErr?.message || mongoErr,
      );
    }
  }
  if (merged.channel === "shopee" && merged.shopId && needsShopeeTrackingEnrichment(merged)) {
    try {
      const accessToken = await getValidShopeeAccessToken(String(merged.shopId));
      if (accessToken) {
        merged = await enrichShopeeOrderTrackingFromApi(String(merged.shopId), accessToken, merged);
        if (existingIndex >= 0) orders[existingIndex] = merged;
        else if (orders[0]?.orderSn === merged.orderSn) orders[0] = merged;
        if (isMongoReady() && hasUsableShopeeTrackingNumber(merged)) {
          await bulkUpsertOrdersToStore([merged]);
          try {
            invalidateOrdersRefreshCache();
          } catch {
            /* ignore */
          }
        }
      }
    } catch (trackErr) {
      console.warn(
        `[Shopee Webhook] enrich tracking AFTER persist ${merged.orderSn} (đơn đã lưu):`,
        trackErr,
      );
    }
  }
  if (
    merged.channel === "shopee" &&
    merged.shopId &&
    merged.orderSn &&
    merged.status !== "cancelled"
  ) {
    try {
      const accessToken = await getValidShopeeAccessToken(String(merged.shopId));
      if (accessToken) {
        await enrichShopeeOrdersEscrowFinance(String(merged.shopId), accessToken, [merged]);
      }
    } catch (financeErr) {
      console.warn(`[Shopee Webhook] enrich escrow ${merged.orderSn}:`, financeErr);
    }
  }
  return String(merged.orderSn);
}

// processShopeeWebhookPayload — controllers/shopeeWebhookController.js (Phase 6)

async function startServer() {
  const app = express();
  const PORT = process.env.PORT || 3000;
  const appWithRouteMethods = app as any;
  for (const method of ["get", "post", "put", "patch", "delete"] as const) {
    const registerRoute = appWithRouteMethods[method].bind(app);
    appWithRouteMethods[method] = (routePath: unknown, ...handlers: any[]) => {
      if (typeof routePath !== "string" || !routePath.startsWith("/api/")) {
        return registerRoute(routePath, ...handlers);
      }
      return registerRoute(
        routePath,
        ...handlers.map((handler) => {
          if (typeof handler !== "function" || handler.length === 4) return handler;
          return (req: any, res: any, next: any) => {
            try {
              return Promise.resolve(handler(req, res, next)).catch((err: unknown) => {
                if (res.headersSent) return next(err);
                return sendStrictApiErrorJson(res, err);
              });
            } catch (err: unknown) {
              if (res.headersSent) return next(err);
              return sendStrictApiErrorJson(res, err);
            }
          };
        })
      );
    };
  }

  app.use(corsMiddleware);

  /**
   * Dùng express.raw CHỈ cho webhook để HMAC đúng bytes Shopee gửi.
   * Route này phải nằm trước express.json; nếu parse JSON trước, payload gốc mất đi
   * và chữ ký không thể được xác thực tin cậy.
   */
  initShopeeWebhookController({
    parseShopeePushEvent,
    SHOPEE_WEBHOOK_ORDER_STATUSES,
    isLogisticsHandedToCarrier,
    loadOrders,
    saveOrders,
    loadOrdersFromStore,
    queueOrdersJsonMirrorFromMongo,
    fetchNormalizeShopeeOrderChunk,
    persistShopeeOrderChunk,
    upsertShopeeWebhookShallow,
    applyShopeePushFieldsToOrder,
    hasUsableShopeeTrackingNumber,
    enrichShopeeOrderTrackingFromApi,
    isMongoReady,
    bulkUpsertOrdersToStore,
    invalidateOrdersRefreshCache,
    applyWebhookReturnFallback,
    listShopeeOAuthShopIds,
  });
  // Canonical Push URL duy nhất: POST/GET /api/shopee/webhook
  // PHẢI mount TRƯỚC express.json (dùng express.raw để giữ raw body).
  app.use("/api/shopee", createShopeeWebhookRouter(processShopeeWebhookPayload, "/webhook"));

  app.use(express.json({ limit: '50mb' }));
  app.use(express.urlencoded({ limit: '50mb', extended: true }));

  // PDF vận đơn CHỈ phục vụ qua /api/public/labels (và alias) — không static /prints.
  try {
    ensureLabelsDir();
  } catch (err) {
    console.error("[Labels] ensureLabelsDir lúc boot Express:", err);
  }

  /** DB chưa sẵn sàng → trả 503 NGAY (sync, không await/chờ). Auth/health/oauth/ship-order vẫn chạy. */
  app.use(dbReadyMiddleware);

  /** Phase 1 MVC — Auth / Health / Config / Debug (inject Shopee deps cho /api/health). */
  initHealthController({
    ensureDataDirs,
    listShopeeOAuthShopIds,
    loadLastOAuthAudit,
    tokensPath: SHOPEE_TOKENS_PATH,
    appRoot: APP_ROOT,
    appBaseUrl: APP_BASE_URL,
    shopeeCallbackUrl: SHOPEE_CALLBACK_URL,
    shopeeWebhookUrl: SHOPEE_WEBHOOK_URL,
  });

  app.use("/api", authRoutes);
  app.use("/api/scan", authMiddleware, scanRoutes);
  app.use("/api", healthRoutes);

  // ─── Mapping products — Phase 4 MVC  // ─── Mapping products — Phase 4 MVC (ĐẶT SỚM, TRƯỚC static / SPA catch-all) ───
  initMappingController({
    reloadCachesFromDb,
    enrichChannelListingsWithMaster,
    isMongoReady,
    readChannelListingsForGet,
    sanitizeChannelListingRow,
    bulkUpsertChannelListingsToStore,
    flushDbWrites,
    sleep,
    loadProducts,
    persistHealedBrokenMappingLinks,
    readChannelListingsDb,
    batchAutoLinkFromDatabase,
    autoLinkSingleListingFromDatabase,
    bulkAutoLinkAllPending,
    bulkAutoLinkListingsByIds,
    normalizeSkuKey,
    getProductChildrenList,
    isProductsDiskMode,
    loadLocalInventoryCache,
    buildMasterProductLookupById,
    writeChannelListingsDb,
    refreshCache,
  });
  app.use("/api/mapping-products", authMiddleware, mappingRoutes);
  app.use("/api", autoLinkRoutes);

  initLabelsRoutes((req: any, res: any) => {
    const result = serveLabelPdfFromMem(req.params.filename, res);
    if (result === "not_found") {
      res.status(404).type("text/plain").send("Không tìm thấy file vận đơn (đã hết hạn hoặc chưa tạo).");
    }
  });
  app.use(labelsRoutes);

  initShopeeAuthController({ logOAuthSaveError });
  app.use("/api/shopee", shopeeAuthRoutes);

  // Real synced orders list  // Real synced orders list — this is what the Order Management UI reads from.
  // --- Products warehouse API — Phase 4 MVC ---
  initStockSyncQueue({
    getProductChildrenList,
    inheritShopeeLinkFromParent,
    getShopeeItemIdForStockPush,
    resolveShopeeModelIdForStockPush,
    applyShopeeLinkFieldsToProduct,
    readChannelListingsDb,
    resolveShopeeTokenShopId,
    resolveShopeeShopIdsForSync,
    listAuthorizedShopeeShopIds,
    getShopeeUnauthorizedShopMessage,
    getValidShopeeAccessToken,
    withShopeeAccessTokenRetry,
    isShopeeInvalidTokenError,
    resolveShopeeShopForItemId,
    loadShopeeTokens,
    productRequiresShopeeModelId,
    resolveShopeeModelIdFromApi,
    appendShopeeSyncErrorToDb,
    resolveShopeeStockLocationId,
    buildShopeeUpdateStockEntry,
    shopeeUpdateStock,
    parseShopeeApiResult,
    extractShopeeStockPushErrorMessage,
    buildShopeeUpdatePriceEntry,
    shopeeUpdatePrice,
    shopeeUpdateModelSku,
    loadProductById,
  });
  initProductsController({
    loadProducts,
    saveProducts,
    getProductChildrenList,
    inheritShopeeLinkFromParent,
    mergeProductPatch,
    applyBulkProductUpdate,
    flattenProductsForStockSync,
    upsertProductsToStoreAsync,
    deleteProductsByIdsFromStore,
    loadProductsPageFromStore,
    searchProductsFromStore,
    withLocalDbTimeout,
    isProductsDiskMode,
    isMongoReady,
    getProductsDiskPath,
    reloadCachesFromDb,
    loadLocalInventoryCache,
    refreshCache,
    enrichChannelListingsWithMaster,
    backupInventoryBeforeDestructiveAction,
    writeInventoryAudit,
    writeChannelListingsDb,
    writeProductListingsDb: (rows: any[]) => {
      const dest = path.join(APP_ROOT, "data", "product_listings.json");
      const dir = path.dirname(dest);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(dest, JSON.stringify(rows, null, 2), "utf-8");
    },
    pushStockUpdatesToShopee,
    resolveShopeeTokenShopId,
    resolveShopeeShopIdsForSync,
    listAuthorizedShopeeShopIds,
    getShopeeUnauthorizedShopMessage,
    isShopeeConfigValid,
    isStaleShopeeItemErrorText,
    sendApiErrorJson,
    getValidShopeeAccessToken,
    syncProductToShopee,
    syncProductToWoo,
    syncProductToTikTok,
  });
  app.use("/api/products", authMiddleware, productsRoutes);
  app.use("/api", inventoryRoutes);

  // --- Suppliers API (data/suppliers.json) — Phase 1 MVC ---
  app.use("/api/suppliers", authMiddleware, suppliersRoutes);

  // --- Imports API — Phase 2 MVC ---
  initImportsController({
    loadProductById,
    loadProducts,
    applyImportStockAndPriceToMainWarehouse,
  });
  app.use("/api/imports", authMiddleware, importsRoutes);

  // --- Expenses API (data/expenses.json) — Phase 1 MVC ---
  app.use("/api/expenses", authMiddleware, expensesRoutes);

  // --- Dashboard API — Phase 2 MVC ---
  // CHỈ đọc MongoDB — không gọi Shopee API.
  initDashboardController({
    isMongoReady,
    withLocalDbTimeout,
    getDashboardStatsFromStore,
    getLowStockProductsFromStore,
    loadProductsByIdsFromStore,
  });
  app.use("/api/dashboard", authMiddleware, dashboardRoutes);

  // --- Orders Core — Phase 5 MVC ---
  initOrdersService({
    repairMisassignedTracking,
    repairFalseProcessedReadyToShip,
    isValidOrder,
    matchesHandedOverCarrierTabOrder,
    matchesReceivedCancelReturnTabOrder,
    resolveLocalStatusUpdatedAt,
    isShopeeInternalTrackingCode,
    hasLeftHandedOverCarrierTab,
    resolveOrderHandoverFlag,
    isEligibleForHandOverShared,
    matchesProcessedPickupTabShared,
    hasOrderTrackingNoShared,
    getHandOverIneligibleReasonShared,
    applyHandedOverWrite,
    HANDED_OVER_SOURCE,
  });

  const buildCarrierLogisticsPayload = (
    carrier: string,
    customer: { name: string; phone: string },
    addr: {
      street: string;
      province: string;
      provinceCode: string;
      district: string;
      districtCode: string;
      ward: string;
      wardCode: string;
    },
    extras: { weight: number; note: string; codAmount: number },
  ) => {
    if (carrier === "ghn") {
      return {
        provider: "ghn",
        to_name: customer.name,
        to_phone: customer.phone,
        to_address: addr.street,
        to_ward_code: addr.wardCode,
        to_district_id: Number(addr.districtCode),
        to_province_id: Number(addr.provinceCode),
        to_ward_name: addr.ward,
        to_district_name: addr.district,
        to_province_name: addr.province,
        weight: extras.weight,
        note: extras.note,
        cod_amount: extras.codAmount,
      };
    }
    if (carrier === "spx") {
      return {
        provider: "spx",
        deliver_info: {
          deliver_name: customer.name,
          deliver_phone: customer.phone,
          deliver_detail_address: addr.street,
          deliver_ward: addr.ward,
          deliver_district: addr.district,
          deliver_province: addr.province,
          deliver_ward_id: addr.wardCode,
          deliver_district_id: addr.districtCode,
          deliver_province_id: addr.provinceCode,
        },
        parcel_weight: extras.weight,
        remark: extras.note,
        cod_amount: extras.codAmount,
      };
    }
    return null;
  };

  const generateCarrierTracking = (carrier: string) => {
    if (carrier === "ghn") return `GHN-VN-${Math.floor(100000000 + Math.random() * 900000000)}`;
    if (carrier === "spx") return `SPX-VN-${Math.floor(100000000 + Math.random() * 900000000)}`;
    return `DIRECT-${Math.floor(100000 + Math.random() * 900000)}`;
  };

  initOrdersController({
    withLocalDbTimeout,
    loadProductsForOrders,
    enrichOrdersFromCatalog,
    enrichOrdersWithShopNames,
    isValidOrder,
    matchesProcessedPickupTabShared,
    matchesUnprocessedPickupTabShared,
    matchesShippingTabShared,
    matchesReceivedCancelReturnTabOrder,
    cleanupExpiredLabelFiles,
    wipeLegacyPublicPrints,
    resolveOrderFromShopeeByScanCode,
    enrichMissingShopeeTracking,
    repairMissingShopeeTrackingInOrders,
    healCancelledReturnTrackingOrders,
    forceResyncStuckOrdersWithoutTracking,
    triggerFixStuckOrders,
    reconcileHandedOverCarrierStatuses,
    cleanupStuckShippedOrders,
    getCleanupStuckShippedStatus,
    beginCleanupStuckShippedJob,
    repairMisassignedTracking,
    buildHandedOverWritePatch,
    buildClearHandedOverPatch,
    HANDED_OVER_SOURCE,
    applyShopeeOrderFinanceFields,
    sumOrderCustomCosts,
    healInvalidHandedOverFlags,
    buildCarrierLogisticsPayload,
    generateCarrierTracking,
  });

  initShopeeOrdersController({
    createSyncJob,
    finishSyncJob,
    pullIncrementalOrdersFromShopee,
    pullShopeeCancelReturnOrders,
    syncShopeeReturnRequests,
    reconcileHandedOverCarrierStatuses,
    invalidateOrdersRefreshCache,
    shopeeGetReturnList,
    shopeeGetReturnDetail,
    shopeeGetReverseTrackingInfo,
    extractShopeeReturnListRows,
    parseShopeeReturnListMore,
    fetchReturnShippingTrackingNumber,
    loadChannelSettings,
    asShopeeArray,
    resolveConnectedShopDisplayName,
    pullShopeeChannelListingsPage,
    flushDbWrites,
    readChannelListingsDb,
    refreshCache,
    isMongoReady,
    isOrdersPullLocked,
    SHOPEE_ITEM_LIST_PAGE_SIZE,
  });

  // Background Sync Service — cron + trigger API dùng chung.
  initOrderSyncService({
    pullIncrementalOrdersFromShopee,
    createSyncJob,
    finishSyncJob,
    invalidateOrdersRefreshCache,
    isOrdersPullLocked,
  });
  initShopeeProductsController({
    isProductsDiskMode,
    isMongoReady,
    saveProducts,
    writeInventoryAudit,
    syncShopeeWarehouseSinglePage,
    SHOPEE_ITEM_LIST_PAGE_SIZE,
    fetchShopeeItemVariants,
    loadProducts,
    replaceProductsForShopeeItem,
    getProductChildrenList,
    extractHttpClientError,
  });

  // --- Scan save / list don_hoan_huy — chỉ Mongo local, không gọi Shopee ---
  initScanController({
    findOrderByScanCodeInStore,
    resolveOrderFromShopeeByScanCode: async () => null,
    isValidOrder,
    mirrorTrackingFieldsForRead,
  });

  // --- Scan BG + Scan Bulk — Phase 3 MVC ---
  initScanBgQueue({
    findOrderByScanCodeInStore,
    isValidOrder,
    mirrorTrackingFieldsForRead,
    resolveOrderFromShopeeByScanCode: async () => null,
    resolveOrderLocalStatusShared,
    existsDonHoanHuy,
    isShopeeCancelOrReturnLikeOrder,
    ORDER_LOCAL_STATUS,
    clearHandedOverLocalForCancelReturn,
    setOrderLocalStatus,
    upsertDonHoanHuy,
    describeMongoWriteError,
    restoreLocalStockOnCancelReturnScan,
    markOrderLocalStatusInStore,
  });
  initScanBulkController({
    findOrderByScanCodeInStore,
    findOrdersByScanCodesInStore,
    resolveOrderFromShopeeByScanCode: async () => null,
    isValidOrder,
    mirrorTrackingFieldsForRead,
    resolveOrderLocalStatus,
    existsDonHoanHuy,
    existsDonHoanHuyMany,
    isShopeeCancelOrReturnLikeOrder,
    isOrderAlreadyScanProcessed,
    getScanProcessedReason,
    handOverOrderToCarrierByIndex,
    clearHandedOverLocalForCancelReturn,
    setOrderLocalStatus,
    ORDER_LOCAL_STATUS,
    isEligibleForHandOverShared,
    isMongoReady,
    upsertDonHoanHuyBatch,
    markOrdersScanFlagsBatch,
    describeMongoWriteError,
    isMongoConnectionError,
    persistChangedOrdersPatch,
    markOrderHandedOverInStore,
    markOrderLocalStatusInStore,
    restoreLocalStockOnCancelReturnScan,
    loadProductsForOrders,
    enrichOrdersFromCatalog,
    invalidateOrdersRefreshCache,
  });

  // Orders + system + Vietnam + Shopee (routers) — sau init scan/bulk deps
  // Binder: mount TRƯỚC ordersRoutes để không bao giờ dính placeholder "fast-process chưa khởi tạo".
  let boundFastProcessHandler: ((req: any, res: any) => any) | null = null;
  const fastProcessRouteGuard = (req: any, res: any) => {
    if (typeof boundFastProcessHandler === "function") {
      return boundFastProcessHandler(req, res);
    }
    return res.status(503).json({
      success: false,
      message: "Đang khởi tạo dịch vụ xác nhận đơn — thử lại sau giây lát.",
    });
  };
  const streamDelegatedPdf = (res: any, filePath: string, filename: string): boolean => {
    const valid = getValidLabelDiskFile(filename);
    if (!valid || path.resolve(valid.filePath) !== path.resolve(filePath)) return false;
    res.status(200);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="${filename}"`);
    res.setHeader("Content-Length", String(valid.size));
    res.setHeader("Cache-Control", "private, max-age=300");
    res.setHeader("X-Content-Type-Options", "nosniff");
    fs.createReadStream(valid.filePath).pipe(res);
    return true;
  };
  const downloadPdfRoute = async (req: any, res: any) => {
    const orderSn = String(req.params.orderSn || "")
      .replace(/^shopee-/i, "")
      .trim();
    const expectedFilename = buildCachedLabelFilename([orderSn]);
    const expectedPath = path.join(PDF_DIR, expectedFilename);
    const failDownload = (error: any, fallbackMessage: string) => {
      console.error("DEBUG DOWNLOAD PDF FAIL for order:", orderSn, error);
      // Chỉ xóa file đích nếu nó không phải PDF thật; tuyệt đối không để JSON/HTML mang đuôi .pdf.
      try {
        if (fs.existsSync(expectedPath) && !getValidLabelDiskFile(expectedFilename)) {
          fs.unlinkSync(expectedPath);
        }
      } catch (cleanupError) {
        console.error("DEBUG DOWNLOAD PDF FAIL for order:", orderSn, cleanupError);
      }
      if (res.headersSent) return;
      const rawMessage =
        String(error?.message || error?.error || fallbackMessage || "Không xác định");
      return res.status(500).json({
        success: false,
        message: "Lỗi từ Backend",
        error: rawMessage,
      });
    };
    if (!/^[A-Za-z0-9_-]+$/.test(orderSn)) {
      return failDownload(new Error("Mã đơn không hợp lệ."), "Mã đơn không hợp lệ.");
    }

    // Ưu tiên local file trước — có PDF thì stream ngay, không gọi Shopee.
    if (fs.existsSync(expectedPath) && streamDelegatedPdf(res, expectedPath, expectedFilename)) {
      console.log(`[Delegated PDF] LOCAL HIT ${expectedFilename} — bỏ qua Shopee API`);
      return;
    }

    try {
      const rows = await loadOrdersForShipScoped([`shopee-${orderSn}`, orderSn], [orderSn]);
      if (!Array.isArray(rows)) {
        return failDownload(
          new Error(`invalid_orders_response order_sn=${orderSn}`),
          "Backend không trả về danh sách đơn hợp lệ.",
        );
      }
      const order = rows.find(
        (item: any) =>
          String(item?.orderSn || item?.order_sn || "")
            .replace(/^shopee-/i, "")
            .trim() === orderSn,
      );
      if (!order || String(order.channel || "").toLowerCase() !== "shopee") {
        return failDownload(
          new Error(`order_not_found_in_database order_sn=${orderSn}`),
          `Không tìm thấy đơn Shopee ${orderSn} trong database.`,
        );
      }

      // Bắt buộc lấy shop/account từ chính bản ghi đơn hàng, rồi lấy token gắn với shop đó.
      // Không dùng token mặc định hay thử tuần tự token của các shop khác.
      const storedShopId = String(
        order.shopId || order.shop_id || order.accountId || order.account_id || "",
      ).trim();
      if (!storedShopId) {
        return failDownload(
          new Error(`missing_shop_id order_sn=${orderSn}`),
          `Đơn ${orderSn} thiếu shopId/accountId nên không thể chọn đúng Token Shop.`,
        );
      }
      const auth = await getShopeeAccessTokenForApi(storedShopId);
      const accessToken = String(auth?.token || "").trim();
      const shopId = String(auth?.apiShopId || "").trim();
      if (!accessToken || !shopId) {
        return failDownload(
          new Error(`no_valid_access_token shop=${storedShopId} order_sn=${orderSn}`),
          `Không có Token Shop hợp lệ cho shop ${storedShopId}.`,
        );
      }
      console.log(
        `[Delegated PDF] order_sn=${orderSn} DB shop=${storedShopId} API shop=${shopId}`,
      );

      if (streamDelegatedPdf(res, expectedPath, expectedFilename)) return;

      try {
        await enrichOrdersPackageAndTrackingForPrint(shopId, accessToken, [order]);
      } catch (err: any) {
        console.warn(`[Delegated PDF] enrich ${orderSn}:`, err?.message || err);
      }
      const shippingRows = buildShopeeShippingDocOrderRows(order);
      if (shippingRows.length === 0) {
        return failDownload(
          new Error(`missing_package_number order_sn=${orderSn} shop=${shopId}`),
          `Đơn ${orderSn} thiếu package_number; đã chặn Create/Poll/Download.`,
        );
      }

      const batch = await batchDownloadShopeeWaybillPdf(shopId, shippingRows, {
        deadlineAt: Date.now() + 90_000,
      });
      if (!batch.success || !batch.filename || !batch.filePath) {
        return failDownload(
          { error: batch.error, message: batch.message },
          batch.message || "Shopee chưa sẵn sàng hoặc sai Token Shop.",
        );
      }
      if (streamDelegatedPdf(res, batch.filePath, batch.filename)) {
        void markOrdersHasPdfInStore([orderSn], {
          shopId,
          labelUrl: `/api/public/labels/${batch.filename}`,
          waybill_url: `/api/public/labels/${batch.filename}`,
          pdfFilename: batch.filename,
        }).catch((err: any) =>
          console.warn(`[Delegated PDF] persist ${orderSn}:`, err?.message || err),
        );
        return;
      }
      return failDownload(
        { error: batch.error, message: batch.message },
        "Shopee chưa sẵn sàng hoặc sai Token Shop.",
      );
    } catch (err: any) {
      return failDownload(
        err,
        err?.message || "Shopee chưa sẵn sàng hoặc sai Token Shop.",
      );
    }
  };
  // API CONFIRM: Chỉ xác nhận đơn (ship_order), KHÔNG in PDF
  // Lưới an toàn riêng cho confirm-only: không poll/chờ tracking/PDF và luôn kết thúc nhanh.
  const BATCH_CONFIRM_OPERATION_TIMEOUT_MS = 4_000;
  const confirmOnlyRoute = async (req: any, res: any) => {
    const t0 = Date.now();
    beginLogisticsWork("confirm-only");
    try {
      const { orderIds, orderSns, order_ids, order_sns, method } = req.body || {};
      const shipMethod: ShipMethod = method === "dropoff" ? "dropoff" : "pickup";
      const idList = [
        ...(Array.isArray(orderIds) ? orderIds : []),
        ...(Array.isArray(order_ids) ? order_ids : []),
      ].map(String);
      const snList = [
        ...(Array.isArray(orderSns) ? orderSns : []),
        ...(Array.isArray(order_sns) ? order_sns : []),
      ].map(String);
      
      if (idList.length === 0 && snList.length === 0) {
        return res.status(400).json({
          success: false,
          message: "Thiếu danh sách orderIds hoặc orderSns.",
        });
      }

      let orders: any[] = [];
      try {
        orders = await loadOrdersForShipScoped(idList, snList);
      } catch (loadErr: any) {
        console.warn("[Confirm Only] loadOrdersForShipScoped:", loadErr?.message || loadErr);
      }
      if (!orders.length) {
        try {
          const loaded = await loadOrdersForApi({ readOnly: true });
          const idSet = new Set([...idList, ...snList, ...snList.map((s) => `shopee-${s}`)]);
          orders = (loaded.orders || []).filter(
            (o: any) =>
              idSet.has(String(o.id || "")) ||
              idSet.has(String(o.orderSn || "")) ||
              idSet.has(`shopee-${o.orderSn}`),
          );
        } catch {
          orders = [];
        }
      }
      
      const toShip = resolveOrdersFromRequest(orders, idList, snList);
      if (toShip.length === 0) {
        return res.status(404).json({
          success: false,
          message: "Không tìm thấy đơn nào trong database.",
        });
      }

      console.log(`[Confirm Only] Xác nhận ${toShip.length} đơn method=${shipMethod}`);

      const results: any[] = [];
      const successSns: string[] = [];

      const confirmOneOrder = async ({ index, order }: { index: number; order: any }) => {
        const orderSn = String(order.orderSn || "");
        const orderId = String(order.id || "");
        try {
          const resolvedShopId = resolveOrderShopId(order);
          if (resolvedShopId && !order.shopId) {
            orders[index].shopId = resolvedShopId;
            order.shopId = resolvedShopId;
          }

          console.log(`[Confirm Only] Xác nhận đơn ${orderSn}...`);
          let shipResult: Awaited<ReturnType<typeof arrangeShipment>>;
          try {
            shipResult = await withOperationTimeout(
              (signal) => arrangeShipment(order, shipMethod, signal, { skipRecover: true }),
              BATCH_CONFIRM_OPERATION_TIMEOUT_MS,
              `Ship order ${orderSn}`,
            );
          } catch (shipErr: any) {
            shipResult = {
              success: false,
              error: /timeout/i.test(String(shipErr?.message || "")) ? "timeout" : "internal_server_error",
              message: "Lỗi server: " + (shipErr?.message || String(shipErr)),
            };
          }

          const treatedAsSuccess = shipResult.success || isAlreadyShippedError(shipResult);
          
          if (!treatedAsSuccess) {
            results.push({ orderId, orderSn, success: false, ...shipResult });
            return;
          }

          const tn = String(
            order.trackingNumber ||
              order.tracking_no ||
              shipResult.trackingNumber ||
              orders[index].trackingNumber ||
              "",
          ).trim();
          
          orders[index] = {
            ...orders[index],
            ...order,
            isPrepared: true,
            isPrinted: false,
            status: "processed",
            is_pending_shopee_check: false,
            fulfillment_type: shipMethod,
            ship_method: shipMethod,
            trackingNumber: tn || orders[index].trackingNumber,
            tracking_no: tn || orders[index].tracking_no || orders[index].trackingNumber,
            shopId: orders[index].shopId || order.shopId || shipResult.shopId || resolvedShopId,
            shopee_order_status: "PROCESSED",
            shopeeSyncPending: false,
            shopeeSyncError: undefined,
          };
          
          forceHealPickupOrderIfHasTracking(orders[index]);
          results.push({ orderId, orderSn, success: true, ...shipResult });
          successSns.push(orderSn);
        } catch (orderErr: any) {
          console.error(`[Confirm Only] Lỗi đơn ${orderSn}:`, orderErr?.stack || orderErr);
          results.push({
            orderId,
            orderSn,
            success: false,
            error: "order_process_error",
            message: String(orderErr?.message || orderErr),
          });
        }
      };

      // Chỉ Init/Arrange Shipment; không chia chunk tuần tự, không sleep/delay/poll PDF.
      await Promise.all(toShip.map(confirmOneOrder));

      console.log(`[Confirm Only] DONE ${successSns.length}/${toShip.length} success (${Date.now() - t0}ms)`);
      const successOrders = results
        .filter((result: any) => result?.success)
        .map((result: any) => ({
          orderId: String(result.orderId || ""),
          orderSn: String(result.orderSn || ""),
        }));
      const failedOrders = results
        .filter((result: any) => !result?.success)
        .map((result: any) => ({
          orderId: String(result.orderId || ""),
          orderSn: String(result.orderSn || ""),
          error: String(result.error || "confirm_failed"),
          message: String(result.message || result.error || "Xác nhận thất bại"),
        }));

      const confirmedRows = toShip
        .map(({ index }) => orders[index])
        .filter((o: any) => o && o.isPrepared === true);
      try {
        await persistConfirmedShipOrdersToMongo(confirmedRows, shipMethod);
      } catch (persistErr: any) {
        console.warn("[Confirm Only] persistConfirmedShipOrdersToMongo:", persistErr?.message || persistErr);
      }

      res.status(200).json({
        success: true,
        results,
        successOrders,
        failedOrders,
        successCount: successSns.length,
        failCount: failedOrders.length,
        total: toShip.length,
        message: `Đã xác nhận ${successSns.length}/${toShip.length} đơn`,
      });

      setImmediate(() => {
        void persistOrdersToDatabase(orders, confirmedRows).catch((err: any) => {
          console.warn("[Confirm Only] background persist failed:", err?.message || err);
        });
        void syncConfirmedOrdersFromShopee(confirmedRows, shipMethod).catch((err: any) => {
          console.warn("[Confirm Only] background sync failed:", err?.message || err);
        });
      });
      return;
    } catch (error: any) {
      console.error("[Confirm Only] Lỗi:", error?.stack || error);
      return res.status(500).json({
        success: false,
        message: "Lỗi server: " + error.message,
      });
    } finally {
      endLogisticsWork();
    }
  };

  // API GET-PDF: Polling tại backend, lưu vào public/pdfs, trả về URL
  const getPdfRoute = async (req: any, res: any) => {
    try {
      const { orderSns } = req.body || {};
      if (!Array.isArray(orderSns) || orderSns.length === 0) {
        return res.status(400).json({
          success: false,
          message: "Thiếu danh sách orderSns.",
        });
      }

      const cleanSns = orderSns.map((sn: any) => 
        String(sn || "").replace(/^shopee-/i, "").trim()
      ).filter(Boolean);

      if (cleanSns.length === 0) {
        return res.status(400).json({
          success: false,
          message: "Danh sách orderSns không hợp lệ.",
        });
      }

      console.log(`[Get PDF] Bắt đầu xử lý ${cleanSns.length} đơn: ${cleanSns.join(", ")}`);

      const rows = await loadOrdersForShipScoped(
        cleanSns.map((sn: string) => `shopee-${sn}`),
        cleanSns
      );

      if (!Array.isArray(rows) || rows.length === 0) {
        return res.status(404).json({
          success: false,
          message: "Không tìm thấy đơn nào trong database.",
        });
      }

      const pdfResults: any[] = [];

      for (const orderSn of cleanSns) {
        try {
          const order = rows.find(
            (item: any) =>
              String(item?.orderSn || item?.order_sn || "")
                .replace(/^shopee-/i, "")
                .trim() === orderSn,
          );

          if (!order || String(order.channel || "").toLowerCase() !== "shopee") {
            pdfResults.push({
              orderSn,
              success: false,
              error: "order_not_found",
              message: `Không tìm thấy đơn ${orderSn} trong database.`,
            });
            continue;
          }

          const storedShopId = String(
            order.shopId || order.shop_id || order.accountId || order.account_id || "",
          ).trim();
          
          if (!storedShopId) {
            pdfResults.push({
              orderSn,
              success: false,
              error: "missing_shop_id",
              message: `Đơn ${orderSn} thiếu shopId.`,
            });
            continue;
          }

          const auth = await getShopeeAccessTokenForApi(storedShopId);
          const accessToken = String(auth?.token || "").trim();
          const shopId = String(auth?.apiShopId || "").trim();
          
          if (!accessToken || !shopId) {
            pdfResults.push({
              orderSn,
              success: false,
              error: "no_valid_token",
              message: `Không có token hợp lệ cho shop ${storedShopId}.`,
            });
            continue;
          }

          // Enrich package/tracking
          try {
            await enrichOrdersPackageAndTrackingForPrint(shopId, accessToken, [order]);
          } catch (err: any) {
            console.warn(`[Get PDF] enrich ${orderSn}:`, err?.message || err);
          }

          if ((order as any).__shopeeOrderNotFound) {
            pdfResults.push({
              orderSn,
              success: false,
              error: "order_not_found",
              message: `Đơn ${orderSn} không tồn tại trên Shopee (not found).`,
            });
            continue;
          }

          const shippingRows = buildShopeeShippingDocOrderRows(order);
          if (shippingRows.length === 0) {
            pdfResults.push({
              orderSn,
              success: false,
              error: "missing_package_number",
              message: `Đơn ${orderSn} thiếu package_number; đã chặn Create/Poll/Download.`,
            });
            continue;
          }

          // Create shipping document
          const createResult = await shopeeCreateShippingDocument(shopId, accessToken, shippingRows);
          const createItems: any[] =
            createResult?.response?.result_list || createResult?.result_list || [];
          const createFailure = createItems.find(
            (item: any) => String(item?.fail_error || "").trim(),
          );
          if (createResult?.error || createFailure || createItems.length < shippingRows.length) {
            pdfResults.push({
              orderSn,
              success: false,
              error: createFailure?.fail_error || createResult?.error || "create_not_acknowledged",
              message:
                createFailure?.fail_message ||
                createResult?.message ||
                "Shopee không xác nhận đầy đủ các package khi tạo PDF.",
            });
            continue;
          }

          // Polling (tối đa 20 lần × 3s = 60s)
          let pdfReady = false;
          let lastError: any = null;
          
          for (let attempt = 1; attempt <= 20; attempt++) {
            await sleep(3000);
            
            try {
              const poll = await shopeeGetShippingDocumentResult(shopId, accessToken, shippingRows);
              if (poll?.error) {
                lastError = poll;
                continue;
              }
              
              const items: any[] = poll?.response?.result_list || poll?.result_list || [];
              const allReady = shippingRows.every((row) => {
                const result = items.find(
                  (item: any) =>
                    String(item?.order_sn || "") === orderSn &&
                    (!item?.package_number ||
                      String(item.package_number) === row.package_number),
                );
                return String(result?.status || "").toUpperCase() === "READY";
              });
              
              if (allReady) {
                pdfReady = true;
                break;
              }
              
              lastError = items || { error: "not_ready", message: `Chưa READY lần ${attempt}/20` };
            } catch (err: any) {
              lastError = err;
            }
          }

          if (!pdfReady) {
            pdfResults.push({
              orderSn,
              success: false,
              error: "polling_timeout",
              message: "Shopee chưa xuất PDF sau 60s.",
              lastError,
            });
            continue;
          }

          // Download và lưu vào public/pdfs
          const publicPdfDir = path.join(APP_ROOT, "public", "pdfs");
          if (!fs.existsSync(publicPdfDir)) {
            fs.mkdirSync(publicPdfDir, { recursive: true });
          }

          const filename = `${orderSn}.pdf`;
          const publicPdfPath = path.join(publicPdfDir, filename);

          // Download từ Shopee
          const apiPath = "/api/v2/logistics/download_shipping_document";
          const timestamp = Math.floor(Date.now() / 1000);
          const sign = shopeeSign(apiPath, timestamp, accessToken, shopId);
          const url = `${SHOPEE_HOST}${apiPath}?partner_id=${SHOPEE_PARTNER_ID}&timestamp=${timestamp}&access_token=${accessToken}&shop_id=${shopId}&sign=${sign}`;

          const downloadRes = await fetchWithTimeout(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              order_list: shippingRows.map((row) => ({
                order_sn: row.order_sn,
                package_number: row.package_number,
                shipping_document_type: SHOPEE_SHIPPING_DOCUMENT_TYPE,
              })),
            }),
          }, 60_000);

          const contentType = String(downloadRes.headers.get("content-type") || "").toLowerCase();
          
          if (contentType.includes("application/json") || !downloadRes.ok || !downloadRes.body) {
            pdfResults.push({
              orderSn,
              success: false,
              error: "download_failed",
              message: "Shopee không trả về file PDF.",
            });
            continue;
          }

          // Lưu file vào public/pdfs
          const fileStream = fs.createWriteStream(publicPdfPath);
          await pipeline(
            Readable.fromWeb(downloadRes.body as any),
            fileStream,
          );

          // Trả về URL trực tiếp - dùng resolveLabelsPublicBaseUrl() để trỏ đúng backend cPanel
          const backendBaseUrl = resolveLabelsPublicBaseUrl();
          const pdfUrl = `${backendBaseUrl}/pdfs/${filename}`;
          
          pdfResults.push({
            orderSn,
            success: true,
            url: pdfUrl,
            filename,
            message: "PDF đã sẵn sàng.",
          });

          console.log(`[Get PDF] OK ${orderSn} -> ${pdfUrl}`);
        } catch (err: any) {
          console.error(`[Get PDF] Lỗi ${orderSn}:`, err?.stack || err);
          pdfResults.push({
            orderSn,
            success: false,
            error: "processing_error",
            message: err?.message || String(err),
          });
        }
      }

      const successCount = pdfResults.filter((r) => r.success).length;
      
      return res.json({
        success: successCount > 0,
        results: pdfResults,
        successCount,
        total: cleanSns.length,
        message: `Đã tải ${successCount}/${cleanSns.length} PDF`,
      });
    } catch (error: any) {
      console.error("[Get PDF] Lỗi:", error?.stack || error);
      return res.status(500).json({
        success: false,
        message: "Lỗi server: " + error.message,
      });
    }
  };

  const BATCH_PRINT_CONCURRENCY = 5;
  const BATCH_PRINT_DEADLINE_MS = 27_000;
  const BATCH_PRINT_ONLY_DEADLINE_MS = 210_000;
  const PRINT_CHUNK_FALLBACK_DEADLINE_MS = 210_000;
  const BATCH_PDF_MAX_BYTES = 25 * 1024 * 1024;

  async function mapBatchConcurrently<T, R>(
    items: T[],
    concurrency: number,
    processFn: (item: T, index: number) => Promise<R>,
  ): Promise<R[]> {
    const results: R[] = new Array(items.length);
    let nextIndex = 0;
    async function worker() {
      while (nextIndex < items.length) {
        const currentIndex = nextIndex++;
        results[currentIndex] = await processFn(items[currentIndex], currentIndex);
      }
    }
    await Promise.all(
      Array.from({ length: Math.min(Math.max(1, concurrency), items.length) }, () => worker()),
    );
    return results;
  }

  async function runBeforeBatchDeadline<T>(
    deadlineAt: number,
    label: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const remainingMs = deadlineAt - Date.now();
    if (remainingMs <= 0) throw new Error(`batch_deadline:${label}`);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        operation(),
        new Promise<T>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`batch_deadline:${label}`)), remainingMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  function validateBatchPdfBytes(bytes: ArrayBuffer): Buffer | null {
    const buffer = Buffer.from(bytes);
    if (buffer.length === 0 || buffer.length > BATCH_PDF_MAX_BYTES || !isPdfBuffer(buffer)) {
      return null;
    }
    return buffer;
  }

  type BatchPdfDocument = { orderSns: string[]; buffer: Buffer };
  type BatchPdfFailure = { orderSn: string; error: string; message: string };

  async function mergeBatchPdfBuffers(
    pdfBuffers: Array<{ orderSn: string; buffer: Buffer }>,
    logPrefix: string,
    onInvalid: (orderSn: string) => void,
  ): Promise<PDFDocument> {
    const startedAt = Date.now();
    const mergedPdf = await PDFDocument.create();
    for (let index = 0; index < pdfBuffers.length; index++) {
      const { orderSn, buffer } = pdfBuffers[index];
      try {
        const sourcePdf = await PDFDocument.load(buffer, { ignoreEncryption: true });
        const copiedPages = await mergedPdf.copyPages(sourcePdf, sourcePdf.getPageIndices());
        copiedPages.forEach((page) => mergedPdf.addPage(page));
      } catch (err: any) {
        console.error(`[${logPrefix}] Lỗi gộp PDF ${orderSn}:`, err?.message || err);
        onInvalid(orderSn);
      }
      // Chia CPU work thành các lát nhỏ để không giữ event loop liên tục khi batch lớn.
      if ((index + 1) % 4 === 0) await yieldEventLoop();
    }
    console.log(
      `[${logPrefix}] timing merge=${Date.now() - startedAt}ms files=${pdfBuffers.length} pages=${mergedPdf.getPageCount()}`,
    );
    return mergedPdf;
  }

  async function fetchBatchPdfDocumentsByShop(
    orders: any[],
    orderSns: string[],
    deadlineAt: number,
    logPrefix: string,
    options?: { signal?: AbortSignal },
  ): Promise<{ documents: BatchPdfDocument[]; failedOrders: BatchPdfFailure[] }> {
    const startedAt = Date.now();
    const failedBySn = new Map<string, BatchPdfFailure>();
    const documents: BatchPdfDocument[] = [];
    const orderBySn = new Map(
      orders.map((item: any) => [
        String(item?.orderSn || item?.order_sn || "").replace(/^shopee-/i, "").trim(),
        item,
      ]),
    );
    const authByStoredShop = new Map<string, Promise<any>>();

    const results = await mapBatchConcurrently(
      orderSns,
      BATCH_PRINT_CONCURRENCY,
      async (orderSn): Promise<BatchPdfDocument | null> => {
        // ── BƯỚC 1: LOCAL CACHE order_${orderSn}.pdf ──
        const localLabelPath = path.join(PDF_DIR, `order_${orderSn}.pdf`);
        if (fs.existsSync(localLabelPath)) {
          try {
            const stat = fs.statSync(localLabelPath);
            if (stat.isFile() && stat.size > 0) {
              const buf = await fs.promises.readFile(localLabelPath);
              if (isPdfBuffer(buf)) {
                console.log(
                  `[${logPrefix}] B1 CACHE HIT order_${orderSn}.pdf (${buf.length} bytes)`,
                );
                putLabelMem(`order_${orderSn}.pdf`, buf, "application/pdf");
                return { orderSns: [orderSn], buffer: buf };
              }
            }
          } catch (err: any) {
            console.warn(`[${logPrefix}] Local read fail order_${orderSn}.pdf:`, err?.message || err);
          }
        }

        const order = orderBySn.get(orderSn);
        if (!order) {
          failedBySn.set(orderSn, { orderSn, error: "order_not_found", message: "Không tìm thấy đơn." });
          return null;
        }
        const storedShopId = String(
          order.shopId || order.shop_id || order.accountId || order.account_id || "",
        ).trim();
        if (!storedShopId) {
          failedBySn.set(orderSn, { orderSn, error: "missing_shop_id", message: "Đơn thiếu shopId." });
          return null;
        }

        let shopId = "";
        let accessToken = "";
        try {
          let authPromise = authByStoredShop.get(storedShopId);
          if (!authPromise) {
            authPromise = runBeforeBatchDeadline(
              deadlineAt,
              `auth:${storedShopId}`,
              () => getShopeeAccessTokenForApi(storedShopId),
            );
            authByStoredShop.set(storedShopId, authPromise);
          }
          const auth = await authPromise;
          shopId = String(auth?.apiShopId || "").trim();
          accessToken = String(auth?.token || "").trim();
          if (!shopId || !accessToken) {
            failedBySn.set(orderSn, { orderSn, error: "token_missing", message: "Không có token Shopee." });
            return null;
          }
        } catch (err: any) {
          failedBySn.set(orderSn, {
            orderSn,
            error: "shop_auth_failed",
            message: String(err?.message || err),
          });
          return null;
        }

        const deadlineController = new AbortController();
        const deadlineTimer = setTimeout(
          () => deadlineController.abort(new Error("batch_deadline:shopee_pdf")),
          Math.max(1, deadlineAt - Date.now()),
        );
        const operationSignal = options?.signal
          ? AbortSignal.any([deadlineController.signal, options.signal])
          : deadlineController.signal;

        try {
          // ── BƯỚC 2: ENRICH package_number (bắt buộc) ──
          await runBeforeBatchDeadline(
            deadlineAt,
            `enrich:${orderSn}`,
            () => enrichOrdersPackageAndTrackingForPrint(shopId, accessToken, [order]),
          );
          if (order.__shopeeOrderNotFound) {
            failedBySn.set(orderSn, {
              orderSn,
              error: "order_not_found",
              message: "Đơn không tồn tại trên Shopee (get_order_detail not found).",
            });
            return null;
          }
          const rows = buildShopeeShippingDocOrderRows(order);
          if (rows.length === 0) {
            failedBySn.set(orderSn, {
              orderSn,
              error: "missing_package_number",
              message: "Thiếu kiện hàng",
            });
            return null;
          }

          // ── BƯỚC 3→5: CREATE → POLL → DOWNLOAD (tuyến tính, có recovery Create 1 lần) ──
          const result = await runBeforeBatchDeadline(
            deadlineAt,
            `waybill_linear:${orderSn}`,
            () =>
              fetchSingleOrderWaybillFromRows(shopId, accessToken, orderSn, rows, {
                deadlineAt,
                signal: operationSignal,
              }),
          );

          if (!result.success || !result.filePath) {
            const rawErr = String(result.error || "pdf_unavailable");
            // Cấm trả mã khiến FE auto-retry (package_should_print_first / timeout).
            const hardError =
              rawErr === "fatal_error" ||
              rawErr === "order_not_found" ||
              rawErr === "package_should_print_first" ||
              /timeout/i.test(rawErr)
                ? rawErr === "order_not_found"
                  ? "order_not_found"
                  : "fatal_error"
                : rawErr;
            failedBySn.set(orderSn, {
              orderSn,
              error: hardError,
              message:
                hardError === "fatal_error"
                  ? "Shopee từ chối tạo file. Vui lòng kiểm tra lại trạng thái đơn trên Shopee."
                  : result.message || "Shopee chưa trả PDF hợp lệ.",
            });
            return null;
          }

          const buffer = await fs.promises.readFile(result.filePath);
          if (!buffer.length || buffer.length > BATCH_PDF_MAX_BYTES || !isPdfBuffer(buffer)) {
            failedBySn.set(orderSn, {
              orderSn,
              error: "invalid_pdf",
              message: "Dữ liệu PDF không hợp lệ.",
            });
            return null;
          }
          putLabelMem(`order_${orderSn}.pdf`, buffer, "application/pdf");
          return { orderSns: [orderSn], buffer };
        } catch (err: any) {
          const msg = String(err?.message || err);
          failedBySn.set(orderSn, {
            orderSn,
            error: "fatal_error",
            message:
              "Shopee từ chối tạo file. Vui lòng kiểm tra lại trạng thái đơn trên Shopee.",
          });
          console.error(`[${logPrefix}] HARD STOP ${orderSn}:`, msg);
          return null;
        } finally {
          clearTimeout(deadlineTimer);
        }
      },
    );

    for (const doc of results) {
      if (doc) documents.push(doc);
    }

    console.log(
      `[${logPrefix}] timing total=${Date.now() - startedAt}ms ok=${documents.length} failed=${failedBySn.size}`,
    );
    return {
      documents,
      failedOrders: [...failedBySn.values()],
    };
  }

  // API BATCH-CONFIRM-PRINT: Xác nhận nhiều đơn + gộp PDF thành 1 file
  const batchConfirmPrintRoute = async (req: any, res: any) => {
    const t0 = Date.now();
    const deadlineAt = t0 + BATCH_PRINT_DEADLINE_MS;
    beginLogisticsWork("batch-confirm-print");
    try {
      const { orderSns, method } = req.body || {};
      const shipMethod: ShipMethod = method === "dropoff" ? "dropoff" : "pickup";
      
      if (!Array.isArray(orderSns) || orderSns.length === 0) {
        return res.status(400).json({
          success: false,
          message: "Thiếu danh sách orderSns.",
        });
      }

      const cleanSns = orderSns.map((sn: any) => 
        String(sn || "").replace(/^shopee-/i, "").trim()
      ).filter(Boolean);

      if (cleanSns.length === 0) {
        return res.status(400).json({
          success: false,
          message: "Danh sách orderSns không hợp lệ.",
        });
      }

      console.log(`[Batch Confirm Print] Bắt đầu xử lý ${cleanSns.length} đơn: ${cleanSns.join(", ")}`);

      // Bước 1: Load orders
      let orders: any[] = [];
      try {
        orders = await runBeforeBatchDeadline(
          deadlineAt,
          "load_orders",
          () => loadOrdersForShipScoped(
            cleanSns.map((sn: string) => `shopee-${sn}`),
            cleanSns,
          ),
        );
      } catch (loadErr: any) {
        console.warn("[Batch Confirm Print] loadOrdersForShipScoped:", loadErr?.message || loadErr);
      }

      if (!Array.isArray(orders) || orders.length === 0) {
        return res.status(404).json({
          success: false,
          message: "Không tìm thấy đơn nào trong database.",
        });
      }

      const toShip = resolveOrdersFromRequest(orders, [], cleanSns);
      if (toShip.length === 0) {
        return res.status(404).json({
          success: false,
          message: "Không tìm thấy đơn nào khớp với danh sách.",
        });
      }

      console.log(`[Batch Confirm Print] Xác nhận ${toShip.length} đơn method=${shipMethod}`);
      try {
        await runBeforeBatchDeadline(
          deadlineAt,
          "prewarm_shipping",
          () => prewarmShopeeAddressCacheForShip(toShip, shipMethod),
        );
      } catch (err: any) {
        console.warn("[Batch Confirm Print] prewarm skipped:", err?.message || err);
      }

      const successSns: string[] = [];
      const failedResults: any[] = [];

      // Bước 2: Xác nhận tối đa 5 đơn song song; lỗi một đơn không dừng cả batch.
      await mapBatchConcurrently(toShip, BATCH_PRINT_CONCURRENCY, async ({ index, order }) => {
        const orderSn = String(order.orderSn || "");
        const orderId = String(order.id || "");
        try {
          const resolvedShopId = resolveOrderShopId(order);
          if (resolvedShopId && !order.shopId) {
            orders[index].shopId = resolvedShopId;
            order.shopId = resolvedShopId;
          }

          console.log(`[Batch Confirm Print] Xác nhận đơn ${orderSn}...`);
          let shipResult: Awaited<ReturnType<typeof arrangeShipment>>;
          try {
            shipResult = await runBeforeBatchDeadline(
              deadlineAt,
              `ship:${orderSn}`,
              () => withOperationTimeout(
                (signal) => arrangeShipment(order, shipMethod, signal, { skipRecover: true }),
                SHIP_ORDER_OPERATION_TIMEOUT_MS,
                `Ship order ${orderSn}`,
              ),
            );
          } catch (shipErr: any) {
            shipResult = {
              success: false,
              error: /timeout/i.test(String(shipErr?.message || "")) ? "timeout" : "internal_server_error",
              message: "Lỗi server: " + (shipErr?.message || String(shipErr)),
            };
          }

          const treatedAsSuccess = shipResult.success || isAlreadyShippedError(shipResult);
          
          if (!treatedAsSuccess) {
            failedResults.push({ orderId, orderSn, error: shipResult.error, message: shipResult.message });
            return;
          }

          const tn = String(
            order.trackingNumber ||
              order.tracking_no ||
              shipResult.trackingNumber ||
              orders[index].trackingNumber ||
              "",
          ).trim();
          
          orders[index] = {
            ...orders[index],
            ...order,
            isPrepared: true,
            status: "processed",
            is_pending_shopee_check: false,
            fulfillment_type: shipMethod,
            ship_method: shipMethod,
            trackingNumber: tn || orders[index].trackingNumber,
            tracking_no: tn || orders[index].tracking_no || orders[index].trackingNumber,
            shopId: orders[index].shopId || order.shopId || shipResult.shopId || resolvedShopId,
            shopee_order_status: "PROCESSED",
            shopeeSyncPending: false,
            shopeeSyncError: undefined,
          };
          
          forceHealPickupOrderIfHasTracking(orders[index]);
          successSns.push(orderSn);
        } catch (orderErr: any) {
          console.error(`[Batch Confirm Print] Lỗi đơn ${orderSn}:`, orderErr?.stack || orderErr);
          failedResults.push({
            orderId,
            orderSn,
            error: "order_process_error",
            message: String(orderErr?.message || orderErr),
          });
        }
      });

      // Lưu vào DB — khóa isPrepared TRƯỚC khi trả response (tab Đã xử lý).
      try {
        const confirmedRows = toShip
          .map(({ index }) => orders[index])
          .filter((o: any) => o && o.isPrepared === true);
        await persistConfirmedShipOrdersToMongo(confirmedRows, shipMethod);
        const changed = toShip.map(({ index }) => orders[index]).filter(Boolean);
        await runBeforeBatchDeadline(
          deadlineAt,
          "persist_orders",
          () => persistOrdersToDatabase(orders, changed),
        );
        setImmediate(() => {
          void syncConfirmedOrdersFromShopee(confirmedRows, shipMethod).catch((err: any) => {
            console.warn("[Batch Confirm Print] background sync failed:", err?.message || err);
          });
        });
      } catch (err: any) {
        console.warn("[Batch Confirm Print] persist failed:", err?.message || err);
      }

      if (successSns.length === 0) {
        return res.status(400).json({
          success: false,
          message: "Không xác nhận được đơn nào.",
          failed: failedResults,
        });
      }

      console.log(`[Batch Confirm Print] Đã xác nhận ${successSns.length}/${toShip.length} đơn - bắt đầu lấy PDF...`);

      // Bước 3: Lấy PDF song song
      const pdfBuffers: { orderSn: string; buffer: Buffer }[] = [];
      const pdfFailures = new Map<string, { orderSn: string; error: string; message: string }>();
      
      const processSingleOrder = async (orderSn: string): Promise<{ orderSn: string; buffer: Buffer } | null> => {
        try {
          const order = orders.find(
            (item: any) =>
              String(item?.orderSn || item?.order_sn || "")
                .replace(/^shopee-/i, "")
                .trim() === orderSn,
          );

          if (!order) {
            console.warn(`[Batch Confirm Print] Không tìm thấy order ${orderSn} trong danh sách`);
            return null;
          }

          const storedShopId = String(
            order.shopId || order.shop_id || order.accountId || order.account_id || "",
          ).trim();
          
          if (!storedShopId) {
            console.warn(`[Batch Confirm Print] Đơn ${orderSn} thiếu shopId`);
            return null;
          }

          const auth = await getShopeeAccessTokenForApi(storedShopId);
          const accessToken = String(auth?.token || "").trim();
          const shopId = String(auth?.apiShopId || "").trim();
          
          if (!accessToken || !shopId) {
            console.warn(`[Batch Confirm Print] Không có token cho ${orderSn}`);
            return null;
          }

          // Enrich package/tracking
          try {
            await enrichOrdersPackageAndTrackingForPrint(shopId, accessToken, [order]);
          } catch (err: any) {
            console.warn(`[Batch Confirm Print] enrich ${orderSn}:`, err?.message || err);
          }

          const shippingRows = buildShopeeShippingDocOrderRows(order);
          if (shippingRows.length === 0) {
            console.warn(`[Batch Confirm Print] Đơn ${orderSn} thiếu package_number`);
            return null;
          }

          // Create shipping document
          const createResult = await runBeforeBatchDeadline(
            deadlineAt,
            `create_document:${orderSn}`,
            () => shopeeCreateShippingDocument(shopId, accessToken, shippingRows),
          );
          const createItems: any[] =
            createResult?.response?.result_list || createResult?.result_list || [];
          const createFailure = createItems.find(
            (item: any) => String(item?.fail_error || "").trim(),
          );
          if (createResult?.error || createFailure || createItems.length < shippingRows.length) {
            console.warn(
              `[Batch Confirm Print] Create doc ${orderSn} failed:`,
              createFailure?.fail_error || createResult?.error || "create_not_acknowledged",
            );
            return null;
          }

          // Poll ngay lần đầu, sau đó mỗi 1s và luôn dừng trước deadline của proxy.
          let pdfReady = false;
          
          for (let attempt = 1; attempt <= 10 && Date.now() < deadlineAt; attempt++) {
            try {
              const poll = await runBeforeBatchDeadline(
                deadlineAt,
                `poll_document:${orderSn}`,
                () => shopeeGetShippingDocumentResult(shopId, accessToken, shippingRows),
              );
              if (poll?.error) continue;
              
              const items: any[] = poll?.response?.result_list || poll?.result_list || [];
              const allReady = shippingRows.every((row) => {
                const result = items.find(
                  (item: any) =>
                    String(item?.order_sn || "") === orderSn &&
                    (!item?.package_number ||
                      String(item.package_number) === row.package_number),
                );
                return String(result?.status || "").toUpperCase() === "READY";
              });
              
              if (allReady) {
                pdfReady = true;
                break;
              }
            } catch (err: any) {
              console.warn(`[Batch Confirm Print] Poll ${orderSn} attempt ${attempt}:`, err?.message || err);
            }
            if (attempt < 10 && Date.now() < deadlineAt) {
              await sleep(Math.min(1000, Math.max(0, deadlineAt - Date.now())));
            }
          }

          if (!pdfReady) {
            console.warn(`[Batch Confirm Print] PDF ${orderSn} chưa READY trước deadline`);
            return null;
          }

          // Download PDF từ Shopee
          const apiPath = "/api/v2/logistics/download_shipping_document";
          const timestamp = Math.floor(Date.now() / 1000);
          const sign = shopeeSign(apiPath, timestamp, accessToken, shopId);
          const url = `${SHOPEE_HOST}${apiPath}?partner_id=${SHOPEE_PARTNER_ID}&timestamp=${timestamp}&access_token=${accessToken}&shop_id=${shopId}&sign=${sign}`;

          const downloadRes = await runBeforeBatchDeadline(
            deadlineAt,
            `download_document:${orderSn}`,
            () => fetchWithTimeout(url, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                order_list: shippingRows.map((row) => ({
                  order_sn: row.order_sn,
                  package_number: row.package_number,
                  shipping_document_type: SHOPEE_SHIPPING_DOCUMENT_TYPE,
                })),
              }),
            }, Math.min(8_000, Math.max(1_000, deadlineAt - Date.now()))),
          );

          const contentType = String(downloadRes.headers.get("content-type") || "").toLowerCase();
          
          if (contentType.includes("application/json") || !downloadRes.ok || !downloadRes.body) {
            console.warn(`[Batch Confirm Print] Download ${orderSn} failed`);
            return null;
          }

          // Đọc buffer
          const buffer = validateBatchPdfBytes(await downloadRes.arrayBuffer());
          if (!buffer) {
            console.warn(`[Batch Confirm Print] Download ${orderSn} không phải PDF hợp lệ`);
            return null;
          }
          console.log(`[Batch Confirm Print] Downloaded PDF ${orderSn} (${buffer.length} bytes)`);
          
          return { orderSn, buffer };
        } catch (err: any) {
          console.error(`[Batch Confirm Print] Lỗi PDF ${orderSn}:`, err?.stack || err);
          return null;
        }
      };

      // Một create/poll/download cho mỗi shop; các shop vẫn chạy song song.
      const batchPdfResult = await fetchBatchPdfDocumentsByShop(
        orders,
        successSns,
        deadlineAt,
        "Batch Confirm Print",
      );
      const printedFromBatch = batchPdfResult.documents.flatMap((item) => item.orderSns);
      pdfBuffers.push(
        ...batchPdfResult.documents.map((item) => ({
          orderSn: item.orderSns.join(","),
          buffer: item.buffer,
        })),
      );
      for (const failure of batchPdfResult.failedOrders) {
        pdfFailures.set(failure.orderSn, failure);
      }

      if (pdfBuffers.length === 0) {
        return res.status(400).json({
          success: false,
          message: `Đã xác nhận ${successSns.length} đơn nhưng không lấy được PDF nào.`,
          confirmedOrders: successSns,
          failedOrders: [...failedResults, ...pdfFailures.values()],
        });
      }

      // Bước 4: Gộp tất cả PDF
      console.log(`[Batch Confirm Print] Gộp ${pdfBuffers.length} PDF...`);
      const mergedPdf = await mergeBatchPdfBuffers(
        pdfBuffers,
        "Batch Confirm Print",
        (orderSn) => {
          for (const failedSn of orderSn.split(",").filter(Boolean)) {
            pdfFailures.set(failedSn, {
              orderSn: failedSn,
              error: "invalid_pdf",
              message: "Dữ liệu PDF bị hỏng hoặc không thể gộp.",
            });
          }
        },
      );

      if (mergedPdf.getPageCount() === 0) {
        return res.status(400).json({
          success: false,
          message: "Không có PDF hợp lệ để gộp.",
          confirmedOrders: successSns,
          failedOrders: [...failedResults, ...pdfFailures.values()],
        });
      }

      // Bước 5: Lưu file gộp
      const mergedBytes = await mergedPdf.save();
      const batchFilename = `batch-${Date.now()}.pdf`;
      putLabelMem(batchFilename, Buffer.from(mergedBytes), "application/pdf");
      const batchUrl = absoluteLabelUrl(`/api/public/labels/${batchFilename}`);
      if (!batchUrl) throw new Error("Không tạo được URL PDF gộp sau khi lưu file.");

      const failedOrders = [...failedResults, ...pdfFailures.values()];
      const failedPdfSns = new Set([...pdfFailures.values()].map((item) => item.orderSn));
      const printedOrders = printedFromBatch.filter((orderSn) => !failedPdfSns.has(orderSn));
      const printedCount = printedOrders.length;
      console.log(`[Batch Confirm Print] DONE ${printedCount} đơn → ${batchUrl} (${Date.now() - t0}ms)`);

      return res.json({
        success: true,
        url: batchUrl,
        filename: batchFilename,
        confirmedCount: successSns.length,
        pdfCount: printedCount,
        totalPages: mergedPdf.getPageCount(),
        confirmedOrders: successSns,
        printedOrders,
        failedOrders,
        message: failedOrders.length > 0
          ? `Đã in gộp ${printedCount} đơn. Các đơn lỗi: ${failedOrders.map((item) => item.orderSn || item.orderId).filter(Boolean).join(", ")}`
          : `Đã in gộp ${printedCount} đơn.`,
      });
    } catch (error: any) {
      console.error("[Batch Confirm Print] Lỗi:", error?.stack || error);
      return res.status(500).json({
        success: false,
        message: "Lỗi server: " + error.message,
      });
    } finally {
      endLogisticsWork();
    }
  };

  // API BATCH-PRINT-ONLY: In lại nhiều đơn đã xác nhận, gộp PDF thành 1 file (KHÔNG xác nhận lại)
  const batchPrintOnlyRoute = async (req: any, res: any) => {
    const t0 = Date.now();
    const deadlineAt = t0 + BATCH_PRINT_ONLY_DEADLINE_MS;
    const requestAbortController = new AbortController();
    const abortOnClientDisconnect = () =>
      requestAbortController.abort(new Error("client_disconnected"));
    req.once("aborted", abortOnClientDisconnect);
    beginLogisticsWork("batch-print-only");
    
    try {
      const { orderSns } = req.body || {};
      
      if (!Array.isArray(orderSns) || orderSns.length === 0) {
        return res.status(400).json({
          success: false,
          message: "Thiếu danh sách orderSns.",
        });
      }

      const cleanSns = orderSns.map((sn: any) => 
        String(sn || "").replace(/^shopee-/i, "").trim()
      ).filter(Boolean);

      if (cleanSns.length === 0) {
        return res.status(400).json({
          success: false,
          message: "Danh sách orderSns không hợp lệ.",
        });
      }

      console.log(`[Batch Print Only] In lại ${cleanSns.length} đơn: ${cleanSns.join(", ")}`);

      // Load orders từ DB
      let orders: any[] = [];
      try {
        orders = await runBeforeBatchDeadline(
          deadlineAt,
          "load_orders",
          () => loadOrdersForShipScoped(
            cleanSns.map((sn: string) => `shopee-${sn}`),
            cleanSns,
          ),
        );
      } catch (loadErr: any) {
        console.warn("[Batch Print Only] loadOrdersForShipScoped:", loadErr?.message || loadErr);
      }

      if (!Array.isArray(orders) || orders.length === 0) {
        return res.status(404).json({
          success: false,
          message: "Không tìm thấy đơn nào trong database.",
        });
      }

      // Lấy PDF tối đa 5 đơn song song; lỗi cục bộ được trả riêng cho frontend.
      const pdfBuffers: { orderSn: string; buffer: Buffer }[] = [];
      const pdfFailures = new Map<string, { orderSn: string; error: string; message: string }>();
      
      const processSingleOrder = async (orderSn: string): Promise<{ orderSn: string; buffer: Buffer } | null> => {
        try {
          const order = orders.find(
            (item: any) =>
              String(item?.orderSn || item?.order_sn || "")
                .replace(/^shopee-/i, "")
                .trim() === orderSn,
          );

          if (!order) {
            console.warn(`[Batch Print Only] Không tìm thấy order ${orderSn}`);
            return null;
          }

          const storedShopId = String(
            order.shopId || order.shop_id || order.accountId || order.account_id || "",
          ).trim();
          
          if (!storedShopId) {
            console.warn(`[Batch Print Only] Đơn ${orderSn} thiếu shopId`);
            return null;
          }

          const auth = await getShopeeAccessTokenForApi(storedShopId);
          const accessToken = String(auth?.token || "").trim();
          const shopId = String(auth?.apiShopId || "").trim();
          
          if (!accessToken || !shopId) {
            console.warn(`[Batch Print Only] Không có token cho ${orderSn}`);
            return null;
          }

          // Enrich package/tracking
          try {
            await enrichOrdersPackageAndTrackingForPrint(shopId, accessToken, [order]);
          } catch (err: any) {
            console.warn(`[Batch Print Only] enrich ${orderSn}:`, err?.message || err);
          }

          const shippingRows = buildShopeeShippingDocOrderRows(order);
          if (shippingRows.length === 0) {
            console.warn(`[Batch Print Only] Đơn ${orderSn} thiếu package_number`);
            return null;
          }

          // Create shipping document
          const createResult = await runBeforeBatchDeadline(
            deadlineAt,
            `create_document:${orderSn}`,
            () => shopeeCreateShippingDocument(shopId, accessToken, shippingRows),
          );
          const createItems: any[] =
            createResult?.response?.result_list || createResult?.result_list || [];
          const createFailure = createItems.find(
            (item: any) => String(item?.fail_error || "").trim(),
          );
          if (createResult?.error || createFailure || createItems.length < shippingRows.length) {
            console.warn(
              `[Batch Print Only] Create doc ${orderSn} failed:`,
              createFailure?.fail_error || createResult?.error || "create_not_acknowledged",
            );
            return null;
          }

          // Poll ngay lần đầu, sau đó mỗi 1s và luôn dừng trước deadline của proxy.
          let pdfReady = false;
          
          for (let attempt = 1; attempt <= 10 && Date.now() < deadlineAt; attempt++) {
            try {
              const poll = await runBeforeBatchDeadline(
                deadlineAt,
                `poll_document:${orderSn}`,
                () => shopeeGetShippingDocumentResult(shopId, accessToken, shippingRows),
              );
              if (poll?.error) continue;
              
              const items: any[] = poll?.response?.result_list || poll?.result_list || [];
              const allReady = shippingRows.every((row) => {
                const result = items.find(
                  (item: any) =>
                    String(item?.order_sn || "") === orderSn &&
                    (!item?.package_number ||
                      String(item.package_number) === row.package_number),
                );
                return String(result?.status || "").toUpperCase() === "READY";
              });
              
              if (allReady) {
                pdfReady = true;
                break;
              }
            } catch (err: any) {
              console.warn(`[Batch Print Only] Poll ${orderSn} attempt ${attempt}:`, err?.message || err);
            }
            if (attempt < 10 && Date.now() < deadlineAt) {
              await sleep(Math.min(1000, Math.max(0, deadlineAt - Date.now())));
            }
          }

          if (!pdfReady) {
            console.warn(`[Batch Print Only] PDF ${orderSn} chưa READY trước deadline`);
            return null;
          }

          // Download PDF từ Shopee
          const apiPath = "/api/v2/logistics/download_shipping_document";
          const timestamp = Math.floor(Date.now() / 1000);
          const sign = shopeeSign(apiPath, timestamp, accessToken, shopId);
          const url = `${SHOPEE_HOST}${apiPath}?partner_id=${SHOPEE_PARTNER_ID}&timestamp=${timestamp}&access_token=${accessToken}&shop_id=${shopId}&sign=${sign}`;

          const downloadRes = await runBeforeBatchDeadline(
            deadlineAt,
            `download_document:${orderSn}`,
            () => fetchWithTimeout(url, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                order_list: shippingRows.map((row) => ({
                  order_sn: row.order_sn,
                  package_number: row.package_number,
                  shipping_document_type: SHOPEE_SHIPPING_DOCUMENT_TYPE,
                })),
              }),
            }, Math.min(8_000, Math.max(1_000, deadlineAt - Date.now()))),
          );

          const contentType = String(downloadRes.headers.get("content-type") || "").toLowerCase();
          
          if (contentType.includes("application/json") || !downloadRes.ok || !downloadRes.body) {
            console.warn(`[Batch Print Only] Download ${orderSn} failed`);
            return null;
          }

          // Đọc buffer
          const buffer = validateBatchPdfBytes(await downloadRes.arrayBuffer());
          if (!buffer) {
            console.warn(`[Batch Print Only] Download ${orderSn} không phải PDF hợp lệ`);
            return null;
          }
          console.log(`[Batch Print Only] Downloaded PDF ${orderSn} (${buffer.length} bytes)`);
          
          return { orderSn, buffer };
        } catch (err: any) {
          console.error(`[Batch Print Only] Lỗi PDF ${orderSn}:`, err?.stack || err);
          return null;
        }
      };

      // Luồng tuyến tính từng đơn: Cache → Enrich → Create → Poll → Download (đã có recovery Create 1 lần).
      const pendingSns = new Set(cleanSns);
      const printedFromBatch: string[] = [];
      const batchPdfResult = await fetchBatchPdfDocumentsByShop(
        orders,
        [...pendingSns],
        deadlineAt,
        "Batch Print Only",
        {
          signal: requestAbortController.signal,
        },
      );
      for (const document of batchPdfResult.documents) {
        pdfBuffers.push({
          orderSn: document.orderSns.join(","),
          buffer: document.buffer,
        });
        for (const orderSn of document.orderSns) {
          pendingSns.delete(orderSn);
          pdfFailures.delete(orderSn);
          printedFromBatch.push(orderSn);
        }
      }
      for (const failure of batchPdfResult.failedOrders) {
        if (pendingSns.has(failure.orderSn)) pdfFailures.set(failure.orderSn, failure);
      }

      if (pdfBuffers.length === 0) {
        return res.status(400).json({
          success: false,
          message: `Shopee chưa tạo xong PDF cho ${cleanSns.length} đơn sau khi đã polling chờ READY.`,
          failedOrders: [...pdfFailures.values()],
        });
      }

      // Gộp tất cả PDF
      console.log(`[Batch Print Only] Gộp ${pdfBuffers.length} PDF...`);
      const mergedPdf = await mergeBatchPdfBuffers(
        pdfBuffers,
        "Batch Print Only",
        (orderSn) => {
          for (const failedSn of orderSn.split(",").filter(Boolean)) {
            pdfFailures.set(failedSn, {
              orderSn: failedSn,
              error: "invalid_pdf",
              message: "Dữ liệu PDF bị hỏng hoặc không thể gộp.",
            });
          }
        },
      );

      if (mergedPdf.getPageCount() === 0) {
        return res.status(400).json({
          success: false,
          message: "Không có PDF hợp lệ để gộp.",
          failedOrders: [...pdfFailures.values()],
        });
      }

      // Lưu file gộp
      const mergedBytes = await mergedPdf.save();
      const batchFilename = `reprint-${Date.now()}.pdf`;
      putLabelMem(batchFilename, Buffer.from(mergedBytes), "application/pdf");
      const batchUrl = absoluteLabelUrl(`/api/public/labels/${batchFilename}`);
      if (!batchUrl) throw new Error("Không tạo được URL PDF gộp sau khi lưu file.");

      const failedOrders = [...pdfFailures.values()];
      const failedPdfSns = new Set(failedOrders.map((item) => item.orderSn));
      const printedOrders = printedFromBatch.filter((orderSn) => !failedPdfSns.has(orderSn));
      const printedCount = printedOrders.length;
      console.log(`[Batch Print Only] DONE ${printedCount}/${cleanSns.length} đơn → ${batchUrl} (${Date.now() - t0}ms)`);

      return res.json({
        success: true,
        url: batchUrl,
        filename: batchFilename,
        pdfCount: printedCount,
        totalPages: mergedPdf.getPageCount(),
        printedOrders,
        failedOrders,
        message: failedOrders.length > 0
          ? `Đã in gộp ${printedCount} đơn. Các đơn lỗi: ${failedOrders.map((item) => item.orderSn).join(", ")}`
          : `Đã in gộp ${printedCount} đơn.`,
      });
    } catch (error: any) {
      console.error("[Batch Print Only] Lỗi:", error?.stack || error);
      return res.status(500).json({
        success: false,
        message: "Lỗi server: " + error.message,
      });
    } finally {
      req.off("aborted", abortOnClientDisconnect);
      endLogisticsWork();
    }
  };

  type PrefetchStatus = {
    total: number;
    succeeded: number;
    failed: number;
    isDone: boolean;
    errors: BatchPdfFailure[];
  };

  const SILENT_PREFETCH_DEADLINE_MS = 45_000;
  const SILENT_PREFETCH_CONCURRENCY = 5;
  const silentPdfPrefetchInFlight = new Set<string>();
  const prefetchStatus = new Map<string, PrefetchStatus>();
  let prefetchBatchSequence = 0;

  const runSilentPdfPrefetch = async (batchId: string, orderSns: string[]): Promise<void> => {
    const pending = new Set(orderSns);
    const settled = new Set<string>();
    const deadlineAt = Date.now() + SILENT_PREFETCH_DEADLINE_MS;
    const settleOrder = (orderSn: string, failure?: BatchPdfFailure) => {
      if (settled.has(orderSn)) return;
      settled.add(orderSn);
      pending.delete(orderSn);
      const status = prefetchStatus.get(batchId);
      if (!status) return;
      if (failure) {
        status.failed = Math.min(status.total, status.failed + 1);
        status.errors.push(failure);
      } else {
        status.succeeded = Math.min(status.total, status.succeeded + 1);
      }
      status.isDone = status.succeeded + status.failed >= status.total;
    };
    beginLogisticsWork("silent-prefetch-pdfs");
    try {
      const publicPdfDir = path.join(APP_ROOT, "public", "pdfs");
      let nextIndex = 0;
      // Promise pool: tối đa 5 đơn chạy song song, không tạo request Shopee ồ ạt.
      const workerCount = Math.min(SILENT_PREFETCH_CONCURRENCY, orderSns.length);
      const runWorker = async () => {
        while (nextIndex < orderSns.length) {
          const orderSn = orderSns[nextIndex++];
          let failure: BatchPdfFailure | undefined;
          try {
            const orders = await runBeforeBatchDeadline(
              deadlineAt,
              `silent_prefetch_load_order_${orderSn}`,
              () => loadOrdersForShipScoped([`shopee-${orderSn}`], [orderSn]),
            );
            const result = await fetchBatchPdfDocumentsByShop(
              orders,
              [orderSn],
              deadlineAt,
              `Silent Prefetch ${orderSn}`,
            );
            const document = result.documents.find((item) =>
              item.orderSns.includes(orderSn),
            );
            if (!document) {
              failure = result.failedOrders.find((item) => item.orderSn === orderSn) || {
                orderSn,
                error: "pdf_unavailable",
                message: "Không tải được PDF trước khi hết thời gian cho phép.",
              };
              continue;
            }
            const filename = buildCachedLabelFilename([orderSn]);
            const storedPdf = getValidLabelDiskFile(filename);
            if (!storedPdf) {
              throw new Error(`PDF chưa được ghi thành công vào ${path.join(PDF_DIR, filename)}`);
            }
            try {
              fs.mkdirSync(publicPdfDir, { recursive: true });
              fs.writeFileSync(path.join(publicPdfDir, filename), document.buffer);
            } catch (publicCopyErr: any) {
              console.warn(
                `[Silent Prefetch] Không thể ghi bản phụ public/pdfs cho ${orderSn}:`,
                publicCopyErr?.message || publicCopyErr,
              );
            }
          } catch (err: any) {
            console.error(`[Silent Prefetch] order ${orderSn} failed:`, err?.stack || err);
            failure = {
              orderSn,
              error: /batch_deadline|timeout/i.test(String(err?.message || ""))
                ? "timeout"
                : "prefetch_error",
              message: String(err?.message || err || "Tải PDF thất bại."),
            };
          } finally {
            // Mỗi đơn luôn hoàn tất riêng, kể cả lỗi, để progress không bị kẹt.
            settleOrder(orderSn, failure);
            const status = prefetchStatus.get(batchId);
            if (status) status.isDone = status.succeeded + status.failed >= status.total;
          }
        }
      };
      await Promise.all(Array.from({ length: workerCount }, () => runWorker()));
      console.log(
        `[Silent Prefetch] DONE cached=${orderSns.length - (prefetchStatus.get(batchId)?.failed || 0)}/${orderSns.length}`,
      );
    } catch (err: any) {
      console.error("[Silent Prefetch] background error:", err?.stack || err);
      for (const orderSn of [...pending]) {
        settleOrder(orderSn, {
          orderSn,
          error: /batch_deadline|timeout/i.test(String(err?.message || ""))
            ? "timeout"
            : "prefetch_error",
          message: String(err?.message || err || "Tải PDF thất bại."),
        });
      }
    } finally {
      const status = prefetchStatus.get(batchId);
      if (status) {
        for (const orderSn of [...pending]) {
          settleOrder(orderSn, {
            orderSn,
            error: "prefetch_incomplete",
            message: "Tiến trình kết thúc nhưng đơn chưa có PDF.",
          });
        }
        status.isDone = status.succeeded + status.failed >= status.total;
      }
      for (const orderSn of orderSns) silentPdfPrefetchInFlight.delete(orderSn);
      endLogisticsWork();
      const cleanupTimer = setTimeout(() => prefetchStatus.delete(batchId), 10 * 60 * 1_000);
      cleanupTimer.unref?.();
    }
  };

  const silentPrefetchPdfsRoute = (req: any, res: any) => {
    const cleanSns = [
      ...new Set(
        (Array.isArray(req.body?.orderSns) ? req.body.orderSns : [])
          .map((sn: any) => String(sn || "").replace(/^shopee-/i, "").trim())
          .filter(Boolean),
      ),
    ] as string[];
    if (cleanSns.length === 0) {
      return res.status(400).json({ success: false, message: "Thiếu danh sách orderSns." });
    }

    const queued = cleanSns.filter((orderSn) => {
      if (silentPdfPrefetchInFlight.has(orderSn)) return false;
      silentPdfPrefetchInFlight.add(orderSn);
      return true;
    });
    const batchId = `${Date.now()}-${++prefetchBatchSequence}`;
    prefetchStatus.set(batchId, {
      total: queued.length,
      succeeded: 0,
      failed: 0,
      isDone: queued.length === 0,
      errors: [],
    });
    res.status(200).json({
      success: true,
      batchId,
      accepted: queued.length,
      skippedInFlight: cleanSns.length - queued.length,
    });
    if (queued.length > 0) {
      setImmediate(() => {
        void runSilentPdfPrefetch(batchId, queued);
      });
    } else {
      const cleanupTimer = setTimeout(() => prefetchStatus.delete(batchId), 10 * 60 * 1_000);
      cleanupTimer.unref?.();
    }
  };

  const prefetchStatusRoute = (req: any, res: any) => {
    const batchId = String(req.params?.batchId || "").trim();
    const status = prefetchStatus.get(batchId);
    if (!status) {
      return res.status(404).json({ success: false, message: "Không tìm thấy tiến trình tải PDF." });
    }
    const completed = status.succeeded + status.failed;
    return res.status(200).json({
      total: status.total,
      completed,
      succeeded: status.succeeded,
      failed: status.failed,
      isDone: status.isDone,
      errors: status.errors.slice(0, 20),
    });
  };

  app.post("/api/orders/fast-process", authMiddleware, fastProcessRouteGuard);
  app.post("/api/shopee/orders/fast-process", authMiddleware, fastProcessRouteGuard);
  app.post("/api/orders/confirm", authMiddleware, confirmOnlyRoute);
  app.post("/api/orders/batch-confirm", authMiddleware, confirmOnlyRoute);
  app.post("/api/orders/get-pdf", authMiddleware, getPdfRoute);
  app.post("/api/orders/batch-confirm-print", authMiddleware, batchConfirmPrintRoute);
  app.post("/api/orders/batch-print-only", authMiddleware, batchPrintOnlyRoute);
  app.post("/api/orders/silent-prefetch-pdfs", authMiddleware, silentPrefetchPdfsRoute);
  app.get("/api/orders/prefetch-status/:batchId", authMiddleware, prefetchStatusRoute);
  // orderSn là mã khó đoán; route GET không dùng Bearer để window.open() tải trực tiếp được.
  app.get("/api/orders/download-pdf/:orderSn", downloadPdfRoute);

  app.post("/api/orders/mark-printed", authMiddleware, markPrinted);
  app.post("/api/orders/update-print-status", authMiddleware, updatePrintStatus);
  app.post("/api/orders/reset-print-status", authMiddleware, resetPrintStatus);
  // One-time script: dọn đơn kẹt SHIPPED — đăng ký tường minh (tránh 404 nếu router cũ trên cPanel).
  app.post("/api/orders/cleanup-shipped", authMiddleware, cleanupShipped);
  app.get("/api/orders/cleanup-shipped", authMiddleware, getCleanupShippedStatus);
  app.post("/api/cleanup-shipped", authMiddleware, cleanupShipped);
  app.get("/api/cleanup-shipped", authMiddleware, getCleanupShippedStatus);
  app.post("/api/orders/recalculate-counts", authMiddleware, recalculateOrderCounts);
  app.use("/api/orders", authMiddleware, ordersRoutes);
  // Endpoint tạm: quét đơn thiếu mã VĐ / kẹt unprocessed → get_order_detail
  app.post("/trigger-fix-stuck-orders", authMiddleware, triggerFixStuckOrdersRoute);
  app.post("/api/trigger-fix-stuck-orders", authMiddleware, triggerFixStuckOrdersRoute);

  /**
   * TEST THỦ CÔNG — ép dò ĐVVC → Shopee → shipping → Mongo (await JSON chi tiết).
   * Mở trên browser (không cần auth): /api/test-sync-shopee
   * Query: ?max=150
   */
  app.get("/api/test-sync-shopee", async (req, res) => {
    const force4 =
      req.query?.force4 === "1" ||
      req.query?.force4 === "true" ||
      String(req.query?.force4 || "").toLowerCase() === "yes";
    if (force4) {
      try {
        if (!isMongoReady()) {
          return res.status(503).json({
            success: false,
            message: "MongoDB chưa sẵn sàng",
            endpoint: "GET /api/test-sync-shopee?force4=1",
          });
        }
        const patches4 = [
          { orderSn: "260803D8MMJJ1B", shopId: "4127421", shopName: "LKAT" },
          { orderSn: "260803D4V7QX5J", shopId: "4127421", shopName: "LKAT" },
        ];
        const results4 = [];
        for (const p of patches4) {
          const sn = String(p.orderSn || "").replace(/^#/, "").trim();
          const r = await forceUpdateOrderShopIdInStore(sn, p.shopId, p.shopName);
          results4.push({ ...p, orderSn: sn, ...r });
        }
        try {
          invalidateOrdersRefreshCache();
        } catch {
          /* ignore */
        }
        const okCount4 = results4.filter((r) => r.ok).length;
        console.log(`[TEST-SYNC-SHOPEE] force4 done ok=${okCount4}/${results4.length}`);
        return res.status(200).json({
          success: okCount4 === results4.length,
          endpoint: "GET /api/test-sync-shopee?force4=1",
          message: `Force4 update ${okCount4}/${results4.length} đơn → LKAT (4127421)`,
          results: results4,
        });
      } catch (err: any) {
        console.error("[TEST-SYNC-SHOPEE] force4 error:", err?.stack || err);
        return res.status(500).json({
          success: false,
          message: err?.message || String(err),
          endpoint: "GET /api/test-sync-shopee?force4=1",
        });
      }
    }

    const force3 =
      req.query?.force3 === "1" ||
      req.query?.force3 === "true" ||
      String(req.query?.force3 || "").toLowerCase() === "yes";
    if (force3) {
      try {
        if (!isMongoReady()) {
          return res.status(503).json({
            success: false,
            message: "MongoDB chưa sẵn sàng",
            endpoint: "GET /api/test-sync-shopee?force3=1",
          });
        }
        const patches = [
          { orderSn: "260804F23WMATA", shopId: "831052930", shopName: "AuDIO" },
          { orderSn: "260804DT3Y5TE2", shopId: "831052930", shopName: "AuDIO" },
          { orderSn: "260803DB4R3F19", shopId: "4127421", shopName: "LKAT" },
        ];
        const results = [];
        for (const p of patches) {
          const r = await forceUpdateOrderShopIdInStore(p.orderSn, p.shopId, p.shopName);
          results.push({ ...p, ...r });
        }
        // THÊM: ép 2 mã (order_sn hoặc tracking_no) → shop LKAT 4127421
        const extraPatches = [
          { code: "GYA8RRQ6", shopId: "4127421", shopName: "LKAT" },
          { code: "SPXVN063169031028", shopId: "4127421", shopName: "LKAT" },
        ];
        for (const p of extraPatches) {
          const r = await forceUpdateOrderShopIdByCodeInStore(p.code, p.shopId, p.shopName);
          results.push({ ...p, ...r });
        }
        try {
          invalidateOrdersRefreshCache();
        } catch {
          /* ignore */
        }
        const okCount = results.filter((r) => r.ok).length;
        console.log(`[TEST-SYNC-SHOPEE] force3 done ok=${okCount}/${results.length}`);
        return res.status(200).json({
          success: okCount === results.length,
          endpoint: "GET /api/test-sync-shopee?force3=1",
          message: `Force update ${okCount}/${results.length} đơn shopId`,
          results,
        });
      } catch (err: any) {
        console.error("[TEST-SYNC-SHOPEE] force3 error:", err?.stack || err);
        return res.status(500).json({
          success: false,
          message: err?.message || String(err),
          endpoint: "GET /api/test-sync-shopee?force3=1",
        });
      }
    }

    const maxRaw = Number(req.query?.max ?? 150);
    const maxOrders = Number.isFinite(maxRaw)
      ? Math.min(Math.max(1, Math.floor(maxRaw)), 200)
      : 150;
    const remapOnly =
      req.query?.remap === "1" ||
      req.query?.remap === "true" ||
      req.query?.remapOnly === "1";
    console.log(
      `[TEST-SYNC-SHOPEE] START maxOrders=${maxOrders} remapOnly=${remapOnly}`,
    );
    try {
      const result = await debugForceSyncHandedOverOrders({ maxOrders, remapOnly });
      return res.status(200).json(result);
    } catch (err: any) {
      console.error("[TEST-SYNC-SHOPEE] route error:", err?.stack || err);
      return res.status(500).json({
        success: false,
        message: err?.message || String(err),
        endpoint: "GET /api/test-sync-shopee",
      });
    }
  });
  app.get("/api/orders/test-sync-shopee", authMiddleware, async (req, res) => {
    const maxRaw = Number(req.query?.max ?? 150);
    const maxOrders = Number.isFinite(maxRaw)
      ? Math.min(Math.max(1, Math.floor(maxRaw)), 200)
      : 150;
    const remapOnly =
      req.query?.remap === "1" ||
      req.query?.remap === "true" ||
      req.query?.remapOnly === "1";
    try {
      const result = await debugForceSyncHandedOverOrders({ maxOrders, remapOnly });
      return res.status(200).json(result);
    } catch (err: any) {
      return res.status(500).json({
        success: false,
        message: err?.message || String(err),
      });
    }
  });

  app.use("/api", apiSystemRoutes);
  app.use("/api/vietnam-address", authMiddleware, vietnamAddressRoutes);
  app.use("/api/shopee", authMiddleware, shopeeOrdersRoutes);
  app.use("/api/shopee", authMiddleware, shopeeProductsRoutes);
  // Mount tường minh — tránh 404 khi router interop/MVC miss sau refactor.
  app.post("/api/orders/pull", authMiddleware, pullOrders);
  app.post("/api/orders/quick-sync", authMiddleware, quickSyncOrders);
  app.post("/api/orders/sync-return-requests", authMiddleware, async (req, res) => {
    try {
      const mode = String(req.body?.mode || req.query?.mode || "incremental").toLowerCase() === "full"
        ? "full"
        : "incremental";
      const result = await syncShopeeReturnRequests({ mode });
      return res.json({ success: result.success !== false, ...result });
    } catch (err: any) {
      return res.status(500).json({
        success: false,
        error: "sync_return_requests_failed",
        message: err?.message || String(err),
      });
    }
  });
  app.post("/api/orders/backfill-return-tracking", authMiddleware, async (req, res) => {
    try {
      const limitPerShop = Math.min(80, Math.max(1, Number(req.body?.limitPerShop) || 80));
      const shopId = String(req.body?.shopId || req.query?.shopId || "").trim();
      const force = req.body?.force === true || req.query?.force === "1";
      const result = await backfillMissingReturnTracking30d({
        trigger: "api",
        limitPerShop,
        shopId: shopId || undefined,
        force,
      });
      return res.json({ success: true, ...result });
    } catch (err: any) {
      return res.status(500).json({
        success: false,
        error: "backfill_return_tracking_failed",
        message: err?.message || String(err),
      });
    }
  });
  app.get("/api/orders/return-alerts", authMiddleware, getReturnAlerts);
  app.post("/api/orders/return-alerts-ack", authMiddleware, ackReturnAlertsApi);
  app.post("/api/orders/sync", authMiddleware, syncOrders);
  app.post("/api/sync-shopee", authMiddleware, syncShopee);
  app.get("/api/order-counts", authMiddleware, getOrderCounts);
  app.get("/api/orders/counter", authMiddleware, getOrderCounts);
  app.get("/api/orders/counts", authMiddleware, getOrderCounts);
  app.post("/api/orders/update-print-status", authMiddleware, updatePrintStatus);
  app.post("/api/orders/reset-print-status", authMiddleware, resetPrintStatus);
  app.post("/api/orders/mark-printed", authMiddleware, markPrinted);
  app.post("/api/shopee/orders/sync", authMiddleware, syncOrders);
  app.post("/api/shopee/orders/pull", authMiddleware, pullOrders);
  app.post("/api/shopee/orders/quick-sync", authMiddleware, quickSyncOrders);
  app.post("/api/shopee/products/item-preview", authMiddleware, previewItemVariants);
  app.get("/api/shopee/products/item-preview", authMiddleware, previewItemVariants);
  app.post("/api/products/shopee-item-preview", authMiddleware, previewItemVariants);
  app.get("/api/products/shopee-item-preview", authMiddleware, previewItemVariants);
  app.post("/api/shopee/products/sync-item-variants", authMiddleware, syncItemVariants);
  app.post("/api/shopee/products/sync", authMiddleware, syncProducts);

  // --- WooCommerce orders sync -----------------------------------------------
  initWooCommerceOrdersController({
    loadChannelSettings,
    isMongoReady,
    persistWooOrdersToStore: async (orders: any[]) => {
      if (!Array.isArray(orders) || orders.length === 0) return 0;
      if (!isMongoReady()) throw new Error("mongodb_not_ready");
      const n = await bulkUpsertOrdersToStore(orders);
      try {
        queueOrdersJsonMirrorFromMongo();
      } catch {
        /* optional mirror */
      }
      try {
        invalidateOrdersRefreshCache();
      } catch {
        /* optional cache */
      }
      return n;
    },
    findOrderByKey: async (key: string) => {
      const k = String(key || "").trim();
      if (!k) return null;
      try {
        const rows = await loadOrdersForShipScoped(
          [k, k.startsWith("woo-") ? k : `woo-${k}`],
          [k.replace(/^woo-/i, ""), k.startsWith("WOO-") ? k : `WOO-${k.replace(/^woo-/i, "")}`],
        );
        return rows?.[0] || null;
      } catch {
        return null;
      }
    },
    patchOrderInStore: async (key: string, patch: Record<string, unknown>) => {
      const k = String(key || "").trim();
      if (!k) return null;
      try {
        const orders = loadOrders();
        let idx = orders.findIndex(
          (o: any) =>
            String(o.id || "") === k ||
            String(o.orderSn || "") === k ||
            String(o.wooOrderId || "") === k.replace(/^woo-/i, "") ||
            String(o.id || "") === `woo-${k.replace(/^woo-/i, "")}`,
        );
        if (idx < 0) {
          const hit = await loadOrdersForShipScoped(
            [k, k.startsWith("woo-") ? k : `woo-${k}`],
            [k.replace(/^woo-/i, "")],
          );
          if (hit?.[0]) {
            orders.push({ ...hit[0], ...patch });
            idx = orders.length - 1;
          }
        } else {
          orders[idx] = { ...orders[idx], ...patch };
        }
        if (idx >= 0) {
          await persistChangedOrdersPatch([orders[idx]]);
          return orders[idx];
        }
      } catch (err: any) {
        console.warn("[WooCommerce] patchOrderInStore:", err?.message || err);
      }
      return null;
    },
  });
  app.post("/api/woocommerce/orders/sync", authMiddleware, syncWooCommerceOrders);
  app.post("/api/woocommerce/orders/update-status", authMiddleware, updateWooCommerceOrderStatus);
  app.get("/api/woocommerce/test-connection", authMiddleware, testWooCommerceConnectionHandler);

  // --- Shopee logistics: "Chuẩn bị hàng" (ship_order) ------------------------

  async function prewarmShopeeAddressCacheForShip(
    toShip: { index: number; order: any }[],
    shipMethod: ShipMethod,
  ): Promise<void> {
    if (shipMethod !== "pickup") return;
    const shopIds = [
      ...new Set(
        toShip
          .map(({ order }) => String(resolveOrderShopId(order) || order.shopId || "").trim())
          .filter(Boolean),
      ),
    ];
    if (shopIds.length === 0) return;
    await mapWithConcurrency(shopIds, 3, async (shopId) => {
      try {
        const hit = await getCachedShopeeAddressList(shopId);
        if (hit?.result && !hit.result.error) return;
        const accessToken = (await getValidShopeeAccessToken(shopId)) || "";
        if (!accessToken) return;
        await getShopeeAddressListCached(shopId, accessToken);
      } catch (err: any) {
        console.warn(`[Ship Order Bulk] prewarm address_list shop=${shopId}:`, err?.message || err);
      }
    });
  }

  async function processShipOrderBatch(
    orders: any[],
    toShip: { index: number; order: any }[],
    shipMethod: ShipMethod,
    opts?: {
      optimistic?: boolean;
      onProgress?: (completed: number, total: number) => void;
    }
  ): Promise<{
    results: any[];
    successfulShopeeOrders: any[];
    successCount: number;
    failedCount: number;
    failedOrders: { orderSn: string; orderId: string; error: string; message: string }[];
  }> {
    const results: any[] = new Array(toShip.length);
    const successfulShopeeOrders: any[] = [];
    const failedOrders: { orderSn: string; orderId: string; error: string; message: string }[] = [];
    let completedCount = 0;

    console.log(
      `[Ship Order Bulk] Bắt đầu xác nhận ${toShip.length} đơn — tuần tự for...of (1 process), pause=${SHIP_ORDER_CHUNK_PAUSE_MS}ms timeout=${SHIP_ORDER_OPERATION_TIMEOUT_MS}ms skipRecover=true.`,
    );

    await prewarmShopeeAddressCacheForShip(toShip, shipMethod);

    const processOne = async (item: { index: number; order: any }, i: number) => {
      const { index, order } = item;
      const resolvedShopId = resolveOrderShopId(order);
      if (resolvedShopId) {
        orders[index].shopId = resolvedShopId;
        order.shopId = resolvedShopId;
      }

      console.log(`[Ship Order Bulk] Đang xử lý đơn ${order.orderSn} (id=${order.id}, shopId=${order.shopId || resolvedShopId || "-"}, ${shipMethod})...`);
      let result: Awaited<ReturnType<typeof arrangeShipment>>;
      try {
        result = await withOperationTimeout(
          (signal) => arrangeShipment(order, shipMethod, signal, { skipRecover: true }),
          SHIP_ORDER_OPERATION_TIMEOUT_MS,
          `Ship order ${order.orderSn}`,
        );
      } catch (error: any) {
        console.error(
          `[Ship Order Bulk] Exception khi chuẩn bị đơn ${order.orderSn} (id=${order.id}, method=${shipMethod}):`,
          error?.stack || error,
        );
        result = {
          success: false,
          error: /timeout/i.test(String(error?.message || "")) ? "timeout" : "internal_server_error",
          message:
            "Lỗi nội bộ server: " +
            (error?.message || String(error)) +
            (error?.stack ? ` | ${String(error.stack).slice(0, 240)}` : ""),
        };
      }

      try {
        const treatedAsSuccess = result.success || isAlreadyShippedError(result);
        const pendingTrap = !treatedAsSuccess && isShopeePendingVerificationError(result);

        if (pendingTrap) {
          console.warn(
            `[Ship Order Bulk] Bỏ qua đơn lỗi Shopee ${order.orderSn}: ${result.message || result.error || ""}`,
          );
          // Chỉ cập nhật RAM — persist 1 lần sau cả batch (tránh race saveOrders khi song song).
          orders[index] = markOrderPendingShopeeCheck(
            orders[index],
            result.message || result.error || "Order is pending verification",
          );
          failedOrders.push({
            orderSn: String(order.orderSn || ""),
            orderId: String(order.id || ""),
            error: String(result.error || "pending_verification"),
            message: String(result.message || "Đơn chưa sẵn sàng / Shopee đang kiểm tra"),
          });
        } else if (!treatedAsSuccess) {
          console.error(
            `[Ship Order Bulk] THẤT BẠI đơn ${order.orderSn} -> error="${result.error || ""}" message="${result.message || ""}" — continue`,
          );
          failedOrders.push({
            orderSn: String(order.orderSn || ""),
            orderId: String(order.id || ""),
            error: String(result.error || "ship_order_failed"),
            message: String(result.message || "ship_order failed"),
          });
          if (opts?.optimistic) {
            orders[index] = {
              ...orders[index],
              status: "unprocessed",
              isPrepared: false,
              shopeeSyncPending: false,
              shopeeSyncError: result.message || result.error || "Không đồng bộ được Shopee",
            };
          }
        } else {
          const tn = String(
            order.trackingNumber ||
              order.tracking_no ||
              result.trackingNumber ||
              orders[index].trackingNumber ||
              "",
          ).trim();
          orders[index] = {
            ...orders[index],
            ...order,
            isPrepared: true,
            status: "processed",
            is_pending_shopee_check: false,
            fulfillment_type: shipMethod,
            ship_method: shipMethod,
            trackingNumber: tn || orders[index].trackingNumber,
            tracking_no: tn || orders[index].tracking_no || orders[index].trackingNumber,
            shopId: orders[index].shopId || order.shopId || result.shopId || resolvedShopId,
            shopee_order_status:
              order.shopee_order_status === "READY_TO_SHIP" ||
              order.shopee_order_status === "RETRY_SHIP" ||
              !order.shopee_order_status
                ? "PROCESSED"
                : order.shopee_order_status || orders[index].shopee_order_status || "PROCESSED",
            shopeeSyncPending: false,
            shopeeSyncError: undefined,
          };
          forceHealPickupOrderIfHasTracking(orders[index]);
          // KHÔNG gọi get_tracking_number tại đây — xác nhận xong là xong; in PDF/tracking lo sau.
          if (orders[index].channel === "shopee") {
            successfulShopeeOrders.push(orders[index]);
          }
        }

        results[i] = {
          orderId: order.id,
          orderSn: order.orderSn,
          success: treatedAsSuccess,
          pendingShopeeCheck: pendingTrap,
          alreadyShipped: !result.success && isAlreadyShippedError(result),
          ...result,
        };
      } catch (postErr: any) {
        console.error(
          `[Ship Order Bulk] Lỗi hậu xử lý đơn ${order.orderSn} — continue:`,
          postErr?.stack || postErr,
        );
        failedOrders.push({
          orderSn: String(order.orderSn || ""),
          orderId: String(order.id || ""),
          error: "post_process_error",
          message: String(postErr?.message || postErr),
        });
        results[i] = {
          orderId: order.id,
          orderSn: order.orderSn,
          success: false,
          error: "post_process_error",
          message: String(postErr?.message || postErr),
        };
      }

      completedCount += 1;
      if (opts?.onProgress) opts.onProgress(completedCount, toShip.length);
    };

    // Gom nhóm theo shopId (DB) — xử lý từng shop với đúng token, cho phép xuyên shop.
    const shopGroups = new Map<string, number[]>();
    const missingShopIdx: number[] = [];
    for (let i = 0; i < toShip.length; i++) {
      const order = toShip[i].order;
      const sid = String(resolveOrderShopId(order) || order?.shopId || "").trim();
      if (!sid) {
        missingShopIdx.push(i);
        continue;
      }
      const list = shopGroups.get(sid);
      if (list) list.push(i);
      else shopGroups.set(sid, [i]);
    }
    const runIndices = [...shopGroups.values()].flat().concat(missingShopIdx);
    console.log(
      `[Ship Order Bulk] Gom ${toShip.length} đơn → ${shopGroups.size} nhóm shop` +
        (missingShopIdx.length ? ` (+${missingShopIdx.length} thiếu shopId)` : "") +
        `: [${[...shopGroups.keys()].join(", ")}]`,
    );

    // Tuần tự for...of — CẤM Promise.all / mapWithConcurrency (Rate Limit Shopee + Over Process cPanel).
    for (let k = 0; k < runIndices.length; k++) {
      const i = runIndices[k];
      try {
        await processOne(toShip[i], i);
      } catch (error) {
        console.error("Lỗi 1 đơn (ship batch):", error);
      }
      if (k < runIndices.length - 1 && SHIP_ORDER_CHUNK_PAUSE_MS > 0) {
        await sleep(SHIP_ORDER_CHUNK_PAUSE_MS);
      }
    }

    const compactResults = results.filter(Boolean);
    const successCount = compactResults.filter((r) => r.success).length;
    console.log(
      `[Ship Order Bulk] Xác nhận thành công ${successCount} đơn. Bỏ qua ${failedOrders.length} đơn bị lỗi.`,
    );

    // Kick create_shipping_document ngay (fire-and-forget) — overlap với persist/tracking/PDF.
    if (successfulShopeeOrders.length > 0) {
      try {
        fireCreateShippingDocumentsForOrders(successfulShopeeOrders);
      } catch (primeErr: any) {
        console.warn(
          `[Ship Order Bulk] BG prime shipping doc skip:`,
          primeErr?.message || primeErr,
        );
      }
    }

    return {
      results: compactResults,
      successfulShopeeOrders,
      successCount,
      failedCount: failedOrders.length,
      failedOrders,
    };
  }

  /**
   * Confirm & Print: ship song song (concurrency 4) → Batch Waybill Shopee
   * (1 create + poll cả lô ≤10×2.5s + 1 download → 1 PDF). Không merge pdf-lib.
   * Luôn trả HTTP 200 + { success, processed, failed, url }.
   */
  const handleFastProcess = async (req: any, res: any) => {
    const t0 = Date.now();
    beginLogisticsWork("fast-process");
    const processed: Array<{
      orderSn: string;
      orderId: string;
      url?: string;
      filename?: string;
    }> = [];
    const failed: Array<{
      orderSn: string;
      orderId: string;
      error: string;
      message: string;
      shipped?: boolean;
    }> = [];
    const results: any[] = [];

    try {
      const { orderIds, orderSns, order_ids, order_sns, method } = req.body || {};
      const shipMethod: ShipMethod = method === "dropoff" ? "dropoff" : "pickup";
      const idList = [
        ...(Array.isArray(orderIds) ? orderIds : []),
        ...(Array.isArray(order_ids) ? order_ids : []),
      ].map(String);
      const snList = [
        ...(Array.isArray(orderSns) ? orderSns : []),
        ...(Array.isArray(order_sns) ? order_sns : []),
      ].map(String);
      if (idList.length === 0 && snList.length === 0) {
        return res.status(200).json({
          success: true,
          processed: [],
          failed: [{ orderSn: "", orderId: "", error: "missing_ids", message: "Thiếu danh sách orderIds hoặc orderSns." }],
          successCount: 0,
          failCount: 1,
          total: 0,
          results: [],
          url: null,
          message: "Thiếu danh sách orderIds hoặc orderSns.",
        });
      }

      let orders: any[] = [];
      try {
        orders = await loadOrdersForShipScoped(idList, snList);
      } catch (loadErr: any) {
        console.warn("[Fast Process] loadOrdersForShipScoped:", loadErr?.message || loadErr);
      }
      if (!orders.length) {
        try {
          const loaded = await loadOrdersForApi({ readOnly: true });
          const idSet = new Set([...idList, ...snList, ...snList.map((s) => `shopee-${s}`)]);
          orders = (loaded.orders || []).filter(
            (o: any) =>
              idSet.has(String(o.id || "")) ||
              idSet.has(String(o.orderSn || "")) ||
              idSet.has(`shopee-${o.orderSn}`),
          );
        } catch {
          orders = [];
        }
      }
      const toShip = resolveOrdersFromRequest(orders, idList, snList);
      if (toShip.length === 0) {
        return res.status(200).json({
          success: true,
          processed: [],
          failed: [
            {
              orderSn: "",
              orderId: "",
              error: "orders_not_found",
              message: "Không tìm thấy đơn nào trong database khớp với danh sách gửi lên.",
            },
          ],
          successCount: 0,
          failCount: 1,
          total: 0,
          results: [],
          url: null,
          message: "Không tìm thấy đơn nào trong database khớp với danh sách gửi lên.",
        });
      }

      console.log(
        `[Fast Process] BATCH ship tuần tự ${toShip.length} đơn method=${shipMethod} — for...of (1 process/chunk), không Promise.all`,
      );

      await prewarmShopeeAddressCacheForShip(toShip, shipMethod);

      // —— Pha 1: xác nhận TUẦN TỰ (không PDF, không Promise.all) ——
      const shippedEntries: { index: number; order: any; orderSn: string; orderId: string }[] = [];

      for (const { index, order } of toShip) {
        const orderSn = String(order.orderSn || "");
        const orderId = String(order.id || "");
        try {
          const resolvedShopId = resolveOrderShopId(order);
          if (resolvedShopId && !order.shopId) {
            orders[index].shopId = resolvedShopId;
            order.shopId = resolvedShopId;
          }

          console.log(`[Fast Process] Đang xác nhận đơn ${orderSn}...`);
          let shipResult: Awaited<ReturnType<typeof arrangeShipment>>;
          try {
            shipResult = await withOperationTimeout(
              (signal) => arrangeShipment(order, shipMethod, signal, { skipRecover: true }),
              SHIP_ORDER_OPERATION_TIMEOUT_MS,
              `Ship order ${orderSn}`,
            );
          } catch (shipErr: any) {
            shipResult = {
              success: false,
              error: /timeout/i.test(String(shipErr?.message || "")) ? "timeout" : "internal_server_error",
              message: "Lỗi nội bộ server: " + (shipErr?.message || String(shipErr)),
            };
          }

          const treatedAsSuccess = shipResult.success || isAlreadyShippedError(shipResult);
          const pendingTrap = !treatedAsSuccess && isShopeePendingVerificationError(shipResult);

          if (pendingTrap) {
            orders[index] = markOrderPendingShopeeCheck(
              orders[index],
              shipResult.message || shipResult.error || "Order is pending verification",
            );
            failed.push({
              orderSn,
              orderId,
              error: String(shipResult.error || "pending_verification"),
              message: String(shipResult.message || "Đơn chưa sẵn sàng / Shopee đang kiểm tra"),
            });
            results.push({
              orderId,
              orderSn,
              success: false,
              pendingShopeeCheck: true,
              ...shipResult,
            });
            continue;
          }

          if (!treatedAsSuccess) {
            failed.push({
              orderSn,
              orderId,
              error: String(shipResult.error || "ship_order_failed"),
              message: String(shipResult.message || "ship_order failed"),
            });
            results.push({ orderId, orderSn, success: false, ...shipResult });
            continue;
          }

          const tn = String(
            order.trackingNumber ||
              order.tracking_no ||
              shipResult.trackingNumber ||
              orders[index].trackingNumber ||
              "",
          ).trim();
          orders[index] = {
            ...orders[index],
            ...order,
            isPrepared: true,
            status: "processed",
            is_pending_shopee_check: false,
            fulfillment_type: shipMethod,
            ship_method: shipMethod,
            trackingNumber: tn || orders[index].trackingNumber,
            tracking_no: tn || orders[index].tracking_no || orders[index].trackingNumber,
            shopId: orders[index].shopId || order.shopId || shipResult.shopId || resolvedShopId,
            shopee_order_status:
              order.shopee_order_status === "READY_TO_SHIP" ||
              order.shopee_order_status === "RETRY_SHIP" ||
              !order.shopee_order_status
                ? "PROCESSED"
                : order.shopee_order_status || orders[index].shopee_order_status || "PROCESSED",
            shopeeSyncPending: false,
            shopeeSyncError: undefined,
          };
          forceHealPickupOrderIfHasTracking(orders[index]);
          results.push({
            orderId,
            orderSn,
            success: true,
            alreadyShipped: !shipResult.success && isAlreadyShippedError(shipResult),
            ...shipResult,
          });
          shippedEntries.push({ index, order: orders[index], orderSn, orderId });
        } catch (orderErr: any) {
          console.error(`[Fast Process] Lỗi đơn ${orderSn}:`, orderErr?.stack || orderErr);
          failed.push({
            orderSn,
            orderId,
            error: "order_process_error",
            message: String(orderErr?.message || orderErr),
          });
          results.push({
            orderId,
            orderSn,
            success: false,
            error: "order_process_error",
            message: String(orderErr?.message || orderErr),
          });
        }
        if (SHIP_ORDER_CHUNK_PAUSE_MS > 0) {
          await sleep(SHIP_ORDER_CHUNK_PAUSE_MS);
        }
      }

      // Persist ship sớm — không chờ PDF.
      const mongoPatchesShip = toShip
        .map(({ index, order }) => {
          const p = orders[index] || order;
          return {
            orderSn: String(p.orderSn || order.orderSn || ""),
            shopId: p.shopId ? String(p.shopId) : undefined,
            status: p.status,
            shopee_order_status: p.shopee_order_status,
            ship_method: p.ship_method || shipMethod,
            fulfillment_type: p.fulfillment_type || shipMethod,
            tracking_no: String(p.tracking_no || p.trackingNumber || "").trim() || undefined,
            isPrepared: Boolean(p.isPrepared),
            isPrinted: Boolean(p.isPrinted),
            labelUrl: p.labelUrl || undefined,
            pdfFilename: p.pdfFilename || undefined,
            shopeeSyncPending: Boolean(p.shopeeSyncPending),
            shopeeSyncError: p.shopeeSyncError != null ? String(p.shopeeSyncError) : null,
          };
        })
        .filter((p) => p.orderSn);

      const confirmedRows = toShip
        .map(({ index }) => orders[index])
        .filter((o: any) => o && o.isPrepared === true);
      try {
        await persistConfirmedShipOrdersToMongo(confirmedRows, shipMethod);
      } catch (persistErr: any) {
        console.warn("[Fast Process] persistConfirmedShipOrdersToMongo:", persistErr?.message || persistErr);
      }

      setImmediate(() => {
        void bulkUpdateShippedOrdersBySn(mongoPatchesShip).catch(async (err: any) => {
          console.warn("[Fast Process] bulkUpdateShippedOrdersBySn:", err?.message || err);
          try {
            const changed = toShip.map(({ index }) => orders[index]).filter(Boolean);
            await persistOrdersToDatabase(orders, changed);
          } catch (err2: any) {
            console.warn("[Fast Process] persistOrdersToDatabase fallback:", err2?.message || err2);
          }
        });
        void syncConfirmedOrdersFromShopee(confirmedRows, shipMethod).catch((err: any) => {
          console.warn("[Fast Process] background sync failed:", err?.message || err);
        });
      });

      const shipFailed = failed;
      const successCount = results.filter((r) => r?.success).length;
      const elapsed = Date.now() - t0;
      let message = `Thành công: ${successCount} đơn. Thất bại: ${shipFailed.length} đơn`;
      if (successCount > 0) message += ` — sẵn sàng chuyển sang tab tải PDF`;
      message += ` (${elapsed}ms).`;

      console.log(
        `[Fast Process] Done ship=${successCount}/${toShip.length} shipFail=${shipFailed.length} ${elapsed}ms (không chờ PDF)`,
      );

      return res.status(200).json({
        success: true,
        processed: [],
        failed: shipFailed,
        total: toShip.length,
        successCount,
        failCount: shipFailed.length,
        failedCount: shipFailed.length,
        failedOrders: shipFailed,
        failedOrderDetails: shipFailed,
        printSkipped: [],
        successfulOrderIds: results
          .filter((r) => r?.success)
          .map((r) => String(r.orderId || r.orderSn || ""))
          .filter(Boolean),
        results,
        url: null,
        mergedUrl: null,
        urls: [],
        pdfFilename: null,
        printDocument: null,
        message,
        elapsedMs: elapsed,
      });

    } catch (error: any) {
      console.error("[Fast Process] Lỗi nội bộ (graceful 200):", error?.stack || error);
      return res.status(200).json({
        success: true,
        processed: processed.map(({ orderSn, orderId, url, filename }) => ({
          orderSn,
          orderId,
          url: url || null,
          filename: filename || null,
        })),
        failed: [
          ...failed,
          {
            orderSn: "",
            orderId: "",
            error: "internal_server_error",
            message: "Lỗi nội bộ server: " + (error?.message || String(error)),
          },
        ],
        successCount: results.filter((r) => r?.success).length,
        failCount: failed.length + 1,
        failedCount: failed.length + 1,
        failedOrders: failed,
        results,
        url: null,
        message: "Lỗi nội bộ server: " + (error?.message || String(error)),
        elapsedMs: Date.now() - t0,
      });
    } finally {
      endLogisticsWork("fast-process");
    }
  };

  // Bulk: arrange shipment ONLY ("Xác nhận Chuẩn bị hàng loạt").
  // KHÔNG tạo/fetch PDF tại đây — user in thủ công bằng nút "In đơn" sau.
  const handleShipBulk = async (req: any, res: any) => {
    beginLogisticsWork("ship-bulk");
    try {
    const { orderIds, orderSns, order_ids, order_sns, method } = req.body;
    const shipMethod: ShipMethod = method === "dropoff" ? "dropoff" : "pickup";
    const idList = [
      ...(Array.isArray(orderIds) ? orderIds : []),
      ...(Array.isArray(order_ids) ? order_ids : []),
    ].map(String);
    const snList = [
      ...(Array.isArray(orderSns) ? orderSns : []),
      ...(Array.isArray(order_sns) ? order_sns : []),
    ].map(String);
    if (idList.length === 0 && snList.length === 0) {
      return res.status(400).json({ error: "Thi\u1EBFu danh s\xE1ch orderIds ho\u1EB7c orderSns." });
    }

    // Cùng nguồn GET /api/orders (JSON ∪ Mongo) — tránh 404 lệch ID khi đơn chỉ có trên Mongo.
    const loaded = await loadOrdersForApi();
    const orders = loaded.orders;
    const toShip = resolveOrdersFromRequest(orders, idList, snList);
    if (toShip.length === 0) {
      console.error(
        `[Ship Order Bulk] orders_not_found ids=${JSON.stringify(idList)} sns=${JSON.stringify(snList)} pool=${orders.length}`,
      );
      return res.status(404).json({
        error: "orders_not_found",
        message: "Kh\xF4ng t\xECm th\u1EA5y \u0111\u01A1n n\xE0o trong database kh\u1EDBp v\u1EDBi danh s\xE1ch g\u1EEDi l\xEAn.",
        successCount: 0,
        total: 0,
        results: [],
        orders: orders.filter(isValidOrder),
      });
    }

    const results: any[] = [];

    const batch = await processShipOrderBatch(orders, toShip, shipMethod);
    results.push(...batch.results);

    const changedOrders = toShip.map(({ index }) => orders[index]).filter(Boolean);
    await persistOrdersToDatabase(orders, changedOrders);
    const confirmedRows = changedOrders.filter((o: any) => o && o.isPrepared === true);
    await persistConfirmedShipOrdersToMongo(confirmedRows, shipMethod);
    setImmediate(() => {
      void syncConfirmedOrdersFromShopee(confirmedRows, shipMethod).catch((err: any) => {
        console.warn("[Ship Order Bulk] background sync failed:", err?.message || err);
      });
    });
    const successCount = batch.successCount;
    console.log(`[Ship Order Bulk] Ho\xE0n t\u1EA5t: ${successCount}/${toShip.length} \u0111\u01A1n chu\u1EA9n b\u1EB1 h\xE0ng th\xE0nh c\xF4ng (không tạo PDF).`);

    console.log("D\u1EEE LI\u1EC6U SHOPEE TR\u1EA2 V\u1EC0 (ship-order/bulk response g\u1EEDi cho Frontend):", JSON.stringify({ successCount, total: toShip.length, results }));
    const failedResults = results.filter(r => !r.success);
    if (failedResults.length > 0) {
      console.error(`[Ship Order Bulk] ${failedResults.length} \u0111\u01A1n L\u1ED6I chi ti\u1EBFt:`);
      for (const f of failedResults) {
        console.error(`   - \u0111\u01A1n ${f.orderSn || f.orderId}: error="${f.error || ""}" message="${f.message || ""}"`);
      }
    }

    const failedCount = batch.failedCount || results.filter((r) => !r.success).length;
    const summary = buildShipConfirmSummaryPayload(toShip.length, {
      successCount,
      failedCount,
      failedOrders: batch.failedOrders || [],
      results,
    });
    let message = `Thành công: ${summary.successCount} đơn. Thất bại: ${summary.failCount} đơn`;
    if (summary.failedOrderDetails.length > 0) {
      const ids = summary.failedOrderDetails.map((f) => f.orderSn || f.orderId).filter(Boolean);
      if (ids.length) message += ` — Mã: ${ids.join(", ")}`;
    }
    message += ".";

    return res.json({
      ...summary,
      failedCount: summary.failCount,
      failedOrders: summary.failedOrderDetails,
      results,
      orders: orders.filter(isValidOrder),
      printDocument: null,
      message,
    });
    } catch (error: any) {
      console.error("[Ship Order Bulk] Lỗi nội bộ endpoint /api/shopee/ship-order/bulk:", error?.stack || error);
      return res.status(500).json({ success: false, message: "Lỗi nội bộ server: " + error.message });
    } finally {
      endLogisticsWork("ship-bulk");
    }
  };

  // --- Shopee logistics: "In đơn hàng" (create + poll + download AWB PDF) ---

  const LABEL_DOWNLOAD_CONCURRENCY = 3;

  // PDF vận đơn: RAM + storage/labels + GET /api/public/labels (chuẩn).

  function extensionForContentType(contentType: string): string {
    if (contentType.includes("zip")) return "zip";
    if (contentType.includes("html")) return "html";
    return "pdf";
  }

  // Batch Print A4: 1 đơn = order_SN.pdf; nhiều đơn = Danh_Sach_Van_Don_N_ThoiGian.pdf
  function buildMergedLabelFilename(orderSns: string[]): string {
    return buildCachedLabelFilename(orderSns);
  }

  /** Ghép nhiều PDF vận đơn thành 1 file — mỗi nguồn giữ nguyên trang A4. */
  async function mergePdfLabelBuffers(buffers: Buffer[]): Promise<Buffer> {
    const valid = buffers.filter((b) => b && Buffer.isBuffer(b) && b.length > 0 && isPdfBuffer(b));
    if (valid.length === 0) {
      throw new Error("Không có buffer PDF hợp lệ để ghép.");
    }
    if (valid.length === 1) return valid[0];
    const merged = await PDFDocument.create();
    for (const buf of valid) {
      const src = await PDFDocument.load(buf, { ignoreEncryption: true });
      const pages = await merged.copyPages(src, src.getPageIndices());
      for (const page of pages) merged.addPage(page);
    }
    const bytes = await merged.save();
    return Buffer.from(bytes);
  }

  function findExistingLabelFile(orderSn: string): string | null {
    const sn = String(orderSn || "").replace(/[^a-zA-Z0-9_-]/g, "");
    if (!sn) return null;
    const canonical = buildCachedLabelFilename([sn]);
    const canonicalMem = labelMemCache.get(canonical);
    if (
      canonicalMem?.buf?.length &&
      canonicalMem.expires >= Date.now() &&
      isPdfBuffer(canonicalMem.buf)
    ) {
      return canonical;
    }
    if (getValidLabelDiskFile(canonical)) return canonical;
    const nameMatches = (name: string) =>
      /\.pdf$/i.test(name) &&
      (name === `${sn}.pdf` ||
        name === canonical ||
        name.startsWith(`${sn}_`) ||
        name.startsWith(`order_${sn}_`));

    // Ưu tiên RAM (PDF vừa prepare nền có thể chưa kịp ghi đĩa).
    try {
      let bestRam: { name: string; expires: number } | null = null;
      for (const [name, val] of labelMemCache) {
        if (!nameMatches(name) || !val?.buf?.length || !isPdfBuffer(val.buf)) continue;
        if (val.expires < Date.now()) continue;
        if (!bestRam || val.expires > bestRam.expires) bestRam = { name, expires: val.expires };
      }
      if (bestRam) return bestRam.name;
    } catch {
      /* ignore */
    }

    try {
      ensureLabelsDir();
      const matches = fs
        .readdirSync(PDF_DIR)
        .filter((name) => nameMatches(name))
        .map((name) => {
          const full = path.join(PDF_DIR, name);
          const stat = fs.statSync(full);
          return { name, mtime: stat.mtimeMs, size: stat.size };
        })
        .filter((x) => x.size > 0)
        .sort((a, b) => b.mtime - a.mtime);
      const newest = matches[0]?.name;
      if (!newest) return null;
      return getValidLabelDiskFile(newest) ? newest : null;
    } catch {
      return null;
    }
  }

  /** Lưu PDF vào storage/labels + RAM. Tuyệt đối không ghi/trả file rỗng. */
  function saveLabelFile(buffer: Buffer, filename: string, contentType?: string): string {
    try {
      if (!buffer || !Buffer.isBuffer(buffer) || buffer.length === 0) {
        throw new Error(`Buffer PDF rỗng — bỏ qua ghi ${filename}`);
      }
      const saved = putLabelMem(filename, buffer, contentType);
      assertLabelFileReady(saved);
      return saved;
    } catch (err: any) {
      console.error(
        `[Shopee Print] Từ chối lưu PDF — ${filename}: ${err?.message || err}, size=${buffer?.length || 0}, type=${contentType || ""}`,
      );
      throw err;
    }
  }

  function saveLabelFileAsync(buffer: Buffer, filename: string, contentType?: string): void {
    try {
      saveLabelFile(buffer, filename, contentType);
    } catch (err) {
      console.warn(`[Shopee Print] Lưu PDF thất bại ${filename}:`, err);
    }
  }

  /**
   * Batch Print Shopee V2: 1× create_shipping_document → poll get_shipping_document_result (2s)
   * → 1× download_shipping_document = 1 PDF Shopee đã ghép sẵn. Không pdf-lib.
   */
  async function generateShopeeShippingDocument(
    shopId: string,
    orderList: ShopeeWaybillOrderRow[],
  ) {
    const requestedSns = orderList.map((o) => String(o.order_sn || "").trim()).filter(Boolean);
    const expectedFilename = buildMergedLabelFilename(requestedSns);
    const cached = getValidLabelDiskFile(expectedFilename);
    if (cached) {
      const url = absoluteLabelUrl(`/api/public/labels/${cached.safe}`);
      console.log(`[Shopee Print] Cache HIT n=${requestedSns.length} file=${cached.safe}`);
      return {
        success: true,
        filename: cached.safe,
        contentType: "application/pdf",
        orderSns: requestedSns,
        skippedOrders: [],
        size: cached.size,
        url,
        cached: true,
      };
    }

    const batch = await batchDownloadShopeeWaybillPdf(shopId, orderList);
    if (!batch.success || !batch.filename || !batch.filePath || !batch.size) {
      const rawErr = String(batch.error || "document_generation_failed");
      const hardError =
        rawErr === "order_not_found"
          ? "order_not_found"
          : rawErr === "fatal_error" ||
              rawErr === "package_should_print_first" ||
              /timeout/i.test(rawErr)
            ? "fatal_error"
            : rawErr;
      return {
        success: false,
        error: hardError,
        message:
          hardError === "fatal_error"
            ? "Shopee từ chối tạo file. Vui lòng kiểm tra lại trạng thái đơn trên Shopee."
            : batch.message || "Shopee batch print thất bại",
        skippedOrders: batch.skippedOrders || [],
        permanent: true,
      };
    }
    const orderSns = batch.readyOrderSns?.length
      ? batch.readyOrderSns
      : orderList.map((o) => o.order_sn);
    const filename = batch.filename;
    assertLabelFileReady(filename);
    const url = absoluteLabelUrl(`/api/public/labels/${filename}`);
    if (!url) {
      return {
        success: false,
        error: "empty_label_url",
        message: "Không tạo được URL sau khi lưu PDF batch",
        skippedOrders: batch.skippedOrders || [],
      };
    }
    console.log(
      `[Shopee Print] Batch PDF OK n=${orderSns.length} size=${batch.size} file=${filename}`,
    );
    return {
      success: true,
      filename,
      contentType: batch.contentType || "application/pdf",
      orderSns,
      skippedOrders: batch.skippedOrders || [],
      size: batch.size,
      url,
    };
  }

  // Shared helper: sau ship_order — chỉ prime create (không poll READY trong request).
  async function autoPrintLabelsForShopeeOrders(allOrders: any[], shopeeOrders: any[]) {
    const candidates = shopeeOrders.filter((o: any) => o.channel === "shopee" && (o.shopId || resolveOrderShopId(o)));
    if (candidates.length === 0) return null;

    for (const o of candidates) {
      if (!o.shopId) {
        const resolved = resolveOrderShopId(o);
        if (resolved) {
          o.shopId = resolved;
          const idx = allOrders.findIndex((x: any) => x.orderSn === o.orderSn);
          if (idx >= 0) allOrders[idx].shopId = resolved;
        }
      }
    }

    fireCreateShippingDocumentsForOrders(
      candidates.map((o: any) => ({
        order: o,
        shopId: String(o.shopId || ""),
        orderSn: String(o.orderSn || ""),
        packageNumber: String(o.packageNumber || "").trim() || undefined,
        trackingNumber: trackingForShopeeShippingDoc(o) || undefined,
      })),
    );
    return {
      url: null,
      printedOrderSns: [],
      skippedOrders: [],
      message: "Đã enqueue chuẩn bị PDF nền (download + lưu labels) — In đơn chỉ đọc kho nội bộ.",
    };
  }

  /**
   * Legacy create/status — chuyển sang in LOCAL (không gọi Shopee khi user bấm In).
   */
  async function printBatchCreateHandler(req: any, res: any) {
    return printChunkHandler(req, res);
  }

  async function printBatchStatusHandler(req: any, res: any) {
    // FE cũ poll status — trả READY nếu đã có PDF local theo task/order trong body.
    beginLogisticsWork("print-batch-status-local");
    try {
      const taskId = String(req.body?.task_id || req.query?.task_id || "").trim();
      const orderIds = req.body?.order_ids ?? req.body?.orderIds ?? [];
      if (Array.isArray(orderIds) && orderIds.length > 0) {
        return printChunkHandler(req, res);
      }
      return res.status(404).json({
        success: false,
        error: "task_not_found",
        status: "FAILED",
        message:
          taskId
            ? "Task in cũ không còn — dùng In đơn (PDF nội bộ)."
            : "Thiếu order_ids. In đơn chỉ đọc PDF đã lưu nội bộ.",
      });
    } finally {
      endLogisticsWork("print-batch-status-local");
    }
  }

  /**
   * In đơn LOCAL: chỉ đọc Mongo + PDF đã lưu tại storage/labels.
   * Tuyệt đối KHÔNG gọi Shopee create/download khi user bấm In.
   * Thiếu PDF → enqueue background prepare, trả lỗi rõ (không treo chờ sàn).
   */
  function resolveLocalLabelForOrder(order: any): { url: string; pdfFilename: string; orderSn: string; orderId: string } | null {
    const orderSn = String(order?.orderSn || "")
      .replace(/^shopee-/i, "")
      .trim();
    const orderId = String(order?.id || (orderSn ? `shopee-${orderSn}` : "")).trim();
    if (!orderSn) return null;

    const tryFilename = (raw: string): { url: string; pdfFilename: string } | null => {
      const fn = String(raw || "").trim();
      const safe = safeLabelFilename(fn) || safeLabelFilename(decodeURIComponent(fn));
      if (!safe || !hasLabelMem(safe)) return null;
      const url = absoluteLabelUrl(`/api/public/labels/${safe}`);
      return url ? { url, pdfFilename: safe } : null;
    };

    const metaFn = String(
      order?.pdfFilename || order?.data?.pdfFilename || "",
    ).trim();
    const fromMeta = tryFilename(metaFn);
    if (fromMeta) {
      return { ...fromMeta, orderSn, orderId };
    }

    const labelUrl = String(
      order?.labelUrl ||
        order?.pdfUrl ||
        order?.waybill_url ||
        order?.data?.labelUrl ||
        order?.data?.pdfUrl ||
        order?.data?.waybill_url ||
        "",
    ).trim();
    const m = labelUrl.match(/\/api\/public\/labels\/([^/?#]+)/i);
    if (m?.[1]) {
      const fromUrl = tryFilename(m[1]);
      if (fromUrl) return { ...fromUrl, orderSn, orderId };
    }

    const existing = findExistingLabelFile(orderSn);
    if (existing) {
      const fromDisk = tryFilename(existing);
      if (fromDisk) return { ...fromDisk, orderSn, orderId };
    }
    return null;
  }

  async function printChunkHandler(req: any, res: any) {
    beginLogisticsWork("print-chunk-local");
    const t0 = Date.now();
    const requestAbortController = new AbortController();
    const abortOnClientDisconnect = () =>
      requestAbortController.abort(new Error("client_disconnected"));
    req.once("aborted", abortOnClientDisconnect);
    try {
      const rawIds = req.body?.order_ids ?? req.body?.orderIds ?? [];
      if (!Array.isArray(rawIds) || rawIds.length === 0) {
        return res.status(400).json({
          success: false,
          error: "missing_order_ids",
          message: "Thiếu danh sách order_ids.",
          urls: [],
          documents: [],
        });
      }

      const idList = [...new Set(rawIds.map((id: any) => String(id || "").trim()).filter(Boolean))];
      const snList = idList.map((id) => id.replace(/^shopee-/i, "").trim()).filter(Boolean);
      console.log(`[Print Local] order_ids=${idList.join(",")} n=${idList.length}`);

      let orders: any[] = [];
      try {
        orders = await loadOrdersForShipScoped(idList, snList);
      } catch (loadErr: any) {
        console.warn("[Print Local] loadOrdersForShipScoped:", loadErr?.message || loadErr);
      }
      if (!orders.length && isMongoReady()) {
        try {
          const loaded = await loadOrdersForApi({ readOnly: true });
          const idSet = new Set(idList);
          orders = (loaded.orders || []).filter(
            (o: any) =>
              idSet.has(String(o.id || "")) ||
              idSet.has(String(o.orderSn || "")) ||
              idSet.has(`shopee-${o.orderSn}`),
          );
        } catch (apiErr: any) {
          console.warn("[Print Local] loadOrdersForApi:", apiErr?.message || apiErr);
        }
      }
      if (!orders.length) {
        const legacy = loadOrders();
        const idSet = new Set(idList);
        orders = legacy.filter(
          (o: any) =>
            idSet.has(String(o.id || "")) ||
            idSet.has(String(o.orderSn || "")) ||
            idSet.has(`shopee-${o.orderSn}`),
        );
      }

      const documents: Array<{
        url?: string;
        pdfFilename?: string;
        orderSn?: string;
        orderSns?: string[];
        orderId?: string;
        error?: string;
        message?: string;
      }> = [];
      const results: any[] = [];
      const urls: string[] = [];
      const missingOrders: any[] = [];

      const byKey = new Map<string, any>();
      for (const o of orders) {
        const sn = String(o.orderSn || "").replace(/^shopee-/i, "").trim();
        const id = String(o.id || "").trim();
        if (id) byKey.set(id, o);
        if (sn) {
          byKey.set(sn, o);
          byKey.set(`shopee-${sn}`, o);
        }
      }

      for (const rawId of idList) {
        const order = byKey.get(rawId) || byKey.get(rawId.replace(/^shopee-/i, ""));
        const orderSn = String(order?.orderSn || rawId.replace(/^shopee-/i, "")).trim();
        const orderId = String(order?.id || rawId).trim();
        if (!order) {
          documents.push({
            orderSn,
            orderId,
            orderSns: [orderSn],
            error: "order_not_found",
            message: "Không tìm thấy đơn trong DB nội bộ.",
          });
          results.push({
            orderId,
            orderSn,
            success: false,
            error: "order_not_found",
            message: "Không tìm thấy đơn trong DB nội bộ.",
          });
          continue;
        }

        const local = resolveLocalLabelForOrder(order);
        if (!local) {
          missingOrders.push(order);
          documents.push({
            orderSn,
            orderId,
            orderSns: [orderSn],
            error: "label_not_ready",
            message:
              "Đang tải file in từ sàn, vui lòng thử lại sau vài giây...",
          });
          results.push({
            orderId,
            orderSn,
            success: false,
            error: "label_not_ready",
            message:
              "Đang tải file in từ sàn, vui lòng thử lại sau vài giây...",
          });
          continue;
        }

        if (!urls.includes(local.url)) urls.push(local.url);
        documents.push({
          url: local.url,
          pdfFilename: local.pdfFilename,
          orderSn: local.orderSn,
          orderId: local.orderId,
          orderSns: [local.orderSn],
        });
        results.push({
          orderId: local.orderId,
          orderSn: local.orderSn,
          success: true,
          url: local.url,
          pdfFilename: local.pdfFilename,
        });
      }

      if (missingOrders.length > 0) {
        try {
          const missingSns = missingOrders
            .map((order) => String(order?.orderSn || order?.order_sn || "").replace(/^shopee-/i, "").trim())
            .filter(Boolean);
          const fallbackDeadlineAt = Date.now() + PRINT_CHUNK_FALLBACK_DEADLINE_MS;
          console.log(
            `[Print Local] Cache thiếu ${missingSns.length} file — polling Shopee và tải trực tiếp trước khi trả response`,
          );
          const fallback = await fetchBatchPdfDocumentsByShop(
            orders,
            missingSns,
            fallbackDeadlineAt,
            "Print Local Direct Fallback",
            { signal: requestAbortController.signal },
          );
          const failureBySn = new Map(fallback.failedOrders.map((item) => [item.orderSn, item]));

          for (const downloaded of fallback.documents) {
            for (const orderSn of downloaded.orderSns) {
              const filename = buildCachedLabelFilename([orderSn]);
              const cached = await getValidLabelDiskFileAsync(filename);
              if (!cached) {
                failureBySn.set(orderSn, {
                  orderSn,
                  error: "invalid_pdf",
                  message: "Shopee đã trả dữ liệu nhưng file PDF lưu xuống ổ cứng không hợp lệ.",
                });
                continue;
              }
              const url = absoluteLabelUrl(`/api/public/labels/${encodeURIComponent(filename)}`);
              if (!url) {
                failureBySn.set(orderSn, {
                  orderSn,
                  error: "label_url_failed",
                  message: "Đã tải PDF nhưng không tạo được URL file in.",
                });
                continue;
              }
              if (!urls.includes(url)) urls.push(url);
              const documentIndex = documents.findIndex((item) => item.orderSn === orderSn);
              const resultIndex = results.findIndex((item) => item.orderSn === orderSn);
              const order = missingOrders.find(
                (item) =>
                  String(item?.orderSn || item?.order_sn || "").replace(/^shopee-/i, "").trim() === orderSn,
              );
              const orderId = String(order?.id || `shopee-${orderSn}`);
              const readyDocument = {
                url,
                pdfFilename: filename,
                orderSn,
                orderId,
                orderSns: [orderSn],
              };
              const readyResult = {
                orderId,
                orderSn,
                success: true,
                url,
                pdfFilename: filename,
              };
              if (documentIndex >= 0) documents[documentIndex] = readyDocument;
              else documents.push(readyDocument);
              if (resultIndex >= 0) results[resultIndex] = readyResult;
              else results.push(readyResult);
              failureBySn.delete(orderSn);
            }
          }

          for (const orderSn of missingSns) {
            const failure = failureBySn.get(orderSn);
            if (!failure) continue;
            const documentIndex = documents.findIndex((item) => item.orderSn === orderSn);
            const resultIndex = results.findIndex((item) => item.orderSn === orderSn);
            if (documentIndex >= 0) {
              documents[documentIndex] = { ...documents[documentIndex], ...failure };
            }
            if (resultIndex >= 0) {
              results[resultIndex] = { ...results[resultIndex], success: false, ...failure };
            }
          }
        } catch (fallbackErr: any) {
          console.error("[Print Local] direct fallback:", fallbackErr?.stack || fallbackErr);
          const fallbackMessage = String(
            fallbackErr?.message || "Shopee không thể tạo hoặc tải PDF sau khi polling.",
          );
          for (const order of missingOrders) {
            const orderSn = String(order?.orderSn || order?.order_sn || "")
              .replace(/^shopee-/i, "")
              .trim();
            const documentIndex = documents.findIndex((item) => item.orderSn === orderSn);
            const resultIndex = results.findIndex((item) => item.orderSn === orderSn);
            if (documentIndex >= 0) {
              documents[documentIndex] = {
                ...documents[documentIndex],
                error: "direct_download_failed",
                message: fallbackMessage,
              };
            }
            if (resultIndex >= 0) {
              results[resultIndex] = {
                ...results[resultIndex],
                success: false,
                error: "direct_download_failed",
                message: fallbackMessage,
              };
            }
          }
        }
      }

      const successCount = results.filter((r) => r.success).length;
      const failCount = results.length - successCount;
      const elapsed = Date.now() - t0;
      const firstFail = results.find((r) => !r.success);
      // Top-level error BẮT BUỘC khi fail hết — tránh FE mặc định label_not_ready rồi auto-retry Create.
      const topError =
        successCount > 0
          ? undefined
          : String(firstFail?.error || "").trim() === "label_not_ready" ||
              String(firstFail?.error || "").trim() === "package_should_print_first" ||
              /timeout/i.test(String(firstFail?.error || ""))
            ? "fatal_error"
            : String(firstFail?.error || "fatal_error").trim() || "fatal_error";
      const topMessage =
        topError === "fatal_error"
          ? "Shopee từ chối tạo file. Vui lòng kiểm tra lại trạng thái đơn trên Shopee."
          : undefined;
      const failureMessage = [
        ...new Set(
          results
            .filter((r) => !r.success)
            .map((r) => String(r.message || r.error || "").trim())
            .filter(Boolean),
        ),
      ].join("; ");
      const message =
        successCount > 0 && failCount === 0
          ? `Đã tải và chuẩn bị ${successCount} PDF (${elapsed}ms).`
          : successCount > 0
            ? `Đã chuẩn bị ${successCount}/${results.length} PDF. ${failCount} đơn lỗi: ${failureMessage}`
            : topMessage ||
              failureMessage ||
              "Shopee không thể tạo hoặc tải PDF sau khi đã polling hết số lần cho phép.";

      console.log(
        `[Print Local] Done ok=${successCount} fail=${failCount} missing=${missingOrders.length} ${elapsed}ms`,
      );

      // User bấm In thành công → isPrinted=true (khác hasPdf từ BG worker).
      if (successCount > 0) {
        const okSns = results.filter((r) => r.success).map((r) => String(r.orderSn || "")).filter(Boolean);
        const firstDoc = documents.find((d) => d.url && d.pdfFilename);
        setImmediate(() => {
          void markOrdersPrintedInStore(okSns, true, {
            labelUrl: firstDoc?.url,
            waybill_url: firstDoc?.url,
            pdfFilename: firstDoc?.pdfFilename,
          }).catch(() => {});
        });
      }

      return res.status(successCount > 0 ? 200 : 422).json({
        success: successCount > 0,
        ...(successCount === 0 ? { error: topError, permanent: true } : {}),
        urls,
        url: urls[0] || null,
        mergedUrl: urls[0] || null,
        pdfFilename: documents.find((d) => d.pdfFilename)?.pdfFilename,
        documents,
        results,
        successCount,
        failCount,
        total: idList.length,
        message,
        elapsedMs: elapsed,
        local_only: false,
        preparing: [],
      });
    } catch (err: any) {
      console.error("[Print Local] fatal:", err?.stack || err);
      return res.status(500).json({
        success: false,
        error: "fatal_error",
        message: "Shopee từ chối tạo file. Vui lòng kiểm tra lại trạng thái đơn trên Shopee.",
        urls: [],
        documents: [],
      });
    } finally {
      req.off("aborted", abortOnClientDisconnect);
      endLogisticsWork("print-chunk-local");
    }
  }

/** Legacy sync endpoint → chuyển sang chunk (nhận order_ids, trả URLs). */
  async function printDocumentHandler(req: any, res: any) {
    return printChunkHandler(req, res);
  }

  /** Order SN đang chuẩn bị PDF nền — tránh trùng job. */
  const labelPrepareInFlight = new Set<string>();

  /**
   * Background: kéo PDF từ Shopee → lưu storage/labels + ghi labelUrl vào Mongo.
   * Chỉ chạy sau ship/sync hoặc khi In phát hiện thiếu — KHÔNG chặn nút In của user.
   */
  function firePrepareShippingLabelsForOrders(
    items: Array<{
      shopId?: string;
      orderSn?: string;
      packageNumber?: string;
      trackingNumber?: string;
      order?: any;
    }>,
  ): void {
    if (!Array.isArray(items) || items.length === 0) return;
    setImmediate(() => {
      void (async () => {
        const queue: any[] = [];
        for (const it of items) {
          const o = it.order || it;
          const sn = String(it.orderSn || o?.orderSn || "")
            .replace(/^shopee-/i, "")
            .trim();
          if (!sn || labelPrepareInFlight.has(sn)) continue;
          if (resolveLocalLabelForOrder(o)) continue;
          labelPrepareInFlight.add(sn);
          queue.push({ ...o, shopId: it.shopId || o?.shopId, orderSn: sn });
        }
        if (queue.length === 0) return;

        console.log(`[Label Prepare BG] START n=${queue.length}`);
        await mapBatchConcurrently(queue, 3, async (order) => {
          const sn = String(order.orderSn || "").trim();
          try {
            const shopId = String(order.shopId || resolveOrderShopId(order) || "").trim();
            if (!shopId) {
              console.warn(`[Label Prepare BG] skip ${sn}: missing shopId`);
              return;
            }
            let accessToken = "";
            try {
              accessToken = (await getValidShopeeAccessToken(shopId)) || "";
            } catch {
              /* ignore */
            }
            if (!accessToken) {
              console.warn(`[Label Prepare BG] skip ${sn}: no token shop=${shopId}`);
              return;
            }

            try {
              await enrichOrdersPackageAndTrackingForPrint(shopId, accessToken, [order]);
            } catch (enrErr: any) {
              console.warn(`[Label Prepare BG] enrich ${sn}:`, enrErr?.message || enrErr);
            }

            if (order.__shopeeOrderNotFound) {
              console.warn(`[Label Prepare BG] FAILED ${sn}: order_not_found — skip create`);
              return;
            }

            const shippingRows = buildShopeeShippingDocOrderRows(order);
            if (shippingRows.length === 0) {
              console.warn(
                `[Label Prepare BG] FAILED ${sn}: missing_package_number; Create/Poll/Download blocked`,
              );
              return;
            }

            const gen = await generateShopeeShippingDocument(shopId, shippingRows);
            const pdfFilename = String(gen?.filename || "").trim();
            if (!gen?.success || !gen.url || !pdfFilename) {
              console.warn(
                `[Label Prepare BG] fail ${sn}:`,
                gen?.message || gen?.error || "no_url",
              );
              return;
            }

            // Lưu meta PDF + hasPdf + waybill_url — tuyệt đối KHÔNG set isPrinted (user chưa bấm In).
            await markOrdersHasPdfInStore([sn], {
              shopId,
              labelUrl: String(gen.url),
              waybill_url: String(gen.url),
              pdfFilename,
            });
            order.labelUrl = gen.url;
            order.pdfUrl = gen.url;
            order.waybill_url = gen.url;
            order.pdfFilename = pdfFilename;
            order.hasPdf = true;
            order.readyToPrint = true;
            console.log(`[Label Prepare BG] OK ${sn} file=${pdfFilename} hasPdf=true waybill_url=set isPrinted=unchanged`);
          } catch (err: any) {
            console.warn(`[Label Prepare BG] ${sn}:`, err?.message || err);
          } finally {
            labelPrepareInFlight.delete(sn);
          }
        });
        console.log("[Label Prepare BG] DONE");
      })();
    });
  }

  /** Alias cũ — sau ship vẫn chuẩn bị PDF đầy đủ (create+download+lưu), không chỉ create. */
  function fireCreateShippingDocumentsForOrders(
    items: Array<{
      shopId?: string;
      orderSn?: string;
      packageNumber?: string;
      trackingNumber?: string;
      order?: any;
    }>,
  ): void {
    firePrepareShippingLabelsForOrders(items);
  }

  // Sync Service / cron / webhook → cùng hàng đợi PDF ngầm.
  registerLabelPdfDownloader(firePrepareShippingLabelsForOrders);

  /**
   * Background ship job — chỉ xác nhận (ship_order), không ghép PDF.
   * Kết quả qua job map để FE poll loading 0/N → N/N.
   */
  async function executeShipOrderBackgroundJob(
    jobId: string,
    shipMethod: ShipMethod,
    idList: string[],
    snList: string[],
  ): Promise<void> {
    pruneOldShipOrderJobs();
    const job = shipOrderJobs.get(jobId);
    if (!job) return;
    const t0 = Date.now();
    beginLogisticsWork(`ship-job:${jobId}`);
    try {
      if (!tryAcquireHeavyJob(`ship-order:${jobId}`)) {
        job.status = "failed";
        job.phase = "failed";
        job.error = "heavy_job_busy";
        job.message = "Một tác vụ Shopee khác đang chạy, vui lòng thử lại sau.";
        return;
      }
      job.status = "running";
      job.phase = "loading";
      job.message = "Đang gọi API Shopee...";
      job.updatedAt = Date.now();

      const orders = await loadOrdersForShipScoped(idList, snList);
      const toShip = resolveOrdersFromRequest(orders, idList, snList);
      job.total = toShip.length;
      if (toShip.length === 0) {
        job.status = "failed";
        job.phase = "failed";
        job.error = "orders_not_found";
        job.message = "Không tìm thấy đơn nào trong database khớp với danh sách gửi lên.";
        job.updatedAt = Date.now();
        return;
      }

      job.phase = "calling_shopee";
      job.message = "Đang xác nhận đơn lên sàn...";
      job.updatedAt = Date.now();

      const batch = await processShipOrderBatch(orders, toShip, shipMethod, {
        onProgress: (completed, total) => {
          job.completed = completed;
          job.total = total;
          job.message = `Đang xác nhận ${completed}/${total} đơn lên sàn...`;
          job.updatedAt = Date.now();
        },
      });
      job.results = Array.isArray(batch.results) ? batch.results : [];

      // Persist kết quả ship + khóa isPrepared (tab Đã xử lý).
      try {
        const changed = toShip.map(({ index }) => orders[index]).filter(Boolean);
        await persistOrdersToDatabase(orders, changed);
        const confirmedRows = changed.filter((o: any) => o && o.isPrepared === true);
        await persistConfirmedShipOrdersToMongo(confirmedRows, shipMethod);
        setImmediate(() => {
          void syncConfirmedOrdersFromShopee(confirmedRows, shipMethod).catch((err: any) => {
            console.warn("[Ship Order Job] background sync failed:", err?.message || err);
          });
        });
      } catch (err: any) {
        console.warn("[Ship Order Job] persist failed:", err?.message || err);
      }

      const summary = buildShipConfirmSummaryPayload(toShip.length, {
        successCount: batch.successCount,
        failedCount: batch.failedCount,
        failedOrders: batch.failedOrders || [],
        results: batch.results || [],
      });
      job.results = batch.results || [];
      job.successCount = summary.successCount;
      job.failedCount = summary.failCount;
      job.failCount = summary.failCount;
      job.failedOrders = summary.failedOrderDetails;
      job.failedOrderDetails = summary.failedOrderDetails;
      job.successfulOrderIds = summary.successfulOrderIds;
      job.completed = toShip.length;
      job.orders = null;
      job.phase = "done";
      job.status = "done";
      job.message = `Thành công: ${summary.successCount} đơn. Thất bại: ${summary.failCount} đơn (${Date.now() - t0}ms).`;
      job.updatedAt = Date.now();
    } catch (err: any) {
      job.status = "failed";
      job.phase = "failed";
      job.error = err?.message || String(err);
      job.message = "Lỗi nội bộ: " + (err?.message || String(err));
      console.error(`[Ship Order Job ${jobId}] Failed:`, err);
    } finally {
      job.updatedAt = Date.now();
      releaseHeavyJob(`ship-order:${jobId}`);
      endLogisticsWork(`ship-job:${jobId}`);
    }
  }

  // Wire HTTP layer — BẮT BUỘC trước khi nhận request (tránh "fast-process chưa khởi tạo").
  initShopeeShipController({
    loadOrdersForApi,
    findOrderRecord,
    arrangeShipment,
    withOperationTimeout,
    SHIP_ORDER_OPERATION_TIMEOUT_MS,
    isAlreadyShippedError,
    isShopeePendingVerificationError,
    forceHealPickupOrderIfHasTracking,
    persistOrdersToDatabase,
    persistConfirmedShipOrdersToMongo,
    syncConfirmedOrdersFromShopee,
    persistPendingShopeeCheckFlag,
    handleShipBulk,
    handleFastProcess,
    executeShipOrderBackgroundJob,
    shipOrderJobs,
    createShipOrderJobId,
    pruneOldShipOrderJobs,
  });
  boundFastProcessHandler = handleFastProcess;
  app.use("/api/shopee", authMiddleware, shopeeShipRoutes);

  initShopeePrintController({
    printDocumentHandler,
    printDocumentJobs,
    createPrintDocumentJobId,
    pruneOldPrintDocumentJobs,
  });
  // Batch Print: chunk (1 request / cụm order_ids) + legacy create/status (FE poll).
  app.post("/api/shopee/print-document/chunk", authMiddleware, printChunkHandler);
  app.post("/api/shopee/print-document/create", authMiddleware, printBatchCreateHandler);
  app.post("/api/shopee/print-document/status", authMiddleware, printBatchStatusHandler);
  app.use("/api/shopee", authMiddleware, shopeePrintRoutes);

  async function checkShopConnectionStatus(shop: any): Promise<{
    online: boolean;
    connection_status: "online" | "expired" | "missing";
    message: string;
  }> {
    if (shop.platform === "shopee") {
      try {
        if (!isShopeeConfigValid()) {
          return {
            online: false,
            connection_status: "missing",
            message: "Shopee Partner ID/Key chưa cấu hình",
          };
        }
        const configuredId = normalizeShopIdKey(String(shop.shopId || ""));
        const tokenStatus = resolveShopeeTokenConnectionStatus(configuredId);

        // Ưu tiên trạng thái token thật (missing/expired) — không báo Online ảo chỉ vì shop có trong DB.
        if (tokenStatus.status === "missing" || tokenStatus.status === "expired") {
          return {
            online: false,
            connection_status: tokenStatus.status,
            message: tokenStatus.message,
          };
        }

        if (!shop?.connected) {
          return {
            online: false,
            connection_status: "online",
            message: "Token hợp lệ nhưng đồng bộ đang tắt (Sync OFF)",
          };
        }

        const oauthShopIds = listShopeeOAuthShopIds();
        const tokens = loadShopeeTokens();
        const record = configuredId ? getShopeeTokenRecord(tokens, configuredId) : null;
        let token = configuredId ? await getValidShopeeAccessToken(configuredId) : null;

        if (token && record) {
          const apiShopId = resolveShopeeApiShopId(record, configuredId);
          let ping = await verifyShopeeShopToken(apiShopId, token);
          if (ping.ok) {
            return {
              online: true,
              connection_status: "online",
              message: `OAuth token hợp lệ (Shopee API OK, shop_id=${apiShopId})`,
            };
          }
          // Auth fail → refresh đúng shop_id + retry 1 lần, KHÔNG Offline ngay.
          if (
            isShopeeInvalidTokenError(ping.error, ping.error) ||
            /invalid|expire|auth|unauthorized/i.test(String(ping.error || ""))
          ) {
            try {
              console.warn(
                `[Shop connection] shop_id=${configuredId} ping fail (${ping.error}) — refresh + retry 1 lần`,
              );
              token = await refreshShopeeAccessTokenLocked(configuredId, { force: true });
              ping = await verifyShopeeShopToken(apiShopId, token);
              if (ping.ok) {
                return {
                  online: true,
                  connection_status: "online",
                  message: `OAuth token hợp lệ sau auto-refresh (Shopee API OK, shop_id=${apiShopId})`,
                };
              }
            } catch (refreshErr: any) {
              console.error(
                `[Shop connection] Refresh thất bại shop_id=${configuredId}:`,
                refreshErr?.message || refreshErr,
              );
              const afterRefresh = resolveShopeeTokenConnectionStatus(configuredId);
              return {
                online: false,
                connection_status:
                  afterRefresh.status === "online" ? "expired" : afterRefresh.status,
                message:
                  refreshErr instanceof ShopeeRefreshTokenExpiredError
                    ? refreshErr.message
                    : `Refresh token thất bại shop_id=${configuredId}: ${refreshErr?.message || ping.error || "unknown"}`,
              };
            }
          }
          return {
            online: false,
            connection_status: "expired",
            message: `Có token trong file nhưng Shopee từ chối shop_id=${apiShopId}: ${ping.error || "invalid_token"}. Cần OAuth lại đúng shop ${configuredId}.`,
          };
        }

        const lastOAuth = loadLastOAuthAudit();
        if (
          lastOAuth?.expected_shop_id === configuredId &&
          lastOAuth?.shop_mismatch &&
          lastOAuth?.callback_shop_id
        ) {
          return {
            online: false,
            connection_status: "missing",
            message: `OAuth gần nhất: Shopee trả shop ${lastOAuth.callback_shop_id}, không phải ${configuredId}. Đăng xuất Shopee Seller, đăng nhập shop ${configuredId}, bấm OAuth lại.`,
          };
        }

        if (oauthShopIds.length > 0) {
          return {
            online: false,
            connection_status: "missing",
            message: `Shop ID cấu hình "${shop.shopId || "(trống)"}" chưa có token. OAuth đã lưu: [${oauthShopIds.join(", ")}] — kiểm tra Shop ID có đúng trên Shopee Seller Center không.`,
          };
        }
        return {
          online: false,
          connection_status: "missing",
          message: "Chưa OAuth hoặc token hết hạn",
        };
      } catch (error: any) {
        console.error("[Shop connection] Shopee check failed:", shop?.shopId, error);
        return {
          online: false,
          connection_status: "missing",
          message: error?.message || "Lỗi kiểm tra kết nối Shopee",
        };
      }
    }

    if (shop.platform === "woocommerce") {
      const base = String(shop.wooUrl || "").replace(/\/$/, "");
      const key = String(shop.shopId || "").trim();
      const secret = String(shop.apiSecret || shop.apiKey || "").trim();
      if (!base || !key) {
        return { online: false, connection_status: "missing", message: "Thiếu URL hoặc Consumer Key" };
      }
      if (!shop?.connected) {
        return {
          online: false,
          connection_status: "missing",
          message: "Đồng bộ đang tắt",
        };
      }
      try {
        const auth = Buffer.from(`${key}:${secret}`).toString("base64");
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 8000);
        const res = await fetch(`${base}/wp-json/wc/v3/system_status`, {
          headers: { Authorization: `Basic ${auth}`, Accept: "application/json" },
          signal: controller.signal,
        });
        clearTimeout(timer);
        if (res.ok) {
          return { online: true, connection_status: "online", message: "WooCommerce REST API phản hồi OK" };
        }
        return {
          online: false,
          connection_status: "expired",
          message: `WooCommerce trả HTTP ${res.status}`,
        };
      } catch (error: any) {
        return {
          online: false,
          connection_status: "expired",
          message: error?.message || "Không kết nối được WooCommerce",
        };
      }
    }

    if (shop.platform === "tiktok") {
      if (!shop.shopId || !shop.apiKey) {
        return { online: false, connection_status: "missing", message: "Thiếu Seller ID hoặc API Key" };
      }
      if (!shop?.connected) {
        return {
          online: false,
          connection_status: "online",
          message: "Credentials đã cấu hình nhưng đồng bộ đang tắt",
        };
      }
      return { online: true, connection_status: "online", message: "Credentials TikTok Shop đã cấu hình" };
    }

    return { online: false, connection_status: "missing", message: "Nền tảng không hỗ trợ" };
  }

  function enrichShopsWithConnectionStatus(shops: any[]): any[] {
    if (!Array.isArray(shops)) return [];
    return shops.map((shop) => {
      if (!shop || typeof shop !== "object") return shop;
      if (shop.platform === "shopee") {
        const tokenStatus = resolveShopeeTokenConnectionStatus(shop.shopId);
        return {
          ...shop,
          connection_status: tokenStatus.status,
          connection_message: tokenStatus.message,
          token_expires_at: tokenStatus.expires_at,
        };
      }
      if (shop.platform === "woocommerce") {
        const hasCreds = Boolean(String(shop.wooUrl || "").trim() && String(shop.shopId || "").trim());
        const status = hasCreds ? "online" : "missing";
        return {
          ...shop,
          connection_status: status,
          connection_message: hasCreds
            ? "Đã cấu hình WooCommerce credentials"
            : "Chưa cấu hình URL/Consumer Key",
        };
      }
      if (shop.platform === "tiktok") {
        const hasCreds = Boolean(shop.shopId && shop.apiKey);
        return {
          ...shop,
          connection_status: hasCreds ? "online" : "missing",
          connection_message: hasCreds
            ? "Đã cấu hình TikTok credentials"
            : "Thiếu Seller ID hoặc API Key",
        };
      }
      return { ...shop, connection_status: "missing", connection_message: "Nền tảng không hỗ trợ" };
    });
  }

  // --- Settings API — Phase 2 MVC ---
  ensureGeminiClientFromEnv();
  initSettingsController({
    CHANNEL_SETTINGS_PATH,
    DEFAULT_CHANNEL_SETTINGS,
    loadChannelSettings,
    saveChannelSettings,
    upsertShopsInChannelSettings,
    logOAuthSaveError,
    checkShopConnectionStatus,
    enrichShopsWithConnectionStatus,
  });
  app.use("/api/settings", authMiddleware, settingsRoutes);

  const LISTINGS_DB_PATH = path.join(APP_ROOT, "data", "multi_channel_listings.json");

  const readListingsDb = (): any[] => {
    try {
      if (!fs.existsSync(LISTINGS_DB_PATH)) return [];
      const raw = fs.readFileSync(LISTINGS_DB_PATH, "utf-8");
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  };

  const writeListingsDb = (listings: any[]) => {
    const dir = path.dirname(LISTINGS_DB_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(LISTINGS_DB_PATH, JSON.stringify(listings, null, 2), "utf-8");
  };

  // --- AI / Gemini API — Phase 2 MVC ---
  app.use("/api", aiRoutes);

  app.get("/api/multi-channel/listing", authMiddleware, async (_req, res) => {
    return res.json({ success: true, listings: readListingsDb() });
  });

  app.post("/api/multi-channel/listing", authMiddleware, async (req, res) => {
    try {
      const payload = req.body || {};
      const listings = readListingsDb();
      const entry = {
        id: `listing-${Date.now()}`,
        ...payload,
        savedAt: new Date().toISOString(),
      };
      listings.unshift(entry);
      writeListingsDb(listings.slice(0, 200));
      return res.json({ success: true, id: entry.id, message: "L\u01B0u nh\xE1p \u0111\u0103ng b\xE1n \u0111a s\xE0n th\xE0nh c\xF4ng" });
    } catch (error: any) {
      return res.status(500).json({ success: false, error: error.message || "L\u01B0u th\u1EA5t b\u1EA1i" });
    }
  });

  const PRODUCT_LISTINGS_DB_PATH = path.join(APP_ROOT, "data", "product_listings.json");

  // mapping-products / channel-listings đã đăng ký sớm sau /api/health (tránh SPA HTML).

  const readProductListingsDb = (): any[] => {
    try {
      if (!fs.existsSync(PRODUCT_LISTINGS_DB_PATH)) return [];
      const raw = fs.readFileSync(PRODUCT_LISTINGS_DB_PATH, "utf-8");
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  };

  const writeProductListingsDb = (rows: any[]) => {
    const dir = path.dirname(PRODUCT_LISTINGS_DB_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(PRODUCT_LISTINGS_DB_PATH, JSON.stringify(rows, null, 2), "utf-8");
  };

  const computeOverallListingStatus = (statuses: string[]): string => {
    if (!statuses.length) return "pending";
    const hasSuccess = statuses.includes("success");
    const hasFailed = statuses.includes("failed");
    const hasPending = statuses.includes("pending");
    if (hasPending && !hasSuccess && !hasFailed) return "pending";
    if (hasSuccess && hasFailed) return "partial";
    if (hasSuccess) return "success";
    if (hasFailed) return "failed";
    return "pending";
  };

  app.get("/api/product-listings", authMiddleware, async (_req, res) => {
    try {
      const rows = readProductListingsDb();
      const products = await loadProducts();
      const byProduct = new Map<string, any[]>();

      for (const row of rows) {
        const pid = row.product_id || "unknown";
        if (!byProduct.has(pid)) byProduct.set(pid, []);
        byProduct.get(pid)!.push(row);
      }

      const groups = Array.from(byProduct.entries()).map(([productId, children]) => {
        const sorted = [...children].sort(
          (a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime()
        );
        const product = products.find((p: any) => p.id === productId);
        const statuses = sorted.map((c) => c.status);
        const created = sorted.reduce((min, c) => (c.created_at < min ? c.created_at : min), sorted[0].created_at);
        const updated = sorted.reduce((max, c) => (c.updated_at > max ? c.updated_at : max), sorted[0].updated_at);
        const platforms = Array.from(new Set(sorted.map((c) => c.platform)));

        return {
          product_id: productId,
          product_title: product?.title || sorted[0]?.listing_title || "Sản phẩm không xác định",
          product_image: product?.imageUrl || product?.avatarUrl || sorted[0]?.product_image,
          product_sku: product?.sku,
          created_at: created,
          updated_at: updated,
          overall_status: computeOverallListingStatus(statuses),
          platform_labels: platforms,
          children: sorted,
        };
      });

      groups.sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime());

      return res.json({ success: true, groups });
    } catch (error: any) {
      return res.status(500).json({ success: false, error: error.message });
    }
  });

  app.post("/api/product-listings/clear-all", authMiddleware, async (_req, res) => {
    writeProductListingsDb([]);
    return res.json({ success: true, cleared: true, groups: [] });
  });

  app.post("/api/catalog/wipe-all", authMiddleware, async (req: any, res) => {
    if (req.body?.confirmation !== "WIPE_CATALOG") {
      return res.status(400).json({
        success: false,
        error: "explicit_confirmation_required",
        message: "Thao tác xóa catalog yêu cầu confirmation: WIPE_CATALOG.",
      });
    }
    try {
      const backupFile = await backupInventoryBeforeDestructiveAction("catalog-wipe");
      await saveProducts([]);
      saveImports([]);
      writeListingsDb([]);
      writeProductListingsDb([]);
      writeInventoryAudit("catalog_wiped", { requestedBy: req.user?.username || null, backupFile });
      console.warn("[Catalog] Đã xóa sạch products, imports, multi_channel_listings, product_listings.");
      return res.json({
        success: true,
        cleared: true,
        backupFile,
        products: [],
        imports: [],
        listings: [],
        productListings: [],
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return res.status(500).json({ success: false, error: "catalog_wipe_failed", message });
    }
  });

  /** Lấy / đồng bộ cây danh mục Shopee (v2.product.get_category). */
  app.get("/api/shopee/categories", authMiddleware, async (req, res) => {
    try {
      res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
      const shopId = String(req.query.shop_id || req.query.shopId || "").trim();
      const force = req.query.force === "1" || req.query.refresh === "1";
      if (!shopId) {
        return res.status(400).json({ success: false, error: "Thiếu shop_id" });
      }
      const accessToken = await getValidShopeeAccessToken(shopId);
      if (!accessToken) {
        const fail = describeShopeeTokenFailure(shopId);
        return res.status(400).json({ success: false, error: fail.message, code: fail.error });
      }
      const cache = await getOrSyncShopeeCategories(
        APP_ROOT,
        { shopId, accessToken, fetchCategoryList: shopeeFetchCategoryList },
        { force },
      );
      return res.json({
        success: true,
        synced_at: cache.synced_at,
        from_cache: Boolean(cache.from_cache),
        category_count: cache.category_count,
        leaf_count: cache.leaf_count,
        tree: cache.tree || [],
        leaf_ids: cache.leaf_ids || [],
        source: "v2.product.get_category",
      });
    } catch (error: any) {
      return res.status(500).json({
        success: false,
        error: error?.message || "Không lấy được danh mục Shopee",
      });
    }
  });

  /** Force đồng bộ lại danh mục ngành hàng từ Shopee. */
  app.post("/api/shopee/categories/sync", authMiddleware, async (req, res) => {
    try {
      res.setHeader("Cache-Control", "no-store");
      const shopId = String(req.body?.shop_id || req.body?.shopId || req.query.shop_id || "").trim();
      if (!shopId) {
        return res.status(400).json({ success: false, error: "Thiếu shop_id" });
      }
      const accessToken = await getValidShopeeAccessToken(shopId);
      if (!accessToken) {
        const fail = describeShopeeTokenFailure(shopId);
        return res.status(400).json({ success: false, error: fail.message, code: fail.error });
      }
      const cache = await getOrSyncShopeeCategories(
        APP_ROOT,
        { shopId, accessToken, fetchCategoryList: shopeeFetchCategoryList },
        { force: true },
      );
      return res.json({
        success: true,
        message: "Đã đồng bộ lại danh mục ngành hàng Shopee",
        synced_at: cache.synced_at,
        from_cache: false,
        category_count: cache.category_count,
        leaf_count: cache.leaf_count,
        tree: cache.tree || [],
        leaf_ids: cache.leaf_ids || [],
        source: "v2.product.get_category",
      });
    } catch (error: any) {
      return res.status(500).json({
        success: false,
        error: error?.message || "Đồng bộ danh mục Shopee thất bại",
      });
    }
  });

  /** Lấy danh sách kênh vận chuyển shop (FE form đăng bán — toggle từng kênh). */
  app.get("/api/shopee/logistics-channels", authMiddleware, async (req, res) => {
    try {
      res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
      const shopId = String(req.query.shop_id || req.query.shopId || "").trim();
      if (!shopId) {
        return res.status(400).json({ success: false, error: "Thiếu shop_id" });
      }
      const accessToken = await getValidShopeeAccessToken(shopId);
      if (!accessToken) {
        const fail = describeShopeeTokenFailure(shopId);
        return res.status(400).json({ success: false, error: fail.message, code: fail.error });
      }
      const channels = await shopeeGetChannelList(shopId, accessToken);
      return res.json({
        success: true,
        shop_id: shopId,
        channels,
        source: "v2.logistics.get_channel_list",
      });
    } catch (error: any) {
      return res.status(500).json({
        success: false,
        error: error?.message || "Không lấy được kênh vận chuyển",
      });
    }
  });

  /** Lấy thuộc tính bắt buộc theo category (FE form đăng bán) — luôn gọi live get_attribute_tree. */
  app.get("/api/shopee/category-attributes", authMiddleware, async (req, res) => {
    try {
      res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
      res.setHeader("Pragma", "no-cache");
      const shopId = String(req.query.shop_id || req.query.shopId || "").trim();
      const categoryId = Number(req.query.category_id || req.query.categoryId);
      if (!shopId) {
        return res.status(400).json({ success: false, error: "Thiếu shop_id" });
      }
      if (!Number.isFinite(categoryId) || categoryId <= 0) {
        return res.status(400).json({ success: false, error: "Thiếu category_id hợp lệ" });
      }
      const accessToken = await getValidShopeeAccessToken(shopId);
      if (!accessToken) {
        const fail = describeShopeeTokenFailure(shopId);
        return res.status(400).json({ success: false, error: fail.message, code: fail.error });
      }
      const attributes = await shopeeGetAttributeTree(shopId, accessToken, categoryId);
      const medicalHint = isShopeeMedicalCategory({
        shopeeCat: String(req.query.category_label || req.query.label || ""),
        shopeeCategory: {
          label: String(req.query.category_label || req.query.label || ""),
          level1: String(req.query.level1 || ""),
          level2: String(req.query.level2 || ""),
          level3: String(req.query.level3 || ""),
        },
      });
      return res.json({
        success: true,
        category_id: categoryId,
        attributes,
        mandatory: attributes.filter((a) => a.mandatory),
        requires_medicine_id: medicalHint,
        fetched_at: new Date().toISOString(),
        source: "v2.product.get_attribute_tree",
      });
    } catch (error: any) {
      return res.status(500).json({
        success: false,
        error: error?.message || "Không lấy được thuộc tính danh mục",
      });
    }
  });

  app.post("/api/multi-channel/publish", authMiddleware, async (req, res) => {
    try {
      const payload = req.body || {};
      const {
        warehouseProductId,
        title,
        images = [],
        shops = [],
        selectedShops = [],
      } = payload;

      const productId = warehouseProductId || payload.product_id || "unknown";
      const product = (await loadProducts()).find((p: any) => p.id === productId);
      const batchId = `batch-${Date.now()}`;
      const now = new Date().toISOString();
      const allRows = readProductListingsDb();
      const newRows: any[] = [];
      const errors: {
        shop_id: string;
        shop_name: string;
        platform: string;
        error: string;
        code?: string;
      }[] = [];

      const shopList = Array.isArray(shops) && shops.length
        ? shops
        : (selectedShops as string[]).map((id: string) => ({ id, name: id, platform: "shopee" }));

      // Tuần tự for...of — mỗi shop try/catch độc lập, không nuốt lỗi
      for (let i = 0; i < shopList.length; i++) {
        const shop = shopList[i];
        const platform = String(shop.platform || "shopee").toLowerCase();
        if (!["shopee", "lazada", "tiktok", "woocommerce"].includes(platform)) continue;

        const clientShopId = String(shop.id || "").trim();
        const shopKey = String(shop.shopId || shop.shop_id || shop.id || "").trim();
        const shopName = shop.name || shop.shopName || shopKey;
        const existingIdx = allRows.findIndex(
          (r) => r.product_id === productId && String(r.shop_id) === shopKey && r.platform === platform
        );

        let status: "success" | "failed" | "pending" = "pending";
        let platformProductId: string | undefined;
        let error_message: string | undefined;

        if (platform === "shopee") {
          try {
            if (i > 0) await sleep(SHOPEE_PRODUCT_API_DELAY_MS * 2);
            if (!shopKey) throw new Error("Thiếu Shopee shop_id (OAuth)");
            const existingListing = allRows.find(
              (r) =>
                r.product_id === productId &&
                String(r.shop_id) === shopKey &&
                r.platform === "shopee" &&
                r.status === "success" &&
                r.platform_product_id,
            );
            const medicineId =
              resolveShopeeMedicineId(payload) ||
              (product?.medicine_id != null ? String(product.medicine_id) : null);
            // Ưu tiên dữ liệu theo từng gian (perShopVariants / perShopLogistics)
            // perShopLogistics[shopKey]: có thể là number[] (FE đã resolve) HOẶC string[] (generic keys chưa resolve)
            const perShopVars =
              payload?.perShopVariants?.[shopKey] ||
              payload?.perShopVariants?.[clientShopId] ||
              null;
            const perShopLogsRaw =
              payload?.perShopLogistics?.[shopKey] ||
              payload?.perShopLogistics?.[clientShopId] ||
              null;
            // Truyền perShopLogistics để publishOneItemToShopee tự resolve & intersect
            const publishResult = await publishOneItemToShopee(shopKey, {
              ...payload,
              medicine_id: medicineId || payload?.medicine_id,
              shopeeItemId: existingListing?.platform_product_id || product?.shopeeItemId,
              platform_product_id: existingListing?.platform_product_id,
              variants: Array.isArray(perShopVars) && perShopVars.length ? perShopVars : payload.variants,
              // Ưu tiên perShopLogistics: gửi mảng để hàm nội bộ resolve theo shop
              perShopLogistics: perShopLogsRaw,
              enabledLogistics: Array.isArray(perShopLogsRaw)
                ? (perShopLogsRaw as (number | string)[]).map(Number).filter((n) => n > 0)
                : (payload.enabledLogistics as number[] || []),
              images: Array.isArray(images) && images.length
                ? images
                : [product?.imageUrl || product?.avatarUrl].filter(Boolean),
            });
            const itemId = publishResult?.itemId;
            const modelIds: string[] = Array.isArray(publishResult?.modelIds) ? publishResult.modelIds : [];
            if (!itemId) throw new Error("publishOneItemToShopee không trả item_id");
            status = "success";
            platformProductId = String(itemId);

            // ─── BƯỚC 1: Upsert Kho nội bộ (products) ───────────────────────────
            try {
              const allProducts = await loadProducts();
              const productData = {
                title: title || product?.title || payload.shopTitles?.[shopKey] || "",
                sku: product?.sku || `SKU-${itemId}`,
                imageUrl: images[0] || product?.imageUrl || product?.avatarUrl,
                description: payload.descriptionHtml || payload.description || title || "",
                price: Math.max(0, Math.round(Number(variants[0]?.priceShopee ?? payload.price ?? 0))),
                stock: Math.max(0, Math.round(Number(variants[0]?.stock ?? 0))),
                weight: Number(payload.packageWeight || 0),
                shopeeItemId: String(itemId),
                shopId: String(shopKey),
                channels: ["shopee"],
                children: modelIds.length > 0
                  ? modelIds.map((mid: string, idx: number) => {
                      const v = (Array.isArray(perShopVars) && perShopVars.length ? perShopVars : payload.variants)[idx];
                      return {
                        id: `child-${itemId}-${mid || idx}`,
                        sku: mid && mid.startsWith("SKU") ? mid : (v?.sku || `SKU-${itemId}-${mid || idx}`),
                        price: Math.max(0, Math.round(Number(v?.priceShopee ?? v?.pricePromo ?? 0))),
                        stock: Math.max(0, Math.round(Number(v?.stock ?? 0))),
                        shopeeModelId: mid && !mid.startsWith("SKU") ? mid : undefined,
                        imageUrl: images[0],
                      };
                    })
                  : undefined,
              };

              const existingIdx = allProducts.findIndex((p: any) =>
                p.shopeeItemId === String(itemId) || p.id === productId
              );
              if (existingIdx >= 0) {
                allProducts[existingIdx] = { ...allProducts[existingIdx], ...productData };
              } else {
                allProducts.push({
                  id: productId !== "unknown" ? productId : `p-${itemId}`,
                  ...productData,
                });
              }
              await saveProducts(allProducts);
              console.log(`[Publish Post-Process] Upsert product item_id=${itemId} → Kho OK`);
            } catch (upsertErr) {
              console.warn(`[Publish Post-Process] Upsert product thất bại item_id=${itemId}:`, upsertErr);
            }

            // ─── BƯỚC 2: Upsert Channel Listings (liên kết + listing) ─────────
            try {
              const channelRows = [];
              if (modelIds.length > 0) {
                const allProducts = await loadProducts();
                const parentSku = product?.sku || `SKU-${itemId}`;
                modelIds.forEach((mid: string, idx: number) => {
                  const v = (Array.isArray(perShopVars) && perShopVars.length ? perShopVars : payload.variants)[idx];
                  channelRows.push({
                    id: `cl-shopee-${itemId}-${mid || idx}`,
                    title: title || product?.title || "",
                    sku: mid && !mid.startsWith("SKU") ? parentSku : (v?.sku || parentSku),
                    channelId: String(itemId),
                    platform: "shopee",
                    shopName: shopName,
                    shopId: String(shopKey),
                    modelId: mid && !mid.startsWith("SKU") ? mid : undefined,
                    itemId: String(itemId),
                    status: "success",
                    linkedProductId: productId !== "unknown" ? productId : undefined,
                    price: Math.max(0, Math.round(Number(v?.priceShopee ?? v?.pricePromo ?? 0))),
                    stock: Math.max(0, Math.round(Number(v?.stock ?? 0))),
                    weight: Number(v?.weight || payload.packageWeight || 0),
                  });
                });
              } else {
                channelRows.push({
                  id: `cl-shopee-${itemId}`,
                  title: title || product?.title || "",
                  sku: product?.sku || `SKU-${itemId}`,
                  channelId: String(itemId),
                  platform: "shopee",
                  shopName: shopName,
                  shopId: String(shopKey),
                  status: "success",
                  linkedProductId: productId !== "unknown" ? productId : undefined,
                  price: Math.max(0, Math.round(Number(variants[0]?.priceShopee ?? payload.price ?? 0))),
                  stock: Math.max(0, Math.round(Number(variants[0]?.stock ?? 0))),
                  weight: Number(payload.packageWeight || 0),
                });
              }

              const existingChannel = await readChannelListingsDb();
              const merged = [...existingChannel];
              channelRows.forEach((row) => {
                const idx = merged.findIndex((r) =>
                  r.itemId === row.itemId &&
                  (r.modelId === row.modelId || (!r.modelId && !row.modelId))
                );
                if (idx >= 0) merged[idx] = { ...merged[idx], ...row };
                else merged.push(row);
              });
              await writeChannelListingsDbAsync(merged);
              console.log(`[Publish Post-Process] Upsert channel_listings item_id=${itemId} (${channelRows.length} rows) → OK`);
            } catch (channelErr) {
              console.warn(`[Publish Post-Process] Upsert channel_listings thất bại item_id=${itemId}:`, channelErr);
            }

            // Lưu medicine_id vào Product (Mongo) nếu có
            if (medicineId && productId && productId !== "unknown") {
              try {
                const products = await loadProducts();
                const idx = products.findIndex((p: any) => p.id === productId);
                if (idx >= 0) {
                  products[idx] = { ...products[idx], medicine_id: String(medicineId) };
                  await saveProducts(products);
                }
              } catch (saveMedErr: any) {
                console.warn("[Shopee Publish] Lưu medicine_id thất bại:", saveMedErr?.message || saveMedErr);
              }
            }
          } catch (err: any) {
            status = "failed";
            const isInvalidCat =
              err?.code === SHOPEE_INVALID_CATEGORY_CODE ||
              isShopeeInvalidCategoryError(err) ||
              isShopeeInvalidCategoryError(err?.message);
            error_message = isInvalidCat
              ? SHOPEE_INVALID_CATEGORY_USER_MSG
              : err?.message || "Đăng Shopee thất bại";
            console.log(
              "[SHOPEE UPLOAD ERROR]:",
              JSON.stringify(
                {
                  shop_id: shopKey,
                  shop_name: shopName,
                  error: error_message,
                  code: isInvalidCat ? SHOPEE_INVALID_CATEGORY_CODE : err?.code || null,
                  stack: err?.stack || null,
                },
                null,
                2,
              ),
            );
            errors.push({
              shop_id: shopKey,
              shop_name: shopName,
              platform,
              error: error_message,
              code: isInvalidCat ? SHOPEE_INVALID_CATEGORY_CODE : err?.code,
            });
          }
        } else if (platform === "woocommerce") {
          try {
            const channelSettings = loadChannelSettings();
            const wooShops = (channelSettings?.shops || []).filter(
              (s: any) => s.platform === "woocommerce" && s.connected !== false,
            );
            const wooShop =
              wooShops.find(
                (s: any) =>
                  String(s.shopId || "") === shopKey ||
                  String(s.id || "") === clientShopId ||
                  String(s.shopId || "") === clientShopId,
              ) || wooShops[0];

            if (!wooShop) {
              throw new Error("Chưa cấu hình shop WooCommerce trong Cài đặt");
            }

            const variantsArr = Array.isArray(payload.variants) ? payload.variants : [];
            const firstVariant = variantsArr[0] || {};
            const price =
              Number(firstVariant?.priceShopee ?? firstVariant?.pricePromo ?? firstVariant?.price ?? payload.price ?? product?.sellingPrice ?? 0) || 0;
            const stock =
              Number(firstVariant?.stock ?? product?.stock ?? 0) || 0;
            const imageList = (Array.isArray(images) && images.length
              ? images
              : [product?.imageUrl || product?.avatarUrl].filter(Boolean)
            ).map((src: string) => ({ src: String(src) }));

            const publishResult = await publishProductToWooCommerce(wooShop, {
              name: title || product?.title || payload.shopTitles?.[shopKey] || "Sản phẩm",
              sku: product?.sku || firstVariant?.sku || "",
              description: payload.descriptionHtml || payload.description || title || "",
              shortDescription: payload.shortDescription || title || "",
              regular_price: String(Math.round(price)),
              stock_quantity: Math.max(0, Math.round(stock)),
              manage_stock: true,
              images: imageList,
              weight: payload.packageWeight || product?.weight || "",
              status: "publish",
              categories: payload.wooCategories || [],
            });

            if (!publishResult.success || !publishResult.wooProductId) {
              throw new Error(publishResult.message || "WooCommerce không trả product id");
            }

            status = "success";
            platformProductId = String(publishResult.wooProductId);

            // Lưu wooId vào product kho nội bộ
            try {
              const allProducts = await loadProducts();
              const idx = allProducts.findIndex(
                (p: any) => p.id === productId || (product?.sku && p.sku === product.sku),
              );
              if (idx >= 0) {
                const channels = Array.isArray(allProducts[idx].channels)
                  ? [...new Set([...allProducts[idx].channels, "woocommerce"])]
                  : ["woocommerce"];
                allProducts[idx] = {
                  ...allProducts[idx],
                  wooId: platformProductId,
                  channels,
                  lastSynced: now,
                };
                await saveProducts(allProducts);
              } else if (productId && productId !== "unknown") {
                allProducts.push({
                  id: productId,
                  title: title || product?.title || "",
                  sku: product?.sku || `SKU-WOO-${platformProductId}`,
                  wooId: platformProductId,
                  channels: ["woocommerce"],
                  stock: Math.max(0, Math.round(stock)),
                  sellingPrice: Math.round(price),
                  imageUrl: imageList[0]?.src,
                  lastSynced: now,
                });
                await saveProducts(allProducts);
              }
              console.log(`[WooCommerce Publish] Lưu wooId=${platformProductId} vào product OK`);
            } catch (saveErr: any) {
              console.warn("[WooCommerce Publish] Lưu wooId thất bại:", saveErr?.message || saveErr);
            }
          } catch (err: any) {
            status = "failed";
            error_message = err?.message || "Đăng WooCommerce thất bại";
            console.error("[WOOCOMMERCE UPLOAD ERROR]:", error_message);
            errors.push({
              shop_id: shopKey,
              shop_name: shopName,
              platform,
              error: error_message,
            });
          }
        } else {
          status = "failed";
          error_message = `Chưa hỗ trợ đăng thật lên ${platform} (chỉ Shopee Open API + WooCommerce)`;
          errors.push({ shop_id: shopKey, shop_name: shopName, platform, error: error_message });
        }

        const row = {
          id: existingIdx >= 0 ? allRows[existingIdx].id : `pl-${Date.now()}-${i}`,
          product_id: productId,
          publish_batch_id: batchId,
          platform,
          shop_id: shopKey,
          client_shop_id: clientShopId || shopKey,
          shop_name: shopName,
          status,
          platform_product_id: platformProductId,
          error_message,
          listing_title:
            (payload.shopTitles && (payload.shopTitles[shopKey] || payload.shopTitles[clientShopId])) ||
            title ||
            product?.title,
          product_image: images[0] || product?.imageUrl || product?.avatarUrl,
          created_at: existingIdx >= 0 ? allRows[existingIdx].created_at : now,
          updated_at: now,
        };

        if (existingIdx >= 0) {
          allRows[existingIdx] = row;
        } else {
          allRows.unshift(row);
        }
        newRows.push(row);
      }

      writeProductListingsDb(allRows.slice(0, 2000));

      const draftListings = readListingsDb();
      draftListings.unshift({
        id: `listing-${Date.now()}`,
        ...payload,
        publish_batch_id: batchId,
        savedAt: now,
        published: true,
      });
      writeListingsDb(draftListings.slice(0, 200));

      const okCount = newRows.filter((r) => r.status === "success").length;
      const failCount = newRows.filter((r) => r.status !== "success").length;
      const summary = {
        total: newRows.length,
        success: okCount,
        failed: failCount,
      };

      // Có bất kỳ lỗi nào → KHÔNG trả success:true (tránh silent failure trên FE)
      if (failCount > 0) {
        const httpStatus = okCount > 0 ? 207 : 400;
        const invalidCategory = errors.some(
          (e) =>
            e.code === SHOPEE_INVALID_CATEGORY_CODE ||
            isShopeeInvalidCategoryError(e.error) ||
            isShopeeInvalidCategoryError(e.code),
        );
        const message = invalidCategory
          ? SHOPEE_INVALID_CATEGORY_USER_MSG
          : okCount > 0
            ? `Đăng bán một phần: ${okCount}/${newRows.length} thành công, ${failCount} thất bại`
            : `Đăng bán thất bại toàn bộ (${failCount}/${newRows.length}). ${errors[0]?.error || ""}`;
        console.log(
          "[SHOPEE UPLOAD ERROR]:",
          JSON.stringify({ batchId, summary, errors, invalidCategory }, null, 2),
        );
        return res.status(httpStatus).json({
          success: false,
          partial: okCount > 0,
          batchId,
          listings: newRows,
          errors,
          summary,
          error: message,
          message,
          code: invalidCategory ? SHOPEE_INVALID_CATEGORY_CODE : undefined,
          invalid_category: invalidCategory,
          reset_category: invalidCategory,
        });
      }

      return res.json({
        success: true,
        partial: false,
        batchId,
        listings: newRows,
        errors: [],
        summary,
        message: `Đăng bán thành công ${okCount}/${newRows.length} gian hàng`,
      });
    } catch (error: any) {
      console.log(
        "[SHOPEE UPLOAD ERROR]:",
        JSON.stringify({ fatal: true, error: error?.message || String(error), stack: error?.stack || null }, null, 2),
      );
      return res.status(500).json({
        success: false,
        error: error.message || "Đăng bán thất bại",
        errors: [{ shop_id: "", shop_name: "", platform: "shopee", error: error.message || "Đăng bán thất bại" }],
      });
    }
  });

  const PUBLISH_EDIT_DB_PATH = path.join(APP_ROOT, "data", "publish_edit.json");
  const FRAMED_IMAGES_DIR = path.join(APP_ROOT, "data", "framed_images");

  const readPublishEditDb = (): { config: any; meta: Record<string, any> } => {
    try {
      if (!fs.existsSync(PUBLISH_EDIT_DB_PATH)) return { config: {}, meta: {} };
      const raw = fs.readFileSync(PUBLISH_EDIT_DB_PATH, "utf-8");
      const parsed = JSON.parse(raw);
      return { config: parsed.config || {}, meta: parsed.meta || {} };
    } catch {
      return { config: {}, meta: {} };
    }
  };

  const writePublishEditDb = (data: { config: any; meta: Record<string, any> }) => {
    const dir = path.dirname(PUBLISH_EDIT_DB_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(PUBLISH_EDIT_DB_PATH, JSON.stringify(data, null, 2), "utf-8");
  };

  app.get("/api/publish-edit", authMiddleware, async (_req, res) => {
    const db = readPublishEditDb();
    return res.json({ success: true, config: db.config, meta: db.meta });
  });

  app.post("/api/publish-edit/config", authMiddleware, async (req, res) => {
    try {
      const db = readPublishEditDb();
      db.config = { ...db.config, ...req.body, updated_at: new Date().toISOString() };
      writePublishEditDb(db);
      return res.json({ success: true, config: db.config });
    } catch (error: any) {
      return res.status(500).json({ success: false, error: error.message });
    }
  });

  app.post("/api/publish-edit/batch-titles", authMiddleware, async (req, res) => {
    try {
      const { assignments = [] } = req.body || {};
      const db = readPublishEditDb();
      for (const item of assignments) {
        if (!item.productId) continue;
        db.meta[item.productId] = {
          ...(db.meta[item.productId] || {}),
          shopTitles: item.shopTitles || {},
          aiTitles: item.aiTitles || [],
          titlesAppliedAt: new Date().toISOString(),
        };
      }
      writePublishEditDb(db);
      return res.json({ success: true, meta: db.meta });
    } catch (error: any) {
      return res.status(500).json({ success: false, error: error.message });
    }
  });

  app.post("/api/publish-edit/save-framed-image", authMiddleware, async (req, res) => {
    try {
      const { productId, imageDataUrl, framedHash } = req.body || {};
      if (!productId || !imageDataUrl) {
        return res.status(400).json({ success: false, error: "Thiếu productId hoặc ảnh" });
      }

      if (!fs.existsSync(FRAMED_IMAGES_DIR)) fs.mkdirSync(FRAMED_IMAGES_DIR, { recursive: true });

      const base64 = String(imageDataUrl).replace(/^data:image\/\w+;base64,/, "");
      const buf = Buffer.from(base64, "base64");
      const filename = `${productId}.jpg`;
      fs.writeFileSync(path.join(FRAMED_IMAGES_DIR, filename), buf);

      const imageUrl = `/api/framed-images/${productId}`;
      const products = await loadProducts();
      const idx = products.findIndex((p: any) => p.id === productId);
      if (idx >= 0) {
        products[idx] = { ...products[idx], imageUrl };
        await saveProducts(products);
      }

      const db = readPublishEditDb();
      db.meta[productId] = {
        ...(db.meta[productId] || {}),
        framedImageUrl: imageUrl,
        framedHash: framedHash || `hash-${buf.length}`,
        frameAppliedAt: new Date().toISOString(),
      };
      writePublishEditDb(db);

      return res.json({ success: true, imageUrl, framedHash: db.meta[productId].framedHash });
    } catch (error: any) {
      return res.status(500).json({ success: false, error: error.message });
    }
  });

  app.get("/api/framed-images/:productId", (req, res) => {
    const filePath = path.join(FRAMED_IMAGES_DIR, `${req.params.productId}.jpg`);
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: "Không tìm thấy ảnh" });
    }
    res.setHeader("Content-Type", "image/jpeg");
    return res.send(fs.readFileSync(filePath));
  });

  app.use("/api", (req, res) => {
    res.status(404).json({
      success: false,
      message: `API không tồn tại: ${req.method} ${req.originalUrl}`,
      details: "not_found",
    });
  });

  app.use(errorHandler);

  if (isDevelopmentRuntime) {
    // Dynamic path keeps Vite out of the server.cjs bundle; resolve from APP_ROOT
    // (and parent) so running dist/server.cjs does not crash with MODULE_NOT_FOUND.
    try {
      const { pathToFileURL } = await import("node:url");
      const devServerFile = ["dev", "Server.ts"].join("");
      const candidates = [
        path.join(APP_ROOT, devServerFile),
        path.join(APP_ROOT, "..", devServerFile),
        path.join(process.cwd(), devServerFile),
      ];
      const found = candidates.find((p) => fs.existsSync(p));
      if (!found) {
        console.warn("[Boot] devServer.ts not found — skipping Vite middleware");
      } else {
        const { setupDevelopmentMiddleware } = await import(pathToFileURL(found).href);
        await setupDevelopmentMiddleware(app);
      }
    } catch (devErr) {
      console.error("[Boot] setupDevelopmentMiddleware failed:", devErr instanceof Error ? devErr.stack || devErr.message : devErr);
      console.warn("[Boot] Continuing without Vite middleware so API routes stay up.");
    }
  } else {
    if (isCpanelPassengerRuntime && process.env.NODE_ENV !== "production") {
      console.warn("[Boot] Passenger/cPanel detected without NODE_ENV=production; forcing static production runtime.");
    }
    
    // Serve static PDFs từ public/pdfs
    const publicPdfDir = path.join(APP_ROOT, "public", "pdfs");
    app.use("/pdfs", express.static(publicPdfDir, {
      setHeaders(res) {
        res.setHeader("Content-Type", "application/pdf");
        res.setHeader("Cache-Control", "public, max-age=300");
      },
    }));
    
    const distPath = path.join(APP_ROOT, "dist");
    app.use(express.static(distPath, {
      setHeaders(res, filePath) {
        if (filePath.endsWith("index.html")) {
          res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
          res.setHeader("Pragma", "no-cache");
          res.setHeader("Expires", "0");
        } else if (/\.(js|css)$/.test(filePath)) {
          res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
        }
      },
    }));
    app.get("*", (req, res) => {
      const pathName = String(req.path || req.originalUrl || "").split("?")[0];
      if (pathName.startsWith("/api/") || pathName === "/api") {
        return res.status(404).json({
          success: false,
          message: `API không tồn tại: ${req.method} ${pathName}`,
          details: "not_found",
        });
      }
      if (pathName.startsWith("/labels/") || pathName.startsWith("/prints/")) {
        return res.status(404).type("text/plain").send("Không tìm thấy file vận đơn.");
      }
      res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      return res.sendFile(path.join(distPath, "index.html"));
    });
  }

  /**
   * Kết nối MongoDB NGẦM — không block app.listen / Passenger boot.
   */
  async function connectDB(): Promise<void> {
    try {
      const ok = await initMongo(APP_ROOT);
      if (ok && isMongoReady()) {
        await hydrateChannelListingsOnBoot();
        // One-shot: dọn is_handed_over trên đơn đã SHIPPED (tránh kẹt tab ĐVVC).
        void clearHandedOverFlagsForShippedOrders()
          .then((r) => {
            if (r.modified > 0) {
              console.log(
                `[Boot] Cleared is_handed_over on ${r.modified} SHIPPED+ orders (matched=${r.matched}).`,
              );
            }
          })
          .catch((err) => {
            console.warn(
              "[Boot] clearHandedOverFlagsForShippedOrders failed:",
              err instanceof Error ? err.message : err,
            );
          });
        // GHN tracking backfill ON (setInterval 10 phút + boot kick). Cancel cron OFF.
        // Handed-over status reconcile ON (cron 5 phút + setInterval + boot kick) — dò SHIPPED → Đang giao.
        scheduleMissingShopeeTrackingEnrichment(); // GHN bù mã RTS/PROCESSED
        scheduleShopeeCancelReturnReconcile(); // no-op OFF
        scheduleAutoIncrementalOrdersSyncSafe(); // node-cron incremental ~2h / 5 phút
        scheduleReadyToShipBackfillSafe(); // READY_TO_SHIP lookback 7 ngày
        scheduleShopeeReturnRequestsSyncSafe(); // Return APIs → tab Yêu cầu trả hàng
        scheduleHandedOverStatusReconcileSafe(); // dò ĐVVC → SHIPPED (cron + interval)
        setTimeout(() => {
          void backfillCancelledEmptyItems({
            limit: 20,
            lookbackDays: 30,
            trigger: "boot",
          }).catch((err) => {
            console.warn(
              "[Boot] backfillCancelledEmptyItems failed:",
              err instanceof Error ? err.message : err,
            );
          });
        }, 120_000);
        setTimeout(() => {
          void backfillMissingReturnTracking30d({
            trigger: "boot",
            limitPerShop: 80,
          }).catch((err) => {
            console.warn(
              "[Boot] backfillMissingReturnTracking30d failed:",
              err instanceof Error ? err.message : err,
            );
          });
        }, 160_000);
        // Cứu 2 SN GHN — 1 lần, delay 90s để không chồng RTS/GHN boot (CageFS nproc).
        setTimeout(() => {
          void forceUpsertShopeeOrderSns(FORCE_RESCUE_SHOPEE_ORDER_SNS)
            .then((r) => {
              console.log(
                `[Boot Rescue] saved=[${r.saved.join(",") || "-"}] failed=[${r.failed.join(",") || "-"}]`,
              );
            })
            .catch((err) => {
              console.warn("[Boot Rescue] failed:", err instanceof Error ? err.message : err);
            });
        }, 90_000);
        // KHÔNG gọi scheduleClosedOrdersRetentionCleanup / scheduleMongoTempCollectionsCleanup.
      }
      console.log(
        `[MongoDB] connectDB xong — ready=${isMongoReady()} uri=${getMongoUriMasked()} | background order sync=ON (cron)`,
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("LỖI MONGODB STARTUP:", msg);
      writeCpanelCrashLog("Rejection", err);
    }
  }

  /**
   * cPanel / Phusion Passenger: BẮT BUỘC listen NGAY — không await DB trước listen.
   */
  function startListening(): void {
    console.log("[Orders] Background Sync & BulkWrite — cron + webhook + nút Đồng bộ (ACK).");

    const onReady = () => {
      resetHeavyJob();
      console.log("[Boot] Heavy-job lock reset.");

      console.log(
        process.env.PORT
          ? `Server optimized for cPanel Phusion Passenger: listening on ${PORT}`
          : `Server running locally on port ${PORT}`
      );
      console.log(`[Config] APP_BASE_URL=${APP_BASE_URL}`);
      console.log(`[Config] NODE_ENV=${process.env.NODE_ENV || "unset"}`);
      console.log(`[Shopee] Callback=${SHOPEE_CALLBACK_URL}`);
      console.log(`[Shopee] Webhook=${SHOPEE_WEBHOOK_URL}`);
      if (!process.env.PORT) {
        console.log("[Dashboard] API route ready: GET /api/dashboard?date_range=...");
      }
      console.log(`[MongoDB] listen OK — connecting DB in background (ready=${isMongoReady()})`);
      // DB non-blocking: fire-and-forget sau khi port đã mở
      void connectDB();

      // Sync đơn: webhook + nút Đồng bộ (ACK) + cron incremental 5 phút.
      console.log("[Boot] Order sync: webhook ON + manual trigger (BG) + cron incremental ON.");
      console.log("[Boot] Recovery pull OFF | GHN tracking backfill ON | CancelReturn cron OFF.");
      console.log("[Labels Cleanup] Auto cleanup ON — 02:00 + setInterval 24h, xóa PDF > 7 ngày trong storage/labels.");
      console.log(
        `[Shopee Webhook] orders write ${
          String(process.env.SHOPEE_WEBHOOK_ORDERS_ENABLED || "1").trim() === "0" ? "OFF (disabled)" : "ON"
        }`,
      );

      scheduleLabelPdfCleanup();
    };

    if (process.env.PORT) {
      app.listen(PORT, onReady);
    } else {
      app.listen(Number(PORT), "0.0.0.0", onReady);
    }
  }

  startListening();
}

startServer().catch((err) => {
  writeCpanelCrashLog("Exception", err);
  console.error("[Boot] startServer failed:", err);
});
