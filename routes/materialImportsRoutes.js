import { Router } from "express";
import {
  listMaterialImports,
  createMaterialImport,
  clearAllMaterialImports,
} from "../controllers/materialImportsController.js";

const router = Router();

router.get("/", listMaterialImports);
router.post("/", createMaterialImport);
router.post("/clear-all", clearAllMaterialImports);

export default router;
export { router };
