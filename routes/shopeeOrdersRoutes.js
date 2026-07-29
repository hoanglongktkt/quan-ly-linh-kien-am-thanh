import { Router } from "express";
import {
  pullOrders,
  syncOrders,
  getDiagnostics,
  debugReturnByOrder,
  syncFromShop,
} from "../controllers/shopeeOrdersController.js";

const router = Router();

router.post("/orders/sync", syncOrders);
router.get("/diagnostics", getDiagnostics);
router.get("/debug/return-by-order", debugReturnByOrder);

export default router;
export { router };
export { pullOrders, syncOrders, getDiagnostics, debugReturnByOrder, syncFromShop };
