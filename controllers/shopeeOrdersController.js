/**
 * Controllers: Shopee orders pull / sync / diagnostics / sync-from-shop.
 * Phase 6 — tách từ server.ts. Logic sync lõi vẫn inject qua deps.
 */
import {
  normalizeShopIdKey,
  loadShopeeTokens,
  getValidShopeeAccessToken,
  getShopeeAccessTokenForApi,
  isShopeeConfigValid,
  ensureDataDirs,
  resolveShopeeTokenShopId,
} from "../services/shopee/auth.js";
import {
  snapshotShopeeRetryTelemetry,
  diffShopeeRetryTelemetry,
} from "../services/shopee/client.js";
import { runShopeeConnectivityDiagnostics } from "../services/shopee/diagnostics.js";
import { sleep } from "../utils/concurrency.js";
import { isMongoTimeoutOrNetworkError } from "../config/db.js";

function friendlyPullError(err) {
  const raw = err?.message || String(err || "");
  if (isMongoTimeoutOrNetworkError(err) || /27017|connection \d+ to .+ timed out/i.test(raw)) {
    return "Lỗi kết nối MongoDB (timeout tới máy chủ DB). Kiểm tra mạng/firewall/IP whitelist rồi thử lại.";
  }
  return raw || "Đồng bộ thất bại";
}

let deps = {
  createSyncJob: async () => ({ id: "" }),
  finishSyncJob: async () => {},
  pullIncrementalOrdersFromShopee: async () => ({
    success: false,
    pulled: 0,
    added: 0,
    updated: 0,
    shops: 0,
    errors: [],
    message: "not_initialized",
  }),
  pullShopeeCancelReturnOrders: async () => ({
    success: false,
    pulled: 0,
    added: 0,
    updated: 0,
    shops: 0,
    errors: [],
    message: "not_initialized",
  }),
  invalidateOrdersRefreshCache: () => {},
  shopeeGetReturnList: async () => ({}),
  shopeeGetReturnDetail: async () => ({}),
  shopeeGetReverseTrackingInfo: async () => ({}),
  extractShopeeReturnListRows: () => [],
  parseShopeeReturnListMore: () => false,
  fetchReturnShippingTrackingNumber: async () => ({ tracking: "", sources: {} }),
  loadChannelSettings: () => ({ shops: [] }),
  asShopeeArray: (v) => (Array.isArray(v) ? v : []),
  resolveConnectedShopDisplayName: () => "",
  pullShopeeChannelListingsPage: async () => ({
    rowsSaved: 0,
    hasMore: false,
    pageIndex: 0,
    pageStats: { rowsInPage: 0 },
    currentOffset: 0,
    nextOffset: null,
    skippedItems: [],
  }),
  flushDbWrites: async () => {},
  readChannelListingsDb: async () => [],
  refreshCache: async () => {},
  isMongoReady: () => false,
  isOrdersPullLocked: () => false,
  SHOPEE_ITEM_LIST_PAGE_SIZE: 10,
};

export function initShopeeOrdersController(partial) {
  deps = { ...deps, ...partial };
}

/**
 * Chạy kéo đơn + cancel/return. Không throw ra ngoài — luôn trả object (kể cả lỗi).
 */
async function runOrdersPull(opts) {
  const {
    lookbackSec,
    shopIds,
    username,
    jobType,
    logTag,
  } = opts;
  let jobId = "";
  let retryTelemetryBefore;
  try {
    retryTelemetryBefore = snapshotShopeeRetryTelemetry();
  } catch {
    retryTelemetryBefore = null;
  }
  try {
    try {
      const job = await deps.createSyncJob(jobType, username);
      jobId = job?.id || "";
    } catch (jobErr) {
      console.warn(`[${logTag}] createSyncJob skip:`, jobErr?.message || jobErr);
    }
    console.log(`[${logTag}] bắt đầu kéo đơn shop_id=${shopIds?.length ? shopIds.join(",") : "all"}`);
    const result = await deps.pullIncrementalOrdersFromShopee({
      lookbackSec,
      reconcileActive: true,
      shopIds: shopIds?.length ? shopIds : undefined,
    });
    let cancelPull = { pulled: 0, added: 0, updated: 0, errors: [], message: "", skipped: false };
    try {
      cancelPull = await deps.pullShopeeCancelReturnOrders({
        lookbackSec: Math.max(lookbackSec, 48 * 3600),
        shopIds: shopIds?.length ? shopIds : undefined,
      });
    } catch (cancelErr) {
      console.error("[API_SYNC_ERROR] cancel pull:", cancelErr?.stack || cancelErr);
    }
    try {
      deps.invalidateOrdersRefreshCache();
    } catch (cacheErr) {
      console.error("[API_SYNC_ERROR] invalidate cache:", cacheErr?.stack || cacheErr);
    }
    const pulled = (result?.pulled || 0) + (cancelPull.pulled || 0);
    const added = (result?.added || 0) + (cancelPull.added || 0);
    const updated = (result?.updated || 0) + (cancelPull.updated || 0);
    const errors = [...(result?.errors || []), ...(cancelPull.errors || [])];
    const dbErrors = errors.filter((e) => String(e?.error || "") === "db_upsert_failed");
    const success =
      dbErrors.length === 0 &&
      (Boolean(result?.success) || cancelPull.pulled > 0 || errors.length === 0);
    const message =
      dbErrors.length > 0
        ? `Lỗi lưu MongoDB: ${dbErrors[0]?.message || "db_upsert_failed"}`
        : String(result?.message || `Đã kéo ${pulled} đơn`) +
          (cancelPull.pulled > 0 || cancelPull.message
            ? ` | Cancel/return: ${cancelPull.message || `+${cancelPull.pulled}`}`
            : "");
    if (jobId) {
      try {
        await deps.finishSyncJob(
          jobId,
          success ? "succeeded" : "failed",
          {
            pulled,
            added,
            updated,
            shops: result?.shops,
            errors: errors.length,
            cancel_return_pulled: cancelPull.pulled || 0,
            retry: retryTelemetryBefore
              ? diffShopeeRetryTelemetry(retryTelemetryBefore)
              : undefined,
          },
          success ? undefined : message,
        );
      } catch (finishErr) {
        console.error("[API_SYNC_ERROR] finishSyncJob:", finishErr?.stack || finishErr);
      }
    }
    console.log(
      `[${logTag}] done pulled=${pulled} +${added}/~${updated} err=${errors.length} — ${message}`,
    );
    return {
      success,
      pulled,
      added,
      updated,
      shops: result?.shops || 0,
      errors,
      message,
      jobId,
      shopee_response: sanitizeShopeeResponseForFe(result?.shopee_response),
      lookbackSec: result?.lookbackSec,
      elapsedMs: result?.elapsedMs,
    };
  } catch (error) {
    console.error("[API_SYNC_ERROR] Lỗi chi tiết:", error?.stack || error);
    if (jobId) {
      try {
        await deps.finishSyncJob(
          jobId,
          "failed",
          {
            retry: retryTelemetryBefore
              ? diffShopeeRetryTelemetry(retryTelemetryBefore)
              : undefined,
          },
          error?.message || String(error),
        );
      } catch (finishErr) {
        console.error("[API_SYNC_ERROR] finishSyncJob:", finishErr?.stack || finishErr);
      }
    }
    return {
      success: false,
      pulled: 0,
      added: 0,
      updated: 0,
      shops: 0,
      errors: [{ error: "orders_pull_exception", message: friendlyPullError(error) }],
      message: friendlyPullError(error),
      jobId,
      shopee_response: null,
    };
  }
}

/** Cắt gọn raw Shopee để FE debug — tránh payload quá lớn / circular JSON. */
function sanitizeShopeeResponseForFe(raw) {
  if (raw == null) return null;
  try {
    const pages = Array.isArray(raw) ? raw.slice(0, 6) : [raw];
    return pages.map((page) => {
      const cloned = JSON.parse(JSON.stringify(page));
      const orderList =
        cloned?.raw?.response?.order_list ||
        cloned?.raw?.order_list ||
        cloned?.response?.order_list;
      if (Array.isArray(orderList) && orderList.length > 10) {
        const kept = orderList.slice(0, 10);
        if (cloned?.raw?.response?.order_list) {
          cloned.raw.response.order_list = kept;
          cloned.raw.response._truncated = orderList.length;
        } else if (cloned?.raw?.order_list) {
          cloned.raw.order_list = kept;
          cloned.raw._truncated = orderList.length;
        }
      }
      return cloned;
    });
  } catch (err) {
    console.warn("[Orders Pull] sanitizeShopeeResponseForFe:", err?.message || err);
    return { sanitize_error: err?.message || String(err), preview: String(raw).slice(0, 500) };
  }
}

/** Gửi JSON an toàn — không double-send. */
function sendJson(res, statusCode, body) {
  if (res.headersSent) {
    console.warn("[Orders Pull] headers đã gửi — bỏ qua response trùng.");
    return false;
  }
  try {
    res.status(statusCode).json(body);
    return true;
  } catch (err) {
    console.error("[Orders Pull] sendJson FAILED:", err?.message || err);
    try {
      if (!res.headersSent) {
        res.status(500).json({
          success: false,
          message: "Lỗi gửi phản hồi JSON",
          error: err?.message || String(err),
        });
      }
    } catch {
      /* ignore */
    }
    return false;
  }
}

/** Resolve shop_ids từ body — 1 shop cụ thể hoặc undefined (= toàn bộ shop sync). */
function resolvePullShopIds(shopIdsRaw) {
  if (
    shopIdsRaw == null ||
    shopIdsRaw === "" ||
    (Array.isArray(shopIdsRaw) && shopIdsRaw.length === 0)
  ) {
    return undefined;
  }
  const rawList = Array.isArray(shopIdsRaw) ? shopIdsRaw : [shopIdsRaw];
  const resolved = [];
  const seen = new Set();
  for (const raw of rawList) {
    try {
      const one = resolveShopeeTokenShopId(raw) || normalizeShopIdKey(raw);
      if (one && !seen.has(one)) {
        seen.add(one);
        resolved.push(one);
      }
    } catch (err) {
      console.warn(
        `[Orders Pull] resolveShopeeTokenShopId skip raw=${raw}:`,
        err?.message || err,
      );
    }
  }
  return resolved.length ? resolved : undefined;
}

/** POST /api/orders/pull — await kéo đơn, trả shopee_response thô về FE để debug. */
export async function pullOrders(req, res) {
  console.log("=== BẮT ĐẦU PULL ORDERS ===");
  try {
    console.log("Bắt đầu lấy đơn");
    // Mặc định 14 ngày (Unix seconds phía Shopee API).
    const hoursRaw = Number(req.body?.lookback_hours ?? req.body?.hours ?? 14 * 24);
    const hours = Number.isFinite(hoursRaw) && hoursRaw > 0
      ? Math.min(Math.max(hoursRaw, 72), 15 * 24)
      : 14 * 24;
    const lookbackSec = Math.floor(hours * 60 * 60);
    const shopIdsRaw = req.body?.shop_ids ?? req.body?.shopIds ?? req.body?.shop_id;
    const shopIds = resolvePullShopIds(shopIdsRaw);
    const username = String(req.user?.username || "");
    console.log(
      `Đã lấy xong shop_id${shopIds?.length ? `: [${shopIds.join(",")}]` : ": all"}` +
        ` lookback_hours=${hours} lookbackSec=${lookbackSec}`,
    );

    if (typeof deps.isOrdersPullLocked === "function" && deps.isOrdersPullLocked()) {
      sendJson(res, 200, {
        status: 200,
        success: true,
        warning: true,
        pulled: 0,
        added: 0,
        updated: 0,
        message: "Hệ thống đang trong quá trình đồng bộ ngầm. Vui lòng đợi trong giây lát",
        shopee_response: { skipped: true, reason: "pull_in_flight" },
      });
      console.log("Đã gửi phản hồi về FE");
      return;
    }

    const result = await runOrdersPull({
      lookbackSec,
      shopIds,
      username,
      jobType: "shopee_orders_pull",
      logTag: "Orders Pull",
    });

    const hasDbError = (result?.errors || []).some(
      (e) => String(e?.error || "") === "db_upsert_failed",
    );
    const hasFatal =
      hasDbError ||
      (result?.success === false &&
        (result?.errors || []).some((e) =>
          ["orders_pull_exception", "no_oauth_shop", "no_valid_access_token"].includes(
            String(e?.error || ""),
          ),
        ));

    if (hasFatal) {
      sendJson(res, 500, {
        success: false,
        message: result?.message || "Lỗi đồng bộ đơn hàng",
        error: result?.errors?.[0]?.message || result?.message || "orders_pull_failed",
        pulled: result?.pulled || 0,
        added: result?.added || 0,
        updated: result?.updated || 0,
        errors: result?.errors || [],
        shopee_response: result?.shopee_response ?? null,
      });
      console.log("Đã gửi phản hồi về FE");
      return;
    }

    // 200 kể cả khi kéo 0 đơn — kèm raw Shopee để debug.
    sendJson(res, 200, {
      status: 200,
      success: result?.success !== false,
      pulled: result?.pulled || 0,
      added: result?.added || 0,
      updated: result?.updated || 0,
      shops: result?.shops || 0,
      errors: result?.errors || [],
      message: result?.message || `Đã kéo ${result?.pulled || 0} đơn`,
      jobId: result?.jobId || "",
      lookbackSec: result?.lookbackSec || lookbackSec,
      elapsedMs: result?.elapsedMs,
      shopee_response: result?.shopee_response ?? null,
    });
    console.log("Đã gửi phản hồi về FE");
    return;
  } catch (err) {
    console.error("[API_SYNC_ERROR] Lỗi chi tiết:", err?.stack || err);
    sendJson(res, 500, {
      success: false,
      message: `Lỗi đồng bộ đơn hàng: ${friendlyPullError(err)}`,
      error: friendlyPullError(err),
      pulled: 0,
      added: 0,
      updated: 0,
      shopee_response: null,
    });
    console.log("Đã gửi phản hồi về FE");
    return;
  }
}

/** POST /api/shopee/orders/sync — await kéo đơn, trả shopee_response thô về FE. */
export async function syncOrders(req, res) {
  console.log("=== BẮT ĐẦU PULL ORDERS ===");
  try {
    console.log("Bắt đầu lấy đơn");
    const hoursRaw = Number(req.body?.lookback_hours ?? req.body?.hours ?? 14 * 24);
    const hours = Number.isFinite(hoursRaw) && hoursRaw > 0
      ? Math.min(Math.max(hoursRaw, 72), 15 * 24)
      : 14 * 24;
    const lookbackSec = Math.floor(hours * 60 * 60);
    const shopIdsRaw = req.body?.shop_ids ?? req.body?.shopIds ?? req.body?.shop_id;
    const shopIds = resolvePullShopIds(shopIdsRaw);
    const username = String(req.user?.username || "");
    console.log(
      `Đã lấy xong shop_id${shopIds?.length ? `: [${shopIds.join(",")}]` : ": all"}` +
        ` lookback_hours=${hours}`,
    );

    if (typeof deps.isOrdersPullLocked === "function" && deps.isOrdersPullLocked()) {
      sendJson(res, 200, {
        status: 200,
        success: true,
        warning: true,
        pulled: 0,
        added: 0,
        updated: 0,
        message: "Hệ thống đang trong quá trình đồng bộ ngầm. Vui lòng đợi trong giây lát",
        shopee_response: { skipped: true, reason: "pull_in_flight" },
      });
      console.log("Đã gửi phản hồi về FE");
      return;
    }

    const result = await runOrdersPull({
      lookbackSec,
      shopIds,
      username,
      jobType: "shopee_orders_sync",
      logTag: "Orders Sync",
    });

    const hasDbError = (result?.errors || []).some(
      (e) => String(e?.error || "") === "db_upsert_failed",
    );
    if (hasDbError || result?.success === false) {
      sendJson(res, hasDbError ? 500 : 200, {
        success: result?.success !== false && !hasDbError,
        message: result?.message || "Lỗi đồng bộ đơn hàng",
        error: result?.errors?.[0]?.message || result?.message || "orders_sync_failed",
        pulled: result?.pulled || 0,
        added: result?.added || 0,
        updated: result?.updated || 0,
        errors: result?.errors || [],
        shopee_response: result?.shopee_response ?? null,
      });
      console.log("Đã gửi phản hồi về FE");
      return;
    }

    sendJson(res, 200, {
      status: 200,
      success: true,
      pulled: result?.pulled || 0,
      added: result?.added || 0,
      updated: result?.updated || 0,
      shops: result?.shops || 0,
      errors: result?.errors || [],
      message: result?.message || `Đã kéo ${result?.pulled || 0} đơn`,
      jobId: result?.jobId || "",
      lookbackSec: result?.lookbackSec || lookbackSec,
      elapsedMs: result?.elapsedMs,
      shopee_response: result?.shopee_response ?? null,
    });
    console.log("Đã gửi phản hồi về FE");
    return;
  } catch (err) {
    console.error("[API_SYNC_ERROR] Lỗi chi tiết:", err?.stack || err);
    sendJson(res, 500, {
      success: false,
      message: `Lỗi đồng bộ đơn hàng: ${friendlyPullError(err)}`,
      error: friendlyPullError(err),
      pulled: 0,
      added: 0,
      updated: 0,
      shopee_response: null,
    });
    console.log("Đã gửi phản hồi về FE");
    return;
  }
}

/** GET /api/shopee/diagnostics */
export async function getDiagnostics(req, res) {
  try {
    const shopId = req.query.shop_id ? String(req.query.shop_id) : undefined;
    console.log("[Shopee Diagnostics] Bắt đầu kiểm tra...", shopId ? `shop_id=${shopId}` : "");
    const report = await runShopeeConnectivityDiagnostics(shopId);
    console.log("[Shopee Diagnostics] Kết quả:", JSON.stringify(report, null, 2));
    return res.status(report.ok ? 200 : 502).json({
      success: report.ok,
      summary: report.code,
      ...report,
      checkedAt: new Date().toISOString(),
      backend: "cpanel-node",
    });
  } catch (error) {
    console.error("[API_SYNC_ERROR] Lỗi chi tiết:", error?.stack || error);
    if (!res.headersSent) {
      return res.status(500).json({
        success: false,
        error: error?.message || String(error) || "diagnostics_failed",
      });
    }
    return;
  }
}

/** GET /api/shopee/debug/return-by-order */
export async function debugReturnByOrder(req, res) {
  try {
    const orderSn = String(req.query.order_sn || "260703PQ2D6RUK").trim();
    const tokens = loadShopeeTokens();
    const shopIds = Object.keys(tokens);
    const shopId = String(req.query.shop_id || shopIds[0] || "").trim();
    if (!shopId) {
      return res.status(400).json({ ok: false, error: "no_shop", message: "Chưa có shop OAuth." });
    }
    const accessToken = await getValidShopeeAccessToken(shopId);
    if (!accessToken) {
      return res.status(401).json({ ok: false, error: "no_token", shopId });
    }

    const coverFrom = Math.floor(new Date("2026-07-01T00:00:00+07:00").getTime() / 1000);
    const coverTo = Math.floor(new Date("2026-07-19T23:59:59+07:00").getTime() / 1000);
    const windowSec = 15 * 24 * 60 * 60;
    const steps = [];
    let matchedReturnSn = "";
    const listHits = [];

    console.log(`[DEBUG Return] ===== order_sn=${orderSn} shop=${shopId} =====`);

    for (const timeField of ["update", "create"]) {
      for (let t = coverFrom; t < coverTo; t += windowSec) {
        const timeFrom = t;
        const timeTo = Math.min(t + windowSec, coverTo);
        let pageNo = 1;
        while (pageNo <= 30) {
          const listOpts = { pageNo, pageSize: 100 };
          if (timeField === "update") {
            listOpts.updateTimeFrom = timeFrom;
            listOpts.updateTimeTo = timeTo;
          } else {
            listOpts.createTimeFrom = timeFrom;
            listOpts.createTimeTo = timeTo;
          }
          const listResult = await deps.shopeeGetReturnList(shopId, accessToken, listOpts);
          const rows = deps.extractShopeeReturnListRows(listResult);
          for (const row of rows) {
            if (String(row?.order_sn || "") === orderSn) {
              matchedReturnSn = String(row.return_sn || "");
              listHits.push(row);
              console.log(
                `[DEBUG Return] FOUND in list ${timeField} ${timeFrom}-${timeTo} page=${pageNo}:`,
                JSON.stringify(row),
              );
            }
          }
          steps.push({
            step: "get_return_list",
            timeField,
            timeFrom,
            timeTo,
            pageNo,
            error: listResult.error || null,
            rowCount: rows.length,
            more: deps.parseShopeeReturnListMore(listResult),
            matched: Boolean(matchedReturnSn),
          });
          if (matchedReturnSn) break;
          if (!deps.parseShopeeReturnListMore(listResult) && rows.length < 100) break;
          if (rows.length === 0) break;
          pageNo++;
          await sleep(400);
        }
        if (matchedReturnSn) break;
        await sleep(300);
      }
      if (matchedReturnSn) break;
    }

    let detailRaw = null;
    let reverseRaw = null;
    let extractedTn = "";
    let trackingSources = {};
    if (matchedReturnSn) {
      detailRaw = await deps.shopeeGetReturnDetail(shopId, accessToken, matchedReturnSn);
      console.log(`[DEBUG Return] === RAW get_return_detail return_sn=${matchedReturnSn} ===`);
      console.log(JSON.stringify(detailRaw, null, 2));
      reverseRaw = await deps.shopeeGetReverseTrackingInfo(shopId, accessToken, matchedReturnSn);
      console.log(`[DEBUG Return] === RAW get_reverse_tracking_info ===`);
      console.log(JSON.stringify(reverseRaw, null, 2));
      const fetched = await deps.fetchReturnShippingTrackingNumber(
        shopId,
        accessToken,
        matchedReturnSn,
        detailRaw,
      );
      extractedTn = fetched.tracking;
      trackingSources = fetched.sources;
      console.log(`[DEBUG Return] extracted tracking = ${extractedTn || "(EMPTY)"} sources=`, trackingSources);
      const blob = JSON.stringify({ detail: detailRaw, reverse: reverseRaw });
      const idxSpx = blob.indexOf("SPXVN064782062347");
      if (idxSpx >= 0) {
        console.log(`[DEBUG Return] FOUND SPXVN064782062347 at JSON index ${idxSpx}`);
      } else {
        console.warn(`[DEBUG Return] SPXVN064782062347 KHÔNG có trong detail/reverse payload`);
      }
    } else {
      console.warn(
        `[DEBUG Return] KHÔNG tìm thấy return_sn cho order_sn=${orderSn} trong cửa sổ 01–19/07/2026`,
      );
    }

    return res.json({
      ok: Boolean(matchedReturnSn),
      order_sn: orderSn,
      shop_id: shopId,
      return_sn: matchedReturnSn || null,
      tracking_number_extracted: extractedTn || null,
      tracking_sources: trackingSources,
      tracking_key_hint:
        "Ưu tiên response.tracking_number từ get_reverse_tracking_info, sau đó get_return_detail.tracking_number",
      expected_tracking_hint: "SPXVN064782062347",
      tracking_match: extractedTn === "SPXVN064782062347",
      list_hits: listHits,
      steps,
      return_detail_raw: detailRaw,
      reverse_tracking_raw: reverseRaw,
      persisted: false,
      message: matchedReturnSn
        ? extractedTn
          ? `OK — lấy được tracking_number=${extractedTn} (sources: ${Object.keys(trackingSources).join(",")})`
          : "Tìm thấy return_sn nhưng tracking rỗng — xem reverse_tracking_raw.response.tracking_number"
        : "Không tìm thấy return trong get_return_list (kiểm tra token/shop/time window)",
    });
  } catch (error) {
    console.error("[DEBUG Return] exception:", error?.message || error, error?.stack || "");
    if (res.headersSent) return;
    return res.status(500).json({
      ok: false,
      error: error?.message || String(error) || "Internal Server Error",
    });
  }
}

/** POST /api/sync-from-shop */
export async function syncFromShop(req, res) {
  try {
    const requestedShopId = String(req.body?.shop_id || "").trim();
    const timeRange = String(req.body?.time_range || "").trim();
    if (!requestedShopId || !["all", "24h"].includes(timeRange)) {
      return res.status(400).json({
        success: false,
        error: "invalid_sync_params",
        message: "shop_id và time_range ('all' hoặc '24h') là bắt buộc.",
      });
    }

    const channelSettings = deps.loadChannelSettings();
    const connectedShop = deps.asShopeeArray(channelSettings?.shops).find(
      (shop) =>
        normalizeShopIdKey(shop?.shopId) === normalizeShopIdKey(requestedShopId) &&
        shop?.connected === true,
    );
    if (!connectedShop) {
      return res.status(404).json({
        success: false,
        error: "connected_shop_not_found",
        message: `Không tìm thấy shop_id=${requestedShopId} trong danh sách gian hàng đã kết nối.`,
      });
    }
    if (connectedShop.platform !== "shopee") {
      return res.status(501).json({
        success: false,
        error: "platform_sync_not_implemented",
        message: `Đồng bộ sản phẩm ${connectedShop.platform} chưa được tích hợp trên server.`,
      });
    }

    if (!isShopeeConfigValid()) {
      return res.status(500).json({
        success: false,
        message: "SHOPEE_PARTNER_ID/SHOPEE_PARTNER_KEY trong .env chưa hợp lệ.",
        error: "invalid_partner_config",
        details: "invalid_partner_config",
      });
    }

    const tokenContext = await getShopeeAccessTokenForApi(requestedShopId);
    if (!tokenContext) {
      return res.status(401).json({
        success: false,
        message: `Chưa có access_token hợp lệ cho shop_id=${requestedShopId}.`,
        error: "no_valid_access_token",
        details: "no_valid_access_token",
      });
    }

    const shopId = tokenContext.apiShopId;
    const accessToken = tokenContext.token;

    ensureDataDirs();

    const shopName =
      String(connectedShop.shopName || "").trim() ||
      deps.resolveConnectedShopDisplayName(shopId) ||
      `Shop ${shopId}`;
    const offset = Math.max(0, Number(req.body?.offset) || 0);
    const requestedSyncTo = Number(req.body?.sync_to);
    const syncTo =
      Number.isFinite(requestedSyncTo) && requestedSyncTo > 0
        ? Math.floor(requestedSyncTo)
        : Math.floor(Date.now() / 1000);
    const updateWindow =
      timeRange === "24h" ? { from: syncTo - 24 * 60 * 60, to: syncTo } : undefined;

    console.log(
      `[Sync From Shop] platform=shopee shop_id=${shopId} range=${timeRange} offset=${offset} page_size=${deps.SHOPEE_ITEM_LIST_PAGE_SIZE}`,
    );

    const pageResult = await deps.pullShopeeChannelListingsPage(
      shopId,
      accessToken,
      shopName,
      offset,
      updateWindow,
    );
    let listingsCount = 0;
    try {
      await deps.flushDbWrites();
      listingsCount = (await deps.readChannelListingsDb()).length;
    } catch {
      listingsCount = pageResult.rowsSaved;
    }
    try {
      await deps.refreshCache();
    } catch (cacheErr) {
      console.error("[Sync From Shop] refreshCache thất bại:", cacheErr);
    }
    console.log(
      `Đã lưu DB thành công — trang offset=${offset}, listingsInDb=${listingsCount} mongo=${deps.isMongoReady()}`,
    );

    return res.status(200).json({
      success: true,
      message:
        pageResult.rowsSaved > 0
          ? `Đã lưu trang ${pageResult.pageIndex + 1}: ${pageResult.pageStats.rowsInPage} parent (${pageResult.rowsSaved} SKU)`
          : pageResult.hasMore
            ? "Trang trống — đang chuyển trang tiếp theo"
            : "Hoàn tất tải dữ liệu từ sàn",
      shopId,
      shop_id: requestedShopId,
      shopName,
      platform: "shopee",
      time_range: timeRange,
      sync_to: syncTo,
      offset: pageResult.currentOffset,
      nextOffset: pageResult.hasMore ? pageResult.nextOffset : null,
      hasMore: pageResult.hasMore,
      pageSize: deps.SHOPEE_ITEM_LIST_PAGE_SIZE,
      pageStats: pageResult.pageStats,
      savedCount: pageResult.rowsSaved,
      fetchedCount: pageResult.pageStats.rowsInPage,
      parentCount: pageResult.pageStats.rowsInPage,
      listingsCount,
      skippedItems:
        pageResult.skippedItems.length > 0 ? pageResult.skippedItems.slice(0, 50) : undefined,
    });
  } catch (error) {
    console.error("[API_SYNC_ERROR] Lỗi chi tiết:", error?.stack || error);
    const errObj = error instanceof Error ? error : new Error(String(error));
    if (!res.headersSent) {
      return res.status(500).json({
        success: false,
        message: errObj.message,
        error: errObj.message || errObj.toString(),
      });
    }
  }
}
