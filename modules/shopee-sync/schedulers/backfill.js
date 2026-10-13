// Scheduler sở hữu timer riêng; giữ lịch, điều kiện bật/tắt và thời gian chờ cũ.
import cron from "node-cron";
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

  let isDeepPullInFlight = false;
  rtsBackfillTask = cron.schedule(cronExpr, () => {
    if (isDeepPullInFlight) {
      console.log("[CRON] READY_TO_SHIP backfill skipped — isDeepPullInFlight");
      return;
    }
    isDeepPullInFlight = true;
    const releaseDeepPull = () => {
      isDeepPullInFlight = false;
    };
    const deepPullStaleTimer = setTimeout(() => {
      if (!isDeepPullInFlight) return;
      console.warn("[CRON] isDeepPullInFlight stale — force release");
      releaseDeepPull();
    }, 16 * 60 * 1000);
    console.log(
      `[CRON] Tick READY_TO_SHIP backfill — lookbackSec=${lookbackSec} (~${Math.round(lookbackSec / 86400)}d)`,
    );
    try {
      void Promise.resolve(deps.runSync({ lookbackSec, trigger: "cron" }))
        .then((r) => {
          if (r?.skipped) {
            console.log(`[CRON] RTS backfill skipped: ${r.message || "busy"}`);
            return;
          }
          console.log(
            `[CRON] RTS backfill done pulled=${r?.pulled || 0} +${r?.added || 0}/~${r?.updated || 0}`,
          );
        })
        .catch((err) => {
          console.error("[CRON] RTS backfill tick failed:", err?.message || err);
        })
        .finally(() => {
          clearTimeout(deepPullStaleTimer);
          releaseDeepPull();
        });
    } catch (err) {
      clearTimeout(deepPullStaleTimer);
      releaseDeepPull();
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
