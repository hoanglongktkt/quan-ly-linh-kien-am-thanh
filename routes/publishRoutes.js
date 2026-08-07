import { Router } from "express";
import { authMiddleware } from "../middlewares/auth.js";

/**
 * Multi-channel / publish / product-listings — handlers inject từ server.ts (Phase 7).
 * Mount: app.use("/api", publishRoutes) — auth gắn từng route (framed-images public).
 */
let handlers = {};

export function initPublishRoutes(partial) {
  handlers = { ...handlers, ...partial };
}

function wrap(name) {
  return (req, res, next) => {
    const fn = handlers[name];
    if (typeof fn !== "function") {
      return res.status(503).json({ success: false, error: `${name}_not_initialized` });
    }
    return Promise.resolve(fn(req, res, next)).catch(next);
  };
}

const router = Router();

router.get("/multi-channel/listing", authMiddleware, wrap("getMultiChannelListing"));
router.post("/multi-channel/listing", authMiddleware, wrap("postMultiChannelListing"));
router.get("/product-listings", authMiddleware, wrap("getProductListings"));
router.post("/product-listings/clear-all", authMiddleware, wrap("clearProductListings"));
router.post("/catalog/wipe-all", authMiddleware, wrap("wipeCatalog"));
router.get("/shopee/category-attributes", authMiddleware, wrap("getCategoryAttributes"));
router.get("/shopee/categories", authMiddleware, wrap("getShopeeCategories"));
router.post("/shopee/categories/sync", authMiddleware, wrap("syncShopeeCategories"));
router.post("/multi-channel/publish", authMiddleware, wrap("publishMultiChannel"));
router.get("/publish-edit", authMiddleware, wrap("getPublishEdit"));
router.post("/publish-edit/config", authMiddleware, wrap("postPublishEditConfig"));
router.post("/publish-edit/batch-titles", authMiddleware, wrap("postPublishEditBatchTitles"));
router.post("/publish-edit/save-framed-image", authMiddleware, wrap("postSaveFramedImage"));
router.get("/framed-images/:productId", wrap("getFramedImage"));

export default router;
export { router };
