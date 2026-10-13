// Scheduler sở hữu timer riêng; giữ lịch, điều kiện bật/tắt và thời gian chờ cũ.
let keepAlivePingScheduled = false;
let keepAlivePingInterval = null;

/**
 * Self-ping GET /api/health định kỳ — chống cPanel/CloudLinux Passenger coi app "idle"
 * rồi spin-down qua đêm (khiến request đầu ngày phải cold-start rất lâu — đúng triệu
 * chứng "để qua đêm phải load lại lâu, như ngủ đông").
 * CHỈ bật khi chạy thật trên Passenger (biến PASSENGER_APP_ROOT/PASSENGER_APP_ENV tồn tại)
 * — không tự ping khi dev local. Tắt: KEEP_ALIVE_PING_CRON=0.
 * Vòng lặp CÓ điều kiện dừng rõ ràng: setInterval cố định + timeout abort 8s mỗi lần ping
 * (không phải while/for vô hạn, không tăng tần suất khi lỗi).
 *
 * @param {object} [deps]
 * @param {string} [deps.appBaseUrl]
 */
export function scheduleKeepAlivePing(deps = {}) {
  if (keepAlivePingScheduled) {
    console.log("[CRON] Keep-alive self-ping already scheduled (idempotent).");
    return;
  }
  keepAlivePingScheduled = true;

  const isCpanelRuntime = Boolean(
    String(
      process.env.PASSENGER_APP_ROOT ||
        process.env.PASSENGER_APP_ENV ||
        process.env.CPANEL_APP_NAME ||
        process.env.CPANEL_RUNTIME ||
        "",
    ).trim(),
  );
  const flagRaw = String(process.env.KEEP_ALIVE_PING_CRON ?? "1").trim().toLowerCase();
  // "force"/"always" — bật self-ping BẤT KỂ có detect được biến Passenger/cPanel hay không.
  // Dùng khi host cPanel không inject PASSENGER_APP_ROOT/... như kỳ vọng nhưng app vẫn cần
  // chống idle-kill (đặt KEEP_ALIVE_PING_CRON=force trong .env, KHÔNG cần sửa code).
  const forceEnabled = flagRaw === "force" || flagRaw === "always";
  const disabledFlag = flagRaw === "0" || flagRaw === "off" || flagRaw === "false";
  const disabled = disabledFlag || (!isCpanelRuntime && !forceEnabled);
  if (disabled) {
    console.log(
      `[CRON] Keep-alive self-ping OFF (isCpanelRuntime=${isCpanelRuntime}, KEEP_ALIVE_PING_CRON=${process.env.KEEP_ALIVE_PING_CRON ?? "unset"}). ` +
        `Nếu app vẫn bị cold-start dù chạy trên cPanel, đặt KEEP_ALIVE_PING_CRON=force trong .env.`,
    );
    return;
  }
  if (forceEnabled && !isCpanelRuntime) {
    console.log("[CRON] Keep-alive self-ping FORCED ON (KEEP_ALIVE_PING_CRON=force, bỏ qua detect runtime).");
  }

  const baseUrl = String(
    process.env.KEEP_ALIVE_BASE_URL ||
      deps.appBaseUrl ||
      process.env.APP_URL ||
      process.env.API_BASE_URL ||
      "",
  )
    .trim()
    .replace(/\/$/, "");
  if (!baseUrl) {
    console.warn(
      "[CRON] Keep-alive self-ping NOT started — thiếu KEEP_ALIVE_BASE_URL/APP_URL/API_BASE_URL.",
    );
    return;
  }
  const url = `${baseUrl}/api/health`;
  // Giới hạn cứng 1-10 phút — không cho env var đẩy về quá nhỏ (spam) hoặc quá lớn (mất tác dụng).
  const intervalMs = Math.max(
    60_000,
    Math.min(10 * 60_000, Number(process.env.KEEP_ALIVE_PING_MS) || 4 * 60_000),
  );

  const ping = async (trigger) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8_000);
    try {
      const res = await fetch(url, { signal: controller.signal });
      const health = await res.json().catch(() => null);
      const dbState = health?.dbState || (health?.dbReady === true ? "ready" : "unknown");
      if (!res.ok || health?.ok !== true) {
        console.warn(
          `[CRON] Keep-alive ping (${trigger}) ${url} -> ${res.status}, db=${dbState}, health chưa sẵn sàng.`,
        );
        return;
      }
      console.log(
        `[CRON] Keep-alive ping (${trigger}) ${url} -> ${res.status}, db=${dbState}`,
      );
    } catch (err) {
      console.warn(`[CRON] Keep-alive ping (${trigger}) failed:`, err?.message || err);
    } finally {
      clearTimeout(timer);
    }
  };

  if (keepAlivePingInterval) {
    try {
      clearInterval(keepAlivePingInterval);
    } catch {
      /* ignore */
    }
  }
  keepAlivePingInterval = setInterval(() => {
    void ping("interval");
  }, intervalMs);
  if (typeof keepAlivePingInterval.unref === "function") {
    keepAlivePingInterval.unref();
  }
  // Boot kick nhẹ — không cần chờ chu kỳ đầu để xác nhận cơ chế hoạt động trong log.
  setTimeout(() => {
    void ping("boot");
  }, 15_000);

  console.log(`[CRON] Keep-alive self-ping ON — every ${Math.round(intervalMs / 1000)}s -> ${url}`);
}

export function stopKeepAlivePing() {
  if (keepAlivePingInterval) {
    try {
      clearInterval(keepAlivePingInterval);
    } catch {
      /* ignore */
    }
    keepAlivePingInterval = null;
  }
  keepAlivePingScheduled = false;
  console.log("[CRON] Keep-alive self-ping stopped.");
}
