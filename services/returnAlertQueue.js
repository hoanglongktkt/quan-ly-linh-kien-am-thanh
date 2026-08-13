/**
 * Hàng đợi thông báo Yêu cầu trả hàng / Hoàn tiền mới (in-memory).
 * Background sync / webhook đẩy vào đây; FE poll GET /api/orders/return-alerts.
 */
const MAX_ALERTS = 80;

/** @type {Array<{
 *   id: string,
 *   orderSn: string,
 *   returnSn: string,
 *   returnTrackingNumber: string,
 *   shopId: string,
 *   createdAt: string,
 *   notified: boolean,
 * }>} */
const alerts = [];

function makeId(orderSn) {
  return `rr-${String(orderSn || "").trim()}-${Date.now()}`;
}

/**
 * Đẩy cảnh báo đơn trả hàng mới. Dedup theo orderSn chưa ACK.
 * @returns {boolean} true nếu thêm mới
 */
export function pushReturnAlert(item) {
  try {
    const orderSn = String(item?.orderSn || "").trim();
    if (!orderSn) return false;
    const returnSn = String(item?.returnSn || "").trim();
    const returnTrackingNumber = String(
      item?.returnTrackingNumber || item?.return_tracking_no || "",
    ).trim();
    const shopId = String(item?.shopId || "").trim();
    const existing = alerts.find((a) => a.orderSn === orderSn && !a.notified);
    if (existing) {
      if (returnSn) existing.returnSn = returnSn;
      if (returnTrackingNumber) existing.returnTrackingNumber = returnTrackingNumber;
      return false;
    }
    alerts.unshift({
      id: makeId(orderSn),
      orderSn,
      returnSn,
      returnTrackingNumber,
      shopId,
      createdAt: new Date().toISOString(),
      notified: false,
    });
    if (alerts.length > MAX_ALERTS) alerts.length = MAX_ALERTS;
    return true;
  } catch (err) {
    console.warn("[ReturnAlert] push failed:", err?.message || err);
    return false;
  }
}

export function getReturnAlertsSnapshot() {
  try {
    const unnotified = alerts.filter((a) => !a.notified);
    return {
      unnotified,
      count: unnotified.length,
      recent: alerts.slice(0, 20),
    };
  } catch (err) {
    console.warn("[ReturnAlert] snapshot failed:", err?.message || err);
    return { unnotified: [], count: 0, recent: [] };
  }
}

/**
 * ACK theo id hoặc orderSn.
 * @returns {number} số bản ghi đánh dấu đã đọc
 */
export function ackReturnAlerts(ids) {
  try {
    const keys = new Set(
      (Array.isArray(ids) ? ids : [])
        .map((v) => String(v || "").trim())
        .filter(Boolean),
    );
    if (!keys.size) {
      let n = 0;
      for (const a of alerts) {
        if (!a.notified) {
          a.notified = true;
          n += 1;
        }
      }
      return n;
    }
    let n = 0;
    for (const a of alerts) {
      if (a.notified) continue;
      if (keys.has(a.id) || keys.has(a.orderSn)) {
        a.notified = true;
        n += 1;
      }
    }
    return n;
  } catch (err) {
    console.warn("[ReturnAlert] ack failed:", err?.message || err);
    return 0;
  }
}
