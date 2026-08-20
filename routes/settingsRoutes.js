import { Router } from "express";
import {
  getChannelSettings,
  putChannelSettings,
  getGeminiStatus,
  updateGeminiKey,
  testGeminiKey,
  postShopConnectionStatus,
  getLogisticsSettings,
  saveLogisticsSettings,
} from "../controllers/settingsController.js";

const router = Router();

router.get("/channels", getChannelSettings);
router.put("/channels", putChannelSettings);
router.get("/gemini-status", getGeminiStatus);
router.post("/update-gemini-key", updateGeminiKey);
router.post("/test-gemini-key", testGeminiKey);
router.post("/shop-connection-status", postShopConnectionStatus);
router.get("/logistics", getLogisticsSettings);
router.post("/logistics", saveLogisticsSettings);

export default router;
export { router };
