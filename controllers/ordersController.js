/**
 * Controllers: Orders Core (CRUD / lookup / cleanup / hand-over).
 * Phase 5 — tách từ server.ts.
 */
import fs from "fs";
import path from "path";
import { PDF_DIR, resolveAppRoot } from "../utils/appPaths.js";
import {
  loadOrders,
  saveOrders,
  loadOrdersForApi,
  loadOrdersForShipScoped,
  persistOrdersToDatabase,
  persistChangedOrdersPatch,
  mirrorTrackingFieldsForRead,
  hydrateTrackingFromMongoToJson,
  purgeHandedOverGarbageOrdersOnce,
  purgeClosedOrdersByRetention,
  findOrderRecord,
  handOverOrderToCarrierByIndex,
  handOverOrderToCarrierFast,
  mapHandoverWriteError,
} from "../services/orders.js";
import {
  isMongoReady,
  loadOrdersFromStore,
  findOrderByScanCodeInStore,
  listScannerSyncRowsFromStore,
  queryOrdersPageFromStore,
  countOrdersByTabsFromStore,
  aggregateFulfillmentProductsFromStore,
  reclassifyCancelReturnsInStore,
  parseCancelReturnKindParam,
  loadPriorityTabOrdersFromStore,
  orderTabFilter,
  loadOrderEvents,
  getSyncJob,
  deleteOrdersFromStore,
  purgeMongoTempCollections,
  ensureRetentionTtlIndexes,
  mergeDonHoanHuyIntoOrders,
  loadDonHoanHuyAsOrders,
  markOrderHandedOverInStore,
  markOrderLocalStatusInStore,
  markOrdersPrintedInStore,
  upsertDonHoanHuy,
  invalidateTabCountCache,
} from "../src/db/mongoStore.ts";
import { saveAddressBookEntry } from "../services/addressBook.js";
import { createGhnShippingOrder, getGhnPrintUrl } from "../services/ghnLogistics.js";
import { createSpxShippingOrder, getSpxWaybill } from "../services/spxLogistics.js";
import { loadSpxCredentialsFromMongo } from "../services/logisticsConfig.js";

const APP_ROOT = resolveAppRoot();

/** Trạng thái PDF trả về UI phải phản ánh file thật trên ổ đĩa, không dùng cờ Mongo cũ. */
function hasOrderPdfOnDisk(order) {
  const filenames = new Set();
  const addFilename = (raw) => {
    if (!raw) return;
    let value = String(raw).trim();
    try {
      value = decodeURIComponent(value);
    } catch {
      /* giữ nguyên giá trị nếu URL encode không hợp lệ */
    }
    const fromUrl = value.match(/\/api\/public\/labels\/([^/?#]+)/i)?.[1];
    const filename = path.basename(fromUrl || value);
    if (/\.pdf$/i.test(filename)) filenames.add(filename);
  };

  addFilename(order?.pdfFilename);
  addFilename(order?.data?.pdfFilename);
  addFilename(order?.labelUrl);
  addFilename(order?.pdfUrl);
  addFilename(order?.waybill_url);
  addFilename(order?.data?.labelUrl);
  addFilename(order?.data?.pdfUrl);
  addFilename(order?.data?.waybill_url);

  const orderSn = String(order?.orderSn || order?.id || "")
    .replace(/^shopee-/i, "")
    .replace(/[^a-zA-Z0-9_-]/g, "");
  if (orderSn) {
    filenames.add(`order_${orderSn}.pdf`);
    filenames.add(`${orderSn}.pdf`);
  }

  for (const filename of filenames) {
    if (fs.existsSync(path.join(PDF_DIR, filename))) return true;
  }
  return false;
}

function attachPdfAvailability(orders) {
  return orders.map((order) => ({
    ...order,
    hasPdf: hasOrderPdfOnDisk(order),
  }));
}

/** Parse shop_ids từ query/body — CSV, array, hoặc shop_id đơn. */
function parseShopIdsParam(rawShopIds, rawShopId) {
  const out = [];
  const seen = new Set();
  const push = (v) => {
    const s = String(v || "").trim();
    if (!s || s === "all" || seen.has(s)) return;
    seen.add(s);
    out.push(s);
  };
  if (Array.isArray(rawShopIds)) {
    for (const v of rawShopIds) push(v);
  } else if (rawShopIds != null && String(rawShopIds).trim() !== "") {
    for (const part of String(rawShopIds).split(",")) push(part);
  }
  if (out.length === 0) push(rawShopId);
  return out;
}

function readOrderDateQuery(req) {
  const startDate = String(req?.query?.startDate ?? req?.query?.start_date ?? "").trim();
  const endDate = String(req?.query?.endDate ?? req?.query?.end_date ?? "").trim();
  return {
    ...(startDate ? { startDate } : {}),
    ...(endDate ? { endDate } : {}),
  };
}

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
  healCancelledReturnTrackingOrders: async () => ({
    candidates: 0,
    attempted: 0,
    filled: 0,
    stillEmpty: 0,
    errors: 0,
    skipped: false,
    samples: [],
  }),
  forceResyncStuckOrdersWithoutTracking: async () => ({
    attempted: 0,
    healed: 0,
    results: [],
  }),
  triggerFixStuckOrders: async () => ({
    attempted: 0,
    healed: 0,
    results: [],
  }),
  reconcileHandedOverCarrierStatuses: async () => ({
    success: true,
    skipped: true,
    pulled: 0,
    updated: 0,
    shipped: 0,
    candidates: 0,
    errors: [],
    message: "not_initialized",
  }),
  cleanupStuckShippedOrders: async () => ({
    success: false,
    skipped: true,
    message: "not_initialized",
  }),
  getCleanupStuckShippedStatus: () => ({
    inFlight: false,
    result: null,
  }),
  beginCleanupStuckShippedJob: () => true,
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

const EXTERNAL_STATUS_MAP = {
  created: { status: "unprocessed", shopee: "EXTERNAL_CREATED", label: "Đã tạo đơn" },
  shipping: { status: "shipping", shopee: "EXTERNAL_SHIPPING", label: "Đang giao" },
  delivered: { status: "completed", shopee: "EXTERNAL_DELIVERED", label: "Giao thành công" },
  rts: { status: "cancelled", shopee: "EXTERNAL_RTS", label: "Giao không thành công / RTS" },
};

function mapExternalStatus(raw) {
  const key = String(raw || "created").toLowerCase();
  return EXTERNAL_STATUS_MAP[key] || EXTERNAL_STATUS_MAP.created;
}

function carrierDisplayName(carrier) {
  if (carrier === "ghn") return "Giao Hàng Nhanh";
  if (carrier === "spx") return "SPX Express";
  return "Tự giao hàng";
}

async function persistExternalOrder(order) {
  if (!isMongoReady()) {
    throw new Error("mongodb_not_ready");
  }
  await persistChangedOrdersPatch([order]);
  try {
    invalidateTabCountCache();
  } catch {
    /* cache optional */
  }
}

let ordersRefreshInFlight = null;
let ordersRefreshCache = null;
const ordersRefreshCoalesce = new Map();
const ordersCounterCoalesce = new Map();

function coalesceInFlight(map, key, factory) {
  const existing = map.get(key);
  if (existing) return existing;
  const run = Promise.resolve()
    .then(factory)
    .finally(() => {
      if (map.get(key) === run) map.delete(key);
    });
  map.set(key, run);
  return run;
}

export function initOrdersController(partial) {
  deps = { ...deps, ...partial };
}

export function invalidateOrdersRefreshCache() {
  ordersRefreshCache = null;
}

async function readOrdersForRefresh(limit, opts = {}) {
  const tab = String(opts.tab || "").trim().toLowerCase();
  const shopId = String(opts.shopId || "").trim();
  const shopIds = Array.isArray(opts.shopIds) ? opts.shopIds : [];

  // Read theo tab = cùng filter với /api/order-counts (Sapo: count ≡ list).
  if (tab) {
    if (
      tab === "received_cancel_returns" ||
      tab === "received-cancel-returns" ||
      tab === "da_nhan_huy_hoan"
    ) {
      const pageSize =
        Number.isFinite(Number(limit)) && Number(limit) > 0
          ? Math.min(Math.floor(Number(limit)), 5000)
          : 2000;
      const dhh = await loadDonHoanHuyAsOrders(pageSize);
      console.log(
        `[GET /api/orders/refresh] tab=${tab} source=don_hoan_huy → ${dhh.length} đơn`,
      );
      return dhh.filter((order) => Boolean(order?.orderSn || order?.id));
    }
    const tabFilter = orderTabFilter(tab);
    console.log(
      `[GET /api/orders/refresh] tab=${tab} shopId=${shopId || "(all)"}` +
        ` shopIds=${shopIds.length ? `[${shopIds.join(",")}]` : "(none)"} filter=`,
      JSON.stringify(tabFilter),
    );
    const pageSize =
      Number.isFinite(Number(limit)) && Number(limit) > 0
        ? Math.min(Math.floor(Number(limit)), 5000)
        : 2000;
    const page = await queryOrdersPageFromStore({
      page: 1,
      pageSize,
      tab,
      shopId,
      shopIds: shopIds.length ? shopIds : undefined,
      printStatus: String(opts.printStatus || ""),
      skipCounts: true,
    });
    console.log(
      `[GET /api/orders/refresh] tab=${tab} → rows=${page.rows.length} total=${page.total} counts=`,
      page.counts,
    );
    return page.rows.filter((order) => Boolean(order?.orderSn || order?.id));
  }

  const now = Date.now();
  if (ordersRefreshCache && ordersRefreshCache.expiresAt > now && !shopId) {
    const cached = ordersRefreshCache.orders;
    if (limit && limit > 0) {
      // Shallow: vẫn merge đơn tab ưu tiên để badge/list không lệch.
      try {
        const priority = await loadPriorityTabOrdersFromStore({
          perTabLimit: Math.min(5000, Math.max(2000, limit)),
        });
        const byId = new Map();
        for (const o of priority) {
          const id = String(o?.id || o?.orderSn || "").trim();
          if (id) byId.set(id, o);
        }
        for (const o of cached.slice(0, limit)) {
          const id = String(o?.id || o?.orderSn || "").trim();
          if (id && !byId.has(id)) byId.set(id, o);
        }
        return [...byId.values()];
      } catch (prioErr) {
        console.warn(
          "[GET /api/orders/refresh] priority merge (cache) skipped:",
          prioErr?.message || prioErr,
        );
        return cached.slice(0, limit);
      }
    }
    return cached;
  }
  if (limit && limit > 0) {
    const recent = await loadOrdersFromStore({ limit });
    let priority = [];
    try {
      priority = await loadPriorityTabOrdersFromStore({
        perTabLimit: Math.min(5000, Math.max(2000, limit)),
        shopId: shopId || undefined,
        shopIds: shopIds.length > 1 ? shopIds : undefined,
      });
    } catch (prioErr) {
      console.warn(
        "[GET /api/orders/refresh] priority merge skipped:",
        prioErr?.message || prioErr,
      );
    }
    const byId = new Map();
    for (const o of priority) {
      const id = String(o?.id || o?.orderSn || "").trim();
      if (id) byId.set(id, o);
    }
    for (const o of recent) {
      const id = String(o?.id || o?.orderSn || "").trim();
      if (id && !byId.has(id)) byId.set(id, o);
    }
    const merged = [...byId.values()].filter((order) =>
      Boolean(order?.orderSn || order?.id),
    );
    console.log(
      `[GET /api/orders/refresh] shallow limit=${limit} recent=${recent.length}` +
        ` priority=${priority.length} merged=${merged.length}`,
    );
    return merged;
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

/** Lọc theo cờ isPrinted — khớp SSOT docToOrder / badge UI. */
function isOrderPrintedFlag(order) {
  if (!order || typeof order !== "object") return false;
  if (order.isPrinted === true || order.isPrinted === 1) return true;
  if (typeof order.isPrinted === "string") {
    const s = String(order.isPrinted).trim().toLowerCase();
    return s === "true" || s === "1" || s === "yes";
  }
  return false;
}

/** Lọc theo cờ isPrinted trong Mongo — không gọi Shopee. */
function filterOrdersByPrintStatus(orders, printStatusRaw) {
  const printStatus = String(printStatusRaw || "").trim().toLowerCase();
  if (!printStatus || printStatus === "all") return orders;
  if (printStatus === "printed" || printStatus === "da-in" || printStatus === "true") {
    return orders.filter((o) => isOrderPrintedFlag(o));
  }
  if (
    printStatus === "unprinted" ||
    printStatus === "chua-in" ||
    printStatus === "false" ||
    printStatus === "not_printed"
  ) {
    return orders.filter((o) => !isOrderPrintedFlag(o));
  }
  return orders;
}

/** GET /api/orders/refresh */
export async function refreshOrders(req, res) {
  res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  try {
    if (!isMongoReady()) {
      return res.status(200).json({
        success: false,
        data: [],
        total: 0,
        error: "mongodb_not_ready",
      });
    }
    // FE gửi ?t= / ?bust= → bỏ cache in-memory để luôn đọc Mongo mới
    if (req.query.t != null || req.query.bust != null) {
      ordersRefreshCache = null;
    }
    // ERP list: mặc định/cố định 50. Cho phép limit cao hơn khi FE gửi (vd: quét mã merge).
    const pageRaw = Number(req.query.page);
    const rawLimit = Number(req.query.limit);
    const page =
      Number.isFinite(pageRaw) && pageRaw > 0 ? Math.floor(pageRaw) : 1;
    const limit =
      Number.isFinite(rawLimit) && rawLimit > 0
        ? Math.min(Math.floor(rawLimit), 5000)
        : 2000;
    const tab = String(req.query.tab || req.query.internal_tab || "").trim();
    const kind = parseCancelReturnKindParam(
      req.query.kind || req.query.cancel_kind || req.query.sub_tab,
    );
    const searchQ = String(req.query.q ?? req.query.query ?? "").trim();
    const shopIds = parseShopIdsParam(
      req.query.shop_ids ?? req.query.shopIds,
      req.query.shop_id ?? req.query.shopId,
    );
    const shopId = shopIds.length === 1 ? shopIds[0] : String(req.query.shop_id ?? req.query.shopId ?? "").trim();
    const printStatus = String(req.query.print_status || req.query.printStatus || "").trim();
    const coalesceKey = [
      page,
      limit,
      tab,
      kind || "",
      searchQ,
      shopIds.join(",") || shopId,
      printStatus,
      req.query.startDate || req.query.start_date || "",
      req.query.endDate || req.query.end_date || "",
    ].join("|");
    console.log(
      `[GET /api/orders/refresh] params page=${page} limit=${limit} tab=${tab || "(none)"}` +
        ` kind=${kind || "(all)"}` +
        ` q=${searchQ || "(none)"}` +
        ` shopId=${shopId || "(all)"} shopIds=${shopIds.length ? `[${shopIds.join(",")}]` : "(none)"}` +
        ` print_status=${printStatus || "(all)"}`,
    );
    const tabLc = tab.toLowerCase();
    const payload = await coalesceInFlight(ordersRefreshCoalesce, coalesceKey, async () => {
      let mergedOrders = [];
      let total = 0;
      let hasMore = false;
      let counters = { total: 0, returned: 0, cancelled: 0, rts: 0 };

      if (
        !searchQ &&
        (tabLc === "received_cancel_returns" ||
          tabLc === "received-cancel-returns" ||
          tabLc === "da_nhan_huy_hoan")
      ) {
        const allReceived = await deps.withLocalDbTimeout(
          readOrdersForRefresh(5000, {
            tab,
            shopId,
            shopIds,
            printStatus,
          }),
          10000,
          "orders_refresh_received",
        );
        total = allReceived.length;
        const start = (page - 1) * limit;
        mergedOrders = allReceived.slice(start, start + limit);
        hasMore = page * limit < total;
      } else {
        const pageResult = await deps.withLocalDbTimeout(
          queryOrdersPageFromStore({
            page,
            pageSize: limit,
            tab: searchQ ? "" : tab,
            kind: searchQ ? "" : kind,
            shopId,
            shopIds: shopIds.length ? shopIds : undefined,
            query: searchQ,
            printStatus,
            skipCounts: true,
            ...readOrderDateQuery(req),
          }),
          10000,
          "orders_refresh",
        );
        mergedOrders = pageResult.rows.filter((order) =>
          Boolean(order?.orderSn || order?.id),
        );
        total = pageResult.total || mergedOrders.length;
        hasMore = Boolean(pageResult.hasMore);
        if (pageResult.counters) counters = pageResult.counters;
        if (!tab) {
          try {
            mergedOrders = await mergeDonHoanHuyIntoOrders(mergedOrders);
          } catch (mergeErr) {
            console.warn(
              "[GET /api/orders/refresh] mergeDonHoanHuy skipped:",
              mergeErr?.message || mergeErr,
            );
          }
        }
      }
      mergedOrders = filterOrdersByPrintStatus(mergedOrders, printStatus);
      const orders = attachPdfAvailability(
        deps.enrichOrdersWithShopNames(
          deps.enrichOrdersFromCatalog(mergedOrders, []),
        ),
      );
      const totalPages = Math.max(1, Math.ceil(Math.max(0, total) / limit) || 1);
      const currentPage = Math.min(page, totalPages);
      console.log(
        `[FRONTEND FETCHED] GET /api/orders/refresh?page=${page}&limit=${limit}` +
          ` — trả về ${orders.length}/${total} đơn từ MongoDB (READ-ONLY).`,
      );
      return {
        success: true,
        data: orders,
        total,
        totalPages,
        currentPage,
        page: currentPage,
        page_size: limit,
        limit,
        has_more: hasMore,
        hasMore,
        counters,
      };
    });
    return res.status(200).json(payload);
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
    const shopIds = parseShopIdsParam(
      req.query.shop_ids ?? req.query.shopIds,
      req.query.shop_id ?? req.query.shopId,
    );
    const shopId =
      shopIds.length === 1
        ? shopIds[0]
        : String(req.query.shop_id ?? req.query.shopId ?? "");
    const page = await queryOrdersPageFromStore({
      page: Number(req.query.page),
      pageSize: Number(req.query.page_size ?? req.query.pageSize),
      tab: String(req.query.tab || ""),
      kind: parseCancelReturnKindParam(req.query.kind || req.query.cancel_kind),
      shopId,
      shopIds: shopIds.length > 1 ? shopIds : undefined,
      carrier: String(req.query.carrier || ""),
      query: String(req.query.q ?? req.query.query ?? ""),
      printStatus: String(req.query.print_status ?? req.query.printStatus ?? ""),
      // Badge dùng /api/order-counts riêng — tránh 6 countDocuments/request trên cPanel.
      skipCounts: true,
      ...readOrderDateQuery(req),
    });
    console.log(
      `[GET /api/orders/query] tab=${req.query.tab || "(all)"}` +
        ` shop=${shopId || "(all)"}` +
        ` shopIds=${shopIds.length ? `[${shopIds.join(",")}]` : "(none)"}` +
        ` carrier=${req.query.carrier || "(all)"}` +
        ` print=${req.query.print_status || req.query.printStatus || "(all)"}` +
        ` filter=`,
      JSON.stringify(orderTabFilter(String(req.query.tab || ""))),
      `→ rows=${page.rows.length} total=${page.total}`,
    );
    let products = [];
    try {
      products = await deps.loadProductsForOrders(page.rows);
    } catch (catalogErr) {
      console.warn(
        "[Orders Query] catalog enrich skipped:",
        catalogErr?.message || catalogErr,
      );
    }
    const rows = deps.enrichOrdersWithShopNames(
      deps.enrichOrdersFromCatalog(page.rows, products),
    );
    const totalPages = Math.max(
      1,
      Math.ceil(Math.max(0, page.total) / (page.pageSize || 50)) || 1,
    );
    return res.json({
      success: true,
      data: rows,
      total: page.total,
      totalPages,
      currentPage: page.page,
      page: page.page,
      page_size: page.pageSize,
      limit: page.pageSize,
      has_more: page.hasMore,
      hasMore: page.hasMore,
      counts: page.counts,
      counters: page.counters,
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

/** GET /api/order-counts — chỉ đếm từ MongoDB (badge/tab), không gọi Shopee. */
/** GET /api/orders/counter | /api/orders/counts | /api/order-counts — chỉ countDocuments theo tab. */
export async function getOrderCounts(req, res) {
  res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
  try {
    if (!isMongoReady()) {
      return res.status(200).json({
        success: false,
        counts: {},
        error: "mongodb_not_ready",
      });
    }
    const shopIds = parseShopIdsParam(
      req.query.shop_ids ?? req.query.shopIds,
      req.query.shop_id ?? req.query.shopId,
    );
    const shopId = shopIds.length === 1 ? shopIds[0] : String(req.query.shop_id ?? req.query.shopId ?? "").trim();
    const dateQ = readOrderDateQuery(req);
    const coalesceKey = `${shopIds.join(",") || shopId}|${dateQ.startDate || ""}|${dateQ.endDate || ""}`;
    const counts = await coalesceInFlight(ordersCounterCoalesce, coalesceKey, () =>
      deps.withLocalDbTimeout(
        countOrdersByTabsFromStore({
          shopId: shopId || undefined,
          shopIds: shopIds.length > 1 ? shopIds : undefined,
          ...dateQ,
        }),
        5000,
        "orders_counter",
      ),
    );
    const counters = {
      total: Number(counts.cancel_returns) || 0,
      returned: Number(counts.cancel_returns_returned ?? counts.refund_return) || 0,
      cancelled: Number(counts.cancel_returns_cancelled ?? counts.cancelled) || 0,
      rts: Number(counts.cancel_returns_rts ?? counts.failed_delivery) || 0,
    };
    console.log(
      `[GET /api/orders/counter] shopId=${shopId || "(all)"}` +
        ` shopIds=${shopIds.length ? `[${shopIds.join(",")}]` : "(none)"} counts=`,
      counts,
      "counters=",
      counters,
    );
    return res.status(200).json({ success: true, counts, counters });
  } catch (error) {
    console.error(
      "[GET /api/orders/counter] failed:",
      error?.stack || error?.message || error,
    );
    return res.status(200).json({
      success: false,
      counts: {},
      error: "order_counts_failed",
      message: error?.message || "Không thể đếm đơn hàng từ MongoDB.",
    });
  }
}

/** GET /api/orders/products-summary — tổng hợp SKU từ 3 tab kho (không kẹp 1 tab FE). */
export async function getFulfillmentProductsSummary(req, res) {
  res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
  try {
    if (!isMongoReady()) {
      return res.status(200).json({
        success: false,
        data: [],
        error: "mongodb_not_ready",
      });
    }
    const shopIds = parseShopIdsParam(
      req.query.shop_ids ?? req.query.shopIds,
      req.query.shop_id ?? req.query.shopId,
    );
    const shopId =
      shopIds.length === 1
        ? shopIds[0]
        : String(req.query.shop_id ?? req.query.shopId ?? "").trim();
    const dateQ = readOrderDateQuery(req);
    const rows = await deps.withLocalDbTimeout(
      aggregateFulfillmentProductsFromStore({
        shopId: shopId || undefined,
        shopIds: shopIds.length > 1 ? shopIds : undefined,
        ...dateQ,
      }),
      7000,
      "orders_products_summary",
    );
    const data = Array.isArray(rows) ? rows : [];
    console.log(
      `[GET /api/orders/products-summary] shopId=${shopId || "(all)"}` +
        ` shopIds=${shopIds.length ? `[${shopIds.join(",")}]` : "(none)"} rows=${data.length}`,
    );
    return res.status(200).json({ success: true, data, total: data.length });
  } catch (error) {
    console.error(
      "[GET /api/orders/products-summary] failed:",
      error?.stack || error?.message || error,
    );
    return res.status(200).json({
      success: false,
      data: [],
      error: "products_summary_failed",
      message: error?.message || "Không thể tổng hợp sản phẩm từ đơn hàng.",
    });
  }
}

/** GET /api/orders — READ-ONLY MongoDB. Không gọi Shopee. Hỗ trợ ?page=&page_size= hoặc ?limit=&tab=. */
export async function listOrders(req, res) {
  res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");

  // ERP: phân trang Mongo — mặc định 2000/trang (không cắt 50).
  const pageRaw = Number(req.query.page);
  const rawLimit = Number(req.query.limit ?? req.query.page_size ?? req.query.pageSize);
  const limit =
    Number.isFinite(rawLimit) && rawLimit > 0
      ? Math.min(Math.floor(rawLimit), 5000)
      : 2000;
  const usePaged = true;
  if (usePaged) {
    try {
      if (!isMongoReady()) {
        return res.status(200).json({
          success: false,
          data: [],
          total: 0,
          totalPages: 1,
          currentPage: 1,
          error: "mongodb_not_ready",
        });
      }
      const shopIds = parseShopIdsParam(
        req.query.shop_ids ?? req.query.shopIds,
        req.query.shop_id ?? req.query.shopId,
      );
      const shopId =
        shopIds.length === 1
          ? shopIds[0]
          : String(req.query.shop_id ?? req.query.shopId ?? "");
      const currentPageReq =
        Number.isFinite(pageRaw) && pageRaw > 0 ? Math.floor(pageRaw) : 1;
      const page = await queryOrdersPageFromStore({
        page: currentPageReq,
        pageSize: limit,
        tab: String(req.query.tab || req.query.internal_tab || ""),
        kind: parseCancelReturnKindParam(req.query.kind || req.query.cancel_kind),
        shopId,
        shopIds: shopIds.length > 1 ? shopIds : undefined,
        carrier: String(req.query.carrier || ""),
        query: String(req.query.q ?? req.query.query ?? ""),
        printStatus: String(req.query.print_status ?? req.query.printStatus ?? ""),
        skipCounts: true,
        ...readOrderDateQuery(req),
      });
      let products = [];
      try {
        products = await deps.loadProductsForOrders(page.rows);
      } catch (catalogErr) {
        console.warn(
          "[GET /api/orders] catalog enrich skipped:",
          catalogErr?.message || catalogErr,
        );
      }
      const rows = attachPdfAvailability(
        deps.enrichOrdersWithShopNames(
          deps.enrichOrdersFromCatalog(page.rows, products),
        ),
      );
      const totalPages = Math.max(
        1,
        Math.ceil(Math.max(0, page.total) / limit) || 1,
      );
      const currentPage = Math.min(page.page, totalPages);
      return res.json({
        success: true,
        data: rows,
        total: page.total,
        totalPages,
        currentPage,
        page: currentPage,
        page_size: limit,
        limit,
        has_more: page.hasMore,
        hasMore: page.hasMore,
        counts: page.counts,
        counters: page.counters,
      });
    } catch (pageErr) {
      console.error("[GET /api/orders] paged query failed:", pageErr?.message || pageErr);
    }
  }

  let { orders: rawOrders } = await loadOrdersForApi({ readOnly: true });
  rawOrders = rawOrders.filter(deps.isValidOrder);
  rawOrders = filterOrdersByPrintStatus(
    rawOrders,
    String(req.query.print_status || req.query.printStatus || ""),
  );

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
    // SSOT: matchesUnprocessedPickupTab (READY_TO_SHIP|RETRY_SHIP, !PROCESSED) —
    // gồm cả đơn GHN chưa có tracking_no. Cùng bộ với Dashboard pendingPack / tab Chưa xử lý.
    rawOrders = rawOrders.filter((o) => deps.matchesUnprocessedPickupTabShared(o));
    console.log(
      `[GET /api/orders] query.tab=${tab} filter=matchesUnprocessedPickupTab → ${rawOrders.length} đơn` +
        ` | query={ shopee_order_status: READY_TO_SHIP|RETRY_SHIP, !PROCESSED }`,
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
    // Khớp isPendingConfirmOrder / orderTabFilter("pending_confirm")
    rawOrders = rawOrders.filter((o) => {
      const raw = String(o.shopee_order_status || "").toUpperCase();
      const tn = String(o.tracking_no || o.trackingNumber || "").trim();
      if (tn && tn !== "0" && !/^0FG/i.test(tn)) return false;
      if (
        raw === "READY_TO_SHIP" ||
        raw === "RETRY_SHIP" ||
        raw === "PROCESSED" ||
        raw === "SHIPPED" ||
        raw === "TO_CONFIRM_RECEIVE" ||
        raw === "COMPLETED" ||
        raw === "CANCELLED" ||
        raw === "IN_CANCEL" ||
        raw === "TO_RETURN"
      ) {
        return false;
      }
      if (
        o.status === "unprocessed" ||
        o.status === "processed" ||
        o.status === "shipping" ||
        o.status === "completed" ||
        o.status === "cancelled" ||
        o.status === "return_pending" ||
        o.status === "return_received"
      ) {
        return false;
      }
      if (deps.matchesProcessedPickupTabShared(o) || deps.matchesUnprocessedPickupTabShared(o)) {
        return false;
      }
      return (
        o.status === "pending_confirm" ||
        o.status === "pending_verification" ||
        ["UNPAID", "PENDING", "IN_REVIEW", "FRAUD_CHECK", "INVOICE_PENDING"].includes(raw)
      );
    });
  }

  const fallbackLimit = Number(req.query.limit);
  if (Number.isFinite(fallbackLimit) && fallbackLimit > 0) {
    rawOrders = rawOrders.slice(0, Math.min(Math.floor(fallbackLimit), 5000));
  }

  const products = await deps.loadProductsForOrders(rawOrders);
  const orders = attachPdfAvailability(
    deps.enrichOrdersWithShopNames(
      deps.enrichOrdersFromCatalog(rawOrders, products),
    ),
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

/**
 * POST /api/orders/cleanup-shipped
 * ACK ngay — dọn đơn kẹt SHIPPED chạy nền (tránh timeout proxy/cPanel).
 * Body: { shopIds?: string[], maxOrders?: number, wait?: boolean }
 */
export async function cleanupShipped(req, res) {
  try {
    if (!isMongoReady()) {
      return res.status(503).json({
        success: false,
        error: "mongodb_not_ready",
        message: "MongoDB chưa sẵn sàng.",
      });
    }
    const body = req.body || {};
    const shopIdsRaw = body.shop_ids ?? body.shopIds ?? body.shop_id ?? req.query.shop_ids;
    const shopIds = Array.isArray(shopIdsRaw)
      ? shopIdsRaw.map((s) => String(s || "").trim()).filter(Boolean)
      : shopIdsRaw
        ? String(shopIdsRaw)
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean)
        : undefined;
    const maxRaw = Number(body.maxOrders ?? body.max ?? req.query.max ?? 2000);
    const maxOrders = Number.isFinite(maxRaw)
      ? Math.min(Math.max(1, Math.floor(maxRaw)), 2000)
      : 2000;
    const wait =
      body.wait === true ||
      body.wait === "1" ||
      req.query.wait === "1" ||
      req.query.wait === "true";

    if (wait) {
      const locked = deps.beginCleanupStuckShippedJob();
      if (!locked) {
        return res.status(200).json({
          success: true,
          background: true,
          message: "Job dọn đơn kẹt đang chạy. Gọi GET /api/orders/cleanup-shipped để xem tiến độ.",
        });
      }
      const result = await deps.cleanupStuckShippedOrders({
        shopIds,
        maxOrders,
        trigger: "api_wait",
        alreadyLocked: true,
      });
      ordersRefreshCache = null;
      return res.status(200).json({ success: true, background: false, ...result });
    }

    const locked = deps.beginCleanupStuckShippedJob();
    if (!locked) {
      return res.status(200).json({
        success: true,
        background: true,
        inFlight: true,
        message: "Job dọn đơn kẹt đang chạy. Đợi xong rồi F5 Dashboard.",
      });
    }

    res.status(200).json({
      success: true,
      background: true,
      inFlight: true,
      message:
        "Đang Deep Clean tab Đang giao (quét tuần tự toàn bộ SHIPPED, force-clean đơn ma). F5 Dashboard sau 5–15 phút.",
    });

    setImmediate(() => {
      deps
        .cleanupStuckShippedOrders({
          shopIds,
          maxOrders,
          trigger: "api",
          alreadyLocked: true,
        })
        .then((result) => {
          ordersRefreshCache = null;
          console.log(`[Orders] cleanup-shipped BG ${result?.message || ""}`);
        })
        .catch((err) => {
          console.error("[Orders] cleanup-shipped BG failed:", err?.message || err);
        });
    });
    return;
  } catch (error) {
    console.error("[Orders] cleanup-shipped failed:", error);
    if (!res.headersSent) {
      return res.status(500).json({
        success: false,
        error: error?.message || "cleanup_shipped_failed",
      });
    }
    return;
  }
}

/** GET /api/orders/cleanup-shipped — trạng thái job dọn đơn kẹt. */
export async function getCleanupShippedStatus(_req, res) {
  const status = deps.getCleanupStuckShippedStatus();
  return res.status(200).json({
    success: true,
    inFlight: Boolean(status?.inFlight),
    result: status?.result || null,
  });
}

/** POST /api/orders/recalculate-counts — đếm lại badge bằng countDocuments. */
export async function recalculateOrderCounts(req, res) {
  res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
  try {
    if (!isMongoReady()) {
      return res.status(503).json({
        success: false,
        error: "mongodb_not_ready",
      });
    }
    const shopIds = parseShopIdsParam(
      req.body?.shop_ids ?? req.body?.shopIds ?? req.query.shop_ids ?? req.query.shopIds,
      req.body?.shop_id ?? req.body?.shopId ?? req.query.shop_id ?? req.query.shopId,
    );
    const shopId = shopIds.length === 1 ? shopIds[0] : String(req.body?.shop_id ?? req.query.shop_id ?? "").trim();
    ordersRefreshCache = null;
    const counts = await countOrdersByTabsFromStore({
      shopId: shopId || undefined,
      shopIds: shopIds.length > 1 ? shopIds : undefined,
    });
    console.log("[POST /api/orders/recalculate-counts] counts=", counts);
    return res.status(200).json({
      success: true,
      counts,
      shipping: Number(counts.shipping) || 0,
      message: `Đã đếm lại: Đang giao = ${Number(counts.shipping) || 0}`,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error?.message || "recalculate_failed",
    });
  }
}

/** POST /api/orders/batch-delete — xóa thủ công đơn đã chọn (cả orders + don_hoan_huy) */
export async function batchDeleteOrders(req, res) {
  try {
    const idsOrSns = req.body?.ids ?? req.body?.orderSns ?? req.body?.order_sns ?? [];
    const normalized = [...new Set(
      (Array.isArray(idsOrSns) ? idsOrSns : [])
        .map((k) => String(k || "").replace(/^shopee-/i, "").trim())
        .filter(Boolean)
    )];
    if (normalized.length === 0) {
      return res.status(400).json({ success: false, error: "Thiếu danh sách id/orderSn." });
    }
    let mongoDeleted = 0;
    let donHoanHuyDeleted = 0;
    let jsonRemoved = 0;
    if (isMongoReady()) {
      try {
        mongoDeleted = await deleteOrdersFromStore(normalized);
      } catch (err) {
        console.warn("[Orders batch-delete] orders Mongo:", err?.message || err);
      }
      try {
        const DonHoanHuy = (await import("../models/DonHoanHuy.js")).default;
        const dhhResult = await DonHoanHuy.deleteMany({ orderSn: { $in: normalized } });
        donHoanHuyDeleted = Number(dhhResult.deletedCount || 0);
        if (donHoanHuyDeleted > 0) {
          console.log(`[Orders batch-delete] don_hoan_huy deleted=${donHoanHuyDeleted}`);
        }
      } catch (err) {
        console.warn("[Orders batch-delete] don_hoan_huy Mongo:", err?.message || err);
      }
    }
    try {
      const orders = loadOrders();
      const snSet = new Set(normalized);
      const before = orders.length;
      const kept = orders.filter((o) => {
        const sn = String(o?.orderSn || o?.id || "").replace(/^shopee-/i, "").trim();
        return !snSet.has(sn);
      });
      jsonRemoved = before - kept.length;
      if (jsonRemoved > 0) saveOrders(kept);
    } catch (err) {
      console.warn("[Orders batch-delete] JSON:", err?.message || err);
    }
    if (mongoDeleted === 0 && jsonRemoved === 0 && donHoanHuyDeleted === 0) {
      return res.status(404).json({ success: false, error: "Không tìm thấy đơn để xóa." });
    }
    console.log(`[Orders batch-delete] ids=${normalized.length} orders=${mongoDeleted} don_hoan_huy=${donHoanHuyDeleted} json=${jsonRemoved}`);
    return res.json({
      success: true,
      deleted: mongoDeleted + donHoanHuyDeleted + jsonRemoved,
      mongoDeleted,
      donHoanHuyDeleted,
      jsonRemoved,
      orderSns: normalized.slice(0, 100),
    });
  } catch (error) {
    console.error("[Orders batch-delete] error:", error);
    return res.status(500).json({
      success: false,
      error: error?.message || "batch_delete_failed",
      message: error?.message || "Không thể xóa đơn.",
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
      ttlHours: 168,
      storage: "disk",
      mongo: false,
      message: `Đã dọn PDF vận đơn >7 ngày trên đĩa (không lưu Mongo). Xóa ${deleted} mục.`,
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

/** GET /api/orders/scanner-sync — payload siêu gọn cho máy quét (O(1) local match). */
export async function scannerSync(req, res) {
  try {
    if (!isMongoReady()) {
      return res.status(503).json({
        success: false,
        error: "MongoDB chưa sẵn sàng",
        orders: [],
        total: 0,
        code_count: 0,
      });
    }
    const t0 = Date.now();
    const orders = await listScannerSyncRowsFromStore();
    let codeCount = 0;
    for (const row of orders) {
      if (row.tracking_code) codeCount += 1;
      if (row.return_waybill) codeCount += 1;
    }
    const ms = Date.now() - t0;
    console.log(
      `[GET /api/orders/scanner-sync] rows=${orders.length} codes=${codeCount} ${ms}ms`,
    );
    return res.json({
      success: true,
      orders,
      total: orders.length,
      code_count: codeCount,
      ms,
    });
  } catch (err) {
    console.error("[GET /api/orders/scanner-sync] failed:", err?.message || err);
    return res.status(500).json({
      success: false,
      error: err?.message || String(err),
      orders: [],
      total: 0,
      code_count: 0,
    });
  }
}

/** GET /api/orders/lookup — chỉ Mongo exact. CẤM Shopee live (get_return_list / reverse). */
export async function lookupOrder(req, res) {
  const code = String(req.query.code || req.query.q || "").trim().toUpperCase();
  if (!code) {
    return res.status(400).json({
      success: false,
      message: "Không tìm thấy mã trên hệ thống",
      notFound: true,
    });
  }
  try {
    let foundRaw = null;
    try {
      foundRaw = await findOrderByScanCodeInStore(code);
      if (foundRaw && !deps.isValidOrder(foundRaw)) foundRaw = null;
      if (foundRaw) foundRaw = mirrorTrackingFieldsForRead(foundRaw);
    } catch (err) {
      console.warn("[Orders Lookup] mongo failed:", err?.message || err);
    }

    if (!foundRaw) {
      return res.status(404).json({
        success: false,
        message: "Không tìm thấy mã trên hệ thống",
        notFound: true,
        scannedCode: code,
      });
    }

    try {
      const products = await deps.loadProductsForOrders([foundRaw]);
      const found = deps.enrichOrdersFromCatalog([foundRaw], products)[0] || foundRaw;
      return res.json(found);
    } catch (enrichErr) {
      console.warn("[Orders Lookup] enrich failed, return raw:", enrichErr?.message || enrichErr);
      return res.json(foundRaw);
    }
  } catch (err) {
    console.error("[Orders Lookup] failed:", err?.message || err);
    return res.status(404).json({
      success: false,
      message: "Không tìm thấy mã trên hệ thống",
      notFound: true,
      scannedCode: code,
    });
  }
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

/**
 * POST /api/orders/force-resync-stuck
 * Fire-and-forget: ACK 200 ngay — xử lý nặng chạy nền (tránh hanging request / process leak).
 * Body: { orderSns?: string[], maxAutoDetect?: number, tryShip?: boolean, includePinned?: boolean }
 */
export async function forceResyncStuck(req, res) {
  try {
    const body = req.body || {};
    const orderSns = Array.isArray(body.orderSns)
      ? body.orderSns
      : Array.isArray(body.order_sns)
        ? body.order_sns
        : typeof body.orderSn === "string"
          ? [body.orderSn]
          : [];
    const maxRaw = Number(body.maxAutoDetect ?? body.max ?? 30);
    const maxAutoDetect = Number.isFinite(maxRaw)
      ? Math.min(Math.max(0, Math.floor(maxRaw)), 200)
      : 30;
    const tryShip = body.tryShip !== false && body.try_ship !== false;
    const includePinned = body.includePinned !== false;

    res.status(200).json({
      success: true,
      background: true,
      message: "Đang ép đồng bộ đơn kẹt ngầm...",
    });

    setImmediate(() => {
      deps
        .forceResyncStuckOrdersWithoutTracking({
          orderSns,
          maxAutoDetect: orderSns.length > 0 ? maxAutoDetect : Math.max(maxAutoDetect, 2),
          tryShip,
          includePinned,
        })
        .then((result) => {
          ordersRefreshCache = null;
          console.log(
            `[Orders] force-resync-stuck BG attempted=${result.attempted} healed=${result.healed}`,
          );
        })
        .catch((err) => {
          console.error("[Orders] force-resync-stuck BG failed:", err?.message || err);
        });
    });
    return;
  } catch (err) {
    console.error("[Orders] force-resync-stuck failed:", err?.message || err);
    if (!res.headersSent) {
      return res.status(500).json({
        success: false,
        error: err?.message || String(err),
        message: "Không thể ép đồng bộ đơn kẹt thiếu mã vận đơn.",
      });
    }
    return;
  }
}

/**
 * POST /api/orders/trigger-fix-stuck-orders  (alias: POST /trigger-fix-stuck-orders)
 * Fire-and-forget: ACK 200 ngay — không await job nặng (tránh treo request cPanel).
 * Body: { orderSns?: string[], maxAutoDetect?: number, tryShip?: boolean, lookbackDays?: number }
 */
export async function triggerFixStuckOrders(req, res) {
  try {
    const body = req.body || {};
    const orderSns = Array.isArray(body.orderSns)
      ? body.orderSns
      : Array.isArray(body.order_sns)
        ? body.order_sns
        : typeof body.orderSn === "string"
          ? [body.orderSn]
          : [];
    const maxRaw = Number(body.maxAutoDetect ?? body.max ?? 100);
    const maxAutoDetect = Number.isFinite(maxRaw)
      ? Math.min(Math.max(1, Math.floor(maxRaw)), 200)
      : 100;
    const tryShip = body.tryShip !== false && body.try_ship !== false;
    const lookbackDaysRaw = Number(body.lookbackDays ?? body.lookback_days ?? 30);
    const lookbackDays = Number.isFinite(lookbackDaysRaw)
      ? Math.min(Math.max(1, Math.floor(lookbackDaysRaw)), 90)
      : 30;

    res.status(200).json({
      success: true,
      background: true,
      message: "Đang sửa đơn kẹt ngầm...",
    });

    setImmediate(() => {
      deps
        .triggerFixStuckOrders({
          orderSns,
          maxAutoDetect,
          tryShip,
          lookbackMs: lookbackDays * 24 * 3600 * 1000,
        })
        .then((result) => {
          ordersRefreshCache = null;
          console.log(
            `[Orders] trigger-fix-stuck-orders BG attempted=${result.attempted} healed=${result.healed}`,
          );
        })
        .catch((err) => {
          console.error("[Orders] trigger-fix-stuck-orders BG failed:", err?.message || err);
        });
    });
    return;
  } catch (err) {
    console.error("[Orders] trigger-fix-stuck-orders failed:", err?.message || err);
    if (!res.headersSent) {
      return res.status(500).json({
        success: false,
        error: err?.message || String(err),
        message: "Không thể trigger sửa đơn kẹt thiếu mã vận đơn.",
      });
    }
    return;
  }
}

/**
 * POST /api/orders/reconcile-handed-over
 * Dò API Shopee cho đơn tab "Đã giao cho ĐVVC" — ACK ngay, chạy nền.
 * Khi Shopee trả SHIPPED → Mongo cập nhật → đơn nhảy tab "Đang giao".
 * Body: { maxOrders?: number, shopIds?: string[], force?: boolean }
 */
export async function reconcileHandedOver(req, res) {
  try {
    const body = req.body || {};
    const maxRaw = Number(body.maxOrders ?? body.max ?? 100);
    const maxOrders = Number.isFinite(maxRaw)
      ? Math.min(Math.max(1, Math.floor(maxRaw)), 150)
      : 100;
    const shopIdsRaw = body.shop_ids ?? body.shopIds ?? body.shop_id;
    const shopIds = Array.isArray(shopIdsRaw)
      ? shopIdsRaw.map((s) => String(s || "").trim()).filter(Boolean)
      : shopIdsRaw
        ? [String(shopIdsRaw).trim()].filter(Boolean)
        : undefined;
    const force = body.force === true || body.force === "1" || body.force === 1;

    res.status(200).json({
      success: true,
      background: true,
      message: "Đang dò trạng thái ĐVVC từ Shopee ngầm...",
    });

    setImmediate(() => {
      deps
        .reconcileHandedOverCarrierStatuses({
          maxOrders,
          shopIds,
          force,
          trigger: "api",
        })
        .then((result) => {
          ordersRefreshCache = null;
          console.log(
            `[Orders] reconcile-handed-over BG` +
              ` candidates=${result.candidates || 0}` +
              ` pulled=${result.pulled || 0}` +
              ` shipped≈${result.shipped || 0}` +
              ` skipped=${Boolean(result.skipped)}` +
              ` msg=${result.message || ""}`,
          );
        })
        .catch((err) => {
          console.error("[Orders] reconcile-handed-over BG failed:", err?.message || err);
        });
    });
    return;
  } catch (err) {
    console.error("[Orders] reconcile-handed-over failed:", err?.message || err);
    if (!res.headersSent) {
      return res.status(500).json({
        success: false,
        error: err?.message || String(err),
        message: "Không thể dò trạng thái đơn Đã giao ĐVVC.",
      });
    }
    return;
  }
}

/** POST /api/orders/enrich-tracking — ACK ngay, enrich chạy nền. */
export async function enrichTracking(req, res) {
  try {
    const maxRaw = Number(req.body?.max ?? req.query?.max ?? 100);
    const max = Number.isFinite(maxRaw) ? Math.min(Math.max(1, Math.floor(maxRaw)), 200) : 100;

    res.status(200).json({
      success: true,
      background: true,
      message: "Đang bù mã vận đơn ngầm...",
    });

    setImmediate(() => {
      (async () => {
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
          `[Orders] enrich-tracking BG filled=${filled} repaired=${repaired}`,
        );
      })().catch((err) => {
        console.error("[Orders] enrich-tracking BG failed:", err?.message || err);
      });
    });
    return;
  } catch (err) {
    console.error("[Orders] enrich-tracking failed:", err?.message || err);
    if (!res.headersSent) {
      return res.status(500).json({
        success: false,
        error: err?.message || String(err),
        message: "Không thể bù mã vận đơn từ Shopee.",
      });
    }
    return;
  }
}

/**
 * POST /api/orders/reclassify-cancel-returns
 * Phân loại lại Hủy/RTS/Return 30 ngày trong Mongo (batch + sleep). ACK 200 rồi chạy nền.
 */
export async function reclassifyCancelReturns(req, res) {
  try {
    const src = { ...(req.query || {}), ...(req.body || {}) };
    const daysRaw = Number(src.lookbackDays ?? src.days ?? 30);
    const lookbackDays = Number.isFinite(daysRaw)
      ? Math.min(Math.max(1, Math.floor(daysRaw)), 30)
      : 30;
    const maxRaw = Number(src.max ?? src.limit ?? 2000);
    const limit = Number.isFinite(maxRaw)
      ? Math.min(Math.max(50, Math.floor(maxRaw)), 4000)
      : 2000;
    res.status(200).json({
      success: true,
      background: true,
      lookbackDays,
      limit,
      message: `Đang phân loại lại Hủy/Hoàn ${lookbackDays} ngày (max=${limit}).`,
    });
    setImmediate(() => {
      void reclassifyCancelReturnsInStore({
        lookbackMs: lookbackDays * 24 * 60 * 60 * 1000,
        limit,
      }).then((r) => {
        console.log(
          `[Orders] reclassify-cancel-returns DONE scanned=${r.scanned} updated=${r.updated}`,
        );
      }).catch((err) => {
        console.error("[Orders] reclassify-cancel-returns failed:", err?.message || err);
      });
    });
  } catch (err) {
    console.error("[Orders] reclassify-cancel-returns failed:", err?.message || err);
    if (!res.headersSent) {
      return res.status(500).json({
        success: false,
        error: err?.message || String(err),
      });
    }
  }
}

/**
 * GET|POST /api/orders/heal-tracking-cancelled
 * ACK 200 ngay — deep heal chạy nền (tránh cPanel/proxy timeout ~120s).
 * Query/body: max (mặc định 100, tối đa 500), lookbackDays (mặc định 60).
 */
export async function healTrackingCancelled(req, res) {
  try {
    const src = { ...(req.query || {}), ...(req.body || {}) };
    const maxRaw = Number(src.max ?? 100);
    const max = Number.isFinite(maxRaw) ? Math.min(Math.max(1, Math.floor(maxRaw)), 500) : 100;
    const daysRaw = Number(src.lookbackDays ?? src.days ?? 60);
    const lookbackDays = Number.isFinite(daysRaw)
      ? Math.min(Math.max(1, Math.floor(daysRaw)), 180)
      : 60;

    // BẮT BUỘC trả 200 ngay — không await Shopee (sync=1 đã gây timeout 120s+).
    res.status(200).json({
      success: true,
      background: true,
      max,
      lookbackDays,
      message:
        `Đang xử lý ngầm: heal mã vận đơn đơn hủy/hoàn (max=${max}, lookback=${lookbackDays} ngày).` +
        ` Không chờ HTTP — xem log server; sau vài phút tải lại tab ĐƠN HỦY, ĐƠN HOÀN.`,
    });

    setImmediate(() => {
      deps
        .healCancelledReturnTrackingOrders({ max, lookbackDays, retries: 2 })
        .then((result) => {
          ordersRefreshCache = null;
          console.log(
            `[Orders] heal-tracking-cancelled BG DONE filled=${result.filled}` +
              ` attempted=${result.attempted} stillEmpty=${result.stillEmpty} errors=${result.errors}`,
          );
        })
        .catch((err) => {
          console.error("[Orders] heal-tracking-cancelled BG failed:", err?.message || err);
        });
    });
    return;
  } catch (err) {
    console.error("[Orders] heal-tracking-cancelled failed:", err?.message || err);
    if (!res.headersSent) {
      return res.status(500).json({
        success: false,
        error: err?.message || String(err),
        message: "Không thể heal mã vận đơn đơn hủy/hoàn.",
      });
    }
    return;
  }
}

/** PATCH /api/orders/:id — bắt buộc dùng dynamic orderId/orderSn (Mongo SSOT). */
export async function patchOrder(req, res) {
  const key = String(req.params.id || "").trim();
  if (!key) {
    return res.status(400).json({
      error: "missing_order_id",
      message: "Thiếu orderId hoặc orderSn động trên URL.",
    });
  }
  const snKey = key.replace(/^shopee-/i, "").trim();
  // Chặn mã test/hardcode cố định — bắt buộc truyền đơn thật từ FE.
  if (/^TEST[-_]/i.test(snKey) || /TEST-SCAN-MVC/i.test(snKey)) {
    return res.status(400).json({
      error: "invalid_order_id",
      message: `Mã đơn không hợp lệ (hardcode/test): ${key}. Hãy truyền orderId/orderSn động của đơn thực tế.`,
    });
  }

  const orders = loadOrders();
  let index = orders.findIndex(
    (o) =>
      o.id === key ||
      o.orderSn === key ||
      o.id === `shopee-${key}` ||
      String(o.orderSn || "") === snKey,
  );

  // Mongo-only: đơn không còn trong orders.json → vẫn PATCH theo orderSn/orderId động.
  if (index === -1 && isMongoReady()) {
    try {
      const scoped = await loadOrdersForShipScoped([key, `shopee-${snKey}`], [snKey]);
      const hit = scoped[0];
      if (hit) {
        const existingIdx = orders.findIndex(
          (o) =>
            String(o.id || "") === String(hit.id || "") ||
            String(o.orderSn || "").replace(/^shopee-/i, "") === snKey,
        );
        if (existingIdx >= 0) {
          index = existingIdx;
          orders[index] = { ...orders[index], ...hit };
        } else {
          orders.push(hit);
          index = orders.length - 1;
        }
      }
    } catch (err) {
      console.warn("[Orders PATCH] Mongo scoped lookup:", err?.message || err);
    }
  }

  if (index === -1) {
    return res.status(404).json({
      error: "order_not_found",
      message: `Không tìm thấy đơn hàng theo orderId/orderSn: ${key}`,
    });
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
    patch.scanFlag = localPatch;
    patch.localStatusAt = patch.localStatusAt || nowIso;
    patch.local_status_updated_at = patch.local_status_updated_at || nowIso;
    if (localPatch === "CANCELLED_STORED" || localPatch === "RETURN_RECEIVED") {
      patch.is_local_return_archived = false;
      Object.assign(patch, deps.buildClearHandedOverPatch(nowIso));
      patch.local_status = localPatch;
      patch.localStatus = localPatch;
      patch.internal_status = localPatch;
      patch.scanFlag = localPatch;
      patch.localStatusAt = nowIso;
      patch.local_status_updated_at = nowIso;
      patch.is_local_return_archived = false;
    }
    if (localPatch === "RETURN_RECEIVED") {
      patch.status = "return_received";
    }
  }
  const stableId =
    String(orders[index].id || "").trim() ||
    (snKey ? `shopee-${snKey}` : key);
  // Bảo vệ: nếu đơn cũ đã Đã in (isPrinted=true), tuyệt đối KHÔNG cho req.body ghi đè thành false.
  const existingWasPrinted =
    orders[index].isPrinted === true ||
    orders[index].isPrinted === 1 ||
    String(orders[index].isPrinted || "").trim().toLowerCase() === "true";
  orders[index] = { ...orders[index], ...patch, id: stableId };
  if (existingWasPrinted) {
    orders[index].isPrinted = true;
  }
  if (!orders[index].orderSn && snKey) {
    orders[index].orderSn = snKey;
  }
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
  try {
    await persistOrdersToDatabase(orders, [orders[index]]);
  } catch (persistErr) {
    console.warn("[Orders PATCH] persistOrdersToDatabase:", persistErr?.message || persistErr);
    try {
      await persistChangedOrdersPatch([orders[index]]);
    } catch (err2) {
      console.error("[Orders PATCH] persistChangedOrdersPatch failed:", err2?.message || err2);
      return res.status(500).json({
        error: "persist_failed",
        message: "Không lưu được đơn lên MongoDB.",
      });
    }
  }
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
  if (isMongoReady() && "isPrinted" in patch) {
    try {
      await markOrdersPrintedInStore(
        [String(orders[index].orderSn || orders[index].id || "")],
        Boolean(patch.isPrinted),
        {
          shopId: orders[index].shopId != null ? String(orders[index].shopId) : undefined,
          labelUrl: orders[index].labelUrl || orders[index].pdfUrl,
          pdfFilename: orders[index].pdfFilename,
        },
      );
      invalidateOrdersRefreshCache();
    } catch (err) {
      console.error("[Orders PATCH] markOrdersPrinted failed:", err?.message || err);
    }
  }
  return res.json(orders[index]);
}

/**
 * POST /api/orders/confirm-return-received
 * POST /api/orders/:id/confirm-return-received
 * Nút thủ công [Xác nhận đã nhận hoàn] — ghi cờ kho RETURN_RECEIVED (không tin API Shopee).
 */
export async function confirmReturnReceived(req, res) {
  const body = req.body || {};
  const key = String(
    req.params.id ||
      body.orderId ||
      body.id ||
      body.orderSn ||
      body.order_sn ||
      "",
  ).trim();
  if (!key) {
    return res.status(400).json({
      success: false,
      error: "missing_order_id",
      message: "Thiếu orderId hoặc orderSn.",
    });
  }
  const snKey = key.replace(/^shopee-/i, "").trim();
  if (/^TEST[-_]/i.test(snKey) || /TEST-SCAN-MVC/i.test(snKey)) {
    return res.status(400).json({
      success: false,
      error: "invalid_order_id",
      message: `Mã đơn không hợp lệ: ${key}.`,
    });
  }

  const orders = loadOrders();
  let index = orders.findIndex(
    (o) =>
      o.id === key ||
      o.orderSn === key ||
      o.id === `shopee-${key}` ||
      String(o.orderSn || "") === snKey,
  );

  if (index === -1 && isMongoReady()) {
    try {
      const scoped = await loadOrdersForShipScoped([key, `shopee-${snKey}`], [snKey]);
      const hit = scoped[0];
      if (hit) {
        const existingIdx = orders.findIndex(
          (o) =>
            String(o.id || "") === String(hit.id || "") ||
            String(o.orderSn || "").replace(/^shopee-/i, "") === snKey,
        );
        if (existingIdx >= 0) {
          index = existingIdx;
          orders[index] = { ...orders[index], ...hit };
        } else {
          orders.push(hit);
          index = orders.length - 1;
        }
      }
    } catch (err) {
      console.warn("[Orders confirm-return] Mongo lookup:", err?.message || err);
    }
  }

  if (index === -1) {
    return res.status(404).json({
      success: false,
      error: "order_not_found",
      message: `Không tìm thấy đơn hàng: ${key}`,
    });
  }

  const existingLocal = String(
    orders[index].local_status ||
      orders[index].localStatus ||
      orders[index].internal_status ||
      orders[index].scanFlag ||
      "",
  ).toUpperCase();
  const nowIso = new Date().toISOString();
  const already = existingLocal === "RETURN_RECEIVED";
  if (!already) {
    Object.assign(orders[index], deps.buildClearHandedOverPatch(nowIso) || {});
    orders[index].local_status = "RETURN_RECEIVED";
    orders[index].localStatus = "RETURN_RECEIVED";
    orders[index].internal_status = "RETURN_RECEIVED";
    orders[index].scanFlag = "RETURN_RECEIVED";
    orders[index].localStatusAt = nowIso;
    orders[index].local_status_updated_at = nowIso;
    orders[index].is_local_return_archived = false;
    orders[index].status = "return_received";
  }

  const stableId =
    String(orders[index].id || "").trim() ||
    (snKey ? `shopee-${snKey}` : key);
  orders[index].id = stableId;
  if (!orders[index].orderSn && snKey) {
    orders[index].orderSn = snKey;
  }

  try {
    await persistOrdersToDatabase(orders, [orders[index]]);
  } catch (persistErr) {
    console.warn("[Orders confirm-return] persistOrdersToDatabase:", persistErr?.message || persistErr);
    try {
      await persistChangedOrdersPatch([orders[index]]);
    } catch (err2) {
      console.error("[Orders confirm-return] persistChangedOrdersPatch failed:", err2?.message || err2);
      return res.status(500).json({
        success: false,
        error: "persist_failed",
        message: "Không lưu được cờ nhận hàng hoàn lên MongoDB.",
      });
    }
  }

  if (isMongoReady()) {
    try {
      await markOrderLocalStatusInStore(
        String(orders[index].orderSn || snKey || ""),
        "RETURN_RECEIVED",
        {
          shopId: orders[index].shopId != null ? String(orders[index].shopId) : undefined,
          clearHandedOver: true,
          status: "return_received",
        },
      );
    } catch (err) {
      console.error("[Orders confirm-return] markOrderLocalStatus failed:", err?.message || err);
    }
    try {
      await upsertDonHoanHuy(orders[index], {
        type: "return",
        source: "manual_button",
        scannedAt: nowIso,
      });
    } catch (err) {
      console.warn("[Orders confirm-return] upsertDonHoanHuy:", err?.message || err);
    }
  }

  invalidateOrdersRefreshCache();
  return res.json({
    success: true,
    already,
    local_status: "RETURN_RECEIVED",
    order: orders[index],
  });
}

/**
 * POST /api/orders/update-print-status
 * Fast path: Mongo updateMany theo orderSn — KHÔNG load orders.json,
 * KHÔNG bulkUpsert full document, KHÔNG gọi Shopee.
 * Body: { order_sns|orderSns|orderIds: string[], is_printed|isPrinted: boolean }
 */
export async function updatePrintStatus(req, res) {
  try {
    const body = req.body || {};
    const rawIds = [
      ...(Array.isArray(body.orderIds) ? body.orderIds : []),
      ...(Array.isArray(body.orderSns) ? body.orderSns : []),
      ...(Array.isArray(body.order_sns) ? body.order_sns : []),
      ...(Array.isArray(body.order_sn) ? body.order_sn : []),
      body.orderId,
      body.orderSn,
      body.order_sn,
    ]
      .map((v) => String(v || "").replace(/^shopee-/i, "").trim())
      .filter(Boolean);
    const sns = [...new Set(rawIds)];
    if (sns.length === 0) {
      return res.status(400).json({
        success: false,
        error: "missing_order_ids",
        message: "Thiếu danh sách đơn cần cập nhật trạng thái in.",
      });
    }

    const hasFlag =
      typeof body.is_printed === "boolean" ||
      typeof body.isPrinted === "boolean" ||
      body.is_printed === 0 ||
      body.is_printed === 1 ||
      body.isPrinted === 0 ||
      body.isPrinted === 1 ||
      typeof body.is_printed === "string" ||
      typeof body.isPrinted === "string";
    if (!hasFlag) {
      return res.status(400).json({
        success: false,
        error: "missing_is_printed",
        message: "Thiếu biến is_printed (true/false).",
      });
    }
    const rawFlag = body.is_printed ?? body.isPrinted;
    const isPrinted =
      rawFlag === true ||
      rawFlag === 1 ||
      String(rawFlag).trim().toLowerCase() === "true" ||
      String(rawFlag).trim() === "1";

    if (!isMongoReady()) {
      return res.status(503).json({
        success: false,
        error: "mongodb_not_ready",
        message: "MongoDB chưa sẵn sàng — không thể cập nhật trạng thái in.",
      });
    }

    const shopIdHint = String(body.shopId || body.shop_id || "").trim();
    const mongoUpdated = await markOrdersPrintedInStore(sns, isPrinted, {
      ...(shopIdHint ? { shopId: shopIdHint } : {}),
    });
    invalidateOrdersRefreshCache();

    return res.json({
      success: true,
      isPrinted,
      updatedCount: Math.max(mongoUpdated, sns.length),
      resetCount: isPrinted ? 0 : Math.max(mongoUpdated, sns.length),
      orderSns: sns,
    });
  } catch (error) {
    console.error("[Orders update-print-status]", error?.stack || error?.message || error);
    return res.status(500).json({
      success: false,
      error: "update_print_status_failed",
      message: error?.message || "Không thể cập nhật trạng thái in.",
    });
  }
}

/** POST /api/orders/mark-printed — đánh dấu nhanh danh sách đơn là đã in. */
export async function markPrinted(req, res) {
  req.body = { ...(req.body || {}), isPrinted: true, is_printed: true };
  return updatePrintStatus(req, res);
}

/**
 * POST /api/orders/reset-print-status
 * Đặt isPrinted=false trên Mongo — cho phép in lại từ đầu (không gọi Shopee).
 * Body: { orderIds?: string[], orderSns?: string[] }
 */
export async function resetPrintStatus(req, res) {
  req.body = { ...(req.body || {}), is_printed: false, isPrinted: false };
  return updatePrintStatus(req, res);
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

/** POST /api/orders/:id/hand-over-carrier — Mongo $set nhanh, không load full orders. */
export async function handOverCarrierById(req, res) {
  try {
    const trackingHint = String(
      req.body?.trackingNumber ||
        req.body?.tracking_no ||
        req.body?.waybill ||
        req.body?.code ||
        "",
    ).trim();
    const result = await handOverOrderToCarrierFast({
      orderId: String(req.params.id || "").trim(),
      orderSn: String(req.body?.orderSn || req.body?.order_sn || "").trim(),
      code: trackingHint,
      trackingHint,
      shopId: req.body?.shopId,
      source: String(req.body?.source || "").trim() === "qr_scan" ? "qr_scan" : "manual_button",
    });
    if (!result.ok) {
      return res
        .status(result.status || 400)
        .json({
          success: false,
          error: result.error,
          message: result.message || result.error,
        });
    }
    invalidateOrdersRefreshCache();
    return res.json({ success: true, order: result.order, changed: result.changed !== false });
  } catch (error) {
    console.error("[Orders Handover] single error:", error);
    const mapped = mapHandoverWriteError(error);
    return res.status(mapped.status || 500).json({
      success: false,
      error: mapped.error,
      message: mapped.message,
    });
  }
}

/** POST /api/orders/hand-over-carrier — Mongo lookup + $set, không sync Shopee. */
export async function handOverCarrierByCode(req, res) {
  try {
    const code = String(req.body?.code || req.body?.scanCode || req.body?.q || "").trim();
    const orderId = String(
      req.body?.orderId || req.body?.id || "",
    ).trim();
    const orderSn = String(
      req.body?.orderSn || req.body?.order_sn || "",
    ).trim();
    const trackingHint = String(
      req.body?.trackingNumber || req.body?.tracking_no || req.body?.waybill || code || "",
    ).trim();

    if (!orderId && !orderSn && !code && !trackingHint) {
      return res.status(400).json({
        success: false,
        error: "Thiếu orderId hoặc mã quét (code).",
        message: "Thiếu orderId hoặc mã quét (code).",
      });
    }

    const result = await handOverOrderToCarrierFast({
      orderId,
      orderSn,
      code: code || trackingHint,
      trackingHint,
      shopId: req.body?.shopId,
      source:
        String(req.body?.source || "").trim() === "qr_scan" || code
          ? "qr_scan"
          : "manual_button",
    });
    if (!result.ok) {
      return res
        .status(result.status || 400)
        .json({
          success: false,
          error: result.error,
          message: result.message || result.error,
        });
    }
    invalidateOrdersRefreshCache();
    return res.json({ success: true, order: result.order, changed: result.changed !== false });
  } catch (error) {
    console.error("[Orders Handover] by-code error:", error);
    const mapped = mapHandoverWriteError(error);
    return res.status(mapped.status || 500).json({
      success: false,
      error: mapped.error,
      message: mapped.message,
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

    const updatedOrders = [];
    const failed = [];
    let skipped = 0;
    const seenSn = new Set();

    for (const key of keys) {
      const result = await handOverOrderToCarrierFast({
        orderId: key,
        orderSn: key,
        source: "manual_button",
      });
      if (!result.ok) {
        failed.push({
          key,
          error: result.error,
          message: result.message || result.error,
        });
        continue;
      }
      const sn = String(result.order?.orderSn || key)
        .replace(/^shopee-/i, "")
        .trim()
        .toLowerCase();
      if (sn && seenSn.has(sn)) {
        skipped++;
        continue;
      }
      if (sn) seenSn.add(sn);
      if (result.changed) updatedOrders.push(result.order);
      else skipped++;
    }

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
        message: failed[0]?.message || failed[0]?.error || "Không bàn giao được đơn nào.",
      });
    }

    invalidateOrdersRefreshCache();
    return res.json({
      success: true,
      updated: updatedOrders.length,
      skipped,
      failed,
      orders: updatedOrders,
    });
  } catch (error) {
    console.error("[Orders Handover Bulk] error:", error);
    const mapped = mapHandoverWriteError(error);
    return res.status(mapped.status || 500).json({
      success: false,
      error: mapped.error || "hand_over_bulk_failed",
      message: mapped.message || "Không thể bàn giao ĐVVC hàng loạt.",
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
      customerName = "",
      customerPhone = "",
      save_to_address_book = false,
    } = body;

    const addr = shippingAddress || {};
    const addressMode = String(addr.addressMode || body.addressMode || "old3");
    const isTwoLevel = addressMode === "new2";
    const name = String(customerName || addr.name || "").trim() || "Khách sỉ";
    const phone = String(customerPhone || addr.phone || "").trim() || "0900000000";

    if (!addr.provinceCode || !addr.wardCode || !addr.street?.trim()) {
      return res.status(400).json({
        error:
          "Địa chỉ chưa đầy đủ. Vui lòng chọn Tỉnh, Phường/Xã và nhập địa chỉ chi tiết.",
      });
    }
    if (!isTwoLevel && !addr.districtCode) {
      return res.status(400).json({
        error: "Địa chỉ 3 cấp cần chọn thêm Quận/Huyện.",
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
    const totalAmount = Math.max(0, subtotal + feeToCollect - Number(orderDiscount));

    const fullAddress = [addr.street, addr.ward, addr.district, addr.province]
      .filter(Boolean)
      .join(", ");

    const orderSn = `DON-NGOAI-${Date.now().toString(36).toUpperCase()}`;
    const orderId = `ext-${orderSn}`;
    const provider = carrier === "ghn" || carrier === "spx" ? carrier : "self";
    const mapped = mapExternalStatus("created");
    const lineItems = items.slice(0, 80).map((it) => ({
      productId: String(it.productId || ""),
      productTitle: String(it.productTitle || it.name || ""),
      name: String(it.productTitle || it.name || ""),
      productImage: it.productImage || "",
      sku: String(it.sku || ""),
      quantity: Number(it.quantity) || 0,
      price: Number(it.price) || 0,
    }));

    let trackingNumber = "";
    let carrierError = "";
    let logisticsResult = null;
    const logisticsPayload =
      provider !== "self"
        ? deps.buildCarrierLogisticsPayload(
            provider,
            { name, phone },
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
        `[Logistics ${provider.toUpperCase()}] Payload đẩy đơn:`,
        JSON.stringify(logisticsPayload, null, 2),
      );
    }

    if (provider === "ghn") {
      try {
        logisticsResult = await createGhnShippingOrder({
          clientOrderCode: orderSn,
          customer: { name, phone },
          address: addr,
          items: lineItems,
          weightGrams: packageWeight,
          codAmount: totalAmount,
          note: carrierNotes,
          shippingFeePayer,
        });
        trackingNumber = String(logisticsResult.trackingNo || "").trim();
      } catch (ghnErr) {
        carrierError = ghnErr?.message || "GHN tạo vận đơn thất bại";
        console.error("[Orders manual] GHN create:", carrierError);
      }
    } else if (provider === "spx") {
      try {
        const spxCredsDb = await loadSpxCredentialsFromMongo();
        logisticsResult = await createSpxShippingOrder({
          clientOrderCode: orderSn,
          customer: { name, phone },
          address: addr,
          items: lineItems,
          weightGrams: packageWeight,
          codAmount: totalAmount,
          note: carrierNotes,
          creds: spxCredsDb,
        });
        trackingNumber = String(logisticsResult.trackingNo || "").trim();
      } catch (spxErr) {
        carrierError = spxErr?.message || "SPX tạo vận đơn thất bại";
        console.error("[Orders manual] SPX create:", carrierError);
      }
    }

    const nowIso = new Date().toISOString();
    const newOrder = {
      id: orderId,
      _id: orderId,
      orderSn,
      order_sn: orderSn,
      channel: "manual",
      source: "external",
      shopId: null,
      customerName: name,
      customerPhone: phone,
      customerAddress: fullAddress,
      shippingAddress: {
        province: addr.province,
        provinceCode: String(addr.provinceCode),
        district: addr.district || "",
        districtCode: String(addr.districtCode || ""),
        ward: addr.ward,
        wardCode: String(addr.wardCode),
        street: addr.street.trim(),
        fullAddress,
        addressMode,
      },
      carrier: provider,
      provider,
      shipping_carrier: carrierDisplayName(provider),
      totalAmount,
      revenue: totalAmount,
      cod_amount: totalAmount,
      status: mapped.status,
      shopee_order_status: mapped.shopee,
      external_status: "created",
      date: nowIso,
      create_time: nowIso,
      trackingNumber: trackingNumber || null,
      tracking_no: trackingNumber || null,
      isPrepared: false,
      isPrinted: false,
      items: lineItems,
      logisticsPayload,
      carrier_error: carrierError || null,
    };

    await persistExternalOrder(newOrder);

    let addressBookEntry = null;
    if (save_to_address_book === true || save_to_address_book === "true" || save_to_address_book === 1) {
      try {
        addressBookEntry = saveAddressBookEntry({
          name,
          phone,
          province: addr.province,
          provinceCode: addr.provinceCode,
          district: addr.district || "",
          districtCode: addr.districtCode || "",
          ward: addr.ward,
          wardCode: addr.wardCode,
          street: addr.street.trim(),
          fullAddress,
        });
      } catch (bookErr) {
        console.warn("[Orders manual] address book:", bookErr?.message || bookErr);
      }
    }

    return res.json({
      success: true,
      order: newOrder,
      trackingNumber,
      carrierError: carrierError || null,
      logisticsPayload,
      addressBookSaved: Boolean(addressBookEntry),
    });
  } catch (error) {
    console.error("[Orders manual]", error);
    return res.status(500).json({ error: error.message || "Tạo đơn thủ công thất bại" });
  }
}

/**
 * POST /api/orders/external/print-waybill
 * Trả URL PDF gốc GHN (gen-token → printA5) hoặc SPX waybill — không vẽ HTML.
 */
export async function printExternalWaybill(req, res) {
  try {
    const body = req.body || {};
    const orderSn = String(body.orderSn || body.order_sn || req.query.orderSn || "")
      .trim()
      .replace(/^ext-/i, "");
    const format = String(body.format || req.query.format || "a5").toLowerCase();
    if (!orderSn) {
      return res.status(400).json({ success: false, error: "Thiếu mã đơn (orderSn)." });
    }
    if (!isMongoReady()) {
      return res.status(503).json({ success: false, error: "mongodb_not_ready" });
    }

    const rows = await loadOrdersFromStore({ orderSns: [orderSn], limit: 1 });
    const order = rows?.[0] || null;
    if (!order) {
      return res.status(404).json({ success: false, error: "Không tìm thấy đơn ngoại sàn." });
    }
    const channel = String(order.channel || "").toLowerCase();
    if (channel !== "manual") {
      return res.status(400).json({
        success: false,
        error: "Chỉ in vận đơn gốc cho đơn ngoại sàn (GHN/SPX).",
      });
    }
    const provider = String(order.provider || order.carrier || "").toLowerCase();
    const trackingNo = String(order.tracking_no || order.trackingNumber || "").trim();
    if (!trackingNo) {
      return res.status(400).json({
        success: false,
        error: "Đơn chưa có mã vận đơn từ hãng. Không thể in phiếu gốc.",
      });
    }

    if (provider === "ghn") {
      const printed = await getGhnPrintUrl(trackingNo, format);
      return res.json({
        success: true,
        provider: "ghn",
        url: printed.url,
        format: printed.format,
        source: "ghn_gen_token",
      });
    }

    if (provider === "spx") {
      const waybill = await getSpxWaybill(trackingNo);
      if (waybill.url) {
        return res.json({
          success: true,
          provider: "spx",
          url: waybill.url,
          source: "spx_awb_url",
        });
      }
      if (waybill.base64) {
        const fs = await import("fs");
        const path = await import("path");
        const fileName = `external-${orderSn}.pdf`;
        const filePath = path.join(PDF_DIR, fileName);
        fs.mkdirSync(PDF_DIR, { recursive: true });
        const buf = Buffer.from(waybill.base64.replace(/^data:application\/pdf;base64,/i, ""), "base64");
        fs.writeFileSync(filePath, buf);
        const base = `${req.protocol}://${req.get("host") || ""}`.replace(/\/$/, "");
        const url = `${base}/api/orders/external/waybill-file/${encodeURIComponent(orderSn)}`;
        return res.json({
          success: true,
          provider: "spx",
          url,
          pdfBase64: waybill.base64.replace(/^data:application\/pdf;base64,/i, ""),
          source: "spx_awb_base64",
        });
      }
      return res.status(502).json({
        success: false,
        error: "SPX không trả URL/PDF waybill gốc.",
      });
    }

    return res.status(400).json({
      success: false,
      error: "Đơn tự giao không có phiếu gửi hàng chuẩn bưu cục.",
    });
  } catch (error) {
    console.error("[Orders external print]", error);
    return res.status(500).json({
      success: false,
      error: error.message || "In vận đơn thất bại",
    });
  }
}

/** GET — stream PDF waybill SPX đã cache (bytes gốc từ hãng, không HTML). */
export async function streamExternalWaybillFile(req, res) {
  try {
    const orderSn = String(req.params.orderSn || "").trim();
    if (!orderSn) return res.status(400).json({ error: "Thiếu mã đơn" });
    const filePath = path.join(PDF_DIR, `external-${orderSn}.pdf`);
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: "Chưa có file PDF waybill. Bấm In vận đơn lại." });
    }
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="${orderSn}.pdf"`);
    return fs.createReadStream(filePath).pipe(res);
  } catch (error) {
    return res.status(500).json({ error: error.message || "Không đọc được PDF" });
  }
}
