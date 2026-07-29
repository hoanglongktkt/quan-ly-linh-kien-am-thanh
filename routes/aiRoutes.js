import { Router } from "express";
import { authMiddleware } from "../middlewares/auth.js";
import { geminiOptimize, parseAddress, generateDescription } from "../controllers/aiController.js";

const router = Router();

// Mount: app.use('/api', aiRoutes) — paths tương đối dưới /api
router.post("/gemini/optimize", authMiddleware, geminiOptimize);
router.post("/ai/parse-address", authMiddleware, parseAddress);
router.post("/ai/generate-description", authMiddleware, generateDescription);

export default router;
export { router };
