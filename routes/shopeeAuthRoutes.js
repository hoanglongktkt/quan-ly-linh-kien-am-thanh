import { Router } from "express";
import { authMiddleware } from "../middlewares/auth.js";
import {
  oauthComplete,
  oauthCallback,
  webhookProbe,
  listOauthShops,
  getAuthUrl,
} from "../controllers/shopeeAuthController.js";

/**
 * Mount tại /api/shopee — canonical routes:
 * - GET /callback  → OAuth (nhận code + shop_id, lưu token)
 * - GET /webhook   → probe (POST webhook do createShopeeWebhookRouter xử lý trước express.json)
 */
const router = Router();

router.get("/oauth/complete", oauthComplete);
router.get("/callback", oauthCallback);
router.get("/webhook", webhookProbe);
router.get("/oauth-shops", authMiddleware, listOauthShops);
router.get("/auth-url", authMiddleware, getAuthUrl);

export default router;
export { router };
