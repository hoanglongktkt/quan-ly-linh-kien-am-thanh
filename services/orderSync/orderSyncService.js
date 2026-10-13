/**
 * Order Sync Service — Background Sync & BulkWrite orchestration.
 *
 * - Frontend / Routes chỉ trigger (ACK ngay).
 * - Service này gọi API sàn + Repository bulkWrite (qua pullIncremental inject).
 * - Sau upsert: đẩy đơn mới vào Label PDF Queue.
 *
 * Không expose Shopee API ra Frontend.
 */

import { enqueueOrderSyncJob, setOrderSyncJobProcessor } from "../webhookJobQueue.js";
import { enqueueLabelPdfDownload } from "./labelPdfQueue.js";
import {
  markSuccessfulShopWatermarks,
  resolveIncrementalLookbackSec,
} from "./syncOrchestrator.js";

const DEFAULT_INCREMENTAL_LOOKBACK_SEC = 2 * 60 * 60; // 2 giờ (trong khoảng 1–3h)
/** Webhook rescue: incremental pull ngắn khi get_order_detail fail (5–10 phút). */
const WEBHOOK_RESCUE_LOOKBACK_SEC = Math.max(
  300,
  Math.min(3600, Number(process.env.WEBHOOK_RESCUE_LOOKBACK_SEC) || 600),
);
/** Dedupe rescue cùng order_sn trong cửa sổ ngắn — tránh spam pull. */
const webhookRescueDedupe = new Set();

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
  listShopIds: () => [],
};

let bgRunning = false;
/** Mốc bắt đầu phiên pull để đo thời gian; không dùng để tự mở khóa. */
let lastPullStart = 0;

export function initOrderSyncService(partial) {
  deps = { ...deps, ...partial };
  // Worker duy nhất thực thi job sync đã lưu trong Mongo.
  setOrderSyncJobProcessor(async (opts) => {
    // Cron phụ cũng dùng khóa và hàng đợi chung với nút Đồng bộ.
    if (opts.mode === "task") {
      const task = deps.syncTasks?.[opts.task];
      if (typeof task !== "function") throw new Error("sync_task_invalid");
      return task(opts);
    }
    if (opts.mode === "quick") return deps.runManualQuickSync3h(opts);
    if (opts.mode === "full") return deps.runQueuedOrdersPull(opts);
    return executeBackgroundOrderSync(opts);
  });
  console.log("[OrderSyncService] initialized");
}

/** Giữ khóa theo vòng đời worker. */
function isBgPullLocked() {
  // Giữ khóa tới finally, không mở khi tác vụ vẫn chạy.
  return bgRunning;
}

export function isOrderSyncBackgroundBusy() {
  if (isBgPullLocked()) return true;
  return typeof deps.isOrdersPullLocked === "function" && deps.isOrdersPullLocked();
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
async function executeBackgroundOrderSync(opts = {}) {
  let lookbackSec = Math.max(
    60,
    Number(opts.lookbackSec) || DEFAULT_INCREMENTAL_LOOKBACK_SEC,
  );
  const trigger = String(opts.trigger || "manual");
  const logTag = `OrderSync[${trigger}]`;

  if (isBgPullLocked()) {
    console.error(
      "[SHOPEE API CRON ERROR]:",
      { skipped: true, reason: "bgRunning", trigger, note: "Không gọi get_order_list." },
    );
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
  lastPullStart = Date.now();
  const myPullStart = lastPullStart;
  let jobId = "";
  const startedAt = Date.now();
  console.log(
    `[${logTag}] Bắt đầu chạy tiến trình ngầm — lookbackSec=${lookbackSec}` +
      ` shops=${opts.shopIds?.length ? opts.shopIds.join(",") : "all"}`,
  );

  try {
    // Hàng đợi đã giữ khóa Mongo toàn cục trước khi gọi worker.
    // Watermark is a fast path only; first run and explicit long pulls preserve
    // the caller's requested range.
    const watermarkShopIds = opts.shopIds?.length
      ? opts.shopIds
      : deps.listShopIds?.();
    if (opts.useWatermark !== false && watermarkShopIds?.length) {
      lookbackSec = await resolveIncrementalLookbackSec(watermarkShopIds, lookbackSec);
    }
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
    });
    try {
      await markSuccessfulShopWatermarks(result?.perShop);
    } catch (watermarkErr) {
      console.warn(`[${logTag}] watermark update skipped:`, watermarkErr?.message || watermarkErr);
    }

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
    if (lastPullStart === myPullStart) {
      bgRunning = false;
      lastPullStart = 0;
    }
  }
}

/**
 * Trigger sync ngầm — trả về ngay, không await Shopee.
 * Dùng cho API Routes + Cron.
 */
export async function triggerBackgroundOrderSync(opts = {}) {
  return enqueueOrderSyncJob(opts, opts.trigger === "manual" || opts.trigger === "api" ? 10 : 0);
}

export async function runBackgroundOrderSync(opts = {}) {
  return triggerBackgroundOrderSync(opts);
}

/**
 * Incremental pull ngắn sau webhook fail / queue overflow — không chờ cron 5 phút.
 * Chạy nền, không block HTTP; bỏ qua bgRunning (ưu tiên heal đơn vừa push).
 * @param {{ orderSn?: string, shopId?: string, trigger?: string }} [opts]
 */
export function triggerWebhookRescuePull(opts = {}) {
  const orderSn = String(opts.orderSn || "").trim();
  const shopId = String(opts.shopId || "").trim();
  const trigger = String(opts.trigger || "webhook_rescue");
  const dedupeKey = orderSn ? `${shopId}:${orderSn}` : "";

  if (dedupeKey && webhookRescueDedupe.has(dedupeKey)) {
    console.log(
      `[OrderSyncService] webhook_rescue SKIP dedupe order_sn=${orderSn} shop=${shopId || "all"}`,
    );
    return { accepted: false, busy: false, reason: "dedupe", lookbackSec: WEBHOOK_RESCUE_LOOKBACK_SEC };
  }
  if (dedupeKey) {
    webhookRescueDedupe.add(dedupeKey);
    setTimeout(() => webhookRescueDedupe.delete(dedupeKey), 120_000);
  }

  const lookbackSec = WEBHOOK_RESCUE_LOOKBACK_SEC;
  console.log(
    `[OrderSyncService] webhook_rescue TRIGGER trigger=${trigger}` +
      ` order_sn=${orderSn || "?"} shop=${shopId || "all"} lookbackSec=${lookbackSec}`,
  );

  // Rescue cũng vào hàng đợi, không ghi đơn độc lập với cron.
  void enqueueOrderSyncJob({ lookbackSec, shopIds: shopId ? [shopId] : undefined,
    trigger, useWatermark: false, reconcileActive: false }, 5)
    .catch(() => console.warn("[OrderSyncService] rescue_enqueue_failed"));
  return { accepted: true, busy: false, lookbackSec, trigger };
}

export { DEFAULT_INCREMENTAL_LOOKBACK_SEC, WEBHOOK_RESCUE_LOOKBACK_SEC };
