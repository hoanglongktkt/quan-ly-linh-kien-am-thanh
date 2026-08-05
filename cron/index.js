/**
 * Cron — Background Incremental Order Sync (node-cron).
 * Mặc định: mỗi 5 phút kéo đơn update_time trong ~2 giờ gần nhất.
 *
 * Tắt: AUTO_ORDER_SYNC_CRON=0
 * Dò trạng thái Shopee cho đơn tab "Đã giao cho ĐVVC" — mỗi 5 phút.
 * Tắt dò ĐVVC: AUTO_HANDED_OVER_RECONCILE_CRON=0
 */
import cron from "node-cron";
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
 * Dò trạng thái Shopee cho đơn tab "Đã giao cho ĐVVC" — mỗi 5 phút.
 * Nhẹ hơn full sync: chỉ batch get_order_detail các đơn ĐVVC còn TO_SHIP.
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
      `[CRON] HandedOver status reconcile ON — expr="${cronExpr}" (chỉ đơn Đã giao ĐVVC).`,
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
