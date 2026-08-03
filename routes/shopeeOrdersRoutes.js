import { Router } from "express";
import {
  pullOrders,
  syncOrders,
  quickSyncOrders,
  getDiagnostics,
  debugReturnByOrder,
  syncFromShop,
} from "../controllers/shopeeOrdersController.js";

/**
 * Routes Shopee Orders — Frontend chỉ trigger sync (ACK ngay).
 * Kéo API sàn chạy ngầm trong Sync Service / controller BG.
 * Danh sách đơn: dùng GET /api/orders/* (MongoDB), không gọi sàn từ đây.
 */
const router = Router();

router.post("/orders/sync", syncOrders); // ACK + background
router.post("/orders/pull", pullOrders); // ACK + background
router.post("/orders/quick-sync", quickSyncOrders); // ACK + background (3h)
router.get("/diagnostics", getDiagnostics);
router.get("/debug/return-by-order", debugReturnByOrder);

export default router;
export { router };
export { pullOrders, syncOrders, quickSyncOrders, getDiagnostics, debugReturnByOrder, syncFromShop };
