// Scheduler sở hữu timer riêng; giữ lịch, điều kiện bật/tắt và thời gian chờ cũ.
import fs from "fs";
import path from "path";
import cron from "node-cron";
import { PDF_DIR } from "../../utils/appPaths.js";
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
