import { Router } from "express";
import { oauthCallback } from "../controllers/tiktokAuthController.js";

/**
 * Mount tại /api/tiktok — canonical routes:
 * - GET /callback → OAuth (nhận code + shop_id, đổi token / redirect FE)
 */
const router = Router();

router.get("/callback", oauthCallback);

export default router;
export { router };
