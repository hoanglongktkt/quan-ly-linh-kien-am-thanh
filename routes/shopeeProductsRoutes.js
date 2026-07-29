import { Router } from "express";
import {
  syncProducts,
  syncItemVariants,
  previewItemVariants,
} from "../controllers/shopeeProductsController.js";

const router = Router();

router.post("/products/sync", syncProducts);
router.post("/products/sync-item-variants", syncItemVariants);
router.post("/products/item-preview", previewItemVariants);
router.get("/products/item-preview", previewItemVariants);

export default router;
export { router };
export { syncProducts, syncItemVariants, previewItemVariants };
