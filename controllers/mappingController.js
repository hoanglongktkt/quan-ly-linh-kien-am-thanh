/**
 * Controllers: mapping products — GET/PUT/POST, auto-link, heal, purge.
 * Phase 4 — tách từ server.ts.
 */

/** Deps từ server.ts (Mongo/cache helpers chưa tách hết). */
let deps = {
  reloadCachesFromDb: async () => ({ listings: [], products: [], updatedAt: "" }),
  enrichChannelListingsWithMaster: (listings) => listings,
  isMongoReady: () => false,
  readChannelListingsForGet: async () => [],
  sanitizeChannelListingRow: (row) => row,
  bulkUpsertChannelListingsToStore: async () => {},
  flushDbWrites: async () => {},
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  loadProducts: async () => [],
  persistHealedBrokenMappingLinks: async () => 0,
  readChannelListingsDb: async () => [],
  batchAutoLinkFromDatabase: async () => ({
    linkedCount: 0,
    alreadyLinked: 0,
    unlinkedRemaining: 0,
    listings: [],
    cacheUpdatedAt: "",
    masterProductCount: 0,
    skuIndexSize: 0,
    scannedCount: 0,
    requestedLimit: 0,
    nextCursor: null,
    hasMore: false,
  }),
  autoLinkSingleListingFromDatabase: async () => ({
    success: false,
    listing: null,
    matchedProductId: null,
    message: "",
  }),
  bulkAutoLinkAllPending: async () => ({
    linkedCount: 0,
    processed: 0,
  }),
  bulkAutoLinkListingsByIds: async () => ({
    linkedCount: 0,
  }),
  normalizeSkuKey: (sku) => String(sku || "").trim(),
  getProductChildrenList: () => [],
  isProductsDiskMode: () => false,
  loadLocalInventoryCache: async () => ({ listings: [], products: [], updatedAt: "" }),
  buildMasterProductLookupById: () => new Map(),
  writeChannelListingsDb: async () => {},
  refreshCache: async () => ({ updatedAt: "" }),
};

export function initMappingController(partial) {
  deps = { ...deps, ...partial };
}

export async function handleMappingProductsGet(_req, res) {
  try {
    // BẮT BUỘC đọc TRỰC TIẾP từ MongoDB — không dùng cache/mảng RAM sau restart.
    const cache = await deps.reloadCachesFromDb();
    const rawListings = cache.listings;
    const listings = deps.enrichChannelListingsWithMaster(rawListings, cache.products);
    const successWithProduct = listings.filter(
      (l) =>
        l?.status === "success" &&
        l?.linkedProduct &&
        (l?.linkedProductTitle || l?.linkedProductSku || l?.linkedProduct?.title),
    ).length;
    const broken = listings.filter((l) => l?.linkBroken).length;
    console.log(
      `[Mapping Products] GET db — ${listings.length} dòng (success+product=${successWithProduct}, broken=${broken}) mongo=${deps.isMongoReady()}`,
    );
    return res.status(200).json({
      success: true,
      listings,
      count: listings.length,
      cacheUpdatedAt: cache.updatedAt,
      source: deps.isMongoReady() ? "mongodb" : "json_fallback",
    });
  } catch (error) {
    console.error("[Mapping Products] GET lỗi:", error?.message || error);
    // Thử lại truy vấn MongoDB một lần — không fallback sang mảng RAM.
    try {
      const raw = await deps.readChannelListingsForGet();
      const safe = (Array.isArray(raw) ? raw : []).map((r) => deps.sanitizeChannelListingRow(r));
      return res.status(200).json({
        success: true,
        listings: safe,
        count: safe.length,
        source: "mongodb_retry",
        message: error?.message || String(error),
      });
    } catch (fallbackErr) {
      return res.status(500).json({
        success: false,
        error: fallbackErr?.message || error?.message || String(error),
      });
    }
  }
}

export async function handleMappingProductsUpsert(req, res) {
  try {
    const incoming = req.body?.listings;
    if (!Array.isArray(incoming)) {
      return res.status(400).json({
        success: false,
        message: "Thiếu mảng listings trong request body.",
        hint: "PUT/POST /api/mapping-products cần body { listings: [...] }. Liên kết tự động dùng POST /api/shopee/channel-products/auto-link (không cần listings).",
      });
    }
    console.log(`[Mapping Save] UPSERT nhận ${incoming.length} dòng (${req.method})`);
    const sanitized = incoming.map((row) => deps.sanitizeChannelListingRow(row));
    // bulkWrite 1 lệnh — cấm vòng await upsert từng dòng (NPROC AZDIGI).
    await deps.bulkUpsertChannelListingsToStore(sanitized);
    await deps.flushDbWrites();
    await deps.sleep(200);
    const verified = deps.enrichChannelListingsWithMaster(sanitized, await deps.loadProducts());
    console.log(`Đã lưu DB thành công — mapping bulkWrite ${sanitized.length} dòng`);
    return res.status(200).json({
      success: true,
      count: verified.length,
      listings: verified,
      cacheUpdatedAt: new Date().toISOString(),
      source: deps.isMongoReady() ? "mongodb" : "json_fallback",
    });
  } catch (error) {
    const errMsg = error?.message || String(error);
    console.error("[Mapping Save] UPSERT lỗi:", errMsg);
    return res.status(500).json({
      success: false,
      message: `Lỗi lưu Database: ${errMsg}`,
      error: errMsg,
    });
  }
}

/** Heal chủ động — tách biệt hoàn toàn khỏi GET (không auto-ghi trên đọc). */
export async function handleMappingProductsHeal(_req, res) {
  try {
    const products = await deps.loadProducts();
    const enriched = deps.enrichChannelListingsWithMaster(
      await deps.readChannelListingsDb(),
      products,
    );
    const healed = await deps.persistHealedBrokenMappingLinks(enriched);
    const listings = deps.enrichChannelListingsWithMaster(
      await deps.readChannelListingsDb(),
      products,
    );
    console.log(`[Mapping Products] HEAL xong: healed=${healed}, total=${listings.length}`);
    return res.status(200).json({
      success: true,
      healed,
      count: listings.length,
      listings,
    });
  } catch (error) {
    const errMsg = error?.message || String(error);
    console.error("[Mapping Products] HEAL lỗi:", errMsg);
    return res.status(500).json({
      success: false,
      message: `Lỗi heal Database: ${errMsg}`,
      error: errMsg,
    });
  }
}

export async function handleBatchAutoLink(req, res) {
  try {
    const body = req?.body && typeof req.body === "object" ? req.body : {};
    const result = await deps.batchAutoLinkFromDatabase({
      cursor: body.cursor,
      limit: body.limit,
    });
    const data = {
      linkedCount: result.linkedCount,
      alreadyLinked: result.alreadyLinked,
      unlinkedRemaining: result.unlinkedRemaining,
      listings: result.listings,
      cacheUpdatedAt: result.cacheUpdatedAt,
      masterProductCount: result.masterProductCount,
      skuIndexSize: result.skuIndexSize,
      scannedCount: result.scannedCount,
      limit: result.requestedLimit,
      nextCursor: result.nextCursor,
      hasMore: result.hasMore,
      source: "database",
    };
    console.log(
      `Đã lưu DB thành công — batch-auto-link linked=${result.linkedCount}, scanned=${result.scannedCount}, remaining=${result.unlinkedRemaining}, nextCursor=${result.nextCursor}`,
    );
    return res.status(200).json({
      success: true,
      data,
      message:
        result.linkedCount > 0
          ? `Đã liên kết thành công ${result.linkedCount} sản phẩm`
          : "Không tìm thấy SKU trùng khớp trong Database hiện tại",
      ...data,
    });
  } catch (error) {
    console.error("[Batch Auto-link] Exception:", error);
    if (!res.headersSent) {
      const message = error instanceof Error ? error.message : String(error);
      return res.status(500).json({ success: false, error: message });
    }
  }
}

export async function handleSingleAutoLink(req, res) {
  try {
    const body = req?.body && typeof req.body === "object" ? req.body : {};
    const result = await deps.autoLinkSingleListingFromDatabase({
      id: body.id,
      listingId: body.listingId,
      channelId: body.channelId,
      platform: body.platform,
    });

    return res.status(200).json({
      success: result.success,
      listing: result.listing,
      matchedProductId: result.matchedProductId,
      message: result.message,
    });
  } catch (error) {
    console.error("[Auto-link Single] Exception:", error);
    const message = error instanceof Error ? error.message : String(error);
    return res.status(500).json({ success: false, error: message });
  }
}

/** Index SKU Kho gốc (products) — payload nhẹ cho frontend Hash Map. */
export async function handleMappingSkuIndex(_req, res) {
  try {
    const masterProducts = await deps.loadProducts();
    const items = [];
    const seen = new Set();

    const addOne = (row) => {
      if (!row || typeof row !== "object") return;
      // Index mọi SKU trong Kho Gốc — kể cả id shopee-item-* (cần để Mapping trang 2+).
      const rawSku = String(row.sku || "").trim();
      const key = deps.normalizeSkuKey(rawSku);
      const id = row.id != null ? String(row.id).trim() : "";
      if (!key || !id || seen.has(key)) return;
      seen.add(key);
      items.push({
        sku: rawSku || key,
        id,
        title: String(row.title || "").trim(),
      });
    };

    for (const masterItem of Array.isArray(masterProducts) ? masterProducts : []) {
      if (!masterItem) continue;
      addOne(masterItem);
      for (const child of deps.getProductChildrenList(masterItem)) addOne(child);
      if (Array.isArray(masterItem.variants)) {
        for (const v of masterItem.variants) addOne(v);
      }
      if (Array.isArray(masterItem.models)) {
        for (const m of masterItem.models) addOne(m);
      }
    }

    console.log(`[SKU Index] Kho gốc products → ${items.length} SKU (Map-ready)`);
    return res.status(200).json({
      success: true,
      count: items.length,
      items,
      source: deps.isProductsDiskMode()
        ? "disk"
        : deps.isMongoReady()
          ? "mongodb"
          : "json_fallback",
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[SKU Index] Lỗi:", message);
    return res.status(500).json({ success: false, message });
  }
}

/** Auto-link theo lô ≤50 id — Hash Map cache + bulkWrite (FE đã có gap giữa chunk). */
export async function handleBulkAutoLinkByIds(req, res) {
  try {
    const body = req?.body && typeof req.body === "object" ? req.body : {};
    const mode = String(body.mode || "").trim().toLowerCase();

    if (mode === "all-pending" || mode === "all_pending" || body.allPending === true) {
      const result = await deps.bulkAutoLinkAllPending({
        limit: Number.isFinite(Number(body.limit)) ? Number(body.limit) : undefined,
      });
      return res.status(200).json({
        success: true,
        ...result,
        message:
          result.linkedCount > 0
            ? `Đã liên kết thành công ${result.linkedCount}/${result.processed} sản phẩm pending`
            : "Không có sản phẩm nào liên kết thành công trong lô pending",
      });
    }

    const rawIds = Array.isArray(body.ids)
      ? body.ids
      : Array.isArray(body.listingIds)
        ? body.listingIds
        : Array.isArray(body.listings)
          ? body.listings.map((row) => row?.id)
          : [];
    const result = await deps.bulkAutoLinkListingsByIds(rawIds);
    return res.status(200).json({
      success: true,
      ...result,
      message:
        result.linkedCount > 0
          ? `Đã liên kết thành công ${result.linkedCount}/${rawIds.length} sản phẩm trong lô`
          : "Không có sản phẩm nào liên kết thành công trong lô này",
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[Bulk Auto-link] Exception:", message);
    return res.status(500).json({ success: false, message, error: message });
  }
}

export async function handleMappingPurgeBroken(_req, res) {
  try {
    // 1) Tìm kiếm: mapping linkedProduct null/undefined hoặc ID không còn trong Kho gốc
    const cache = await deps.loadLocalInventoryCache();
    const listings =
      Array.isArray(cache.listings) && cache.listings.length > 0
        ? cache.listings
        : await deps.readChannelListingsDb();
    const masterLookup = deps.buildMasterProductLookupById(cache.products);
    const kept = [];
    let deletedCount = 0;

    for (const row of Array.isArray(listings) ? listings : []) {
      if (!row || typeof row !== "object") {
        deletedCount += 1;
        continue;
      }

      const linkedId =
        row?.linkedProductId != null && String(row.linkedProductId).trim() !== ""
          ? String(row.linkedProductId).trim()
          : row?.linkedProduct?.id != null && String(row.linkedProduct.id).trim() !== ""
            ? String(row.linkedProduct.id).trim()
            : "";

      const linkedProductMissing =
        row?.linkedProduct == null ||
        typeof row.linkedProduct !== "object" ||
        row?.linkedProduct?.id == null ||
        String(row.linkedProduct.id).trim() === "";

      const claimsLink = row?.status === "success" || linkedId !== "";
      const isBroken =
        claimsLink &&
        ((!linkedId && linkedProductMissing) || (linkedId !== "" && !masterLookup.has(linkedId)));

      if (isBroken) {
        deletedCount += 1;
        continue;
      }

      kept.push(row);
    }

    if (deletedCount > 0) {
      await deps.writeChannelListingsDb(kept);
    }
    const nextCache = await deps.refreshCache();

    return res.json({
      success: true,
      deletedCount,
      cacheUpdatedAt: nextCache.updatedAt,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error?.message || String(error),
    });
  }
}
