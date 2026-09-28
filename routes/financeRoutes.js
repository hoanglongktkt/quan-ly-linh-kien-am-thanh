import { Router } from "express";
import { listReconciliation, syncEscrow, verifyReconciliation } from "../controllers/financeController.js";

const router = Router();

router.get("/reconciliation", listReconciliation);
router.patch("/reconciliation/verify", verifyReconciliation);
router.post("/sync-escrow", syncEscrow);

export default router;
export { router };
