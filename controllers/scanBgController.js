/**
 * Controllers: scan-bg-enqueue / scan-bg-status / scan-bg-ack
 * Phase 3 — tách từ server.ts.
 */
import {
  enqueueScanBgCodes,
  getScanBgStatusSnapshot,
  ackScanBgNotifications,
  isScanBgWorkerRunning,
} from "../services/scanBgQueue.js";

/** POST /api/orders/scan-bg-enqueue */
export async function enqueueScanBg(req, res) {
  try {
    const rawCodes = Array.isArray(req.body?.codes)
      ? req.body.codes
      : Array.isArray(req.body?.scannedCodes)
        ? req.body.scannedCodes
        : req.body?.code
          ? [req.body.code]
          : [];
    const codes = [
      ...new Set(rawCodes.map((c) => String(c || "").trim()).filter(Boolean)),
    ];
    if (!codes.length) {
      return res.status(400).json({
        success: false,
        error: "missing_codes",
        message: "Thiếu mã quét (codes).",
      });
    }
    const result = enqueueScanBgCodes(codes);
    console.log(
      `[Scan BG] enqueue queued=${result.queued} pending=${result.pending} codes=${codes.length}`,
    );
    return res.json({
      success: true,
      queued: result.queued,
      pending: result.pending,
      jobs: result.jobs,
      message:
        result.queued > 0
          ? `Đã xếp ${result.queued} mã vào hàng đợi dò ngầm.`
          : "Các mã đã có trong hàng đợi dò ngầm.",
    });
  } catch (error) {
    console.error("[Scan BG] enqueue error:", error);
    return res.status(500).json({
      success: false,
      error: error?.message || "scan_bg_enqueue_failed",
      message: error?.message || "Không thể xếp hàng đợi dò ngầm.",
    });
  }
}

/** GET /api/orders/scan-bg-status */
export async function getScanBgStatus(_req, res) {
  try {
    const snap = getScanBgStatusSnapshot();
    return res.json({
      success: true,
      pendingCount: snap.pendingCount,
      pending: snap.pending,
      running: snap.running,
      recent: snap.recent,
      unnotified: snap.unnotified,
      summary: snap.summary,
      workerRunning: isScanBgWorkerRunning(),
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error?.message || "scan_bg_status_failed",
    });
  }
}

/** POST /api/orders/scan-bg-ack */
export async function ackScanBg(req, res) {
  try {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(String) : undefined;
    const acked = ackScanBgNotifications(ids);
    return res.json({ success: true, acked });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error?.message || "scan_bg_ack_failed",
    });
  }
}
