import { Router } from "express";
import {
  handleMappingProductsGet,
  handleMappingProductsUpsert,
  handleMappingProductsHeal,
  handleBatchAutoLink,
  handleSingleAutoLink,
  handleBulkAutoLinkByIds,
  handleMappingSkuIndex,
  handleMappingPurgeBroken,
} from "../controllers/mappingController.js";

const router = Router();

router.get("/sku-index", handleMappingSkuIndex);
router.post("/auto-link-single", handleSingleAutoLink);
router.post("/batch-auto-link", handleBatchAutoLink);
router.post("/bulk-auto-link", handleBulkAutoLinkByIds);
router.post("/purge-broken", handleMappingPurgeBroken);
router.post("/heal", handleMappingProductsHeal);
router.get("/", handleMappingProductsGet);
router.put("/", handleMappingProductsUpsert);
router.post("/", handleMappingProductsUpsert);

export default router;
export { router };

/** Aliases — mount trực tiếp từ server.ts */
export {
  handleBulkAutoLinkByIds,
  handleBatchAutoLink,
};
