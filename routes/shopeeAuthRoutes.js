import { Router } from "express";
import { authMiddleware } from "../middlewares/auth.js";
import {
  oauthComplete,
  oauthCallback,
  webhookProbe,
  listOauthShops,
  getAuthUrl,
} from "../controllers/shopeeAuthController.js";

/** Mount tại /api/shopee — OAuth public + shops/auth-url có auth */
const router = Router();

router.get("/oauth/complete", oauthComplete);
router.get("/callback", oauthCallback);
router.get("/webhook", webhookProbe);
router.get("/oauth-shops", authMiddleware, listOauthShops);
router.get("/auth-url", authMiddleware, getAuthUrl);

export default router;
export { router };

/** Alias callback: /api/auth/shopee/callback */
export const shopeeAuthCallbackAlias = Router();
shopeeAuthCallbackAlias.get("/callback", oauthCallback);
