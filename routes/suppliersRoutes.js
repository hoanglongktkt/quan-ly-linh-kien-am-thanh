import { Router } from "express";
import {
  listSuppliers,
  createSupplier,
  updateSupplier,
  deleteSupplier,
  clearAllSuppliers,
} from "../controllers/suppliersController.js";

const router = Router();

router.get("/", listSuppliers);
router.post("/", createSupplier);
router.post("/clear-all", clearAllSuppliers);
router.put("/:id", updateSupplier);
router.delete("/:id", deleteSupplier);

export default router;
export { router };
