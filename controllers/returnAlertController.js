/**
 * GET /api/orders/return-alerts  — FE poll toast YCTH mới.
 * POST /api/orders/return-alerts-ack
 */
import {
  getReturnAlertsSnapshot,
  ackReturnAlerts,
} from "../services/returnAlertQueue.js";
import {
  isMongoReady,
  listPendingReturnAlertsFromStore,
  ackReturnAlertsInStore,
} from "../src/db/mongoStore.ts";

/** GET /api/orders/return-alerts */
export async function getReturnAlerts(_req, res) {
  try {
    const snap = getReturnAlertsSnapshot();
    let unnotified = snap.unnotified || [];
    if (unnotified.length === 0 && isMongoReady()) {
      try {
        const fromDb = await listPendingReturnAlertsFromStore();
        if (Array.isArray(fromDb) && fromDb.length) unnotified = fromDb;
      } catch (dbErr) {
        console.warn("[ReturnAlert] mongo list failed:", dbErr?.message || dbErr);
      }
    }
    return res.json({
      success: true,
      count: unnotified.length,
      unnotified,
      message:
        unnotified.length > 0 ? "Có yêu cầu trả hàng hoàn tiền mới!" : undefined,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error?.message || "return_alerts_failed",
      unnotified: [],
      count: 0,
    });
  }
}

/** POST /api/orders/return-alerts-ack */
export async function ackReturnAlertsApi(req, res) {
  try {
    const ids = Array.isArray(req.body?.ids)
      ? req.body.ids
      : Array.isArray(req.body?.orderSns)
        ? req.body.orderSns
        : [];
    const acked = ackReturnAlerts(ids);
    const sns = [
      ...new Set(
        ids
          .map((v) => String(v || "").replace(/^rr-/, "").replace(/-\d+$/, "").trim())
          .concat(ids.map((v) => String(v || "").trim()))
          .filter(Boolean),
      ),
    ];
    let mongoAcked = 0;
    if (isMongoReady() && sns.length) {
      try {
        mongoAcked = await ackReturnAlertsInStore(sns);
      } catch (dbErr) {
        console.warn("[ReturnAlert] mongo ack failed:", dbErr?.message || dbErr);
      }
    }
    return res.json({ success: true, acked, mongoAcked });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error?.message || "return_alerts_ack_failed",
    });
  }
}
