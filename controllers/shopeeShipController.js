/**
 * Controllers: Shopee ship-order (+ job map shared từ server).
 * Phase 6 — HTTP layer tách; logistics lõi inject qua deps.
 */
import { tryAcquireHeavyJob, releaseHeavyJob } from "../utils/heavyJob.js";

let deps = {
  loadOrdersForApi: async () => ({ orders: [] }),
  findOrderRecord: () => null,
  arrangeShipment: async () => ({ success: false }),
  withOperationTimeout: async (fn) => fn(),
  SHIP_ORDER_OPERATION_TIMEOUT_MS: 60_000,
  isAlreadyShippedError: () => false,
  isShopeePendingVerificationError: () => false,
  forceHealPickupOrderIfHasTracking: () => {},
  persistOrdersToDatabase: async () => {},
  persistPendingShopeeCheckFlag: async () => {},
  /** Full bulk sync handler body — inject từ server. */
  handleShipBulk: null,
  /** Single-API: ship + tracking + PDF — inject từ server. */
  handleFastProcess: null,
  executeShipOrderBackgroundJob: null,
  shipOrderJobs: new Map(),
  createShipOrderJobId: () => `ship-${Date.now()}`,
  pruneOldShipOrderJobs: () => {},
};

export function initShopeeShipController(partial) {
  deps = { ...deps, ...partial };
}

export function getShipOrderJobs() {
  return deps.shipOrderJobs;
}

/** POST /api/shopee/ship-order */
export async function shipOrder(req, res) {
  try {
    const { orderId, orderSn, method } = req.body || {};
    const shipMethod = method === "dropoff" ? "dropoff" : "pickup";
    const loaded = await deps.loadOrdersForApi();
    const orders = loaded.orders;
    const hit = deps.findOrderRecord(orders, String(orderId || orderSn || ""));
    if (!hit) {
      return res.status(404).json({ error: "Không tìm thấy đơn hàng." });
    }
    const { index } = hit;
    const order = orders[index];

    console.log(
      `[Ship Order] Yêu cầu chuẩn bị hàng (${shipMethod}) cho đơn ${order.orderSn} (channel=${order.channel})...`,
    );
    const result = await deps.withOperationTimeout(
      (signal) => deps.arrangeShipment(order, shipMethod, signal, { skipRecover: true }),
      deps.SHIP_ORDER_OPERATION_TIMEOUT_MS,
      `Ship order ${order.orderSn}`,
    );
    console.log("DỮ LIỆU SHOPEE TRẢ VỀ:", JSON.stringify(result));

    if (!result.success) {
      console.error(
        `[Ship Order] THẤT BẠI cho đơn ${order.orderSn} -> error="${result.error || ""}" message="${result.message || ""}"`,
      );
    }

    if (result.success || deps.isAlreadyShippedError(result)) {
      const tn = String(
        order.trackingNumber ||
          order.tracking_no ||
          result.trackingNumber ||
          orders[index].trackingNumber ||
          "",
      ).trim();
      orders[index] = {
        ...orders[index],
        ...order,
        isPrepared: true,
        status: "processed",
        is_pending_shopee_check: false,
        fulfillment_type: shipMethod,
        ship_method: shipMethod,
        trackingNumber: tn || orders[index].trackingNumber,
        tracking_no: tn || orders[index].tracking_no || orders[index].trackingNumber,
        shopId: orders[index].shopId || order.shopId || result.shopId,
        shopee_order_status:
          order.shopee_order_status === "READY_TO_SHIP" ||
          order.shopee_order_status === "RETRY_SHIP" ||
          !order.shopee_order_status
            ? "PROCESSED"
            : order.shopee_order_status || orders[index].shopee_order_status || "PROCESSED",
      };
      deps.forceHealPickupOrderIfHasTracking(orders[index]);
      await deps.persistOrdersToDatabase(orders, [orders[index]]);
      return res.json({ success: true, mode: result.mode, order: orders[index] });
    }

    if (deps.isShopeePendingVerificationError(result)) {
      await deps.persistPendingShopeeCheckFlag(
        orders,
        index,
        result.message || result.error || "Order is pending verification",
      );
      return res.json({
        success: false,
        pendingShopeeCheck: true,
        skipped: true,
        order: orders[index],
        message: result.message || "Đơn chưa sẵn sàng — đã bỏ qua.",
        ...result,
      });
    }

    return res.status(400).json({ success: false, ...result });
  } catch (error) {
    console.error("[Ship Order] Lỗi nội bộ endpoint /api/shopee/ship-order:", error?.stack || error);
    return res.status(500).json({ success: false, message: "Lỗi nội bộ server: " + error.message });
  }
}

/** POST /api/shopee/ship-order/bulk */
export async function shipOrderBulk(req, res) {
  if (typeof deps.handleShipBulk === "function") {
    return deps.handleShipBulk(req, res);
  }
  return res.status(500).json({ success: false, message: "ship bulk chưa khởi tạo" });
}

/** POST /api/orders/fast-process — xác nhận + lấy mã + PDF trong 1 request */
export async function fastProcessOrders(req, res) {
  if (typeof deps.handleFastProcess === "function") {
    return deps.handleFastProcess(req, res);
  }
  return res.status(500).json({ success: false, message: "fast-process chưa khởi tạo" });
}

/** POST /api/shopee/ship-order/bulk-async */
export function shipOrderBulkAsync(req, res) {
  try {
    deps.pruneOldShipOrderJobs();
    const { orderIds, orderSns, method } = req.body || {};
    const shipMethod = method === "dropoff" ? "dropoff" : "pickup";
    const idList = Array.isArray(orderIds) ? orderIds.map(String) : [];
    const snList = Array.isArray(orderSns) ? orderSns.map(String) : [];
    if (idList.length === 0 && snList.length === 0) {
      return res.status(400).json({ error: "Thiếu danh sách orderIds hoặc orderSns." });
    }

    const estimatedTotal = Math.max(
      new Set(
        [...idList, ...snList]
          .map((s) => String(s || "").replace(/^shopee-/i, "").trim())
          .filter(Boolean),
      ).size,
      idList.length || snList.length,
    );

    const jobId = deps.createShipOrderJobId();
    deps.shipOrderJobs.set(jobId, {
      id: jobId,
      status: "pending",
      phase: "pending",
      message: "Đã tiếp nhận — đang xếp hàng xử lý...",
      total: estimatedTotal,
      completed: 0,
      successCount: 0,
      results: [],
      printDocument: null,
      orders: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    res.once("finish", () => {
      setImmediate(() => {
        if (typeof deps.executeShipOrderBackgroundJob === "function") {
          void deps.executeShipOrderBackgroundJob(jobId, shipMethod, idList, snList);
        } else {
          const job = deps.shipOrderJobs.get(jobId);
          if (job) {
            job.status = "failed";
            job.error = "executeShipOrderBackgroundJob chưa khởi tạo";
            job.updatedAt = Date.now();
          }
        }
      });
    });
    return res.status(202).json({ accepted: true, jobId, total: estimatedTotal });
  } catch (error) {
    console.error(
      "[Ship Order Bulk Async] Lỗi nội bộ endpoint /api/shopee/ship-order/bulk-async:",
      error?.stack || error,
    );
    if (!res.headersSent) {
      return res.status(500).json({ success: false, message: "Lỗi nội bộ server: " + error.message });
    }
  }
}

/** GET /api/shopee/ship-order/job/:jobId */
export async function getShipOrderJob(req, res) {
  deps.pruneOldShipOrderJobs();
  const job = deps.shipOrderJobs.get(String(req.params.jobId || ""));
  if (!job) {
    return res.status(404).json({
      error: "job_not_found",
      message: "Không tìm thấy tiến trình xử lý.",
    });
  }
  return res.json(job);
}

export { tryAcquireHeavyJob, releaseHeavyJob };
