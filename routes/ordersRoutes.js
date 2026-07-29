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
  patchOrder,
  deleteOrder,
  handOverCarrierById,
  handOverCarrierByCode,
  handOverCarrierBulk,
  healHandedOver,
  createManualOrder,
} from "../controllers/ordersController.js";

const router = Router();

// Static paths trước :id / :orderSn
router.get("/refresh", refreshOrders);
router.get("/query", queryOrders);
router.get("/lookup", lookupOrder);
router.post("/cleanup-handed-over", cleanupHandedOver);
router.post("/cleanup-closed-retention", cleanupClosedRetention);
router.post("/cleanup-label-pdfs", cleanupLabelPdfs);
router.post("/cleanup-processed-pickup", cleanupProcessedPickup);
router.post("/cleanup-mock", cleanupMockOrders);
router.post("/hydrate-tracking", hydrateTracking);
router.post("/enrich-tracking", enrichTracking);
router.post("/hand-over-carrier/bulk", handOverCarrierBulk);
router.post("/hand-over-carrier", handOverCarrierByCode);
router.post("/heal-handed-over", healHandedOver);
router.post("/manual", createManualOrder);
router.get("/:orderSn/events", getOrderEvents);
router.post("/:id/hand-over-carrier", handOverCarrierById);
router.get("/", listOrders);
router.patch("/:id", patchOrder);
router.delete("/:id", deleteOrder);

export default router;
export { router };

/** Handlers mount ngoài /api/orders — dùng trực tiếp từ server.ts */
export {
  getSyncJobById,
  cleanupMongoTemp,
  ensureMongoTtl,
} from "../controllers/ordersController.js";
