import { Router } from "express";
import { saveScanOrders, listDonHoanHuy } from "../controllers/scanController.js";

const router = Router();

router.post("/save", saveScanOrders);
router.get("/don-hoan-huy", listDonHoanHuy);

export default router;
