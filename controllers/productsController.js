/**
 * Controllers: products warehouse API.
 * Phase 4 — tách từ server.ts.
 */
import {
  detectStockPriceChanges,
  findProductRowById,
  pushProductStockPriceToShopeeImmediate,
  enqueueShopeeStockPriceSync,
  resolveProductWithShopeeMapping,
} from "../services/stockSyncQueue.js";

const PRODUCTS_PAGE_SIZE_DEFAULT = 50;
const PRODUCTS_PAGE_SIZE_MAX = 50;

/** Deps từ server.ts (Mongo/product helpers chưa tách hết). */
let deps = {
  loadProducts: async () => [],
  saveProducts: async () => {},
  getProductChildrenList: () => [],
  inheritShopeeLinkFromParent: (child) => child,
  mergeProductPatch: (p, patch) => ({ ...p, ...patch }),
  applyBulkProductUpdate: (p, opts) => p,
  flattenProductsForStockSync: (products) => products,
  upsertProductsToStoreAsync: async () => {},
  deleteProductsByIdsFromStore: async () => {},
  loadProductsPageFromStore: async () => ({
    products: [],
    page: 1,
    pageSize: PRODUCTS_PAGE_SIZE_DEFAULT,
    total: 0,
    totalPages: 0,
    hasMore: false,
  }),
  searchProductsFromStore: async () => [],
  withLocalDbTimeout: async (p) => p,
  isProductsDiskMode: () => false,
  isMongoReady: () => false,
  getProductsDiskPath: () => "",
  reloadCachesFromDb: async () => {},
  loadLocalInventoryCache: async () => ({ products: [], listings: [], updatedAt: "" }),
  refreshCache: async () => ({ updatedAt: "" }),
  enrichChannelListingsWithMaster: (listings) => listings,
  backupInventoryBeforeDestructiveAction: async () => "",
  writeInventoryAudit: () => {},
  writeChannelListingsDb: async () => {},
  writeProductListingsDb: () => {},
  pushStockUpdatesToShopee: async () => ({
    ok: true,
    pushed: 0,
    errors: [],
    warnings: [],
    staleSkus: [],
  }),
  resolveShopeeTokenShopId: () => null,
  resolveShopeeShopIdsForSync: () => [],
  listAuthorizedShopeeShopIds: () => [],
  getShopeeUnauthorizedShopMessage: () =>
    "Chưa có shop Shopee được ủy quyền. Vào mục Cài đặt → Ủy quyền lại Shop Shopee.",
  isShopeeConfigValid: () => false,
  isStaleShopeeItemErrorText: () => false,
  sendApiErrorJson: (res, err, status) =>
    res.status(status).json({ success: false, message: err?.message || String(err) }),
  getValidShopeeAccessToken: async () => null,
  syncProductToShopee: async () => [],
  syncProductToWoo: async () => [],
  syncProductToTikTok: async () => [],
};

export function initProductsController(partial) {
  deps = { ...deps, ...partial };
}

export { PRODUCTS_PAGE_SIZE_DEFAULT, PRODUCTS_PAGE_SIZE_MAX };

/** GET /api/products */
export async function listProducts(req, res) {
  res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
  try {
    const diskMode = deps.isProductsDiskMode();
    if (!diskMode && !deps.isMongoReady()) {
      return res.status(503).json({
        success: false,
        products: [],
        error: "mongodb_not_ready",
        message: "MongoDB chưa sẵn sàng — thử lại sau vài giây.",
      });
    }

    const rawPage = Number(req.query?.page);
    const rawSize = Number(req.query?.pageSize ?? req.query?.limit);
    const page = Number.isFinite(rawPage) && rawPage > 0 ? Math.floor(rawPage) : 1;
    const pageSize =
      Number.isFinite(rawSize) && rawSize > 0
        ? Math.min(PRODUCTS_PAGE_SIZE_MAX, Math.floor(rawSize))
        : PRODUCTS_PAGE_SIZE_DEFAULT;
    // Khớp FE: ?search=... hoặc ?keyword=... (hỗ trợ array / khoảng trắng thừa)
    const rawSearch = req.query?.search ?? req.query?.keyword ?? "";
    const search = String(Array.isArray(rawSearch) ? rawSearch[0] : rawSearch)
      .replace(/\s+/g, " ")
      .trim();

    // Có search: $regex trên toàn collection (name/title/sku), rồi mới limit 50 — không lọc local page 1.
    const paged = await deps.withLocalDbTimeout(
      deps.loadProductsPageFromStore(page, pageSize, search),
      diskMode ? 15_000 : 30_000,
      "products_page_load",
    );

    if (search) {
      console.log("[Products API] GET /api/products search", {
        search,
        page: paged.page,
        total: paged.total,
        hits: Array.isArray(paged.products) ? paged.products.length : 0,
      });
    }

    return res.status(200).json({
      success: true,
      products: paged.products,
      page: paged.page,
      pageSize: paged.pageSize,
      total: paged.total,
      totalPages: paged.totalPages,
      hasMore: paged.hasMore,
      grouped: false,
      source: diskMode ? "disk" : "mongodb",
      storage: diskMode ? deps.getProductsDiskPath() : "mongodb.products",
    });
  } catch (err) {
    console.error("[Products API] GET /api/products failed:", err);
    return res.status(503).json({
      success: false,
      error: "products_unavailable",
      message: err instanceof Error ? err.message : "products_read_error",
    });
  }
}

/** GET /api/products/search */
export async function searchProducts(req, res) {
  const q = String(req.query?.q ?? req.query?.query ?? "").trim();
  const limit = Number(req.query?.limit ?? 40);
  const mapRow = (p) => ({
    ...p,
    id: p.id,
    sku: p.sku || "",
    name: p.name || p.title || "",
    title: p.title || p.name || "",
    image: p.image || p.avatarUrl || p.imageUrl || "",
    current_stock: p.current_stock ?? p.stock ?? 0,
    stock: p.stock ?? p.current_stock ?? 0,
    last_import_price: p.last_import_price ?? p.importPrice ?? 0,
    importPrice: p.importPrice ?? p.last_import_price ?? 0,
    sellingPrice: Math.max(0, Math.round(Number(p.sellingPrice ?? p.price) || 0)),
    shopeeItemId: p.shopeeItemId || p.shopeeId || undefined,
    shopeeModelId: p.shopeeModelId || undefined,
  });

  try {
    let raw = [];
    let source = "mongodb";
    try {
      raw = await deps.searchProductsFromStore(q, limit);
    } catch (mongoErr) {
      console.warn("[Products API] searchProductsFromStore failed, fallback loadProducts:", mongoErr);
      const all = await deps.loadProducts();
      const qLower = q.toLowerCase();
      const flat = [];
      const seen = new Set();
      const push = (row) => {
        const id = String(row?.id || "").trim();
        if (!id || seen.has(id)) return;
        seen.add(id);
        flat.push(row);
      };
      const match = (row, extra = "") => {
        if (!q) return true;
        const hay =
          `${row?.sku || ""} ${row?.title || ""} ${row?.name || ""} ${row?.modelName || ""} ${extra}`.toLowerCase();
        return hay.includes(qLower);
      };
      for (const p of Array.isArray(all) ? all : []) {
        const children =
          Array.isArray(p?.children) && p.children.length
            ? p.children
            : Array.isArray(p?.children_models)
              ? p.children_models
              : [];
        if (children.length > 0) {
          let n = 0;
          for (const c of children) {
            if (!match(c, `${p.title || ""} ${p.sku || ""}`)) continue;
            push({
              ...c,
              title: c.title || p.title,
              imageUrl: c.imageUrl || p.imageUrl,
              avatarUrl: c.avatarUrl || p.avatarUrl,
            });
            n += 1;
          }
          if (n === 0 && match(p)) push(p);
        } else if (match(p)) {
          push(p);
        }
      }
      raw = flat.slice(0, Math.min(100, Math.max(1, Math.floor(limit) || 40)));
      source = "products_memory_fallback";
    }

    const products = raw.map(mapRow);
    console.log("[Products API] /api/products/search", {
      q,
      limit,
      total: products.length,
      source,
      sample: products.slice(0, 5).map((p) => ({
        id: p.id,
        sku: p.sku,
        name: p.name,
        current_stock: p.current_stock,
        last_import_price: p.last_import_price,
      })),
    });
    return res.json({
      success: true,
      products,
      total: products.length,
      source,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[Products API] GET /api/products/search failed:", err);
    return res
      .status(500)
      .json({ success: false, error: message || "search_failed", products: [] });
  }
}

/** POST /api/products/sync-shopee, POST /api/products/:id/sync-shopee */
export async function handleProductSyncShopee(req, res) {
  console.log("Bắt đầu đồng bộ Shopee", req.body);
  try {
    const requestedIds = Array.isArray(req.body?.productIds)
      ? req.body.productIds
      : [req.params?.id || req.body?.id || req.body?.productId];
    const productIds = [
      ...new Set(requestedIds.map((id) => String(id || "").trim()).filter(Boolean)),
    ];
    if (productIds.length === 0) {
      return res.status(400).json({
        success: false,
        error: "Thiếu product id. Gửi body { id }, { productId } hoặc { productIds: [...] }.",
      });
    }
    const products = await deps.loadProducts();
    const results = [];

    for (const productId of productIds) {
      const row = findProductRowById(products, productId);
      if (!row) {
        results.push({
          productId,
          success: false,
          message: "Không tìm thấy sản phẩm trong kho.",
        });
        continue;
      }
      const shopee = await pushProductStockPriceToShopeeImmediate(row, {
        syncStock: true,
        syncPrice: true,
        shopId: req.body?.shopId,
      });
      if (shopee.skipped || !shopee.ok) {
        results.push({
          productId,
          success: false,
          message:
            shopee.message ||
            (shopee.skipped
              ? "Chưa liên kết Mapping Shopee."
              : "Shopee từ chối đồng bộ tồn/giá"),
        });
        continue;
      }

      row.lastSynced = new Date().toISOString();
      results.push({
        productId,
        success: true,
        message: shopee.message,
      });
    }

    const succeeded = results.filter((result) => result.success);
    if (succeeded.length > 0) {
      await deps.saveProducts(products);
    }
    const failed = results.filter((result) => !result.success);
    if (failed.length > 0) {
      const detail = failed
        .map((result) => `${result.productId}: ${result.message}`)
        .join(" | ");
      return res.status(400).json({
        success: false,
        message: `Shopee báo lỗi: ${detail}`,
        error: `Shopee báo lỗi: ${detail}`,
        shopeeSynced: succeeded.length > 0,
        results,
      });
    }
    return res.status(200).json({
      success: true,
      shopeeSynced: true,
      shopeeMessage: results.map((result) => result.message).join(" | "),
      message: "Đồng bộ thành công",
      results,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[Products API] sync-shopee failed:", err);
    return res.status(500).json({
      success: false,
      message: message || "Internal Server Error",
      error: message || "Internal Server Error",
    });
  }
}

function readPositiveShopeeId(raw) {
  const s = String(raw ?? "").trim();
  if (!s || !/^\d+$/.test(s)) return "";
  return s;
}

/** POST /api/products/update-price — chỉ đẩy giá bán lên Shopee (v2.product.update_price), không đụng tồn/nhập hàng. */
export async function updateProductPrice(req, res) {
  try {
    const body = req.body || {};
    const productId = String(body.productId || body.id || body.product_id || "").trim();
    const sellingPrice = Math.max(
      0,
      Math.round(Number(body.sellingPrice ?? body.price ?? body.original_price) || 0),
    );

    if (!productId) {
      return res.status(400).json({
        success: false,
        message: "Thiếu productId.",
        error: "missing_product_id",
      });
    }
    if (!Number.isFinite(sellingPrice) || sellingPrice <= 0) {
      return res.status(400).json({
        success: false,
        message: "Giá bán không hợp lệ.",
        error: "invalid_selling_price",
      });
    }

    const products = await deps.loadProducts();
    const found = findProductRowById(products, productId);
    if (!found) {
      return res.status(404).json({
        success: false,
        message: "Không tìm thấy sản phẩm trong kho.",
        error: "product_not_found",
      });
    }

    const overlayItemId = readPositiveShopeeId(
      body.item_id ?? body.shopeeItemId ?? body.itemId,
    );
    const overlayModelId = readPositiveShopeeId(
      body.model_id ?? body.shopeeModelId ?? body.modelId,
    );

    const patched = { ...found, sellingPrice };
    if (overlayItemId) {
      patched.shopeeItemId = overlayItemId;
      if (!patched.shopeeId) patched.shopeeId = overlayItemId;
    }
    if (overlayModelId) patched.shopeeModelId = overlayModelId;

    const mapped = await resolveProductWithShopeeMapping(patched);
    if (!mapped) {
      return res.status(400).json({
        success: false,
        shopeeSynced: false,
        message: "Sản phẩm chưa liên kết Shopee (thiếu item_id). Không gọi API sàn.",
        error: "missing_item_id",
      });
    }

    const shopee = await pushProductStockPriceToShopeeImmediate(mapped, {
      syncStock: false,
      syncPrice: true,
      shopId: body.shopId,
    });

    if (shopee.skipped) {
      return res.status(400).json({
        success: false,
        shopeeSynced: false,
        message: shopee.message || "Chưa liên kết Shopee (thiếu item_id). Không gọi API sàn.",
        error: "missing_item_id",
      });
    }
    if (!shopee.ok) {
      return res.status(400).json({
        success: false,
        shopeeSynced: false,
        message: shopee.message || "Shopee từ chối cập nhật giá.",
        error: "shopee_update_price_failed",
      });
    }

    const topIndex = products.findIndex((p) => String(p?.id || "").trim() === productId);
    let savedRow = null;
    if (topIndex !== -1) {
      const merged = deps.mergeProductPatch(products[topIndex], { sellingPrice });
      products[topIndex] = merged;
      savedRow = merged;
      await deps.upsertProductsToStoreAsync([merged]);
    } else {
      let persisted = false;
      for (let i = 0; i < products.length; i++) {
        const children = deps.getProductChildrenList(products[i]);
        const childIdx = children.findIndex((c) => String(c?.id || "").trim() === productId);
        if (childIdx === -1) continue;
        const mergedChild = deps.mergeProductPatch(children[childIdx], { sellingPrice });
        const nextChildren = [...children];
        nextChildren[childIdx] = mergedChild;
        const nextParent = { ...products[i], children: nextChildren };
        products[i] = nextParent;
        savedRow = mergedChild;
        await deps.upsertProductsToStoreAsync([nextParent]);
        persisted = true;
        break;
      }
      if (!persisted) {
        return res.status(200).json({
          success: true,
          shopeeSynced: true,
          sellingPrice,
          productId,
          message: shopee.message || "Đã cập nhật giá lên Shopee (chưa ghi được kho nội bộ).",
        });
      }
    }

    return res.status(200).json({
      success: true,
      shopeeSynced: true,
      sellingPrice: Math.max(0, Math.round(Number(savedRow?.sellingPrice ?? sellingPrice) || 0)),
      productId,
      message: shopee.message || "Đã cập nhật giá lên Shopee.",
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[Products API] POST /api/products/update-price failed:", err);
    return res.status(500).json({
      success: false,
      message: message || "Internal Server Error",
      error: message || "Internal Server Error",
    });
  }
}

/** POST /api/products */
export async function createProduct(req, res) {
  const body = req.body || {};
  const title = String(body.title || body.name || "").trim();
  const sku = String(body.sku || "").trim();
  if (!title || !sku) {
    return res.status(400).json({
      success: false,
      error: "title_and_sku_required",
      message: "Vui lòng nhập tên sản phẩm và mã SKU.",
    });
  }

  try {
    const hits = await deps.searchProductsFromStore(sku, 20);
    const skuLower = sku.toLowerCase();
    const skuMatch = (row) => String(row?.sku || "").trim().toLowerCase() === skuLower;
    const duplicated = (Array.isArray(hits) ? hits : []).some((p) => {
      if (skuMatch(p)) return true;
      const children = Array.isArray(p?.children) && p.children.length
        ? p.children
        : Array.isArray(p?.children_models)
          ? p.children_models
          : [];
      return children.some(skuMatch);
    });
    if (duplicated) {
      return res.status(409).json({
        success: false,
        error: "sku_duplicate",
        message: "Mã SKU đã tồn tại.",
      });
    }
  } catch (dupErr) {
    console.warn("[Products API] SKU duplicate check skipped:", dupErr?.message || dupErr);
  }

  const product = {
    id: body.id || `prod-${Date.now()}`,
    title,
    sku,
    stock: Math.max(0, Math.round(Number(body.stock) || 0)),
    importPrice: Math.max(0, Math.round(Number(body.importPrice) || 0)),
    sellingPrice: Math.max(0, Math.round(Number(body.sellingPrice) || 0)),
    unit: String(body.unit || "").trim() || "cái",
    channels: Array.isArray(body.channels) ? body.channels : ["shopee"],
    category: body.category || "Chưa phân loại",
    description: body.description || "",
    imageUrl: body.imageUrl || undefined,
    status: body.status || "active",
    shopeeId: body.shopeeId,
    shopeeItemId: body.shopeeItemId,
    shopeeModelId: body.shopeeModelId,
    modelName: body.modelName,
    weight: body.weight != null ? Number(body.weight) : undefined,
    medicine_id:
      body.medicine_id != null && String(body.medicine_id).trim()
        ? String(body.medicine_id).trim()
        : undefined,
    tiktokId: body.tiktokId,
    wooId: body.wooId,
    lastSynced: new Date().toISOString(),
  };
  // Thêm một dòng bằng upsert, không đọc-rồi-ghi đè toàn bộ Kho gốc.
  await deps.upsertProductsToStoreAsync([product]);
  const cache = await deps.loadLocalInventoryCache();
  // b+c) Trả product + inventory từ Local Cache để UI hiển thị ngay, không reload trang tổng.
  return res.status(201).json({
    success: true,
    ...product,
    product,
    localInventory: cache.products,
    cacheUpdatedAt: cache.updatedAt,
  });
}

/** GET /api/local-inventory */
export async function getLocalInventory(_req, res) {
  try {
    await deps.reloadCachesFromDb();
    const cache = await deps.loadLocalInventoryCache();
    return res.status(200).json({
      success: true,
      updatedAt: cache.updatedAt,
      products: cache.products,
      listings: deps.enrichChannelListingsWithMaster(cache.listings, cache.products),
      count: {
        products: cache.products.length,
        listings: cache.listings.length,
      },
      source: deps.isMongoReady() ? "mongodb" : "json_fallback",
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error?.message || String(error),
    });
  }
}

/** POST /api/local-inventory/refresh */
export async function refreshLocalInventory(_req, res) {
  try {
    const cache = await deps.refreshCache();
    return res.status(200).json({
      success: true,
      updatedAt: cache.updatedAt,
      products: cache.products,
      listingsCount: cache.listings.length,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error?.message || String(error),
    });
  }
}

/** PUT /api/products/replace */
export async function replaceProducts(req, res) {
  const incoming = req.body?.products;
  if (!Array.isArray(incoming)) {
    return res.status(400).json({ error: "products_array_required" });
  }
  await deps.saveProducts(incoming);
  return res.json({ count: incoming.length, products: incoming });
}

/** PATCH /api/products/:id — CHỈ lưu kho nội bộ (Mongo/disk). Không gọi Shopee. */
export async function patchProduct(req, res) {
  try {
    const products = await deps.loadProducts();
    const patch = req.body || {};

    const topIndex = products.findIndex((p) => p.id === req.params.id);
    if (topIndex !== -1) {
      const merged = deps.mergeProductPatch(products[topIndex], patch);
      products[topIndex] = merged;
      await deps.upsertProductsToStoreAsync([merged]);
      return res.json({
        ...merged,
        success: true,
        shopeeSynced: false,
        shopeeMessage: "Đã lưu kho nội bộ (chưa đồng bộ Shopee).",
      });
    }

    // Cập nhật Child SKU nằm trong children
    for (let i = 0; i < products.length; i++) {
      const children = deps.getProductChildrenList(products[i]);
      const childIdx = children.findIndex((c) => c.id === req.params.id);
      if (childIdx === -1) continue;
      const mergedChild = deps.mergeProductPatch(children[childIdx], patch);
      const nextChildren = [...children];
      nextChildren[childIdx] = mergedChild;
      const totalStock = nextChildren.reduce((s, c) => s + (Number(c.stock) || 0), 0);
      products[i] = { ...products[i], children: nextChildren, stock: totalStock };
      await deps.upsertProductsToStoreAsync([products[i]]);
      return res.json({
        ...mergedChild,
        success: true,
        shopeeSynced: false,
        shopeeMessage: "Đã lưu kho nội bộ (chưa đồng bộ Shopee).",
      });
    }

    return res.status(404).json({ success: false, error: "product_not_found" });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[Products API] PATCH /api/products/:id failed:", err);
    return res.status(500).json({ success: false, error: message || "Internal Server Error" });
  }
}

/** POST /api/products/inventory-balance */
export async function inventoryBalance(req, res) {
  try {
    const items = req.body?.items;
    if (!Array.isArray(items) || items.length === 0) {
      return res
        .status(400)
        .json({ success: false, message: "Chưa có dòng tồn kho nào để cân bằng." });
    }

    const preferredShopId = String(req.body?.shopId || "").trim() || undefined;

    const skuStockMap = new Map();
    for (const item of items) {
      const sku = String(item?.sku || "").trim();
      if (!sku) continue;
      const rawStock = item?.actual_stock;
      if (rawStock === "" || rawStock == null) continue;
      const parsed = Number(rawStock);
      if (!Number.isFinite(parsed)) continue;
      const actual = Math.max(0, Math.round(parsed));
      skuStockMap.set(sku, actual);
    }

    if (skuStockMap.size === 0) {
      return res
        .status(400)
        .json({ success: false, message: "Dữ liệu cân bằng kho không hợp lệ." });
    }

    const products = await deps.loadProducts();
    let updatedCount = 0;
    const next = products.map((p) => {
      const children = deps.getProductChildrenList(p);
      if (children.length > 0) {
        let changed = false;
        const nextChildren = children.map((c) => {
          const sku = String(c.sku || "").trim();
          if (!skuStockMap.has(sku)) return c;
          updatedCount++;
          changed = true;
          return deps.mergeProductPatch(c, { stock: skuStockMap.get(sku) });
        });
        if (!changed) return p;
        const totalStock = nextChildren.reduce((s, c) => s + (Number(c.stock) || 0), 0);
        return { ...p, children: nextChildren, stock: totalStock };
      }
      const sku = String(p.sku || "").trim();
      if (!skuStockMap.has(sku)) return p;
      updatedCount++;
      return deps.mergeProductPatch(p, { stock: skuStockMap.get(sku) });
    });

    if (updatedCount === 0) {
      return res
        .status(404)
        .json({ success: false, message: "Không tìm thấy SKU nào trong kho gốc để cập nhật." });
    }

    const updatedProducts = deps
      .flattenProductsForStockSync(next)
      .filter((p) => skuStockMap.has(String(p.sku || "").trim()));

    await deps.upsertProductsToStoreAsync(
      next.filter((product, index) => product !== products[index]),
    );
    console.log(`[Inventory Balance] Cập nhật kho gốc ${updatedCount} SKU`);

    // Đồng bộ Shopee đồng bộ (trả lỗi thật) — chỉ SKU đã Mapping / có item_id.
    const pushResult = await deps.pushStockUpdatesToShopee(updatedProducts, preferredShopId);

    const parts = [];
    parts.push("kho gốc đã cập nhật");
    if (pushResult.pushed > 0) {
      parts.push(`đã đẩy tồn ${pushResult.pushed} SKU lên Shopee`);
    } else if (pushResult.errors.length === 0 && pushResult.warnings.length === 0) {
      parts.push("không có SKU Mapping Shopee để đồng bộ (hoặc chưa liên kết)");
    }

    const msg = `Cân bằng kho thành công (${parts.join(", ")}).`;
    console.log(`[Inventory Balance] ${msg}`);

    if (pushResult.errors.length > 0) {
      return res.status(200).json({
        success: true,
        message: msg,
        shopeeQueued: 0,
        shopeePushed: pushResult.pushed,
        shopeeErrors: pushResult.errors,
        shopeeWarnings: pushResult.warnings,
        staleSkus: pushResult.staleSkus,
      });
    }

    return res.status(200).json({
      success: true,
      message: msg,
      shopeeQueued: 0,
      shopeePushed: pushResult.pushed,
      shopeeErrors: [],
      shopeeWarnings: pushResult.warnings,
      staleSkus: pushResult.staleSkus,
    });
  } catch (err) {
    console.error("[Inventory Balance] Exception:", err);
    return deps.sendApiErrorJson(res, err, 500);
  }
}

/** POST /api/sync-stock */
export async function syncStock(req, res) {
  try {
    // Đồng bộ 1 CHIỀU: Kho gốc (Master) → Sàn. Không kéo tồn từ Sàn đè Kho gốc.
    const products = await deps.loadProducts();
    const requestedShopId = req.body?.shopId;
    const shopIds =
      typeof deps.resolveShopeeShopIdsForSync === "function"
        ? deps.resolveShopeeShopIdsForSync(requestedShopId)
        : (() => {
            const one = deps.resolveShopeeTokenShopId(requestedShopId);
            return one ? [one] : [];
          })();
    const warnings = [];

    if (!deps.isShopeeConfigValid()) {
      return res.status(400).json({
        success: false,
        message: "Shopee: cấu hình Partner chưa hợp lệ.",
      });
    }
    if (!shopIds.length) {
      const msg = deps.getShopeeUnauthorizedShopMessage();
      console.error(`[Sync Stock] ${msg}`);
      return res.status(400).json({
        success: false,
        message: msg,
        error: msg,
      });
    }

    console.log(`[Sync Stock] Multi-shop đẩy tồn shops=[${shopIds.join(", ")}]`);

    // Không truyền shop cụ thể → pushStockUpdatesToShopee tự loop tất cả shop đã ủy quyền
    const shopeeResult = await deps.pushStockUpdatesToShopee(
      products,
      requestedShopId || undefined,
    );
    if (shopeeResult.warnings?.length) warnings.push(...shopeeResult.warnings);
    if (!shopeeResult.ok && shopeeResult.errors.length > 0) {
      const onlyStale = shopeeResult.errors.every((e) => deps.isStaleShopeeItemErrorText(e));
      if (!onlyStale) {
        const detailMsg = shopeeResult.errors.join(" | ");
        return res.status(400).json({
          success: false,
          message: `Đẩy tồn Kho gốc → Shopee thất bại: ${detailMsg}`,
          error: detailMsg,
          shopeeErrors: shopeeResult.errors,
          shopeeWarnings: warnings,
        });
      }
      warnings.push(...shopeeResult.errors);
    }

    const message =
      shopeeResult.pushed > 0
        ? `Đã đẩy ${shopeeResult.pushed} SKU từ Kho gốc lên Shopee (đồng bộ 1 chiều).`
        : "Không có SKU nào cần đẩy lên Shopee (đã khớp hoặc chưa liên kết).";

    return res.json({
      success: true,
      message,
      direction: "warehouse_to_channel",
      shopee: {
        pushed: shopeeResult.pushed,
        staleSkus: shopeeResult.staleSkus,
        warnings,
      },
      tiktok: { updated: 0, message: "TikTok Shop API chưa được tích hợp trên server." },
      warnings,
      products: await deps.loadProducts(),
    });
  } catch (err) {
    console.error("[Sync Stock]", err);
    return deps.sendApiErrorJson(res, err, 500);
  }
}

/** POST /api/products/bulk-save */
export async function bulkSaveProducts(req, res) {
  const updates = req.body?.updates;
  if (!Array.isArray(updates) || updates.length === 0) {
    return res.status(400).json({ error: "updates_required" });
  }
  const patchMap = new Map();
  for (const u of updates) {
    if (u?.id) patchMap.set(String(u.id), u);
  }
  const products = await deps.loadProducts();
  const beforeFlat = deps.flattenProductsForStockSync(products);
  let updatedCount = 0;
  const changedRows = [];
  const next = products.map((p) => {
    const patch = patchMap.get(String(p.id));
    if (patch) {
      updatedCount++;
      patchMap.delete(String(p.id));
      const merged = deps.mergeProductPatch(p, patch);
      const before = beforeFlat.find((b) => String(b.id) === String(p.id));
      const changes = detectStockPriceChanges(before || p, merged);
      if (changes.stock || changes.price) changedRows.push(merged);
      return merged;
    }

    const children = deps.getProductChildrenList(p);
    if (children.length === 0) return p;

    let childChanged = false;
    const nextChildren = children.map((c) => {
      const childPatch = patchMap.get(String(c.id));
      if (!childPatch) return c;
      updatedCount++;
      patchMap.delete(String(c.id));
      childChanged = true;
      const mergedChild = deps.mergeProductPatch(c, childPatch);
      const beforeChild = beforeFlat.find((b) => String(b.id) === String(c.id));
      const changes = detectStockPriceChanges(beforeChild || c, mergedChild);
      if (changes.stock || changes.price) changedRows.push(mergedChild);
      return mergedChild;
    });
    if (!childChanged) return p;

    const totalStock = nextChildren.reduce((s, c) => s + (Number(c.stock) || 0), 0);
    return { ...p, children: nextChildren, stock: totalStock };
  });
  await deps.upsertProductsToStoreAsync(
    next.filter((product, index) => product !== products[index]),
  );
  if (changedRows.length > 0) {
    const anyStock = changedRows.some((row) => {
      const before = beforeFlat.find((b) => String(b.id) === String(row.id));
      return detectStockPriceChanges(before || {}, row).stock;
    });
    const anyPrice = changedRows.some((row) => {
      const before = beforeFlat.find((b) => String(b.id) === String(row.id));
      return detectStockPriceChanges(before || {}, row).price;
    });
    await enqueueShopeeStockPriceSync(changedRows, { syncStock: anyStock, syncPrice: anyPrice });
  }
  return res.json({ updated: updatedCount, products: next });
}

/** DELETE /api/products/:id */
export async function deleteProduct(req, res) {
  try {
    const id = String(req.params.id);
    const products = await deps.loadProducts();
    let found = false;
    const next = [];

    for (const p of products) {
      if (p.id === id) {
        found = true;
        continue; // xóa parent / dòng flat
      }
      const children = deps.getProductChildrenList(p);
      if (children.length > 0) {
        const filteredChildren = children.filter((c) => c.id !== id);
        if (filteredChildren.length !== children.length) {
          found = true;
          if (filteredChildren.length === 0) continue; // không còn child → bỏ parent rỗng
          const totalStock = filteredChildren.reduce(
            (s, c) => s + (Number(c.stock) || 0),
            0,
          );
          next.push({ ...p, children: filteredChildren, stock: totalStock });
          continue;
        }
      }
      next.push(p);
    }

    if (!found) {
      return res.status(404).json({ error: "product_not_found" });
    }
    const nextIds = new Set(next.map((product) => String(product.id)));
    await deps.deleteProductsByIdsFromStore(
      products
        .filter((product) => !nextIds.has(String(product.id)))
        .map((product) => String(product.id)),
    );
    await deps.upsertProductsToStoreAsync(
      next.filter(
        (product) => products.find((before) => before.id === product.id) !== product,
      ),
    );
    return res.json({ deleted: id, success: true });
  } catch (err) {
    console.error("[Products] DELETE failed:", err);
    return res.status(500).json({
      error: "delete_failed",
      message: err instanceof Error ? err.message : "Xóa sản phẩm thất bại",
    });
  }
}

/** POST /api/products/clear-all */
export async function clearAllProducts(req, res) {
  if (req.body?.confirmation !== "CLEAR_INVENTORY") {
    return res.status(400).json({ success: false, error: "explicit_confirmation_required" });
  }
  const backupFile = await deps.backupInventoryBeforeDestructiveAction("products-clear");
  await deps.saveProducts([]);
  deps.writeInventoryAudit("products_cleared", {
    requestedBy: req.user?.username || null,
    backupFile,
  });
  return res.json({ success: true, cleared: true, backupFile, products: [] });
}

/** DELETE+POST /api/inventory/clear-all */
export async function handleInventoryClearAll(req, res) {
  try {
    if (req.body?.confirmation !== "CLEAR_INVENTORY") {
      return res.status(400).json({
        success: false,
        error: "explicit_confirmation_required",
        message: "Xóa kho yêu cầu confirmation: CLEAR_INVENTORY.",
      });
    }
    const backupFile = await deps.backupInventoryBeforeDestructiveAction("inventory-clear");
    // 1) Xóa Kho Gốc trước (disk hoặc mongo) — không phụ thuộc Atlas quota.
    await deps.saveProducts([]);
    let listingsCleared = false;
    let listingsError = null;
    try {
      await deps.writeChannelListingsDb([]);
      listingsCleared = true;
    } catch (listErr) {
      listingsError = listErr?.message || String(listErr);
      console.warn("[Inventory] clear listings failed (Atlas?):", listingsError);
    }
    try {
      deps.writeProductListingsDb([]);
    } catch {
      /* optional */
    }
    try {
      await deps.refreshCache();
    } catch (cacheErr) {
      console.warn("[Inventory] refreshCache after clear:", cacheErr?.message || cacheErr);
    }
    deps.writeInventoryAudit("inventory_cleared", {
      requestedBy: req.user?.username || null,
      backupFile,
      productsCleared: true,
      listingsCleared,
      listingsError,
      storage: deps.isProductsDiskMode() ? "disk" : "mongo",
    });
    console.log(
      `[Inventory] Đã xóa Kho gốc (products=${deps.isProductsDiskMode() ? "disk" : "mongo"}) listingsCleared=${listingsCleared}.`,
    );
    return res.status(200).json({
      success: true,
      message: listingsCleared
        ? "Đã xóa toàn bộ Kho gốc và dữ liệu Liên kết (Mapping)."
        : `Đã xóa Kho gốc. Mapping chưa xóa được (Mongo đầy/lỗi): ${listingsError || "unknown"}`,
      backupFile,
      cleared: true,
      productsCleared: true,
      listingsCleared,
      listingsError,
      products: [],
      channelListings: listingsCleared ? [] : undefined,
    });
  } catch (error) {
    const errObj = error instanceof Error ? error : new Error(String(error));
    console.error("[Inventory] clear-all failed:", errObj);
    return res.status(500).json({
      success: false,
      message: errObj.message,
      error: errObj.toString(),
    });
  }
}

/** POST /api/products/bulk-update-prices — FE gửi giá đã tính sẵn, cập nhật DB + đồng bộ Shopee */
export async function bulkUpdatePrices(req, res) {
  try {
    const raw = req.body?.updates ?? req.body?.items ?? [];
    if (!Array.isArray(raw) || raw.length === 0) {
      return res.status(400).json({
        success: false,
        error: "updates_required",
        message: "Thiếu danh sách cập nhật giá.",
      });
    }

    const priceUpdates = [];
    for (const item of raw) {
      const id = String(item?.id ?? item?.sku ?? item?.productId ?? "").trim();
      const sellingPrice = Math.max(
        0,
        Math.round(
          Number(item?.new_price ?? item?.newPrice ?? item?.sellingPrice ?? item?.price) || 0,
        ),
      );
      if (!id || sellingPrice <= 0) continue;
      priceUpdates.push({ id, sellingPrice });
    }

    if (priceUpdates.length === 0) {
      return res.status(400).json({
        success: false,
        error: "invalid_updates",
        message: "Không có bản ghi giá hợp lệ trong payload.",
      });
    }

    const products = await deps.loadProducts();
    const beforeFlat = deps.flattenProductsForStockSync(products);
    let updatedCount = 0;
    const changedRows = [];
    const patchMap = new Map(priceUpdates.map((u) => [u.id, u.sellingPrice]));

    const next = products.map((p) => {
      const directPrice = patchMap.get(String(p.id));
      if (directPrice !== undefined) {
        updatedCount++;
        patchMap.delete(String(p.id));
        const merged = deps.mergeProductPatch(p, { sellingPrice: directPrice });
        const before = beforeFlat.find((b) => String(b.id) === String(p.id));
        const changes = detectStockPriceChanges(before || p, merged);
        if (changes.price) changedRows.push(merged);
        return merged;
      }

      const children = deps.getProductChildrenList(p);
      if (children.length === 0) return p;

      let childChanged = false;
      const nextChildren = children.map((c) => {
        const childPrice = patchMap.get(String(c.id));
        if (childPrice === undefined) return c;
        updatedCount++;
        patchMap.delete(String(c.id));
        childChanged = true;
        const mergedChild = deps.mergeProductPatch(c, { sellingPrice: childPrice });
        const beforeChild = beforeFlat.find((b) => String(b.id) === String(c.id));
        const changes = detectStockPriceChanges(beforeChild || c, mergedChild);
        if (changes.price) changedRows.push(mergedChild);
        return mergedChild;
      });
      if (!childChanged) return p;

      const totalStock = nextChildren.reduce((s, c) => s + (Number(c.stock) || 0), 0);
      return { ...p, children: nextChildren, stock: totalStock };
    });

    const parentsToUpsert = next.filter((product, index) => product !== products[index]);
    for (const parent of parentsToUpsert) {
      await deps.upsertProductsToStoreAsync([parent]);
      await new Promise((r) => setTimeout(r, 30));
    }

    if (changedRows.length > 0) {
      await enqueueShopeeStockPriceSync(changedRows, { syncStock: false, syncPrice: true });
    }

    return res.json({
      success: true,
      updated: updatedCount,
      products: next,
      message: `Đã cập nhật giá cho ${updatedCount} sản phẩm và đồng bộ Shopee.`,
    });
  } catch (err) {
    console.error("[Products API] POST /api/products/bulk-update-prices failed:", err);
    const message = err instanceof Error ? err.message : String(err);
    return res.status(500).json({
      success: false,
      error: "bulk_update_prices_failed",
      message: message || "Cập nhật giá hàng loạt thất bại.",
    });
  }
}

/** POST /api/products/bulk-update */
export async function bulkUpdateProducts(req, res) {
  const { productIds, stock, price } = req.body || {};
  if (!Array.isArray(productIds) || productIds.length === 0) {
    return res.status(400).json({ error: "productIds_required" });
  }
  if (!stock && !price) {
    return res.status(400).json({ error: "stock_or_price_required" });
  }
  const idSet = new Set(productIds.map(String));
  const products = await deps.loadProducts();
  let updatedCount = 0;
  const changedRows = [];
  const next = products.map((p) => {
    const children = deps.getProductChildrenList(p);
    if (children.length > 0) {
      let changed = false;
      const nextChildren = children.map((c) => {
        if (!idSet.has(c.id)) return c;
        updatedCount++;
        changed = true;
        const merged = deps.applyBulkProductUpdate(c, { stock, price });
        changedRows.push(merged);
        return merged;
      });
      if (!changed && !idSet.has(p.id)) return p;
      if (idSet.has(p.id)) {
        updatedCount++;
        const parentPatched = deps.applyBulkProductUpdate(p, { stock, price });
        changedRows.push(parentPatched);
        const totalStock = nextChildren.reduce((s, c) => s + (Number(c.stock) || 0), 0);
        return { ...parentPatched, children: nextChildren, stock: totalStock };
      }
      const totalStock = nextChildren.reduce((s, c) => s + (Number(c.stock) || 0), 0);
      return { ...p, children: nextChildren, stock: totalStock };
    }
    if (!idSet.has(p.id)) return p;
    updatedCount++;
    const merged = deps.applyBulkProductUpdate(p, { stock, price });
    changedRows.push(merged);
    return merged;
  });
  await deps.saveProducts(next);
  if (changedRows.length > 0) {
    await enqueueShopeeStockPriceSync(changedRows, {
      syncStock: !!stock,
      syncPrice: !!price,
    });
  }
  return res.json({ updated: updatedCount, products: next });
}

/** POST /api/products/bulk-channel-sync */
export async function bulkChannelSync(req, res) {
  try {
    const { productIds, channels, shopId, shops } = req.body || {};
    if (!Array.isArray(productIds) || productIds.length === 0) {
      return res.status(400).json({ error: "productIds_required" });
    }

    const channelList =
      Array.isArray(channels) && channels.length ? channels : ["shopee"];

    const idSet = new Set(productIds.map(String));
    const products = deps
      .flattenProductsForStockSync(await deps.loadProducts())
      .filter((p) => idSet.has(p.id));
    if (products.length === 0) {
      return res.status(404).json({ error: "Không tìm thấy sản phẩm nào trong kho." });
    }

    const shopList = Array.isArray(shops) ? shops : [];
    const wooShop = shopList.find((s) => s.platform === "woocommerce" && s.connected !== false);
    const tiktokShop = shopList.find((s) => s.platform === "tiktok" && s.connected !== false);

    const requestedShopeeShop =
      shopId || shopList.find((s) => s.platform === "shopee")?.shopId || "";
    const shopeeShopIds =
      typeof deps.resolveShopeeShopIdsForSync === "function"
        ? deps.resolveShopeeShopIdsForSync(requestedShopeeShop)
        : (() => {
            const one = deps.resolveShopeeTokenShopId(requestedShopeeShop);
            return one ? [one] : [];
          })();

    /** @type {Map<string, string>} */
    const shopeeTokensByShop = new Map();
    if (channelList.includes("shopee")) {
      if (!shopeeShopIds.length) {
        const authMsg = deps.getShopeeUnauthorizedShopMessage();
        console.error(`[Bulk Channel Sync] ${authMsg}`);
        return res.status(400).json({
          error: authMsg,
          logs: products.flatMap((p) => [
            {
              productId: p.id,
              sku: p.sku,
              channel: "shopee",
              action: "auth",
              success: false,
              message: authMsg,
            },
          ]),
        });
      }
      for (const sid of shopeeShopIds) {
        const token = await deps.getValidShopeeAccessToken(sid);
        if (token) {
          shopeeTokensByShop.set(sid, token);
          console.log(`[Bulk Channel Sync] Token OK shop_id=${sid}`);
        } else {
          console.error(`[Bulk Channel Sync] Token FAIL shop_id=${sid}`);
        }
      }
      if (shopeeTokensByShop.size === 0) {
        return res.status(400).json({
          error: `Chưa có access_token hợp lệ cho các shop: [${shopeeShopIds.join(", ")}].`,
          logs: products.flatMap((p) => [
            {
              productId: p.id,
              sku: p.sku,
              channel: "shopee",
              action: "auth",
              success: false,
              message: `Chưa có access_token hợp lệ cho shops=[${shopeeShopIds.join(", ")}]`,
            },
          ]),
        });
      }
    }

    const logs = [];
    const SKU_SYNC_DELAY_MS = 300;

    for (const product of products) {
      for (const channel of channelList) {
        try {
          if (channel === "shopee" && shopeeTokensByShop.size > 0) {
            for (const [sid, token] of shopeeTokensByShop.entries()) {
              const lines = await deps.syncProductToShopee(product, sid, token);
              logs.push(...lines);
              await new Promise((r) => setTimeout(r, SKU_SYNC_DELAY_MS));
            }
          } else if (channel === "woocommerce") {
            const lines = await deps.syncProductToWoo(product, wooShop);
            logs.push(...lines);
            await new Promise((r) => setTimeout(r, SKU_SYNC_DELAY_MS));
          } else if (channel === "tiktok") {
            const lines = await deps.syncProductToTikTok(product, tiktokShop);
            logs.push(...lines);
            await new Promise((r) => setTimeout(r, SKU_SYNC_DELAY_MS));
          }
        } catch (syncErr) {
          console.error(`[Bulk Channel Sync] SKU=${product.sku} channel=${channel}:`, syncErr);
          logs.push({
            productId: product.id,
            sku: product.sku,
            channel,
            action: "sync",
            success: false,
            message: syncErr?.message || String(syncErr),
          });
        }
      }
    }

    const successCount = logs.filter((l) => l.success).length;
    const failCount = logs.filter((l) => !l.success).length;
    const syncedProductIds = new Set(logs.filter((l) => l.success).map((l) => l.productId));

    if (syncedProductIds.size > 0) {
      const allProducts = await deps.loadProducts();
      const now = new Date().toISOString();
      const next = allProducts.map((p) =>
        syncedProductIds.has(p.id) ? { ...p, lastSynced: now } : p,
      );
      await deps.saveProducts(next);
    }

    const failMessages = logs
      .filter((l) => !l.success)
      .map((l) => l.message)
      .filter(Boolean);
    const summaryError =
      failMessages.length > 0
        ? `Đồng bộ có lỗi: ${failMessages.slice(0, 3).join(" | ")}${failMessages.length > 3 ? " …" : ""}`
        : "Một số kênh từ chối cập nhật giá/tồn kho";

    return res.status(failCount === 0 ? 200 : 400).json({
      success: failCount === 0,
      message:
        failCount === 0
          ? "Đồng bộ thành công"
          : summaryError,
      error: failCount === 0 ? undefined : summaryError,
      logs,
      successCount,
      failCount,
      total: logs.length,
      products: await deps.loadProducts(),
    });
  } catch (error) {
    console.error("[Bulk Channel Sync]", error);
    return res.status(500).json({
      error: error?.message || "Đồng bộ đa kênh thất bại",
      logs: [],
    });
  }
}
