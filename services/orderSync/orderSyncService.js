/**
 * Order Sync Service — Background Sync & BulkWrite orchestration.
 *
 * - Frontend / Routes chỉ trigger (ACK ngay).
 * - Service này gọi API sàn + Repository bulkWrite (qua pullIncremental inject).
 * - Sau upsert: đẩy đơn mới vào Label PDF Queue.
 *
 * Không expose Shopee API ra Frontend.
 */

import { enqueueLabelPdfDownload } from "./labelPdfQueue.js";

const DEFAULT_INCREMENTAL_LOOKBACK_SEC = 2 * 60 * 60; // 2 giờ (trong khoảng 1–3h)

let deps = {
  /** @type {(opts?: any) => Promise<any>} */
  pullIncrementalOrdersFromShopee: async () => ({
    success: false,
    pulled: 0,
    added: 0,
    updated: 0,
    shops: 0,
    errors: [],
    message: "not_initialized",
    newlyUpsertedOrders: [],
  }),
  createSyncJob: async () => ({ id: "" }),
  finishSyncJob: async () => {},
  invalidateOrdersRefreshCache: () => {},
  isOrdersPullLocked: () => false,
};

let bgRunning = false;

export function initOrderSyncService(partial) {
  deps = { ...deps, ...partial };
  console.log("[OrderSyncService] initialized");
}

export function isOrderSyncBackgroundBusy() {
  return bgRunning || (typeof deps.isOrdersPullLocked === "function" && deps.isOrdersPullLocked());
}

/**
 * Chạy 1 phiên incremental sync ngầm (update_time cửa sổ ngắn).
 * @param {object} [opts]
 * @param {number} [opts.lookbackSec] mặc định 2h
 * @param {string[]} [opts.shopIds]
 * @param {string} [opts.username]
 * @param {string} [opts.trigger] cron | api | webhook
 * @param {boolean} [opts.reconcileActive]
 */
export async function runBackgroundOrderSync(opts = {}) {
  const lookbackSec = Math.max(
    60,
    Number(opts.lookbackSec) || DEFAULT_INCREMENTAL_LOOKBACK_SEC,
  );
  const trigger = String(opts.trigger || "manual");
  const logTag = `OrderSync[${trigger}]`;

  if (bgRunning) {
    console.log(`[${logTag}] SKIP — background sync đang chạy`);
    return {
      success: true,
      skipped: true,
      message: "Hệ thống đang trong quá trình đồng bộ ngầm. Vui lòng đợi trong giây lát",
      pulled: 0,
      added: 0,
      updated: 0,
    };
  }
  if (typeof deps.isOrdersPullLocked === "function" && deps.isOrdersPullLocked()) {
    console.log(`[${logTag}] SKIP — orders pull lock busy`);
    return {
      success: true,
      skipped: true,
      message: "Hệ thống đang trong quá trình đồng bộ ngầm. Vui lòng đợi trong giây lát",
      pulled: 0,
      added: 0,
      updated: 0,
    };
  }

  bgRunning = true;
  let jobId = "";
  const startedAt = Date.now();
  console.log(
    `[${logTag}] Bắt đầu chạy tiến trình ngầm — lookbackSec=${lookbackSec}` +
      ` shops=${opts.shopIds?.length ? opts.shopIds.join(",") : "all"}`,
  );

  try {
    try {
      const job = await deps.createSyncJob(
        opts.jobType || "shopee_orders_bg_sync",
        opts.username || trigger,
      );
      jobId = job?.id || "";
    } catch (jobErr) {
      console.warn(`[${logTag}] createSyncJob skip:`, jobErr?.message || jobErr);
    }

    const result = await deps.pullIncrementalOrdersFromShopee({
      lookbackSec,
      shopIds: opts.shopIds?.length ? opts.shopIds : undefined,
      allowShortLookback: opts.allowShortLookback !== false,
      reconcileActive: opts.reconcileActive === true,
      enrichTracking: opts.enrichTracking === true,
      oneShopPerTick: opts.oneShopPerTick === true,
    });

    const pulled = result?.pulled || 0;
    const added = result?.added || 0;
    const updated = result?.updated || 0;
    console.log(
      `[${logTag}] Số lượng lấy được từ Sàn — pulled=${pulled} +${added}/~${updated}` +
        ` shops=${result?.shops || 0}`,
    );

    // PDF queue: đơn mới từ kết quả pull (nếu pull trả về danh sách)
    const newly = Array.isArray(result?.newlyUpsertedOrders)
      ? result.newlyUpsertedOrders
      : [];
    if (newly.length > 0) {
      console.log(`[${logTag}] Đẩy vào hàng đợi tải PDF — n=${newly.length}`);
      enqueueLabelPdfDownload(newly);
    }

    try {
      deps.invalidateOrdersRefreshCache?.();
    } catch {
      /* ignore */
    }

    const success = result?.success !== false && !result?.skipped;
    const message =
      result?.message ||
      (pulled > 0
        ? `Đồng bộ ngầm xong — ${pulled} đơn (+${added}/~${updated})`
        : "Đồng bộ ngầm xong — 0 đơn trong cửa sổ");

    if (jobId) {
      try {
        await deps.finishSyncJob(
          jobId,
          success || result?.skipped ? "succeeded" : "failed",
          { pulled, added, updated, shops: result?.shops, trigger, lookbackSec },
          success || result?.skipped ? undefined : message,
        );
      } catch {
        /* ignore */
      }
    }

    console.log(
      `[${logTag}] DONE elapsedMs=${Date.now() - startedAt} — ${message}`,
    );
    return {
      success: success || Boolean(result?.skipped),
      skipped: Boolean(result?.skipped),
      pulled,
      added,
      updated,
      shops: result?.shops || 0,
      errors: result?.errors || [],
      message,
      lookbackSec,
      elapsedMs: Date.now() - startedAt,
      jobId,
    };
  } catch (err) {
    console.error(`[${logTag}] FATAL:`, err?.stack || err?.message || err);
    if (jobId) {
      try {
        await deps.finishSyncJob(jobId, "failed", {}, err?.message || String(err));
      } catch {
        /* ignore */
      }
    }
    return {
      success: false,
      pulled: 0,
      added: 0,
      updated: 0,
      shops: 0,
      errors: [{ error: "bg_sync_exception", message: err?.message || String(err) }],
      message: err?.message || "Đồng bộ ngầm thất bại",
      elapsedMs: Date.now() - startedAt,
      jobId,
    };
  } finally {
    bgRunning = false;
  }
}

/**
 * Trigger sync ngầm — trả về ngay, không await Shopee.
 * Dùng cho API Routes + Cron.
 */
export function triggerBackgroundOrderSync(opts = {}) {
  if (isOrderSyncBackgroundBusy()) {
    console.log(
      `[OrderSyncService] trigger SKIP — đang đồng bộ ngầm (trigger=${opts.trigger || "api"})`,
    );
    return {
      accepted: false,
      busy: true,
      message: "Hệ thống đang trong quá trình đồng bộ ngầm. Vui lòng đợi trong giây lát",
    };
  }

  console.log(
    `[OrderSyncService] trigger ACCEPTED — hệ thống đang đồng bộ ngầm` +
      ` (trigger=${opts.trigger || "api"} lookbackSec=${opts.lookbackSec || DEFAULT_INCREMENTAL_LOOKBACK_SEC})`,
  );

  setImmediate(() => {
    void runBackgroundOrderSync(opts).catch((err) => {
      console.error(
        "[OrderSyncService] background run failed:",
        err?.stack || err?.message || err,
      );
    });
  });

  return {
    accepted: true,
    busy: false,
    message: "Hệ thống đang đồng bộ ngầm",
    lookbackSec: opts.lookbackSec || DEFAULT_INCREMENTAL_LOOKBACK_SEC,
  };
}

export { DEFAULT_INCREMENTAL_LOOKBACK_SEC };
