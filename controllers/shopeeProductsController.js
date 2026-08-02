/**
 * Controllers: Shopee warehouse / products sync.
 * Phase 6 — tách từ server.ts.
 */
import {
  isShopeeConfigValid,
  resolveShopeeTokenShopId,
  getValidShopeeAccessToken,
  getShopeeUnauthorizedShopMessage,
} from "../services/shopee/auth.js";
import { sendApiErrorJson } from "../utils/apiError.js";

let deps = {
  isProductsDiskMode: () => false,
  isMongoReady: () => false,
  saveProducts: async () => {},
  writeInventoryAudit: () => {},
  syncShopeeWarehouseSinglePage: async () => ({
    productCount: 0,
    pageIndex: 0,
    pageStats: {
      rowsInPage: 0,
      variantItemCount: 0,
      itemsInPage: 0,
      savedCount: 0,
      skippedCount: 0,
    },
    currentOffset: 0,
    nextOffset: null,
    hasMore: false,
    skippedItems: [],
    mergeDebug: {},
  }),
  SHOPEE_ITEM_LIST_PAGE_SIZE: 10,
  fetchShopeeItemVariants: async () => ({ variantProducts: [], error: "not_initialized", modelCount: 0 }),
  loadProducts: async () => [],
  replaceProductsForShopeeItem: (all, _itemId, variants) => variants,
  getProductChildrenList: (p) =>
    Array.isArray(p?.children) && p.children.length
      ? p.children
      : Array.isArray(p?.children_models)
        ? p.children_models
        : [],
  extractHttpClientError: (err) => ({
    message: err?.message || String(err),
    details: "",
  }),
};

export function initShopeeProductsController(partial) {
  deps = { ...deps, ...partial };
}

/** POST /api/shopee/products/sync */
export async function syncProducts(req, res) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  try {
    if (!deps.isProductsDiskMode() && !deps.isMongoReady()) {
      return res.status(503).json({
        success: false,
        error: "mongodb_not_ready",
        message: "Database chưa sẵn sàng. Thử lại sau vài giây.",
      });
    }
    if (!isShopeeConfigValid()) {
      return res.status(500).json({
        success: false,
        error: "invalid_partner_config",
        message: "SHOPEE_PARTNER_ID/SHOPEE_PARTNER_KEY trong .env chưa hợp lệ.",
        details: "invalid_partner_config",
      });
    }

    const shopId = resolveShopeeTokenShopId(req.body?.shopId);
    if (!shopId) {
      return res.status(404).json({
        success: false,
        error: "no_shopee_shop_linked",
        message: getShopeeUnauthorizedShopMessage(),
        details: "no_shopee_shop_linked",
      });
    }

    const accessToken = await getValidShopeeAccessToken(shopId);
    if (!accessToken) {
      return res.status(401).json({
        success: false,
        error: "no_valid_access_token",
        message: `Chưa có access_token hợp lệ cho shop_id=${shopId}.`,
        details: "no_valid_access_token",
      });
    }

    const rawOffset = Number(req.body?.offset ?? 0);
    const offset = Number.isFinite(rawOffset) && rawOffset >= 0 ? Math.floor(rawOffset) : 0;
    const resetWarehouse =
      offset === 0 &&
      (req.body?.reset === true ||
        req.body?.reset === 1 ||
        req.body?.reset === "1" ||
        req.body?.replace === true);

    if (resetWarehouse) {
      console.log(
        `[Shopee Product Sync] RESET Kho Gốc trước khi sync shop=${shopId} storage=${deps.isProductsDiskMode() ? "disk" : "mongo"}`,
      );
      await deps.saveProducts([]);
    }

    try {
      deps.writeInventoryAudit("shopee_sync_page", {
        shopId,
        offset,
        reset: resetWarehouse,
        requestedBy: req.user?.username || null,
      });
    } catch {
      /* ignore audit */
    }

    const syncStarted = Date.now();
    console.log(
      `[Shopee Product Sync] Bắt đầu đồng bộ 1 trang shop_id=${shopId}, offset=${offset}, page_size=${deps.SHOPEE_ITEM_LIST_PAGE_SIZE}`,
    );
    const result = await deps.syncShopeeWarehouseSinglePage(shopId, accessToken, offset);
    const initialized = Number(result.productCount) || 0;
    const durationMs = Date.now() - syncStarted;
    console.log(
      `[Shopee Product Sync] Xong trang ${result.pageIndex + 1} — productCount=${initialized}, rowsInPage=${result.pageStats.rowsInPage}, hasMore=${result.hasMore}, durationMs=${durationMs}`,
    );
    if (!result.hasMore) {
      deps.writeInventoryAudit("shopee_sync_completed", {
        shopId,
        requestedBy: req.user?.username || null,
        productCount: initialized,
        pageCount: result.pageIndex + 1,
        skippedCount: result.pageStats.skippedCount,
      });
    }

    return res.status(200).json({
      success: true,
      shopId,
      productCount: initialized,
      stats: {
        rowCount: result.pageStats.rowsInPage,
        variantItemCount: result.pageStats.variantItemCount,
        pageCount: result.pageIndex + 1,
        itemsInPage: result.pageStats.itemsInPage,
        savedCount: result.pageStats.savedCount,
        skippedCount: result.pageStats.skippedCount,
      },
      currentOffset: result.currentOffset,
      nextOffset: result.nextOffset,
      hasMore: result.hasMore,
      pageIndex: result.pageIndex + 1,
      skippedItems: result.skippedItems?.length ? result.skippedItems.slice(0, 20) : undefined,
      message: result.hasMore
        ? `Đã lưu trang ${result.pageIndex + 1} (${result.pageStats.itemsInPage} sản phẩm), tiếp tục trang sau`
        : `Đã khởi tạo xong ${initialized} sản phẩm`,
      forceRefresh: !result.hasMore,
      refresh: { forceRefresh: !result.hasMore },
      _debug: {
        durationMs,
        existingCount: result.mergeDebug?.existingCount ?? 0,
        upsertCount: result.mergeDebug?.upsertCount ?? 0,
        batchRows: result.mergeDebug?.batchRows ?? 0,
        loadMs: result.mergeDebug?.loadMs ?? 0,
        upsertMs: result.mergeDebug?.upsertMs ?? 0,
      },
    });
  } catch (error) {
    console.error("[Shopee Product Sync] Exception:", error);
    console.error("Lỗi khi lưu DB chunk:", error);
    const { message, details } = deps.extractHttpClientError(error);
    const isRate = /429|rate.?limit|too many request/i.test(message);
    if (!res.headersSent) {
      return res.status(isRate ? 429 : 500).json({
        success: false,
        error: isRate ? "shopee_rate_limit" : "exception",
        message: message || "Khởi tạo kho thất bại",
        details: String(details || "").slice(0, 500),
      });
    }
  }
}

/** POST /api/shopee/products/sync-item-variants */
export async function syncItemVariants(req, res) {
  try {
    if (!isShopeeConfigValid()) {
      return res.status(500).json({
        success: false,
        error: "invalid_partner_config",
        message: "Cấu hình Shopee Partner không hợp lệ.",
        details: "invalid_partner_config",
      });
    }

    const rawItemId = String(
      req.body?.itemId || req.body?.shopeeItemId || req.body?.productId || req.body?.channelId || "",
    );
    const itemIdMatch = rawItemId.match(/(\d{6,})/);
    if (!itemIdMatch) {
      return res.status(400).json({
        success: false,
        error: "itemId_required",
        message: "Không xác định được item_id Shopee.",
        details: "itemId_required",
      });
    }
    const itemId = itemIdMatch[1];
    const previewOnly = req.body?.previewOnly === true || req.body?.preview === true || req.query?.previewOnly === "1";

    const shopId = resolveShopeeTokenShopId(req.body?.shopId);
    if (!shopId) {
      return res.status(400).json({
        success: false,
        error: "no_shopee_shop",
        message: getShopeeUnauthorizedShopMessage(),
        details: "no_shopee_shop",
      });
    }

    const accessToken = await getValidShopeeAccessToken(shopId);
    if (!accessToken) {
      return res.status(401).json({
        success: false,
        error: "no_valid_access_token",
        message: "Chưa có access_token hợp lệ.",
        details: "no_valid_access_token",
      });
    }

    const { item, variantProducts, error, modelCount } = await deps.fetchShopeeItemVariants(
      shopId,
      accessToken,
      itemId,
    );
    if (error && variantProducts.length === 0) {
      return res.status(400).json({ success: false, error, message: error, details: String(error) });
    }
    if (variantProducts.length === 0) {
      return res.status(404).json({
        success: false,
        error: "no_variants_found",
        message: "Không lấy được phân loại từ Shopee.",
        details: "no_variants_found",
      });
    }

    const initVariants = flattenShopeeRowsForInitForm(variantProducts);

    // Modal khởi tạo kho chỉ cần đọc — không ghi Kho Gốc.
    if (previewOnly) {
      return res.json({
        success: true,
        previewOnly: true,
        itemId: String(itemId),
        title: String(item?.item_name || variantProducts?.[0]?.title || ""),
        variantCount: initVariants.length,
        modelCount,
        variants: initVariants,
      });
    }

    const allProducts = await deps.loadProducts();
    const merged = deps.replaceProductsForShopeeItem(allProducts, String(itemId), variantProducts);
    await deps.saveProducts(merged);

    console.log(
      `[Shopee Variant Sync] item_id=${itemId} -> ${variantProducts.length} dong (modelCount=${modelCount})`,
    );
    return res.json({
      success: true,
      itemId: String(itemId),
      variantCount: variantProducts.length,
      modelCount,
      variants: initVariants.length > 0 ? initVariants : variantProducts,
      products: merged,
    });
  } catch (err) {
    console.error("[Shopee Variant Sync] Exception:", err);
    return sendApiErrorJson(res, err, 500);
  }
}

/** Flatten parent/children → dòng form khởi tạo kho (price/weight/stock thật từ Shopee). */
function flattenShopeeRowsForInitForm(variantProducts) {
  const out = [];
  for (const row of Array.isArray(variantProducts) ? variantProducts : []) {
    if (!row || typeof row !== "object") continue;
    const children = deps.getProductChildrenList(row);
    const parentWeight = Math.max(0, Number(row.weight) || 0);
    if (children.length > 0) {
      children.forEach((child, idx) => {
        out.push({
          label: String(child?.modelName || child?.title?.split(" - ").pop() || `Phiên bản ${idx + 1}`),
          sku: String(child?.sku || ""),
          price: Math.max(0, Math.round(Number(child?.sellingPrice ?? child?.price) || 0)),
          weight: Math.max(0, Number(child?.weight) || parentWeight),
          stock: Math.max(0, Math.round(Number(child?.stock) || 0)),
          modelId: child?.shopeeModelId != null ? String(child.shopeeModelId) : undefined,
          itemId: child?.shopeeItemId != null ? String(child.shopeeItemId) : String(row.shopeeItemId || ""),
        });
      });
      continue;
    }
    out.push({
      label: String(row?.modelName || "Phiên bản 1"),
      sku: String(row?.sku || ""),
      price: Math.max(0, Math.round(Number(row?.sellingPrice ?? row?.price) || 0)),
      weight: parentWeight,
      stock: Math.max(0, Math.round(Number(row?.stock) || 0)),
      modelId: row?.shopeeModelId != null ? String(row.shopeeModelId) : undefined,
      itemId: row?.shopeeItemId != null ? String(row.shopeeItemId) : undefined,
    });
  }
  return out;
}

/**
 * POST /api/shopee/products/item-preview
 * Lấy giá / khối lượng / tồn kho từ Shopee để fill modal khởi tạo — KHÔNG ghi kho.
 */
export async function previewItemVariants(req, res) {
  try {
    if (!isShopeeConfigValid()) {
      return res.status(500).json({
        success: false,
        error: "invalid_partner_config",
        message: "Cấu hình Shopee Partner không hợp lệ.",
      });
    }

    const rawItemId = String(
      req.body?.itemId || req.body?.shopeeItemId || req.body?.channelId || req.query?.itemId || "",
    );
    const itemIdMatch = rawItemId.match(/(\d{6,})/);
    if (!itemIdMatch) {
      return res.status(400).json({
        success: false,
        error: "itemId_required",
        message: "Không xác định được item_id Shopee.",
      });
    }
    const itemId = itemIdMatch[1];

    const shopId = resolveShopeeTokenShopId(req.body?.shopId || req.query?.shopId);
    if (!shopId) {
      return res.status(400).json({
        success: false,
        error: "no_shopee_shop",
        message: getShopeeUnauthorizedShopMessage(),
      });
    }

    const accessToken = await getValidShopeeAccessToken(shopId);
    if (!accessToken) {
      return res.status(401).json({
        success: false,
        error: "no_valid_access_token",
        message: "Chưa có access_token hợp lệ.",
      });
    }

    const { item, variantProducts, error, modelCount } = await deps.fetchShopeeItemVariants(
      shopId,
      accessToken,
      itemId,
    );
    if (error && (!Array.isArray(variantProducts) || variantProducts.length === 0)) {
      return res.status(400).json({ success: false, error, message: error });
    }

    const variants = flattenShopeeRowsForInitForm(variantProducts);
    return res.json({
      success: true,
      itemId: String(itemId),
      title: String(item?.item_name || variantProducts?.[0]?.title || ""),
      modelCount,
      variants,
    });
  } catch (err) {
    console.error("[Shopee Item Preview] Exception:", err);
    return sendApiErrorJson(res, err, 500);
  }
}
