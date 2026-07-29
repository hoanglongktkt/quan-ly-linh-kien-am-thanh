import { Router } from "express";
import { saveScanOrders, listDonHoanHuy } from "../controllers/scanController.js";
import { asyncHandler } from "../middlewares/errorHandler.js";

const router = Router();

// Mount tại app.use('/api/scan', ...) → path chỉ còn /save và /don-hoan-huy
router.post("/save", asyncHandler(saveScanOrders));
router.get("/don-hoan-huy", asyncHandler(listDonHoanHuy));

export default router;
export { router };
