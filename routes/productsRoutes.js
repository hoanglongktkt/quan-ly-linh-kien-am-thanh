import { Router } from "express";
import {
  listProducts,
  searchProducts,
  handleProductSyncShopee,
  updateProductPrice,
  createProduct,
  replaceProducts,
  patchProduct,
  inventoryBalance,
  bulkSaveProducts,
  deleteProduct,
  clearAllProducts,
  bulkUpdateProducts,
  bulkUpdatePrices,
  bulkChannelSync,
} from "../controllers/productsController.js";
import { previewItemVariants } from "../controllers/shopeeProductsController.js";

const router = Router();

router.get("/search", searchProducts);
router.post("/sync-shopee", handleProductSyncShopee);
router.post("/update-price", updateProductPrice);
// Alias ổn định — ĐẶT TRƯỚC route /:id/*
router.post("/shopee-item-preview", previewItemVariants);
router.get("/shopee-item-preview", previewItemVariants);
router.post("/:id/sync-shopee", handleProductSyncShopee);
router.put("/replace", replaceProducts);
router.post("/inventory-balance", inventoryBalance);
router.post("/bulk-save", bulkSaveProducts);
router.post("/clear-all", clearAllProducts);
router.post("/bulk-update", bulkUpdateProducts);
router.post("/bulk-update-prices", bulkUpdatePrices);
router.post("/bulk-channel-sync", bulkChannelSync);
router.get("/", listProducts);
router.post("/", createProduct);
router.patch("/:id", patchProduct);
router.delete("/:id", deleteProduct);

export default router;
export { router };

/** Handlers mount ngoài /api/products — dùng trực tiếp từ server.ts */
export {
  getLocalInventory,
  refreshLocalInventory,
  syncStock,
  handleInventoryClearAll,
} from "../controllers/productsController.js";
