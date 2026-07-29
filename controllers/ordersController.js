/**
 * Controllers: Orders Core (CRUD / lookup / cleanup / hand-over).
 * Phase 5 — tách từ server.ts.
 */
import fs from "fs";
import path from "path";
import { resolveAppRoot } from "../utils/appPaths.js";
import {
  loadOrders,
  saveOrders,
  loadOrdersForApi,
  persistOrdersToDatabase,
  mirrorTrackingFieldsForRead,
  hydrateTrackingFromMongoToJson,
  purgeHandedOverGarbageOrdersOnce,
  purgeClosedOrdersByRetention,
  findOrderRecord,
  findOrderByScanLookup,
  handOverOrderToCarrierByIndex,
} from "../services/orders.js";
import {
  isMongoReady,
  loadOrdersFromStore,
  findOrderByScanCodeInStore,
  queryOrdersPageFromStore,
  loadOrderEvents,
  getSyncJob,
  deleteOrdersFromStore,
  purgeMongoTempCollections,
  ensureRetentionTtlIndexes,
  mergeDonHoanHuyIntoOrders,
  loadDonHoanHuyAsOrders,
  markOrderHandedOverInStore,
  markOrderLocalStatusInStore,
} from "../src/db/mongoStore.ts";

const APP_ROOT = resolveAppRoot();

let deps = {
  withLocalDbTimeout: async (p) => p,
  loadProductsForOrders: async () => [],
  enrichOrdersFromCatalog: (orders) => orders,
  enrichOrdersWithShopNames: (orders) => orders,
  isValidOrder: () => true,
  matchesProcessedPickupTabShared: () => false,
  matchesUnprocessedPickupTabShared: () => false,
  matchesShippingTabShared: () => false,
  matchesReceivedCancelReturnTabOrder: () => false,
  cleanupExpiredLabelFiles: () => 0,
  wipeLegacyPublicPrints: () => {},
  resolveOrderFromShopeeByScanCode: async () => null,
  enrichMissingShopeeTracking: async () => null,
  repairMissingShopeeTrackingInOrders: async () => 0,
  repairMisassignedTracking: (o) => o,
  buildHandedOverWritePatch: () => ({}),
  buildClearHandedOverPatch: () => ({}),
  HANDED_OVER_SOURCE: { MANUAL_BUTTON: "manual_button", QR_SCAN: "qr_scan" },
  applyShopeeOrderFinanceFields: () => {},
  sumOrderCustomCosts: () => 0,
  healInvalidHandedOverFlags: () => [],
  buildCarrierLogisticsPayload: () => null,
  generateCarrierTracking: () => "",
};

let ordersRefreshInFlight = null;
let ordersRefreshCache = null;

export function initOrdersController(partial) {
  deps = { ...deps, ...partial };
}

export function invalidateOrdersRefreshCache() {
  ordersRefreshCache = null;
}

async function readOrdersForRefresh(limit) {
  const now = Date.now();
  if (ordersRefreshCache && ordersRefreshCache.expiresAt > now) {
    return limit && limit > 0
      ? ordersRefreshCache.orders.slice(0, limit)
      : ordersRefreshCache.orders;
  }
  if (limit && limit > 0) {
    const orders = await loadOrdersFromStore({ limit });
    return orders.filter((order) => Boolean(order?.orderSn || order?.id));
  }
  if (!ordersRefreshInFlight) {
    ordersRefreshInFlight = loadOrdersFromStore()
      .then((orders) => {
        const validOrders = orders.filter((order) => Boolean(order?.orderSn || order?.id));
        ordersRefreshCache = {
          orders: validOrders,
          expiresAt: Date.now() + 1_500,
        };
        return validOrders;
      })
      .finally(() => {
        ordersRefreshInFlight = null;
      });
  }
  return ordersRefreshInFlight;
}

/** GET /api/orders/refresh */
export async function refreshOrders(req, res) {
  res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
  try {
    if (!isMongoReady()) {
      return res.status(200).json({
        success: false,
        data: [],
        total: 0,
        error: "mongodb_not_ready",
      });
    }
    const rawLimit = Number(req.query.limit);
    const limit =
      Number.isFinite(rawLimit) && rawLimit > 0
        ? Math.min(Math.floor(rawLimit), 5000)
        : undefined;
    const rawOrders = await readOrdersForRefresh(limit);
    let mergedOrders = rawOrders;
    try {
      mergedOrders = await mergeDonHoanHuyIntoOrders(rawOrders);
    } catch (mergeErr) {
      console.warn(
        "[GET /api/orders/refresh] mergeDonHoanHuy skipped:",
        mergeErr?.message || mergeErr,
      );
    }
    let products = [];
    if (!limit) {
      try {
        products = await deps.withLocalDbTimeout(
          deps.loadProductsForOrders(mergedOrders),
          2500,
          "orders_refresh_catalog",
        );
      } catch (catalogErr) {
        console.warn(
          "[GET /api/orders/refresh] Catalog enrich skipped:",
          catalogErr instanceof Error ? catalogErr.message : catalogErr,
        );
      }
    }
    const orders = deps.enrichOrdersWithShopNames(
      deps.enrichOrdersFromCatalog(mergedOrders, products),
    );
    console.log(
      `[FRONTEND FETCHED] GET /api/orders/refresh` +
        `${limit ? `?limit=${limit}` : ""} — trả về ${orders.length} đơn từ MongoDB.`,
    );
    return res.status(200).json({ success: true, data: orders, total: orders.length });
  } catch (error) {
    console.error(
      "[GET /api/orders/refresh] Mongo query failed:",
      error?.stack || error?.message || error,
    );
    return res.status(200).json({
      success: false,
      data: [],
      total: 0,
      error: "orders_refresh_failed",
      message: error?.message || "Không thể tải danh sách đơn hàng từ MongoDB.",
    });
  }
}

/** GET /api/orders/query */
export async function queryOrders(req, res) {
  try {
    if (!isMongoReady()) {
      return res.status(503).json({ success: false, error: "mongodb_not_ready", data: [] });
    }
    const page = await queryOrdersPageFromStore({
      page: Number(req.query.page),
      pageSize: Number(req.query.page_size ?? req.query.pageSize),
      tab: String(req.query.tab || ""),
      shopId: String(req.query.shop_id ?? req.query.shopId ?? ""),
      carrier: String(req.query.carrier || ""),
      query: String(req.query.q ?? req.query.query ?? ""),
    });
    const products = await deps.loadProductsForOrders(page.rows);
    const rows = deps.enrichOrdersWithShopNames(
      deps.enrichOrdersFromCatalog(page.rows, products),
    );
    return res.json({
      success: true,
      data: rows,
      total: page.total,
      page: page.page,
      page_size: page.pageSize,
      has_more: page.hasMore,
      counts: page.counts,
    });
  } catch (error) {
    console.error("[Orders Query] failed:", error?.stack || error?.message || error);
    return res.status(500).json({
      success: false,
      error: "orders_query_failed",
      message: error?.message || "Không thể truy vấn đơn hàng.",
    });
  }
}

/** GET /api/orders/:orderSn/events */
export async function getOrderEvents(req, res) {
  try {
    const events = await loadOrderEvents(
      String(req.params.orderSn || ""),
      Number(req.query.limit) || 50,
    );
    return res.json({ success: true, data: events });
  } catch (error) {
    return res
      .status(500)
      .json({ success: false, error: "order_events_failed", message: error?.message });
  }
}

/** GET /api/sync-jobs/:jobId */
export async function getSyncJobById(req, res) {
  const job = await getSyncJob(String(req.params.jobId || ""));
  if (!job) return res.status(404).json({ success: false, error: "sync_job_not_found" });
  return res.json({ success: true, data: job });
}

/** GET /api/orders */
export async function listOrders(req, res) {
  res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");

  let { orders: rawOrders } = await loadOrdersForApi({ readOnly: true });
  rawOrders = rawOrders.filter(deps.isValidOrder);

  const unprocessedPool = rawOrders.filter((o) => deps.matchesUnprocessedPickupTabShared(o));
  const processedPool = rawOrders.filter((o) => deps.matchesProcessedPickupTabShared(o));
  const readyToShipRaw = rawOrders.filter((o) => {
    const raw = String(o?.shopee_order_status || "").toUpperCase();
    return raw === "READY_TO_SHIP" || raw === "RETRY_SHIP";
  });
  console.log(
    `[GET /api/orders] tab-diag total=${rawOrders.length}` +
      ` READY_TO_SHIP|RETRY_SHIP(raw)=${readyToShipRaw.length}` +
      ` unprocessedTab=${unprocessedPool.length}` +
      ` processedTab=${processedPool.length}` +
      ` sampleUnprocessed=${JSON.stringify(
        unprocessedPool.slice(0, 3).map((o) => ({
          sn: o.orderSn,
          status: o.status,
          raw: o.shopee_order_status,
          tn: o.trackingNumber || o.tracking_no || null,
          prepared: o.isPrepared,
          fulfillment: o.fulfillment_type || o.ship_method || null,
        })),
      )}`,
  );

  const tab = String(req.query.tab || req.query.internal_tab || "").trim().toLowerCase();
  if (tab === "processed" || tab === "da-xu-ly" || tab === "processed_pickup") {
    rawOrders = rawOrders.filter((o) => deps.matchesProcessedPickupTabShared(o));
    console.log(
      `[GET /api/orders] query.tab=${tab} filter=matchesProcessedPickupTab → ${rawOrders.length} đơn`,
    );
  } else if (
    tab === "unprocessed" ||
    tab === "chua-xu-ly" ||
    tab === "ready_to_ship" ||
    tab === "cho-lay-hang"
  ) {
    rawOrders = rawOrders.filter((o) => deps.matchesUnprocessedPickupTabShared(o));
    console.log(
      `[GET /api/orders] query.tab=${tab} filter=matchesUnprocessedPickupTab → ${rawOrders.length} đơn` +
        ` | query={ shopee_order_status: READY_TO_SHIP|RETRY_SHIP, !PROCESSED, !tracking_outbound, !isProcessedCondition }`,
    );
  } else if (tab === "shipping" || tab === "shipped" || tab === "dang-giao") {
    rawOrders = rawOrders.filter((o) => deps.matchesShippingTabShared(o));
  } else if (
    tab === "received_cancel_returns" ||
    tab === "received-cancel-returns" ||
    tab === "da_nhan_huy_hoan"
  ) {
    try {
      rawOrders = await loadDonHoanHuyAsOrders(
        Number.isFinite(Number(req.query.limit))
          ? Math.min(Math.floor(Number(req.query.limit)), 5000)
          : 2000,
      );
      console.log(
        `[GET /api/orders] query.tab=${tab} source=don_hoan_huy → ${rawOrders.length} đơn`,
      );
    } catch (dhhErr) {
      console.error("[GET /api/orders] don_hoan_huy load failed:", dhhErr);
      rawOrders = rawOrders.filter((o) => deps.matchesReceivedCancelReturnTabOrder(o));
    }
  } else if (
    tab === "pending_confirm" ||
    tab === "pending_verification" ||
    tab === "cho-xac-nhan" ||
    tab === "pending_shopee_check" ||
    tab === "dang_kiem_tra_shopee" ||
    tab === "shopee_check"
  ) {
    rawOrders = rawOrders.filter((o) => {
      const raw = String(o.shopee_order_status || "").toUpperCase();
      if (raw === "CANCELLED" || raw === "IN_CANCEL" || o.status === "cancelled") {
        return false;
      }
      return (
        o.status === "pending_confirm" ||
        o.status === "pending_verification" ||
        ["UNPAID", "PENDING", "IN_REVIEW", "FRAUD_CHECK", "INVOICE_PENDING"].includes(raw)
      );
    });
  }

  const rawLimit = Number(req.query.limit);
  if (Number.isFinite(rawLimit) && rawLimit > 0) {
    rawOrders = rawOrders.slice(0, Math.min(Math.floor(rawLimit), 5000));
  }

  const products = await deps.loadProductsForOrders(rawOrders);
  const orders = deps.enrichOrdersWithShopNames(
    deps.enrichOrdersFromCatalog(rawOrders, products),
  );
  console.log(
    `[GET /api/orders] READ-ONLY return length=${orders.length} tab=${tab || "(all)"} mongoReady=${isMongoReady()}`,
  );
  return res.json(orders);
}

/** POST /api/orders/cleanup-handed-over */
export async function cleanupHandedOver(req, res) {
  try {
    for (const name of [".cleanup-handed-over-v1", ".cleanup-handed-over-v2"]) {
      try {
        const p = path.join(APP_ROOT, "data", name);
        if (fs.existsSync(p)) fs.unlinkSync(p);
      } catch {
        /* ignore */
      }
    }
    const result = await purgeHandedOverGarbageOrdersOnce({ force: true });
    console.log(`Deleted count: ${result.removed}`);
    return res.json({
      success: true,
      removed: result.removed,
      orderSns: result.sns,
      message:
        result.removed > 0
          ? `Đã xóa ${result.removed} đơn kẹt tab ĐÃ GIAO CHO ĐVVC.`
          : "Không còn đơn HANDED_OVER để xóa.",
    });
  } catch (error) {
    console.error("[Cleanup HandedOver] API error:", error);
    return res.status(500).json({
      success: false,
      error: error?.message || "cleanup_failed",
    });
  }
}

/** POST /api/orders/cleanup-closed-retention */
export async function cleanupClosedRetention(req, res) {
  try {
    const dryRun =
      req.body?.dry_run === true ||
      req.body?.dryRun === true ||
      String(req.query?.dry_run || "") === "1";
    const cancelReturnDays = Number(req.body?.cancel_return_days ?? req.body?.cancelReturnDays);
    const closedDays = Number(req.body?.closed_days ?? req.body?.closedDays);
    const result = await purgeClosedOrdersByRetention({
      dryRun,
      cancelReturnDays:
        Number.isFinite(cancelReturnDays) && cancelReturnDays > 0
          ? cancelReturnDays
          : undefined,
      closedDays: Number.isFinite(closedDays) && closedDays > 0 ? closedDays : undefined,
    });
    return res.json({
      success: true,
      ...result,
      orderSns: result.sns.slice(0, 100),
    });
  } catch (error) {
    console.error("[Orders Retention] API error:", error);
    return res.status(500).json({
      success: false,
      error: error?.message || "cleanup_closed_retention_failed",
      message: error?.message || "Không thể dọn đơn đã đóng.",
    });
  }
}

/** POST /api/mongo/cleanup-temp */
export async function cleanupMongoTemp(req, res) {
  try {
    if (!isMongoReady()) {
      return res.status(503).json({
        success: false,
        error: "mongodb_not_ready",
        message: "MongoDB chưa sẵn sàng.",
      });
    }
    const eventDays = Number(req.body?.order_event_days ?? req.body?.orderEventDays ?? 14);
    const jobDays = Number(req.body?.sync_job_days ?? req.body?.syncJobDays ?? 14);
    const ensureTtl = req.body?.ensure_ttl !== false && req.body?.ensureTtl !== false;
    const result = await purgeMongoTempCollections({
      orderEventDays: Number.isFinite(eventDays) && eventDays > 0 ? eventDays : 14,
      syncJobDays: Number.isFinite(jobDays) && jobDays > 0 ? jobDays : 14,
      ensureTtl,
    });
    return res.json({
      success: true,
      ...result,
      message:
        result.orderEventsDeleted > 0 || result.syncJobsDeleted > 0
          ? `Đã xóa ${result.orderEventsDeleted} order_events + ${result.syncJobsDeleted} sync_jobs.`
          : "Không còn bản ghi tạm quá hạn để xóa (TTL vẫn giữ 14 ngày).",
    });
  } catch (error) {
    console.error("[Mongo Temp Cleanup] API error:", error);
    return res.status(500).json({
      success: false,
      error: error?.message || "mongo_temp_cleanup_failed",
      message: error?.message || "Không thể dọn order_events/sync_jobs.",
    });
  }
}

/** POST /api/mongo/ensure-ttl */
export async function ensureMongoTtl(_req, res) {
  try {
    if (!isMongoReady()) {
      return res.status(503).json({ success: false, error: "mongodb_not_ready" });
    }
    const ttl = await ensureRetentionTtlIndexes();
    return res.json({ success: true, ...ttl });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error?.message || "ensure_ttl_failed",
    });
  }
}

/** POST /api/orders/cleanup-label-pdfs */
export async function cleanupLabelPdfs(_req, res) {
  try {
    const deleted = deps.cleanupExpiredLabelFiles();
    deps.wipeLegacyPublicPrints();
    return res.json({
      success: true,
      deleted,
      ttlHours: 24,
      storage: "disk",
      mongo: false,
      message: `Đã dọn PDF vận đơn >24h trên đĩa (không lưu Mongo). Xóa ${deleted} mục.`,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error?.message || "cleanup_label_pdfs_failed",
    });
  }
}

/** POST /api/orders/cleanup-processed-pickup */
export async function cleanupProcessedPickup(_req, res) {
  try {
    const orders = loadOrders();
    const garbage = orders.filter((o) => deps.matchesProcessedPickupTabShared(o));
    const kept = orders.filter((o) => !deps.matchesProcessedPickupTabShared(o));
    const sns = garbage.map((o) => String(o.orderSn || o.id || "").trim()).filter(Boolean);
    const ids = garbage.map((o) => String(o.id || "").trim()).filter(Boolean);

    if (garbage.length > 0) {
      saveOrders(kept);
    }

    let mongoDeleted = 0;
    if (isMongoReady() && (ids.length || sns.length)) {
      try {
        mongoDeleted = await deleteOrdersFromStore([...ids, ...sns]);
      } catch (err) {
        console.warn("[Cleanup Processed Pickup] Mongo:", err?.message || err);
      }
    }

    console.log(`Deleted count (JSON): ${garbage.length}`);
    console.log(`Deleted count (Mongo): ${mongoDeleted}`);
    console.log(`Deleted count: ${garbage.length}`);

    return res.json({
      success: true,
      removed: garbage.length,
      mongoDeleted,
      orderSns: sns,
      message:
        garbage.length > 0
          ? `Đã xóa ${garbage.length} đơn tab Chờ lấy hàng (Đã xử lý).`
          : "Không còn đơn Đã xử lý để xóa.",
    });
  } catch (error) {
    console.error("[Cleanup Processed Pickup] API error:", error);
    return res.status(500).json({
      success: false,
      error: error?.message || "cleanup_failed",
    });
  }
}

/** GET /api/orders/lookup */
export async function lookupOrder(req, res) {
  const code = String(req.query.code || req.query.q || "").trim();
  if (!code) {
    return res.status(400).json({ error: "Thiếu mã quét (code)." });
  }
  let foundRaw = null;
  try {
    foundRaw = await findOrderByScanCodeInStore(code);
    if (foundRaw && !deps.isValidOrder(foundRaw)) foundRaw = null;
    if (foundRaw) foundRaw = mirrorTrackingFieldsForRead(foundRaw);
  } catch (err) {
    console.warn("[Orders Lookup] mongo failed:", err?.message || err);
  }

  if (!foundRaw) {
    try {
      const { orders } = await loadOrdersForApi({ readOnly: true });
      const hit = await findOrderByScanLookup(
        (Array.isArray(orders) ? orders : []).filter(deps.isValidOrder),
        code,
      );
      if (hit && deps.isValidOrder(hit)) {
        foundRaw = mirrorTrackingFieldsForRead(hit);
      }
    } catch (err) {
      console.warn("[Orders Lookup] fallback failed:", err?.message || err);
    }
  }

  if (!foundRaw) {
    try {
      const fromShopee = await deps.resolveOrderFromShopeeByScanCode(code);
      if (fromShopee) {
        foundRaw = mirrorTrackingFieldsForRead(fromShopee);
        ordersRefreshCache = null;
      }
    } catch (err) {
      console.warn("[Orders Lookup] Shopee on-demand failed:", err?.message || err);
    }
  }

  if (!foundRaw) {
    return res.status(404).json({
      error: "Không tìm thấy đơn hàng khớp mã quét.",
      scannedCode: code,
    });
  }
  const products = await deps.loadProductsForOrders([foundRaw]);
  const found = deps.enrichOrdersFromCatalog([foundRaw], products)[0];
  return res.json(found);
}

/** POST /api/orders/cleanup-mock */
export async function cleanupMockOrders(_req, res) {
  const orders = loadOrders();
  const validOrders = orders.filter(deps.isValidOrder);
  const removedOrders = orders.filter((o) => !deps.isValidOrder(o));

  saveOrders(validOrders);
  console.log(
    `[Orders Cleanup] Đã xóa ${removedOrders.length} đơn hàng lỗi/mock (0đ và không có sản phẩm). Còn lại ${validOrders.length} đơn thật.`,
    removedOrders.map((o) => o.orderSn || o.id),
  );

  return res.json({
    removed: removedOrders.length,
    remaining: validOrders.length,
    removedOrderSns: removedOrders.map((o) => o.orderSn || o.id),
  });
}

/** POST /api/orders/hydrate-tracking */
export async function hydrateTracking(_req, res) {
  try {
    const result = await hydrateTrackingFromMongoToJson();
    console.log(
      `[Orders] hydrate-tracking mirrored=${result.mirrored} filled=${result.filled}/${result.total}`,
    );
    return res.json({ success: true, ...result });
  } catch (err) {
    console.error("[Orders] hydrate-tracking failed:", err?.message || err);
    return res.status(500).json({
      success: false,
      error: err?.message || String(err),
    });
  }
}

/** POST /api/orders/enrich-tracking */
export async function enrichTracking(req, res) {
  try {
    const maxRaw = Number(req.body?.max ?? req.query?.max ?? 100);
    const max = Number.isFinite(maxRaw) ? Math.min(Math.max(1, Math.floor(maxRaw)), 200) : 100;

    let enrichResult = null;
    try {
      enrichResult = await deps.enrichMissingShopeeTracking();
    } catch (enrichErr) {
      console.warn(
        "[Orders] enrich-tracking enrichMissingShopeeTracking:",
        enrichErr?.message || enrichErr,
      );
    }

    let repaired = 0;
    try {
      const { orders } = await loadOrdersForApi();
      repaired = await deps.repairMissingShopeeTrackingInOrders(orders, {
        max,
        retries: 2,
      });
    } catch (repairErr) {
      console.warn(
        "[Orders] enrich-tracking repairMissing:",
        repairErr?.message || repairErr,
      );
    }

    ordersRefreshCache = null;
    const filled =
      Number(enrichResult?.filled || 0) +
      Number(enrichResult?.returnFilled || 0) +
      repaired;
    console.log(
      `[Orders] enrich-tracking filled=${filled} scheduler=${JSON.stringify(enrichResult)} repaired=${repaired}`,
    );
    return res.json({
      success: true,
      filled,
      repaired,
      scheduler: enrichResult || undefined,
      message:
        filled > 0
          ? `Đã bù ${filled} mã vận đơn từ Shopee.`
          : "Không có đơn nào cần bù mã (hoặc Shopee chưa trả tracking).",
    });
  } catch (err) {
    console.error("[Orders] enrich-tracking failed:", err?.message || err);
    return res.status(500).json({
      success: false,
      error: err?.message || String(err),
      message: "Không thể bù mã vận đơn từ Shopee.",
    });
  }
}

/** PATCH /api/orders/:id */
export async function patchOrder(req, res) {
  const orders = loadOrders();
  const key = String(req.params.id || "").trim();
  const index = orders.findIndex(
    (o) =>
      o.id === key ||
      o.orderSn === key ||
      o.id === `shopee-${key}` ||
      String(o.orderSn || "") === key.replace(/^shopee-/i, ""),
  );
  if (index === -1) {
    return res.status(404).json({ error: "Không tìm thấy đơn hàng." });
  }
  const patch = { ...req.body };
  delete patch.id;
  const patchTn = String(patch.tracking_no || patch.trackingNumber || "").trim();
  if (patchTn && !/^0FG/i.test(patchTn)) {
    patch.tracking_no = patchTn;
    patch.trackingNumber = patchTn;
  }
  const localPatch = String(patch.local_status || patch.localStatus || "").toUpperCase();
  const wantHanded =
    patch.is_handed_over === true ||
    patch.isHandedOverToCarrier === true ||
    patch.is_handed_over_to_carrier === true ||
    localPatch === "HANDED_OVER";
  if (wantHanded) {
    Object.assign(
      patch,
      deps.buildHandedOverWritePatch(undefined, deps.HANDED_OVER_SOURCE.MANUAL_BUTTON),
    );
  }
  const wantLocalStored =
    localPatch === "CANCELLED_STORED" ||
    localPatch === "RETURN_RECEIVED" ||
    localPatch === "NONE";
  if (wantLocalStored) {
    const nowIso = new Date().toISOString();
    patch.local_status = localPatch;
    patch.localStatus = localPatch;
    patch.internal_status = localPatch;
    patch.localStatusAt = patch.localStatusAt || nowIso;
    patch.local_status_updated_at = patch.local_status_updated_at || nowIso;
    if (localPatch === "CANCELLED_STORED" || localPatch === "RETURN_RECEIVED") {
      patch.is_local_return_archived = false;
      Object.assign(patch, deps.buildClearHandedOverPatch(nowIso));
      patch.local_status = localPatch;
      patch.localStatus = localPatch;
      patch.internal_status = localPatch;
      patch.localStatusAt = nowIso;
      patch.local_status_updated_at = nowIso;
      patch.is_local_return_archived = false;
    }
    if (localPatch === "RETURN_RECEIVED") {
      patch.status = "return_received";
    }
  }
  orders[index] = { ...orders[index], ...patch, id: orders[index].id };
  {
    const tn = String(
      orders[index].tracking_no || orders[index].trackingNumber || "",
    ).trim();
    if (tn && !/^0FG/i.test(tn)) {
      orders[index].tracking_no = tn;
      orders[index].trackingNumber = tn;
    }
    deps.repairMisassignedTracking(orders[index]);
  }
  if ("custom_costs" in patch || "custom_cost_items" in patch) {
    deps.applyShopeeOrderFinanceFields(orders[index], {
      totalAmount: orders[index].totalAmount,
      itemAmount: orders[index].item_amount,
      withholdingCitTax: orders[index].withholdingCitTax,
      escrowAmount: orders[index].escrowAmount,
      shopeeFees: orders[index].shopee_fees,
      escrowSynced: orders[index].escrow_synced,
      customCosts: deps.sumOrderCustomCosts(orders[index]),
    });
  }
  await persistOrdersToDatabase(orders, [orders[index]]);
  if (wantHanded && isMongoReady()) {
    try {
      await markOrderHandedOverInStore(String(orders[index].orderSn || ""), {
        source: deps.HANDED_OVER_SOURCE.MANUAL_BUTTON,
        handedOverAt: String(orders[index].handedOverAt || ""),
        shopId: orders[index].shopId != null ? String(orders[index].shopId) : undefined,
      });
    } catch (err) {
      console.error("[Orders PATCH] markOrderHandedOver failed:", err?.message || err);
    }
  }
  if (
    isMongoReady() &&
    (localPatch === "CANCELLED_STORED" || localPatch === "RETURN_RECEIVED")
  ) {
    try {
      await markOrderLocalStatusInStore(
        String(orders[index].orderSn || ""),
        localPatch,
        {
          shopId: orders[index].shopId != null ? String(orders[index].shopId) : undefined,
          clearHandedOver: true,
          status:
            localPatch === "RETURN_RECEIVED"
              ? "return_received"
              : String(orders[index].status || "cancelled"),
        },
      );
    } catch (err) {
      console.error("[Orders PATCH] markOrderLocalStatus failed:", err?.message || err);
    }
  }
  return res.json(orders[index]);
}

/** DELETE /api/orders/:id */
export async function deleteOrder(req, res) {
  const key = String(req.params.id || "").trim();
  if (!key) {
    return res.status(400).json({ success: false, error: "Thiếu id đơn." });
  }
  const orders = loadOrders();
  const index = orders.findIndex(
    (o) =>
      o.id === key ||
      o.orderSn === key ||
      o.id === `shopee-${key}` ||
      String(o.orderSn || "") === key.replace(/^shopee-/i, ""),
  );
  const normalizedKey = key.replace(/^shopee-/i, "");
  let mongoDeleted = 0;
  if (isMongoReady()) {
    try {
      mongoDeleted = await deleteOrdersFromStore([key, normalizedKey]);
    } catch (err) {
      console.warn("[Orders DELETE] Mongo:", err?.message || err);
    }
  }
  if (index === -1) {
    if (mongoDeleted > 0) {
      console.log(`Deleted count: ${mongoDeleted} (Mongo-only orderSn=${normalizedKey})`);
      return res.json({
        success: true,
        removed: mongoDeleted,
        orderSn: normalizedKey,
        mongoDeleted,
      });
    }
    return res.status(404).json({ success: false, error: "Không tìm thấy đơn hàng." });
  }
  const removed = orders[index];
  const sn = String(removed.orderSn || removed.id || "").trim();
  orders.splice(index, 1);
  saveOrders(orders);
  console.log(`Deleted count: 1 (orderSn=${sn}, mongoDeleted=${mongoDeleted})`);
  return res.json({
    success: true,
    removed: 1,
    orderSn: sn,
    mongoDeleted,
  });
}

/** POST /api/orders/:id/hand-over-carrier */
export async function handOverCarrierById(req, res) {
  try {
    const loaded = await loadOrdersForApi();
    const orders = loaded.orders;
    const hit = findOrderRecord(orders, String(req.params.id || ""));
    const trackingHint = String(
      req.body?.trackingNumber ||
        req.body?.tracking_no ||
        req.body?.waybill ||
        req.body?.code ||
        "",
    ).trim();
    const result = await handOverOrderToCarrierByIndex(orders, hit ? hit.index : -1, {
      source: "manual_button",
      trackingHint,
    });
    if (!result.ok) {
      return res
        .status(result.status)
        .json({ success: false, error: result.error, message: result.error });
    }
    const products = await deps.loadProductsForOrders([result.order]);
    const enriched = deps.enrichOrdersFromCatalog([result.order], products)[0];
    return res.json({ success: true, order: enriched });
  } catch (error) {
    console.error("[Orders Handover] single error:", error);
    return res.status(500).json({
      success: false,
      error: error?.message || "hand_over_failed",
      message: error?.message || "Không thể ghi nhận bàn giao ĐVVC.",
    });
  }
}

/** POST /api/orders/hand-over-carrier */
export async function handOverCarrierByCode(req, res) {
  try {
    const code = String(req.body?.code || req.body?.scanCode || req.body?.q || "").trim();
    const orderId = String(
      req.body?.orderId || req.body?.id || req.body?.orderSn || req.body?.order_sn || "",
    ).trim();
    const loaded = await loadOrdersForApi();
    const orders = loaded.orders;

    let index = -1;
    if (orderId) {
      const hit = findOrderRecord(orders, orderId);
      index = hit ? hit.index : -1;
    } else if (code) {
      const found = await findOrderByScanLookup(orders.filter(deps.isValidOrder), code);
      if (found) {
        const hit = findOrderRecord(orders, String(found.id || found.orderSn || ""));
        index = hit ? hit.index : orders.findIndex((o) => o.id === found.id);
      }
    } else {
      return res.status(400).json({
        success: false,
        error: "Thiếu orderId hoặc mã quét (code).",
        message: "Thiếu orderId hoặc mã quét (code).",
      });
    }

    const result = await handOverOrderToCarrierByIndex(orders, index, {
      source: code ? "qr_scan" : "manual_button",
      trackingHint:
        code || String(req.body?.trackingNumber || req.body?.tracking_no || "").trim(),
    });
    if (!result.ok) {
      return res
        .status(result.status)
        .json({ success: false, error: result.error, message: result.error });
    }
    const products = await deps.loadProductsForOrders([result.order]);
    const enriched = deps.enrichOrdersFromCatalog([result.order], products)[0];
    return res.json({ success: true, order: enriched });
  } catch (error) {
    console.error("[Orders Handover] by-code error:", error);
    return res.status(500).json({
      success: false,
      error: error?.message || "hand_over_failed",
      message: error?.message || "Không thể ghi nhận bàn giao ĐVVC.",
    });
  }
}

/** POST /api/orders/hand-over-carrier/bulk */
export async function handOverCarrierBulk(req, res) {
  try {
    const rawIds = Array.isArray(req.body?.orderIds)
      ? req.body.orderIds
      : Array.isArray(req.body?.ids)
        ? req.body.ids
        : [];
    const rawSns = Array.isArray(req.body?.orderSns) ? req.body.orderSns : [];
    const keys = [
      ...new Set(
        (rawIds.length ? rawIds : rawSns)
          .map((v) => String(v || "").trim())
          .filter(Boolean),
      ),
    ];
    if (!keys.length && rawSns.length) {
      keys.push(
        ...new Set(rawSns.map((v) => String(v || "").trim()).filter(Boolean)),
      );
    }
    if (!keys.length) {
      return res.status(400).json({
        success: false,
        error: "Thiếu danh sách đơn (orderIds / orderSns).",
        message: "Thiếu danh sách đơn (orderIds / orderSns).",
      });
    }

    const loaded = await loadOrdersForApi();
    const orders = loaded.orders;
    const updatedOrders = [];
    const failed = [];
    let skipped = 0;
    const seenIdx = new Set();

    for (const key of keys) {
      const hit = findOrderRecord(orders, key);
      if (!hit) {
        failed.push({ key, error: "Không tìm thấy đơn hàng." });
        continue;
      }
      if (seenIdx.has(hit.index)) {
        skipped++;
        continue;
      }
      seenIdx.add(hit.index);
      const result = await handOverOrderToCarrierByIndex(orders, hit.index, {
        persist: false,
        source: "manual_button",
      });
      if (!result.ok) {
        failed.push({ key, error: result.error });
        continue;
      }
      if (result.changed) updatedOrders.push(result.order);
      else skipped++;
    }

    if (updatedOrders.length) {
      await persistOrdersToDatabase(orders, updatedOrders);
    }

    const products = await deps.loadProductsForOrders(updatedOrders);
    const enriched = deps.enrichOrdersFromCatalog(updatedOrders, products);
    console.log(
      `[Orders Handover Bulk] keys=${keys.length} updated=${updatedOrders.length} skipped=${skipped} failed=${failed.length}`,
    );

    if (updatedOrders.length === 0 && skipped === 0) {
      return res.status(400).json({
        success: false,
        updated: 0,
        skipped: 0,
        failed,
        orders: [],
        error: failed[0]?.error || "Không bàn giao được đơn nào.",
        message: failed[0]?.error || "Không bàn giao được đơn nào.",
      });
    }

    return res.json({
      success: true,
      updated: updatedOrders.length,
      skipped,
      failed,
      orders: enriched,
    });
  } catch (error) {
    console.error("[Orders Handover Bulk] error:", error);
    return res.status(500).json({
      success: false,
      error: error?.message || "hand_over_bulk_failed",
      message: error?.message || "Không thể bàn giao ĐVVC hàng loạt.",
    });
  }
}

/** POST /api/orders/heal-handed-over */
export async function healHandedOver(_req, res) {
  try {
    const loaded = await loadOrdersForApi();
    const orders = loaded.orders;
    const healed = deps.healInvalidHandedOverFlags(orders);
    if (healed.length) {
      await persistOrdersToDatabase(orders, healed);
    }
    return res.json({
      success: true,
      healed: healed.length,
      orderSns: healed.map((o) => o.orderSn || o.id).filter(Boolean),
      message:
        healed.length > 0
          ? `Đã gỡ ${healed.length} cờ ĐVVC lưu sai.`
          : "Không còn cờ ĐVVC lưu sai.",
    });
  } catch (error) {
    console.error("[Heal HandedOver] error:", error);
    return res.status(500).json({
      success: false,
      error: error?.message || "heal_failed",
    });
  }
}

/** POST /api/orders/manual */
export async function createManualOrder(req, res) {
  try {
    const body = req.body || {};
    const {
      shippingAddress,
      items,
      carrier = "self",
      packageWeight = 500,
      shippingFee = 0,
      shippingFeePayer = "customer",
      orderDiscount = 0,
      carrierNotes = "",
    } = body;

    const addr = shippingAddress || {};
    if (!addr.provinceCode || !addr.districtCode || !addr.wardCode || !addr.street?.trim()) {
      return res.status(400).json({
        error:
          "Địa chỉ chưa đầy đủ. Vui lòng chọn Tỉnh, Quận/Huyện, Phường/Xã và nhập địa chỉ chi tiết.",
      });
    }

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: "Đơn hàng cần ít nhất 1 sản phẩm." });
    }

    const subtotal = items.reduce(
      (acc, it) => acc + Number(it.price || 0) * Number(it.quantity || 0),
      0,
    );
    const feeToCollect = shippingFeePayer === "customer" ? Number(shippingFee) : 0;
    const totalAmount = subtotal + feeToCollect - Number(orderDiscount);

    const fullAddress = [addr.street, addr.ward, addr.district, addr.province]
      .filter(Boolean)
      .join(", ");

    const trackingNumber = deps.generateCarrierTracking(carrier);
    const logisticsPayload =
      carrier !== "self"
        ? deps.buildCarrierLogisticsPayload(
            carrier,
            { name: "Khách sỉ", phone: "0900000000" },
            {
              street: addr.street.trim(),
              province: addr.province,
              provinceCode: String(addr.provinceCode),
              district: addr.district,
              districtCode: String(addr.districtCode),
              ward: addr.ward,
              wardCode: String(addr.wardCode),
            },
            {
              weight: Number(packageWeight) || 500,
              note: carrierNotes || "",
              codAmount: totalAmount,
            },
          )
        : null;

    if (logisticsPayload) {
      console.log(
        `[Logistics ${carrier.toUpperCase()}] Payload đẩy đơn:`,
        JSON.stringify(logisticsPayload, null, 2),
      );
    }

    const newOrder = {
      id: `order-manual-${Date.now()}`,
      orderSn: `DON-NGOAI-${Math.floor(100000 + Math.random() * 900000)}`,
      channel: "manual",
      shippingAddress: {
        province: addr.province,
        provinceCode: String(addr.provinceCode),
        district: addr.district,
        districtCode: String(addr.districtCode),
        ward: addr.ward,
        wardCode: String(addr.wardCode),
        street: addr.street.trim(),
        fullAddress,
      },
      carrier,
      totalAmount,
      revenue: totalAmount,
      status: "unprocessed",
      date: new Date().toISOString(),
      trackingNumber,
      isPrepared: carrier !== "self",
      isPrinted: false,
      items: items.map((it) => ({
        productId: it.productId,
        productTitle: it.productTitle,
        productImage: it.productImage,
        quantity: Number(it.quantity),
        price: Number(it.price),
      })),
      logisticsPayload,
    };

    const orders = loadOrders();
    orders.unshift(newOrder);
    saveOrders(orders);

    return res.json({
      success: true,
      order: newOrder,
      trackingNumber,
      logisticsPayload,
      orders: orders.filter(deps.isValidOrder),
    });
  } catch (error) {
    console.error("[Orders manual]", error);
    return res.status(500).json({ error: error.message || "Tạo đơn thủ công thất bại" });
  }
}
