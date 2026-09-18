import { Router } from "express";
import {
  listMaterials,
  createMaterial,
  updateMaterial,
} from "../controllers/materialsController.js";

const router = Router();

router.get("/", listMaterials);
router.post("/", createMaterial);
router.put("/:id", updateMaterial);

export default router;
export { router };
