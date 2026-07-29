import { Router } from "express";
import {
  listImports,
  getImportHistory,
  getImportProductContext,
  createImport,
  clearAllImports,
} from "../controllers/importsController.js";

const router = Router();

router.get("/", listImports);
router.get("/history/:productId", getImportHistory);
router.get("/product-context/:productId", getImportProductContext);
router.post("/", createImport);
router.post("/clear-all", clearAllImports);

export default router;
export { router };
