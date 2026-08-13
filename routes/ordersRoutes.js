import { Router } from "express";
import {
  refreshOrders,
  queryOrders,
  getOrderCounts,
  getOrderEvents,
  listOrders,
  cleanupHandedOver,
  batchDeleteOrders,
  cleanupLabelPdfs,
  cleanupProcessedPickup,
  lookupOrder,
  scannerSync,
  cleanupMockOrders,
  hydrateTracking,
  enrichTracking,
  healTrackingCancelled,
  forceResyncStuck,
  triggerFixStuckOrders,
  reconcileHandedOver,
  patchOrder,
  deleteOrder,
  handOverCarrierById,
  handOverCarrierByCode,
  handOverCarrierBulk,
  healHandedOver,
  createManualOrder,
  resetPrintStatus,
  updatePrintStatus,
  markPrinted,
} from "../controllers/ordersController.js";
import { pullOrders, quickSyncOrders, syncOrders } from "../controllers/shopeeOrdersController.js";
import { fastProcessOrders, shipOrderBulk } from "../controllers/shopeeShipController.js";
import { saveScanOrders, listDonHoanHuy } from "../controllers/scanController.js";
import {
  enqueueScanBg,
  getScanBgStatus,
  ackScanBg,
} from "../controllers/scanBgController.js";
import { scanBulkUpdate } from "../controllers/scanBulkController.js";
import { asyncHandler } from "../middlewares/errorHandler.js";

const router = Router();
const h = asyncHandler;

// Static paths trước :id / :orderSn
router.get("/refresh", h(refreshOrders));
router.get("/query", h(queryOrders));
router.get("/counts", h(getOrderCounts));
/** Badge count nhanh — chỉ countDocuments Mongo, không gọi Shopee / không trả list. */
router.get("/counter", h(getOrderCounts));
router.get("/lookup", h(lookupOrder));
/** Sync siêu tốc máy quét — chỉ order_id / tracking_code / return_waybill / status. */
router.get("/scanner-sync", h(scannerSync));
/** Sync = ACK + background job; list/refresh = Mongo read-only. */
router.post("/sync", syncOrders);
router.post("/pull", pullOrders);
router.post("/quick-sync", quickSyncOrders);
router.post("/fast-process", fastProcessOrders);
router.post("/batch-confirm", shipOrderBulk);
router.post("/confirm", shipOrderBulk);
router.post("/batch-confirm-print", fastProcessOrders);
router.post("/cleanup-handed-over", h(cleanupHandedOver));
router.post("/batch-delete", h(batchDeleteOrders));
router.post("/cleanup-label-pdfs", h(cleanupLabelPdfs));
router.post("/cleanup-processed-pickup", h(cleanupProcessedPickup));
router.post("/cleanup-mock", h(cleanupMockOrders));
router.post("/hydrate-tracking", h(hydrateTracking));
router.post("/enrich-tracking", h(enrichTracking));
/** Heal data cũ: đơn hủy/hoàn thiếu mã — GET hoặc POST đều được. */
router.get("/heal-tracking-cancelled", h(healTrackingCancelled));
router.post("/heal-tracking-cancelled", h(healTrackingCancelled));
router.post("/force-resync-stuck", h(forceResyncStuck));
router.post("/trigger-fix-stuck-orders", h(triggerFixStuckOrders));
router.post("/reconcile-handed-over", h(reconcileHandedOver));
router.post("/hand-over-carrier/bulk", h(handOverCarrierBulk));
router.post("/hand-over-carrier", h(handOverCarrierByCode));
router.post("/heal-handed-over", h(healHandedOver));
router.post("/manual", h(createManualOrder));
router.get("/don-hoan-huy", h(listDonHoanHuy));
router.post("/don-hoan-huy", h(saveScanOrders));
router.post("/scan-bg-enqueue", h(enqueueScanBg));
router.get("/scan-bg-status", h(getScanBgStatus));
router.post("/scan-bg-ack", h(ackScanBg));
router.post("/scan-bulk-update", h(scanBulkUpdate));
router.post("/reset-print-status", h(resetPrintStatus));
router.post("/update-print-status", h(updatePrintStatus));
router.post("/mark-printed", h(markPrinted));
router.get("/:orderSn/events", h(getOrderEvents));
router.post("/:id/hand-over-carrier", h(handOverCarrierById));
router.get("/", h(listOrders));
router.patch("/:id", h(patchOrder));
router.delete("/:id", h(deleteOrder));

export default router;
export { router };
