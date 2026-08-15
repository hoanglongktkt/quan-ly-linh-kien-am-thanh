/**
 * Cron — Background Incremental Order Sync (node-cron).
 * Mặc định: mỗi 5 phút kéo đơn update_time trong ~2 giờ gần nhất.
 *
 * Tắt: AUTO_ORDER_SYNC_CRON=0
 * Dò SHIPPED cho đơn ĐVVC + READY_TO_SHIP/PROCESSED chưa quét mã — mỗi 5 phút.
 * Tắt dò ĐVVC: AUTO_HANDED_OVER_RECONCILE_CRON=0
 */
import fs from "fs";
import path from "path";
import cron from "node-cron";
import { PDF_DIR } from "../utils/appPaths.js";
import {
  triggerBackgroundOrderSync,
  DEFAULT_INCREMENTAL_LOOKBACK_SEC,
} from "../services/orderSync/orderSyncService.js";

let autoIncrementalScheduled = false;
let cronTask = null;
let handedOverReconcileScheduled = false;
let handedOverReconcileTask = null;

/**
 * @param {object} [deps]
 * @param {() => Promise<any>} [deps.runSync] — optional override
 * @param {number} [deps.lookbackSec]
 * @param {string} [deps.cronExpr] — mặc định mỗi 5 phút
 */
export function scheduleAutoIncrementalOrdersSync(deps = {}) {
  if (autoIncrementalScheduled) {
    console.log("[CRON] Auto Incremental Sync already scheduled (idempotent).");
    return;
  }
  autoIncrementalScheduled = true;

  const disabled =
    String(process.env.AUTO_ORDER_SYNC_CRON || "1").trim() === "0" ||
    String(process.env.AUTO_ORDER_SYNC_CRON || "").toLowerCase() === "off" ||
    String(process.env.AUTO_ORDER_SYNC_CRON || "").toLowerCase() === "false";

  if (disabled) {
    console.log(
      "[CRON] Auto Incremental Sync DISABLED (AUTO_ORDER_SYNC_CRON=0) — chỉ webhook + nút Đồng bộ.",
    );
    return;
  }

  const lookbackSec = Math.max(
    60,
    Number(deps.lookbackSec) ||
      Number(process.env.AUTO_ORDER_SYNC_LOOKBACK_SEC) ||
      DEFAULT_INCREMENTAL_LOOKBACK_SEC,
  );
  const cronExpr = String(
    deps.cronExpr || process.env.AUTO_ORDER_SYNC_CRON_EXPR || "*/5 * * * *",
  ).trim();

  if (!cron.validate(cronExpr)) {
    console.error(`[CRON] Invalid cron expr="${cronExpr}" — sync cron NOT started`);
    return;
  }

  cronTask = cron.schedule(cronExpr, () => {
    console.log(
      `[CRON] Tick Incremental Sync — lookbackSec=${lookbackSec} (${Math.round(lookbackSec / 3600)}h)`,
    );
    try {
      if (typeof deps.runSync === "function") {
        void deps.runSync({ lookbackSec, trigger: "cron" });
        return;
      }
      const ack = triggerBackgroundOrderSync({
        lookbackSec,
        trigger: "cron",
        allowShortLookback: true,
        // Đối soát PROCESSED/Đã giao ĐVVC còn kẹt — bắt SHIPPED khi bưu tá đã lấy hàng.
        reconcileActive: true,
        jobType: "shopee_orders_cron_sync",
      });
      console.log(
        `[CRON] trigger → accepted=${ack.accepted} busy=${ack.busy} msg=${ack.message}`,
      );
    } catch (err) {
      console.error("[CRON] Incremental Sync tick failed:", err?.message || err);
    }
  });

  console.log(
    `[CRON] Auto Incremental Sync ON — expr="${cronExpr}" lookbackSec=${lookbackSec}` +
      ` (~${Math.round(lookbackSec / 3600)}h). Mutex bảo vệ chồng job.`,
  );
}

/**
 * Dò trạng thái Shopee cho đơn ĐVVC + READY_TO_SHIP/PROCESSED (chưa quét mã) — mỗi 5 phút.
 * Nhẹ hơn full sync: batch get_order_detail các đơn còn TO_SHIP.
 * Đồng thời setInterval (Passenger-safe) vì node-cron có thể không tick khi worker idle.
 *
 * @param {object} [deps]
 * @param {(opts?: any) => Promise<any>} [deps.reconcileHandedOverCarrierStatuses]
 * @param {string} [deps.cronExpr]
 * @param {number} [deps.intervalMs] — mặc định 5 phút
 */
let handedOverReconcileInterval = null;
let handedOverReconcileBootTimer = null;

function runHandedOverReconcileTick(deps, trigger) {
  console.log(`[CRON] Tick HandedOver status reconcile (ĐVVC → SHIPPED) trigger=${trigger}`);
  try {
    void Promise.resolve(
      deps.reconcileHandedOverCarrierStatuses({ trigger }),
    ).then((r) => {
      if (r?.skipped) {
        console.log(`[CRON] HandedOver reconcile skipped: ${r.message || "busy"}`);
        return;
      }
      console.log(
        `[CRON] HandedOver reconcile done candidates=${r?.candidates || 0}` +
          ` pulled=${r?.pulled || 0} shipped≈${r?.shipped || 0}`,
      );
    });
  } catch (err) {
    console.error("[CRON] HandedOver reconcile tick failed:", err?.message || err);
  }
}

export function scheduleHandedOverStatusReconcile(deps = {}) {
  if (handedOverReconcileScheduled) {
    console.log("[CRON] HandedOver status reconcile already scheduled (idempotent).");
    return;
  }
  handedOverReconcileScheduled = true;

  const disabled =
    String(process.env.AUTO_HANDED_OVER_RECONCILE_CRON || "1").trim() === "0" ||
    String(process.env.AUTO_HANDED_OVER_RECONCILE_CRON || "").toLowerCase() === "off" ||
    String(process.env.AUTO_HANDED_OVER_RECONCILE_CRON || "").toLowerCase() === "false";

  if (disabled) {
    console.log(
      "[CRON] HandedOver status reconcile DISABLED (AUTO_HANDED_OVER_RECONCILE_CRON=0).",
    );
    return;
  }

  if (typeof deps.reconcileHandedOverCarrierStatuses !== "function") {
    console.warn(
      "[CRON] HandedOver status reconcile NOT started — thiếu deps.reconcileHandedOverCarrierStatuses",
    );
    return;
  }

  const cronExpr = String(
    deps.cronExpr || process.env.AUTO_HANDED_OVER_RECONCILE_CRON_EXPR || "*/5 * * * *",
  ).trim();
  const intervalMs = Math.max(
    60_000,
    Number(deps.intervalMs) ||
      Number(process.env.AUTO_HANDED_OVER_RECONCILE_MS) ||
      5 * 60 * 1000,
  );

  if (cron.validate(cronExpr)) {
    handedOverReconcileTask = cron.schedule(cronExpr, () => {
      runHandedOverReconcileTick(deps, "cron");
    });
    console.log(
      `[CRON] HandedOver status reconcile ON — expr="${cronExpr}" (ĐVVC + READY_TO_SHIP/PROCESSED).`,
    );
  } else {
    console.error(
      `[CRON] Invalid handed-over reconcile expr="${cronExpr}" — dùng setInterval thay thế`,
    );
  }

  // setInterval: bắt buộc trên cPanel/Passenger (process idle → node-cron có thể không tick).
  if (handedOverReconcileInterval) {
    try {
      clearInterval(handedOverReconcileInterval);
    } catch {
      /* ignore */
    }
  }
  handedOverReconcileInterval = setInterval(() => {
    runHandedOverReconcileTick(deps, "interval");
  }, intervalMs);
  if (typeof handedOverReconcileInterval.unref === "function") {
    handedOverReconcileInterval.unref();
  }

  // Boot kick ~20s sau khi schedule — xử lý ngay 69 đơn kẹt, không đợi chu kỳ đầu.
  if (handedOverReconcileBootTimer) {
    try {
      clearTimeout(handedOverReconcileBootTimer);
    } catch {
      /* ignore */
    }
  }
  handedOverReconcileBootTimer = setTimeout(() => {
    runHandedOverReconcileTick(deps, "boot");
  }, 20_000);
  if (typeof handedOverReconcileBootTimer.unref === "function") {
    handedOverReconcileBootTimer.unref();
  }

  console.log(
    `[CRON] HandedOver setInterval ON — every ${Math.round(intervalMs / 1000)}s + boot kick 20s.`,
  );
}

export function stopAutoIncrementalOrdersSync() {
  if (cronTask) {
    try {
      cronTask.stop();
    } catch {
      /* ignore */
    }
    cronTask = null;
  }
  autoIncrementalScheduled = false;
  console.log("[CRON] Auto Incremental Sync stopped.");
}

export function stopHandedOverStatusReconcile() {
  if (handedOverReconcileTask) {
    try {
      handedOverReconcileTask.stop();
    } catch {
      /* ignore */
    }
    handedOverReconcileTask = null;
  }
  if (handedOverReconcileInterval) {
    try {
      clearInterval(handedOverReconcileInterval);
    } catch {
      /* ignore */
    }
    handedOverReconcileInterval = null;
  }
  if (handedOverReconcileBootTimer) {
    try {
      clearTimeout(handedOverReconcileBootTimer);
    } catch {
      /* ignore */
    }
    handedOverReconcileBootTimer = null;
  }
  handedOverReconcileScheduled = false;
  console.log("[CRON] HandedOver status reconcile stopped.");
}

let returnRequestsScheduled = false;
let returnRequestsTask = null;

/**
 * Đồng bộ Yêu cầu trả hàng từ Shopee Return APIs — mặc định mỗi 10 phút.
 * Tắt: AUTO_RETURN_REQUESTS_CRON=0
 *
 * @param {object} [deps]
 * @param {(opts?: any) => Promise<any>} deps.runSync
 * @param {string} [deps.cronExpr]
 */
export function scheduleShopeeReturnRequestsSync(deps = {}) {
  if (returnRequestsScheduled) {
    console.log("[CRON] Return Requests Sync already scheduled (idempotent).");
    return;
  }
  returnRequestsScheduled = true;

  const disabled =
    String(process.env.AUTO_RETURN_REQUESTS_CRON || "1").trim() === "0" ||
    String(process.env.AUTO_RETURN_REQUESTS_CRON || "").toLowerCase() === "off" ||
    String(process.env.AUTO_RETURN_REQUESTS_CRON || "").toLowerCase() === "false";

  if (disabled) {
    console.log(
      "[CRON] Return Requests Sync DISABLED (AUTO_RETURN_REQUESTS_CRON=0).",
    );
    return;
  }

  if (typeof deps.runSync !== "function") {
    console.warn("[CRON] Return Requests Sync NOT started — thiếu deps.runSync");
    return;
  }

  const cronExpr = String(
    deps.cronExpr || process.env.AUTO_RETURN_REQUESTS_CRON_EXPR || "*/10 * * * *",
  ).trim();

  if (!cron.validate(cronExpr)) {
    console.error(`[CRON] Invalid return-requests cron expr="${cronExpr}"`);
    return;
  }

  returnRequestsTask = cron.schedule(cronExpr, () => {
    console.log("[CRON] Tick Return Requests Sync (get_return_list → detail → reverse TN)");
    try {
      void Promise.resolve(deps.runSync({ mode: "incremental", trigger: "cron" })).then((r) => {
        if (r?.skipped) {
          console.log(`[CRON] Return Requests skipped: ${r.message || "busy"}`);
          return;
        }
        console.log(
          `[CRON] Return Requests done pulled=${r?.pulled || 0} updated=${r?.updated || 0} retryFilled=${r?.retryFilled || 0}`,
        );
      });
    } catch (err) {
      console.error("[CRON] Return Requests tick failed:", err?.message || err);
    }
  });

  // Boot kick nhẹ — không chờ 10 phút mới có dữ liệu cho tab.
  setTimeout(() => {
    try {
      void Promise.resolve(deps.runSync({ mode: "incremental", trigger: "boot" }));
    } catch {
      /* ignore */
    }
  }, 45_000);

  console.log(`[CRON] Return Requests Sync ON — expr="${cronExpr}"`);
}

export function stopShopeeReturnRequestsSync() {
  if (returnRequestsTask) {
    try {
      returnRequestsTask.stop();
    } catch {
      /* ignore */
    }
    returnRequestsTask = null;
  }
  returnRequestsScheduled = false;
  console.log("[CRON] Return Requests Sync stopped.");
}

let rtsBackfillScheduled = false;
let rtsBackfillTask = null;

/**
 * Vét đơn READY_TO_SHIP (chưa Arrange / miss webhook) — lookback ≥ 7 ngày.
 * Tắt: AUTO_RTS_BACKFILL_CRON=0
 *
 * @param {object} [deps]
 * @param {(opts?: any) => Promise<any>} deps.runSync
 * @param {number} [deps.lookbackSec]
 * @param {string} [deps.cronExpr]
 */
export function scheduleReadyToShipBackfill(deps = {}) {
  if (rtsBackfillScheduled) {
    console.log("[CRON] READY_TO_SHIP backfill already scheduled (idempotent).");
    return;
  }
  rtsBackfillScheduled = true;

  const disabled =
    String(process.env.AUTO_RTS_BACKFILL_CRON || "1").trim() === "0" ||
    String(process.env.AUTO_RTS_BACKFILL_CRON || "").toLowerCase() === "off" ||
    String(process.env.AUTO_RTS_BACKFILL_CRON || "").toLowerCase() === "false";

  if (disabled) {
    console.log("[CRON] READY_TO_SHIP backfill DISABLED (AUTO_RTS_BACKFILL_CRON=0).");
    return;
  }

  if (typeof deps.runSync !== "function") {
    console.warn("[CRON] READY_TO_SHIP backfill NOT started — thiếu deps.runSync");
    return;
  }

  const lookbackSec = Math.max(
    7 * 24 * 60 * 60,
    Number(deps.lookbackSec) || 7 * 24 * 60 * 60,
  );
  const cronExpr = String(
    deps.cronExpr || process.env.AUTO_RTS_BACKFILL_CRON_EXPR || "*/10 * * * *",
  ).trim();

  if (!cron.validate(cronExpr)) {
    console.error(`[CRON] Invalid RTS backfill cron expr="${cronExpr}"`);
    return;
  }

  rtsBackfillTask = cron.schedule(cronExpr, () => {
    console.log(
      `[CRON] Tick READY_TO_SHIP backfill — lookbackSec=${lookbackSec} (~${Math.round(lookbackSec / 86400)}d)`,
    );
    try {
      void Promise.resolve(
        deps.runSync({ lookbackSec, trigger: "cron" }),
      ).then((r) => {
        if (r?.skipped) {
          console.log(`[CRON] RTS backfill skipped: ${r.message || "busy"}`);
          return;
        }
        console.log(
          `[CRON] RTS backfill done pulled=${r?.pulled || 0} +${r?.added || 0}/~${r?.updated || 0}`,
        );
      });
    } catch (err) {
      console.error("[CRON] RTS backfill tick failed:", err?.message || err);
    }
  });

  setTimeout(() => {
    try {
      void Promise.resolve(deps.runSync({ lookbackSec, trigger: "boot" }));
    } catch {
      /* ignore */
    }
  }, 28_000);

  console.log(
    `[CRON] READY_TO_SHIP backfill ON — expr="${cronExpr}" lookbackSec=${lookbackSec}`,
  );
}

export function stopReadyToShipBackfill() {
  if (rtsBackfillTask) {
    try {
      rtsBackfillTask.stop();
    } catch {
      /* ignore */
    }
    rtsBackfillTask = null;
  }
  rtsBackfillScheduled = false;
  console.log("[CRON] READY_TO_SHIP backfill stopped.");
}

const LABEL_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 ngày
let labelPdfCleanupScheduled = false;
let labelPdfCleanupTask = null;
let labelPdfCleanupInterval = null;
let labelPdfCleanupRunning = false;

/**
 * Dọn PDF rác trong storage/labels (PDF_DIR): file > 7 ngày hoặc size <= 0.
 * Dual: node-cron 02:00 + setInterval 24h (Passenger idle) + chạy 1 lần lúc boot.
 * Không throw — lỗi permission/ENOENT chỉ log, không crash process.
 */
export function scheduleLabelPdfCleanup() {
  if (labelPdfCleanupScheduled) {
    console.log("[Labels Cleanup Cron] already scheduled (idempotent).");
    return;
  }
  labelPdfCleanupScheduled = true;

  const run = () => {
    if (labelPdfCleanupRunning) return;
    labelPdfCleanupRunning = true;
    let deleted = 0;
    try {
      if (!fs.existsSync(PDF_DIR)) return;
      const cutoff = Date.now() - LABEL_MAX_AGE_MS;
      let names = [];
      try {
        names = fs.readdirSync(PDF_DIR);
      } catch (err) {
        console.warn("[Labels Cleanup Cron] Không đọc được thư mục:", err?.message || err);
        return;
      }
      for (const name of names) {
        if (!/\.pdf$/i.test(name)) continue;
        const full = path.join(PDF_DIR, name);
        try {
          const st = fs.statSync(full);
          if (!st.isFile()) continue;
          if (st.size <= 0 || st.mtimeMs < cutoff) {
            fs.unlinkSync(full);
            deleted += 1;
          }
        } catch (err) {
          console.warn(`[Labels Cleanup Cron] Bỏ qua ${name}:`, err?.message || err);
        }
      }
    } catch (err) {
      console.error("[Labels Cleanup Cron]", err?.message || err);
    } finally {
      labelPdfCleanupRunning = false;
    }
    if (deleted > 0) {
      console.log(`[Labels Cleanup Cron] Đã xóa ${deleted} PDF > 7 ngày trong ${PDF_DIR}`);
    }
  };

  try {
    run(); // boot
  } catch (err) {
    console.error("[Labels Cleanup Cron] boot failed:", err?.message || err);
  }

  try {
    if (cron.validate("0 2 * * *")) {
      labelPdfCleanupTask = cron.schedule("0 2 * * *", run, { timezone: "Asia/Ho_Chi_Minh" });
    }
  } catch (err) {
    console.warn("[Labels Cleanup Cron] node-cron không start:", err?.message || err);
  }

  try {
    if (labelPdfCleanupInterval) clearInterval(labelPdfCleanupInterval);
    labelPdfCleanupInterval = setInterval(run, 24 * 60 * 60 * 1000);
    if (typeof labelPdfCleanupInterval.unref === "function") {
      labelPdfCleanupInterval.unref();
    }
  } catch (err) {
    console.warn("[Labels Cleanup Cron] setInterval không start:", err?.message || err);
  }

  console.log(`[Labels Cleanup Cron] ON — 02:00 Asia/Ho_Chi_Minh + setInterval 24h, dir=${PDF_DIR}, TTL=7d`);
}
