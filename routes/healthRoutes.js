import { Router } from "express";
import {
  getHealth,
  getPublicConfig,
  postClientLog,
  getClientLog,
} from "../controllers/healthController.js";
import { authMiddleware } from "../middlewares/auth.js";

const router = Router();

// Mount tại app.use('/api', ...) — path khớp endpoint cũ
router.get("/health", getHealth);
router.get("/config/public", getPublicConfig);
router.post("/debug/client-log", authMiddleware, postClientLog);
router.get("/debug/client-log", authMiddleware, getClientLog);

export default router;
export { router };
