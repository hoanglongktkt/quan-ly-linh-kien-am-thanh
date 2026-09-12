import { Router } from "express";
import {
  listImports,
  getImportHistory,
  getImportProductContext,
  createImport,
  clearAllImports,
  getSupplierReport,
} from "../controllers/importsController.js";

const router = Router();

router.get("/", listImports);
// Route tĩnh "supplier-report" đặt trước các route "/:param" phía dưới không xung đột
// vì các route đó đều có tiền tố riêng (history/, product-context/).
router.get("/supplier-report", getSupplierReport);
router.get("/history/:productId", getImportHistory);
router.get("/product-context/:productId", getImportProductContext);
router.post("/", createImport);
router.post("/clear-all", clearAllImports);

export default router;
export { router };
