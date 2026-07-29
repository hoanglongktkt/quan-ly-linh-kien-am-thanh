import { Router } from "express";
import { authMiddleware } from "../middlewares/auth.js";
import {
  getLocalInventory,
  refreshLocalInventory,
  syncStock,
  handleInventoryClearAll,
} from "../controllers/productsController.js";

/** Mount tại /api — paths ngoài /api/products (auth từng route) */
const router = Router();

router.get("/local-inventory", authMiddleware, getLocalInventory);
router.post("/local-inventory/refresh", authMiddleware, refreshLocalInventory);
router.post("/sync-stock", authMiddleware, syncStock);
router.delete("/inventory/clear-all", authMiddleware, handleInventoryClearAll);
router.post("/inventory/clear-all", authMiddleware, handleInventoryClearAll);

export default router;
export { router };
