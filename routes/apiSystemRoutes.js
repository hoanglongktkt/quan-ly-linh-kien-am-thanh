import { Router } from "express";
import { authMiddleware } from "../middlewares/auth.js";
import {
  getSyncJobById,
  getOrderCounts,
  cleanupMongoTemp,
  ensureMongoTtl,
} from "../controllers/ordersController.js";
import { pullOrders, syncFromShop, syncShopee } from "../controllers/shopeeOrdersController.js";
import { setupScannerIndexes } from "../controllers/systemController.js";

/** Mount tại /api — paths hệ thống (auth từng route) */
const router = Router();

/** One-shot: tạo index scanner — không auth (xóa route sau khi chạy xong). */
router.get("/system/setup-indexes", setupScannerIndexes);

router.get("/sync-jobs/:jobId", authMiddleware, getSyncJobById);
router.get("/order-counts", authMiddleware, getOrderCounts);
router.post("/sync-shopee", authMiddleware, syncShopee);
router.post("/mongo/cleanup-temp", authMiddleware, cleanupMongoTemp);
router.post("/mongo/ensure-ttl", authMiddleware, ensureMongoTtl);
router.post("/orders/pull", authMiddleware, pullOrders);
router.post("/sync-from-shop", authMiddleware, syncFromShop);

export default router;
export { router };
