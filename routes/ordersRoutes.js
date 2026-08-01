import { Router } from "express";
import {
  refreshOrders,
  queryOrders,
  getOrderEvents,
  listOrders,
  cleanupHandedOver,
  cleanupClosedRetention,
  cleanupLabelPdfs,
  cleanupProcessedPickup,
  lookupOrder,
  cleanupMockOrders,
  hydrateTracking,
  enrichTracking,
  forceResyncStuck,
  triggerFixStuckOrders,
  patchOrder,
  deleteOrder,
  handOverCarrierById,
  handOverCarrierByCode,
  handOverCarrierBulk,
  healHandedOver,
  createManualOrder,
  resetPrintStatus,
} from "../controllers/ordersController.js";
import { pullOrders, quickSyncOrders } from "../controllers/shopeeOrdersController.js";
import { fastProcessOrders } from "../controllers/shopeeShipController.js";
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
router.get("/lookup", h(lookupOrder));
router.post("/pull", pullOrders);
router.post("/quick-sync", quickSyncOrders);
router.post("/fast-process", fastProcessOrders);
router.post("/cleanup-handed-over", h(cleanupHandedOver));
router.post("/cleanup-closed-retention", h(cleanupClosedRetention));
router.post("/cleanup-label-pdfs", h(cleanupLabelPdfs));
router.post("/cleanup-processed-pickup", h(cleanupProcessedPickup));
router.post("/cleanup-mock", h(cleanupMockOrders));
router.post("/hydrate-tracking", h(hydrateTracking));
router.post("/enrich-tracking", h(enrichTracking));
router.post("/force-resync-stuck", h(forceResyncStuck));
router.post("/trigger-fix-stuck-orders", h(triggerFixStuckOrders));
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
router.get("/:orderSn/events", h(getOrderEvents));
router.post("/:id/hand-over-carrier", h(handOverCarrierById));
router.get("/", h(listOrders));
router.patch("/:id", h(patchOrder));
router.delete("/:id", h(deleteOrder));

export default router;
export { router };
