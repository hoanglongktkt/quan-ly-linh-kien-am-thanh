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
} from "../services/shopee/auth.js";
import {
  snapshotShopeeRetryTelemetry,
  diffShopeeRetryTelemetry,
} from "../services/shopee/client.js";
import { runShopeeConnectivityDiagnostics } from "../services/shopee/diagnostics.js";
import { sleep } from "../utils/concurrency.js";

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
  SHOPEE_ITEM_LIST_PAGE_SIZE: 10,
};

export function initShopeeOrdersController(partial) {
  deps = { ...deps, ...partial };
}

/** POST /api/orders/pull — fire-and-forget: HTTP trả ngay, sync chạy ngầm. */
export async function pullOrders(req, res) {
  try {
    const hoursRaw = Number(req.body?.lookback_hours ?? req.body?.hours ?? 24);
    const hours = Number.isFinite(hoursRaw) && hoursRaw > 0 ? Math.min(hoursRaw, 15 * 24) : 24;
    const lookbackSec = Math.floor(hours * 60 * 60);
    const shopIdsRaw = req.body?.shop_ids ?? req.body?.shopIds ?? req.body?.shop_id;
    const shopIds = Array.isArray(shopIdsRaw)
      ? shopIdsRaw.map((id) => normalizeShopIdKey(id)).filter(Boolean)
      : shopIdsRaw
        ? [normalizeShopIdKey(shopIdsRaw)].filter(Boolean)
        : undefined;
    const username = String(req.user?.username || "");
    console.log(
      `[Orders Pull] POST /api/orders/pull (background) lookback_hours=${hours}` +
        (shopIds?.length ? ` shop_ids=[${shopIds.join(",")}]` : " shop_ids=all"),
    );

    res.status(200).json({
      status: 200,
      success: true,
      background: true,
      message: "Đã đưa vào tiến trình đồng bộ ngầm",
    });

    void (async () => {
      let jobId = "";
      const retryTelemetryBefore = snapshotShopeeRetryTelemetry();
      try {
        const job = await deps.createSyncJob("shopee_orders_pull", username);
        jobId = job.id;
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
          console.warn("[Orders Pull] BG cancel/return follow-up:", cancelErr?.message || cancelErr);
        }
        deps.invalidateOrdersRefreshCache();
        const pulled = result.pulled + (cancelPull.pulled || 0);
        const added = result.added + (cancelPull.added || 0);
        const updated = result.updated + (cancelPull.updated || 0);
        const errors = [...(result.errors || []), ...(cancelPull.errors || [])];
        const success = result.success || cancelPull.pulled > 0;
        const message =
          result.message +
          (cancelPull.pulled > 0 || cancelPull.message
            ? ` | Cancel/return: ${cancelPull.message || `+${cancelPull.pulled}`}`
            : "");
        await deps.finishSyncJob(
          jobId,
          success ? "succeeded" : "failed",
          {
            pulled,
            added,
            updated,
            shops: result.shops,
            errors: errors.length,
            cancel_return_pulled: cancelPull.pulled || 0,
            retry: diffShopeeRetryTelemetry(retryTelemetryBefore),
          },
          success ? undefined : message,
        );
        console.log(
          `[Orders Pull] BG done pulled=${pulled} +${added}/~${updated} err=${errors.length} — ${message}`,
        );
      } catch (error) {
        console.error(
          "[Orders Pull] BG exception:",
          error?.stack || error?.message || error,
        );
        if (jobId) {
          try {
            await deps.finishSyncJob(
              jobId,
              "failed",
              { retry: diffShopeeRetryTelemetry(retryTelemetryBefore) },
              error?.message || String(error),
            );
          } catch (finishErr) {
            console.warn("[Orders Pull] BG finishSyncJob failed:", finishErr?.message || finishErr);
          }
        }
      }
    })();
  } catch (error) {
    console.error("[Orders Pull] /api/orders/pull exception:", error?.stack || error?.message || error);
    if (!res.headersSent) {
      return res.status(500).json({
        success: false,
        pulled: 0,
        error: "orders_pull_failed",
        message: error?.message || "Không thể kéo đơn từ Shopee.",
      });
    }
  }
}

/** POST /api/shopee/orders/sync — fire-and-forget: HTTP trả ngay, sync chạy ngầm. */
export async function syncOrders(req, res) {
  try {
    const hoursRaw = Number(req.body?.lookback_hours ?? req.body?.hours ?? 24);
    const hours = Number.isFinite(hoursRaw) && hoursRaw > 0 ? Math.min(hoursRaw, 15 * 24) : 24;
    const lookbackSec = Math.floor(hours * 60 * 60);
    const shopIdsRaw = req.body?.shop_ids ?? req.body?.shopIds ?? req.body?.shop_id;
    const shopIds = Array.isArray(shopIdsRaw)
      ? shopIdsRaw.map((id) => normalizeShopIdKey(id)).filter(Boolean)
      : shopIdsRaw
        ? [normalizeShopIdKey(shopIdsRaw)].filter(Boolean)
        : undefined;
    const username = String(req.user?.username || "");
    console.log(
      `[Orders Sync] POST /api/shopee/orders/sync (background) lookback_hours=${hours}` +
        (shopIds?.length ? ` shop_ids=[${shopIds.join(",")}]` : " shop_ids=all"),
    );

    res.status(200).json({
      status: 200,
      success: true,
      background: true,
      message: "Đã đưa vào tiến trình đồng bộ ngầm",
    });

    void (async () => {
      let jobId = "";
      const retryTelemetryBefore = snapshotShopeeRetryTelemetry();
      try {
        const job = await deps.createSyncJob("shopee_orders_sync", username);
        jobId = job.id;
        const result = await deps.pullIncrementalOrdersFromShopee({
          lookbackSec,
          reconcileActive: true,
          shopIds: shopIds?.length ? shopIds : undefined,
        });
        let cancelPull = { pulled: 0, added: 0, updated: 0, errors: [], message: "" };
        try {
          cancelPull = await deps.pullShopeeCancelReturnOrders({
            lookbackSec: Math.max(lookbackSec, 48 * 3600),
            shopIds: shopIds?.length ? shopIds : undefined,
          });
        } catch (cancelErr) {
          console.warn("[Orders Sync] BG cancel/return follow-up:", cancelErr?.message || cancelErr);
        }
        deps.invalidateOrdersRefreshCache();
        const pulled = result.pulled + (cancelPull.pulled || 0);
        const added = result.added + (cancelPull.added || 0);
        const updated = result.updated + (cancelPull.updated || 0);
        const errors = [...(result.errors || []), ...(cancelPull.errors || [])];
        const success = result.success || cancelPull.pulled > 0;
        const message =
          result.message +
          (cancelPull.pulled > 0 || cancelPull.message
            ? ` | Cancel/return: ${cancelPull.message || `+${cancelPull.pulled}`}`
            : "");
        await deps.finishSyncJob(
          jobId,
          success ? "succeeded" : "failed",
          {
            pulled,
            added,
            updated,
            shops: result.shops,
            errors: errors.length,
            cancel_return_pulled: cancelPull.pulled || 0,
            retry: diffShopeeRetryTelemetry(retryTelemetryBefore),
          },
          success ? undefined : message,
        );
        console.log(
          `[Orders Sync] BG done pulled=${pulled} +${added}/~${updated} err=${errors.length} — ${message}`,
        );
      } catch (error) {
        console.error(
          "[Orders Sync] BG exception:",
          error?.stack || error?.message || error,
        );
        if (jobId) {
          try {
            await deps.finishSyncJob(
              jobId,
              "failed",
              { retry: diffShopeeRetryTelemetry(retryTelemetryBefore) },
              error?.message || String(error),
            );
          } catch (finishErr) {
            console.warn("[Orders Sync] BG finishSyncJob failed:", finishErr?.message || finishErr);
          }
        }
      }
    })();
  } catch (error) {
    console.error(
      "[Orders Sync] /api/shopee/orders/sync exception:",
      error?.stack || error?.message || error,
    );
    if (!res.headersSent) {
      return res.status(500).json({
        success: false,
        pulled: 0,
        error: "orders_pull_failed",
        message: error?.message || "Không thể kéo đơn từ Shopee.",
      });
    }
  }
}

/** GET /api/shopee/diagnostics */
export async function getDiagnostics(req, res) {
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
    console.error("DB Save Error:", error);
    console.error("[Sync From Shop] Exception:", error);
    const errObj = error instanceof Error ? error : new Error(String(error));
    if (!res.headersSent) {
      return res.status(500).json({
        success: false,
        message: errObj.message,
        error: errObj.toString(),
      });
    }
  }
}
