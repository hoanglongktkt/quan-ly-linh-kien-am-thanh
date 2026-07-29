import { Router } from "express";
import { saveScanOrders, listDonHoanHuy } from "../controllers/scanController.js";

const router = Router();

// Mount tại app.use('/api/scan', ...) → path chỉ còn /save và /don-hoan-huy
router.post("/save", saveScanOrders);
router.get("/don-hoan-huy", listDonHoanHuy);

export default router;
export { router };
