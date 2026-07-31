/**
 * Cron jobs an toàn — mọi lỗi bị nuốt trong try/catch, không throw ra ngoài
 * (tránh Unhandled Promise Rejection / crash Passenger trên cPanel).
 */
import cron from "node-cron";

let autoIncrementalScheduled = false;

/**
 * Auto Incremental Sync mỗi 30 phút — lookback ngắn (mặc định 2h qua deps).
 * Webhook lo real-time; cron chỉ bù miss, không kéo nhiều ngày.
 * @param {{
 *   isMongoReady: () => boolean,
 *   isPullInFlight: () => boolean,
 *   pullIncrementalOrdersFromShopee: (opts: { lookbackSec: number, reconcileActive?: boolean, allowShortLookback?: boolean }) => Promise<any>,
 *   invalidateOrdersRefreshCache?: () => void,
 *   lookbackSec?: number,
 * }} deps
 */
export function scheduleAutoIncrementalOrdersSync(deps) {
  if (autoIncrementalScheduled) return;
  // Mặc định 2h — caller có thể override; pull có allowShortLookback ở server.ts.
  const lookbackSec = Math.max(60, Number(deps.lookbackSec) || 2 * 60 * 60);
  const expression = "*/30 * * * *";

  try {
    if (typeof cron.validate !== "function" || !cron.validate(expression)) {
      console.error("[Background Sync Error]: Invalid cron expression */30 * * * *");
      return;
    }
  } catch (error) {
    console.error("[Background Sync Error]:", error?.message || error);
    return;
  }

  try {
    cron.schedule(expression, () => {
      // Không dùng async callback trực tiếp của node-cron — chạy fire-and-forget + catch tuyệt đối.
      Promise.resolve()
        .then(() => runAutoIncrementalOnce(deps, lookbackSec))
        .catch((error) => {
          console.error("[Background Sync Error]:", error?.message || error);
        });
    });
    autoIncrementalScheduled = true;
    console.log(
      `[CRON] Auto Incremental Sync ON — mỗi 30 phút (lookback ${lookbackSec}s, short window).`,
    );
  } catch (error) {
    console.error("[Background Sync Error]:", error?.message || error);
  }
}

async function runAutoIncrementalOnce(deps, lookbackSec) {
  try {
    if (typeof deps.isMongoReady === "function" && !deps.isMongoReady()) {
      console.log("[CRON] Auto sync 30m skipped — Mongo not ready.");
      return;
    }
    if (typeof deps.isPullInFlight === "function" && deps.isPullInFlight()) {
      console.log("[CRON] Auto sync 30m skipped — pull already in flight.");
      return;
    }

    console.log(`[CRON] Auto sync 30m start — lookbackSec=${lookbackSec}`);
    const result = await deps.pullIncrementalOrdersFromShopee({
      lookbackSec,
      reconcileActive: false,
      allowShortLookback: true,
    });

    if (result && !result.skipped && typeof deps.invalidateOrdersRefreshCache === "function") {
      try {
        deps.invalidateOrdersRefreshCache();
      } catch (cacheErr) {
        console.error("[Background Sync Error]:", cacheErr?.message || cacheErr);
      }
    }

    console.log(
      `[CRON] Auto sync 30m finished successfully pulled=${result?.pulled ?? 0} +${result?.added ?? 0}/~${result?.updated ?? 0} err=${(result?.errors || []).length} — ${result?.message || ""}`,
    );
  } catch (error) {
    console.error("[Background Sync Error]:", error?.message || error);
    return;
  }
}
