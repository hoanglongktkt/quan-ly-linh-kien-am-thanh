/** Chỉ 1 tác vụ nặng (ship-order, in vận đơn) chạy cùng lúc — tránh NPROC 100% trên cPanel. */
const HEAVY_JOB_LOCK_MAX_MS = 120_000;
let cpanelHeavyJobActive = null;

export function tryAcquireHeavyJob(name) {
  if (cpanelHeavyJobActive) {
    const elapsedMs = Date.now() - cpanelHeavyJobActive.startedAt;
    // ship_order là fast path; lock quá 2 phút nghĩa là process/job trước đã treo.
    // Không chặn vĩnh viễn các đơn tiếp theo chỉ vì một Promise không bao giờ resolve.
    if (elapsedMs > HEAVY_JOB_LOCK_MAX_MS) {
      console.error(
        `[Heavy Job] Watchdog giải phóng lock kẹt "${cpanelHeavyJobActive.name}" sau ${elapsedMs}ms`,
      );
      cpanelHeavyJobActive = null;
    } else {
      console.warn(
        `[Heavy Job] Từ chối "${name}" — "${cpanelHeavyJobActive.name}" đang chạy (${elapsedMs}ms)`,
      );
      return false;
    }
  }
  cpanelHeavyJobActive = { name, startedAt: Date.now() };
  return true;
}

export function releaseHeavyJob(name) {
  if (cpanelHeavyJobActive?.name === name) cpanelHeavyJobActive = null;
}

/** Reset lock khi boot listen — giữ nguyên hành vi startListening. */
export function resetHeavyJob() {
  cpanelHeavyJobActive = null;
}
