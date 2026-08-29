import { Router } from "express";
import { authMiddleware } from "../middlewares/auth.js";
import { oauthCallback } from "../controllers/tiktokAuthController.js";
import {
  saveCustomAppCredentials,
  getCustomAppStatus,
  syncOrders,
  previewOrders,
  getOrderDetail,
  getProductDetail,
  previewProducts,
} from "../controllers/tiktokCustomAppController.js";

/**
 * Mount tại /api/tiktok
 * - Custom App (ưu tiên): credentials thủ công + sync orders/products
 * - GET /callback: giữ tương thích redirect URL cũ (không bắt buộc cho Custom App)
 */
const router = Router();

router.get("/callback", oauthCallback);

router.post("/custom-app/credentials", authMiddleware, saveCustomAppCredentials);
router.get("/custom-app/status", authMiddleware, getCustomAppStatus);

router.post("/orders/sync", authMiddleware, syncOrders);
router.get("/orders/preview", authMiddleware, previewOrders);
router.get("/orders/:orderId", authMiddleware, getOrderDetail);

router.get("/products/preview", authMiddleware, previewProducts);
router.get("/products/:productId", authMiddleware, getProductDetail);

export default router;
export { router };
