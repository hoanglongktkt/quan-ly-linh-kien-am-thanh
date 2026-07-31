/**
 * Cron jobs — TẮT hoàn toàn auto-sync nền (process leak cPanel).
 * Kéo đơn chỉ qua: Shopee webhook real-time HOẶC nút Làm mới thủ công.
 */

let autoIncrementalScheduled = false;

/**
 * No-op: không đăng ký node-cron / setInterval.
 * Giữ export để server.ts import không gãy.
 */
export function scheduleAutoIncrementalOrdersSync(_deps) {
  if (autoIncrementalScheduled) {
    console.log("[CRON] Auto Incremental Sync already OFF (idempotent).");
    return;
  }
  autoIncrementalScheduled = true;
  console.log(
    "[CRON] Auto Incremental Sync DISABLED — không kéo đơn ngầm; chỉ webhook + nút Làm mới.",
  );
}
