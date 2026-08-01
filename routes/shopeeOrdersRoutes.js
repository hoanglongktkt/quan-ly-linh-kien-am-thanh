import { Router } from "express";
import {
  pullOrders,
  syncOrders,
  quickSyncOrders,
  getDiagnostics,
  debugReturnByOrder,
  syncFromShop,
} from "../controllers/shopeeOrdersController.js";

const router = Router();

router.post("/orders/sync", syncOrders);
router.post("/orders/pull", pullOrders);
router.post("/orders/quick-sync", quickSyncOrders);
router.get("/diagnostics", getDiagnostics);
router.get("/debug/return-by-order", debugReturnByOrder);

export default router;
export { router };
export { pullOrders, syncOrders, quickSyncOrders, getDiagnostics, debugReturnByOrder, syncFromShop };
