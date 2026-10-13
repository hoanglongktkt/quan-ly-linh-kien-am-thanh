// Scheduler sở hữu timer riêng; giữ lịch, điều kiện bật/tắt và thời gian chờ cũ.
import cron from "node-cron";
let ghnStatusSyncScheduled = false;
let ghnStatusSyncTask = null;
let ghnStatusSyncInterval = null;
let ghnStatusSyncBootTimer = null;

function runGhnStatusSyncTick(deps, trigger) {
  if (typeof deps.runSync !== "function") return;
  console.log(`[CRON] Tick GHN status sync (đơn ngoại sàn còn mở) trigger=${trigger}`);
  try {
    void Promise.resolve(deps.runSync({ trigger }))
      .then((r) => {
        if (r?.skipped) {
          console.log(`[CRON] GHN status sync skipped: ${r.message || "busy"}`);
          return;
        }
        console.log(
          `[CRON] GHN status sync done scanned=${r?.scanned || 0} updated=${r?.updated || 0}` +
            ` unchanged=${r?.unchanged || 0} errors=${r?.errors || 0}`,
        );
      })
      .catch((err) => {
        console.error("[CRON] GHN status sync tick failed:", err?.message || err);
      });
  } catch (err) {
    console.error("[CRON] GHN status sync tick failed:", err?.message || err);
  }
}

/**
 * Đồng bộ trạng thái GHN tự động — node-cron 30 phút + setInterval (Passenger-safe).
 * Tắt: AUTO_GHN_STATUS_SYNC_CRON=0
 *
 * @param {object} [deps]
 * @param {(opts?: any) => Promise<any>} deps.runSync
 * @param {string} [deps.cronExpr]
 * @param {number} [deps.intervalMs]
 */
export function scheduleGhnStatusSync(deps = {}) {
  if (ghnStatusSyncScheduled) {
    console.log("[CRON] GHN status sync already scheduled (idempotent).");
    return;
  }
  ghnStatusSyncScheduled = true;

  const disabled =
    String(process.env.AUTO_GHN_STATUS_SYNC_CRON || "1").trim() === "0" ||
    String(process.env.AUTO_GHN_STATUS_SYNC_CRON || "").toLowerCase() === "off" ||
    String(process.env.AUTO_GHN_STATUS_SYNC_CRON || "").toLowerCase() === "false";

  if (disabled) {
    console.log("[CRON] GHN status sync DISABLED (AUTO_GHN_STATUS_SYNC_CRON=0).");
    return;
  }

  if (typeof deps.runSync !== "function") {
    console.warn("[CRON] GHN status sync NOT started — thiếu deps.runSync");
    return;
  }

  const cronExpr = String(
    deps.cronExpr || process.env.AUTO_GHN_STATUS_SYNC_CRON_EXPR || "*/30 * * * *",
  ).trim();
  const intervalMs = Math.max(
    10 * 60 * 1000,
    Number(deps.intervalMs) ||
      Number(process.env.AUTO_GHN_STATUS_SYNC_MS) ||
      30 * 60 * 1000,
  );

  if (cron.validate(cronExpr)) {
    ghnStatusSyncTask = cron.schedule(cronExpr, () => {
      runGhnStatusSyncTick(deps, "cron");
    });
    console.log(`[CRON] GHN status sync ON — expr="${cronExpr}" (đơn ngoại sàn GHN còn mở).`);
  } else {
    console.error(
      `[CRON] Invalid GHN status sync expr="${cronExpr}" — dùng setInterval thay thế`,
    );
  }

  if (ghnStatusSyncInterval) {
    try {
      clearInterval(ghnStatusSyncInterval);
    } catch {
      /* ignore */
    }
  }
  ghnStatusSyncInterval = setInterval(() => {
    runGhnStatusSyncTick(deps, "interval");
  }, intervalMs);
  if (typeof ghnStatusSyncInterval.unref === "function") {
    ghnStatusSyncInterval.unref();
  }

  if (ghnStatusSyncBootTimer) {
    try {
      clearTimeout(ghnStatusSyncBootTimer);
    } catch {
      /* ignore */
    }
  }
  ghnStatusSyncBootTimer = setTimeout(() => {
    runGhnStatusSyncTick(deps, "boot");
  }, 75_000);
  if (typeof ghnStatusSyncBootTimer.unref === "function") {
    ghnStatusSyncBootTimer.unref();
  }

  console.log(
    `[CRON] GHN status sync interval=${Math.round(intervalMs / 60000)} phút + boot kick 75s. Mutex chống chồng job.`,
  );
}
