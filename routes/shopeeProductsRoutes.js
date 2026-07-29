import { Router } from "express";
import {
  syncProducts,
  syncItemVariants,
} from "../controllers/shopeeProductsController.js";

const router = Router();

router.post("/products/sync", syncProducts);
router.post("/products/sync-item-variants", syncItemVariants);

export default router;
export { router };
export { syncProducts, syncItemVariants };
