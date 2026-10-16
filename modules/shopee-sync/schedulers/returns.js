// Scheduler sở hữu timer riêng; giữ lịch, điều kiện bật/tắt và thời gian chờ cũ.
import cron from "node-cron";
let returnRequestsScheduled = false;
let returnRequestsTask = null;

/**
 * Đồng bộ Yêu cầu trả hàng từ Shopee Return APIs — mặc định mỗi 30 phút.
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
    // Lệch khỏi các nhịp đồng bộ đơn để không tranh CPU/pool Mongo cùng phút.
    deps.cronExpr || process.env.AUTO_RETURN_REQUESTS_CRON_EXPR || "7,37 * * * *",
  ).trim();

  if (!cron.validate(cronExpr)) {
    console.error(`[CRON] Invalid return-requests cron expr="${cronExpr}"`);
    return;
  }

  let returnRequestsInFlight = false;
  returnRequestsTask = cron.schedule(cronExpr, () => {
    if (returnRequestsInFlight) {
      console.log("[CRON] Return Requests skipped — previous tick still running");
      return;
    }
    returnRequestsInFlight = true;
    console.log("[CRON] Tick Return Requests Sync (get_return_list → detail → reverse TN)");
    try {
      void Promise.resolve(deps.runSync({ mode: "incremental", trigger: "cron" }))
        .then((r) => {
          if (r?.skipped) {
            console.log(`[CRON] Return Requests skipped: ${r.message || "busy"}`);
            return;
          }
          console.log(
            `[CRON] Return Requests done pulled=${r?.pulled || 0} updated=${r?.updated || 0} retryFilled=${r?.retryFilled || 0}`,
          );
        })
        .catch((err) => {
          console.error("[CRON] Return Requests tick failed:", err?.message || err);
        })
        .finally(() => {
          returnRequestsInFlight = false;
        });
    } catch (err) {
      returnRequestsInFlight = false;
      console.error("[CRON] Return Requests tick failed:", err?.message || err);
    }
  });

  // Chạy sau các job nhận đơn quan trọng; tab trả hàng không cần tranh tải lúc boot.
  const bootDelayMs = Math.max(
    3 * 60_000,
    Number(process.env.AUTO_RETURN_REQUESTS_BOOT_DELAY_MS) || 6 * 60 * 1000,
  );
  const bootTimer = setTimeout(() => {
    if (returnRequestsInFlight) return;
    returnRequestsInFlight = true;
    try {
      void Promise.resolve(deps.runSync({ mode: "incremental", trigger: "boot" }))
        .catch(() => {})
        .finally(() => {
          returnRequestsInFlight = false;
        });
    } catch {
      returnRequestsInFlight = false;
    }
  }, bootDelayMs);
  bootTimer.unref?.();

  console.log(`[CRON] Return Requests Sync ON — expr="${cronExpr}" bootDelayMs=${bootDelayMs}`);
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
