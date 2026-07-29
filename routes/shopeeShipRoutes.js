import { Router } from "express";
import {
  shipOrder,
  shipOrderBulk,
  shipOrderBulkAsync,
  getShipOrderJob,
} from "../controllers/shopeeShipController.js";

const router = Router();

router.post("/ship-order", shipOrder);
router.post("/ship-order/bulk", shipOrderBulk);
router.post("/ship-order/bulk-async", shipOrderBulkAsync);
router.get("/ship-order/job/:jobId", getShipOrderJob);

export default router;
export { router };
export { shipOrder, shipOrderBulk, shipOrderBulkAsync, getShipOrderJob };
