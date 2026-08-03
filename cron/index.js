/**
 * Cron — Background Incremental Order Sync (node-cron).
 * Mặc định: mỗi 5 phút kéo đơn update_time trong ~2 giờ gần nhất.
 *
 * Tắt: AUTO_ORDER_SYNC_CRON=0
 */
import cron from "node-cron";
import {
  triggerBackgroundOrderSync,
  DEFAULT_INCREMENTAL_LOOKBACK_SEC,
} from "../services/orderSync/orderSyncService.js";

let autoIncrementalScheduled = false;
let cronTask = null;

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
        reconcileActive: false,
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
