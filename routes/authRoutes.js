import { Router } from "express";
import { login, verifyAuth } from "../controllers/authController.js";
import { authMiddleware } from "../middlewares/auth.js";

const router = Router();

router.post("/login", login);
router.get("/auth/verify", authMiddleware, verifyAuth);

export default router;
export { router };
