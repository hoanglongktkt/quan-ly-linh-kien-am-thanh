import { Router } from "express";
import {
  oauthComplete,
  oauthCallback,
  webhookProbe,
  listOauthShops,
  getAuthUrl,
} from "../controllers/shopeeAuthController.js";

const router = Router();

router.get("/oauth/complete", oauthComplete);
router.get("/callback", oauthCallback);
router.get("/webhook", webhookProbe);
router.get("/oauth-shops", listOauthShops);
router.get("/auth-url", getAuthUrl);

export default router;
export { router };
export {
  oauthComplete,
  oauthCallback,
  webhookProbe,
  listOauthShops,
  getAuthUrl,
};
