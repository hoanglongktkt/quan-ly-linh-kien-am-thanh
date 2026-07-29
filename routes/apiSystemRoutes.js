import { Router } from "express";
import { authMiddleware } from "../middlewares/auth.js";
import {
  getSyncJobById,
  cleanupMongoTemp,
  ensureMongoTtl,
} from "../controllers/ordersController.js";
import { pullOrders, syncFromShop } from "../controllers/shopeeOrdersController.js";

/** Mount tại /api — paths hệ thống (auth từng route) */
const router = Router();

router.get("/sync-jobs/:jobId", authMiddleware, getSyncJobById);
router.post("/mongo/cleanup-temp", authMiddleware, cleanupMongoTemp);
router.post("/mongo/ensure-ttl", authMiddleware, ensureMongoTtl);
router.post("/orders/pull", authMiddleware, pullOrders);
router.post("/sync-from-shop", authMiddleware, syncFromShop);

export default router;
export { router };
