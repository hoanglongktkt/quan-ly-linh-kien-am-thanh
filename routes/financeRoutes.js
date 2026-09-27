import { Router } from "express";
import { listReconciliation, syncEscrow } from "../controllers/financeController.js";

const router = Router();

router.get("/reconciliation", listReconciliation);
router.post("/sync-escrow", syncEscrow);

export default router;
export { router };
