import { Router } from "express";
import { authMiddleware } from "../middlewares/auth.js";
import { handleBatchAutoLink, handleBulkAutoLinkByIds } from "../controllers/mappingController.js";

/** Alias auto-link — mount tại /api (auth từng route) */
const router = Router();

router.post("/mapping/bulk-update", authMiddleware, handleBulkAutoLinkByIds);
router.post("/shopee/channel-products/auto-link", authMiddleware, handleBatchAutoLink);
router.post("/channel-products/auto-link", authMiddleware, handleBatchAutoLink);
router.post("/auto-link", authMiddleware, handleBatchAutoLink);

export default router;
export { router };
