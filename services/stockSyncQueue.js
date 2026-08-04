/**
 * Shopee Sync Queue — rate-limit (750ms) + retry (tối đa 3) cho stock/price.
 * Phase 4: tách từ server.ts.
 */
import { sleep } from "../utils/concurrency.js";

const SHOPEE_SYNC_QUEUE_GAP_MS = 750;
const SHOPEE_SYNC_QUEUE_MAX_RETRY = 3;

const shopeeSyncQueue = [];
const shopeeSyncQueueKeys = new Set();
let shopeeSyncQueueRunning = false;

/** Deps từ server.ts (Shopee helpers chưa tách hết). */
let deps = {
  getProductChildrenList: () => [],
  inheritShopeeLinkFromParent: (child) => child,
  getShopeeItemIdForStockPush: () => null,
  resolveShopeeModelIdForStockPush: () => null,
  applyShopeeLinkFieldsToProduct: (product) => product,
  readChannelListingsDb: async () => [],
  resolveShopeeTokenShopId: () => null,
  resolveShopeeShopIdsForSync: () => [],
  listAuthorizedShopeeShopIds: () => [],
  getShopeeUnauthorizedShopMessage: () =>
    "Chưa có shop Shopee được ủy quyền. Vào mục Cài đặt → Ủy quyền lại Shop Shopee.",
  getValidShopeeAccessToken: async () => null,
  withShopeeAccessTokenRetry: async (_shopId, runner) => runner(null),
  isShopeeInvalidTokenError: () => false,
  resolveShopeeShopForItemId: async () => null,
  loadShopeeTokens: () => ({}),
  productRequiresShopeeModelId: () => false,
  resolveShopeeModelIdFromApi: async () => ({ hasModel: false, modelId: null }),
  appendShopeeSyncErrorToDb: async () => {},
  resolveShopeeStockLocationId: async () => null,
  buildShopeeUpdateStockEntry: () => ({}),
  shopeeUpdateStock: async () => ({}),
  parseShopeeApiResult: () => ({ success: false, message: "" }),
  extractShopeeStockPushErrorMessage: (_err, fallback) => fallback || "",
  buildShopeeUpdatePriceEntry: () => ({}),
  shopeeUpdatePrice: async () => ({}),
  shopeeUpdateModelSku: async () => ({}),
  loadProductById: async () => null,
};

export function initStockSyncQueue(partial) {
  deps = { ...deps, ...partial };
}

export function detectStockPriceChanges(before, after) {
  const stockBefore = Math.max(0, Math.round(Number(before?.stock) || 0));
  const stockAfter = Math.max(0, Math.round(Number(after?.stock) || 0));
  const priceBefore = Math.max(0, Math.round(Number(before?.sellingPrice) || 0));
  const priceAfter = Math.max(0, Math.round(Number(after?.sellingPrice) || 0));
  return {
    stock: stockBefore !== stockAfter,
    price: priceBefore !== priceAfter,
  };
}

export function findProductRowById(products, productId) {
  const id = String(productId || "").trim();
  if (!id) return null;
  for (const p of Array.isArray(products) ? products : []) {
    if (String(p?.id || "").trim() === id) return p;
    for (const child of deps.getProductChildrenList(p)) {
      if (String(child?.id || "").trim() === id) {
        return deps.inheritShopeeLinkFromParent(child, p);
      }
    }
  }
  return null;
}

/**
 * Gắn Shopee item/model từ DB Mapping (channel_listings) nếu sản phẩm kho đã liên kết.
 * Luôn cố bổ sung model_id kể cả khi đã có item_id.
 */
export async function resolveProductWithShopeeMapping(product) {
  if (!product || typeof product !== "object") return null;

  let current = product;
  const hasItemId = () => deps.getShopeeItemIdForStockPush(current) != null;
  const hasModelId = () => deps.resolveShopeeModelIdForStockPush(current) != null;

  if (!hasItemId() || !hasModelId()) {
    let listings = [];
    try {
      listings = await deps.readChannelListingsDb();
    } catch (err) {
      console.error("[Shopee Sync Queue] Không đọc được channel_listings:", err);
      if (!hasItemId()) return null;
    }

    const productId = String(product.id || "").trim();
    if (productId && listings.length > 0) {
      const match = listings.find((row) => {
        if (!row || typeof row !== "object") return false;
        const platform = String(row.platform || "shopee").trim().toLowerCase();
        if (platform && platform !== "shopee") return false;
        const linkedId =
          row.linkedProductId != null && String(row.linkedProductId).trim() !== ""
            ? String(row.linkedProductId).trim()
            : row.linkedProduct?.id != null
              ? String(row.linkedProduct.id).trim()
              : "";
        if (!linkedId || linkedId !== productId) return false;
        const status = String(row.status || "").trim().toLowerCase();
        return status === "success";
      });

      if (match) {
        const channelId = String(match.channelId || match.itemId || "").trim();
        if (channelId || match.itemId != null) {
          current = deps.applyShopeeLinkFieldsToProduct(current, channelId || String(match.itemId), {
            modelId: match.modelId ?? match.shopeeModelId ?? current.shopeeModelId,
            itemId: match.itemId ?? deps.getShopeeItemIdForStockPush(current),
          });
          // Giữ shop_id từ mapping nếu có — dùng khi multi-shop.
          const listingShop =
            match.shopId ?? match.shop_id ?? match.channelShopId ?? null;
          if (listingShop != null && String(listingShop).trim()) {
            current = { ...current, shopeeShopId: String(listingShop).trim() };
          }
        }
      }
    }
  }

  if (deps.getShopeeItemIdForStockPush(current) == null) return null;
  return current;
}

/**
 * Resolve shop_id + access_token cho ĐÚNG 1 shop (bắt buộc có shop_id).
 * Access token hết hạn → getValidShopeeAccessToken tự refresh.
 */
async function resolveShopAuthForStockSync(mapped, opts) {
  const itemId = deps.getShopeeItemIdForStockPush(mapped);
  const shopId = String(
    opts?.shopId || mapped?.shopeeShopId || mapped?.shopId || mapped?.shop_id || "",
  ).trim();

  console.log(
    `[Shopee Sync] Auth resolve: shop_id=${shopId || "(THIẾU)"} item_id=${itemId ?? "?"}`,
  );

  if (!shopId) {
    return {
      ok: false,
      message:
        "Thiếu shop_id — hệ thống đa shop bắt buộc truyền shop_id khi lấy token / đồng bộ.",
    };
  }

  try {
    console.log(
      `[Shopee Sync] getValidShopeeAccessToken shop_id=${shopId} (refresh nếu hết hạn)...`,
    );
    const accessToken = await deps.getValidShopeeAccessToken(shopId);
    if (!accessToken) {
      const msg = `Không lấy được access_token hợp lệ cho shop_id=${shopId} (token hết hạn và refresh thất bại). Vào mục Cài đặt → Ủy quyền lại Shop Shopee.`;
      console.error(`[Shopee Sync] ${msg}`);
      return { ok: false, message: msg };
    }
    console.log(`[Shopee Sync] access_token OK shop_id=${shopId}`);
    return { ok: true, shopId, accessToken };
  } catch (err) {
    const msg =
      err?.message ||
      `Lỗi lấy/refresh token Shopee shop_id=${shopId}. Vào mục Cài đặt → Ủy quyền lại Shop.`;
    console.error(`[Shopee Sync] Exception resolve auth:`, err);
    return { ok: false, message: msg };
  }
}

function isAuthFailResult(result) {
  if (!result || typeof result !== "object") return false;
  if (Number(result.httpStatus) === 401 || Number(result.httpStatus) === 403) return true;
  return deps.isShopeeInvalidTokenError(result.error, result.message);
}

export async function executeShopeeStockPriceSyncJob(product, opts) {
  try {
    const mapped = await resolveProductWithShopeeMapping(product);
    if (!mapped) {
      return { ok: false, message: "Chưa liên kết Mapping Shopee — bỏ qua sync." };
    }

    const auth = await resolveShopAuthForStockSync(mapped, opts || {});
    if (!auth.ok) {
      return { ok: false, message: auth.message };
    }

    let { shopId, accessToken } = auth;

    const itemId = deps.getShopeeItemIdForStockPush(mapped);
    let modelId = deps.resolveShopeeModelIdForStockPush(mapped);
    if (itemId == null) {
      return { ok: false, message: "Thiếu Shopee item_id sau khi resolve Mapping." };
    }

    // Fallback: lấy model_id từ get_model_list nếu thiếu (item has_model).
    let itemHasModel = deps.productRequiresShopeeModelId(mapped, 1);
    if (modelId == null) {
      try {
        const fromApi = await deps.resolveShopeeModelIdFromApi(shopId, accessToken, itemId, mapped);
        if (fromApi.hasModel) itemHasModel = true;
        if (fromApi.modelId != null) {
          modelId = fromApi.modelId;
          mapped.shopeeModelId = String(fromApi.modelId);
        }
      } catch (err) {
        console.error(
          `[Shopee Sync] resolveShopeeModelIdFromApi lỗi shop=${shopId} item=${itemId}:`,
          err?.message || err,
        );
      }
    }

    if (itemHasModel && modelId == null) {
      const msg =
        "Phân loại (variant) thiếu model_id — bắt buộc truyền item_id + model_id khi update_stock";
      await deps.appendShopeeSyncErrorToDb({
        itemId,
        modelId: undefined,
        sku: mapped.sku,
        shopId,
        action: "update_stock",
        error: msg,
        productId: mapped.id,
      });
      return { ok: false, message: msg };
    }

    let locationId = null;
    if (opts.syncStock) {
      try {
        locationId = await deps.resolveShopeeStockLocationId(shopId, accessToken);
      } catch (err) {
        console.warn(
          `[Shopee Sync] resolveShopeeStockLocationId shop=${shopId}:`,
          err?.message || err,
        );
      }
    }

    const lines = [];

    if (opts.syncStock) {
      const stockEntry = deps.buildShopeeUpdateStockEntry(mapped.stock, modelId, locationId);
      try {
        console.log(
          `[Shopee Sync] UpdateStock shop_id=${shopId} item_id=${itemId} model_id=${modelId ?? "n/a"} stock=${mapped.stock}`,
        );
        const stockResult = await deps.withShopeeAccessTokenRetry(
          shopId,
          async (token) => {
            accessToken = token || accessToken;
            return deps.shopeeUpdateStock(shopId, accessToken, itemId, [stockEntry]);
          },
          isAuthFailResult,
        );
        const parsed = deps.parseShopeeApiResult(stockResult, mapped, "update_stock");
        lines.push(parsed.message);
        if (!parsed.success) {
          console.error(`[Shopee Sync] UpdateStock FAIL:`, parsed.message);
          await deps.appendShopeeSyncErrorToDb({
            itemId,
            modelId: modelId ?? mapped.shopeeModelId,
            sku: mapped.sku,
            shopId,
            action: "update_stock",
            error: parsed.message,
            productId: mapped.id,
          });
          return { ok: false, message: parsed.message };
        }
        console.log(`[Shopee Sync] UpdateStock OK item_id=${itemId}`);
      } catch (err) {
        const msg = deps.extractShopeeStockPushErrorMessage(
          err,
          err instanceof Error ? err.message : String(err),
        );
        console.error(`[Shopee Sync] UpdateStock exception shop=${shopId} item=${itemId}:`, err);
        await deps.appendShopeeSyncErrorToDb({
          itemId,
          modelId: modelId ?? mapped.shopeeModelId,
          sku: mapped.sku,
          shopId,
          action: "update_stock",
          error: msg,
          productId: mapped.id,
        });
        return { ok: false, message: msg };
      }
    }

    if (opts.syncPrice) {
      await sleep(SHOPEE_SYNC_QUEUE_GAP_MS);
      const priceEntry = deps.buildShopeeUpdatePriceEntry(mapped.sellingPrice, modelId);
      try {
        console.log(
          `[Shopee Sync] UpdatePrice shop_id=${shopId} item_id=${itemId} model_id=${modelId ?? "n/a"} price=${mapped.sellingPrice} sku=${mapped.sku || ""}`,
        );
        const priceResult = await deps.withShopeeAccessTokenRetry(
          shopId,
          async (token) => {
            accessToken = token || accessToken;
            return deps.shopeeUpdatePrice(shopId, accessToken, itemId, [priceEntry]);
          },
          isAuthFailResult,
        );
        const parsed = deps.parseShopeeApiResult(priceResult, mapped, "update_price");
        lines.push(parsed.message);
        if (!parsed.success) {
          console.error(`[Shopee Sync] UpdatePrice FAIL:`, parsed.message);
          await deps.appendShopeeSyncErrorToDb({
            itemId,
            modelId: modelId ?? mapped.shopeeModelId,
            sku: mapped.sku,
            shopId,
            action: "update_price",
            error: parsed.message,
            productId: mapped.id,
          });
          return { ok: false, message: parsed.message };
        }
        console.log(`[Shopee Sync] UpdatePrice OK item_id=${itemId}`);
      } catch (err) {
        const msg = deps.extractShopeeStockPushErrorMessage(
          err,
          err instanceof Error ? err.message : String(err),
        );
        console.error(`[Shopee Sync] UpdatePrice exception shop=${shopId} item=${itemId}:`, err);
        await deps.appendShopeeSyncErrorToDb({
          itemId,
          modelId: modelId ?? mapped.shopeeModelId,
          sku: mapped.sku,
          shopId,
          action: "update_price",
          error: msg,
          productId: mapped.id,
        });
        return { ok: false, message: msg };
      }
    }

    // Cập nhật model_sku trên Shopee khi có model_id + SKU mới
    if (opts.syncSku && modelId != null && typeof deps.shopeeUpdateModelSku === "function") {
      await sleep(SHOPEE_SYNC_QUEUE_GAP_MS);
      const modelSku = String(mapped.sku || "").trim();
      try {
        console.log(
          `[Shopee Sync] UpdateModelSku shop_id=${shopId} item_id=${itemId} model_id=${modelId} sku=${modelSku}`,
        );
        const skuResult = await deps.withShopeeAccessTokenRetry(
          shopId,
          async (token) => {
            accessToken = token || accessToken;
            return deps.shopeeUpdateModelSku(shopId, accessToken, itemId, modelId, modelSku);
          },
          isAuthFailResult,
        );
        const parsed = deps.parseShopeeApiResult(skuResult, mapped, "update_model");
        lines.push(parsed.message || `update_model sku=${modelSku}`);
        if (!parsed.success) {
          console.error(`[Shopee Sync] UpdateModelSku FAIL:`, parsed.message);
          await deps.appendShopeeSyncErrorToDb({
            itemId,
            modelId: modelId ?? mapped.shopeeModelId,
            sku: mapped.sku,
            shopId,
            action: "update_model",
            error: parsed.message,
            productId: mapped.id,
          });
          return { ok: false, message: parsed.message };
        }
        console.log(`[Shopee Sync] UpdateModelSku OK item_id=${itemId} model_id=${modelId}`);
      } catch (err) {
        const msg = deps.extractShopeeStockPushErrorMessage(
          err,
          err instanceof Error ? err.message : String(err),
        );
        console.error(`[Shopee Sync] UpdateModelSku exception shop=${shopId} item=${itemId}:`, err);
        await deps.appendShopeeSyncErrorToDb({
          itemId,
          modelId: modelId ?? mapped.shopeeModelId,
          sku: mapped.sku,
          shopId,
          action: "update_model",
          error: msg,
          productId: mapped.id,
        });
        return { ok: false, message: msg };
      }
    }

    return { ok: true, message: lines.join(" | ") || "Sync Shopee OK" };
  } catch (err) {
    console.error("[Shopee Sync] executeShopeeStockPriceSyncJob exception:", err);
    return {
      ok: false,
      message: err instanceof Error ? err.message : String(err || "Lỗi đồng bộ Shopee không xác định"),
    };
  }
}

/** Đẩy stock/price lên Shopee ngay (không qua queue) — dùng cho PATCH sản phẩm / nút sync nhanh.
 * Đa shop: nếu không truyền shop_id → lần lượt đồng bộ lên TẤT CẢ shop đã ủy quyền.
 */
export async function pushProductStockPriceToShopeeImmediate(product, opts) {
  if (!opts.syncStock && !opts.syncPrice && !opts.syncSku) {
    return { ok: true, skipped: true, message: "Không có thay đổi tồn/giá/SKU cần đồng bộ Shopee." };
  }
  try {
    const mapped = await resolveProductWithShopeeMapping(product);
    if (!mapped) {
      return {
        ok: true,
        skipped: true,
        message: "Chưa liên kết Mapping Shopee — chỉ lưu kho nội bộ.",
      };
    }

    const requestedShop =
      opts.shopId || mapped.shopeeShopId || mapped.shopId || mapped.shop_id || "";
    const shopIds =
      typeof deps.resolveShopeeShopIdsForSync === "function"
        ? deps.resolveShopeeShopIdsForSync(requestedShop)
        : (() => {
            const one = deps.resolveShopeeTokenShopId(requestedShop);
            return one ? [one] : deps.listAuthorizedShopeeShopIds?.() || [];
          })();

    if (!shopIds.length) {
      const msg = deps.getShopeeUnauthorizedShopMessage();
      console.error(`[Shopee Sync] ${msg}`);
      return { ok: false, message: msg };
    }

    console.log(
      `[Shopee Sync] Manual sync product=${mapped.id || mapped.sku} item=${deps.getShopeeItemIdForStockPush(mapped) ?? "?"} model=${deps.resolveShopeeModelIdForStockPush(mapped) ?? "?"} sku=${mapped.sku || ""} shops=[${shopIds.join(", ")}] stock=${!!opts.syncStock} price=${!!opts.syncPrice} skuSync=${!!opts.syncSku}`,
    );

    const shopResults = [];
    for (const shopId of shopIds) {
      const result = await executeShopeeStockPriceSyncJob(mapped, {
        syncStock: opts.syncStock,
        syncPrice: opts.syncPrice,
        syncSku: !!opts.syncSku,
        shopId,
      });
      shopResults.push({ shopId, ...result });
      console.log(
        `[Shopee Sync] shop_id=${shopId} → ${result.ok ? "OK" : "FAIL"}: ${result.message || ""}`,
      );
    }

    const successes = shopResults.filter((r) => r.ok);
    if (successes.length > 0) {
      return {
        ok: true,
        message: successes.map((r) => `[${r.shopId}] ${r.message}`).join(" | "),
        shopResults,
      };
    }

    const failMsg = shopResults.map((r) => `[${r.shopId}] ${r.message}`).join(" | ");
    return {
      ok: false,
      message: failMsg || "Đồng bộ Shopee thất bại trên mọi shop.",
      shopResults,
    };
  } catch (err) {
    console.error("[Shopee Sync] pushProductStockPriceToShopeeImmediate exception:", err);
    return {
      ok: false,
      message: err instanceof Error ? err.message : String(err || "Lỗi đồng bộ Shopee"),
    };
  }
}

export async function processShopeeSyncQueue() {
  if (shopeeSyncQueueRunning) return;
  shopeeSyncQueueRunning = true;

  try {
    while (shopeeSyncQueue.length > 0) {
      const job = shopeeSyncQueue.shift();
      shopeeSyncQueueKeys.delete(job.key);

      try {
        const row = await deps.loadProductById(job.productId);
        if (!row) {
          console.warn(`[Shopee Sync Queue] Bỏ qua — không thấy productId=${job.productId}`);
          await sleep(SHOPEE_SYNC_QUEUE_GAP_MS);
          continue;
        }

        const mapped = await resolveProductWithShopeeMapping(row);
        if (!mapped) {
          console.log(
            `[Shopee Sync Queue] Skip SKU=${row.sku || job.productId} — chưa Mapping Shopee`,
          );
          await sleep(SHOPEE_SYNC_QUEUE_GAP_MS);
          continue;
        }

        const shopIds = job.shopId
          ? [String(job.shopId)]
          : typeof deps.resolveShopeeShopIdsForSync === "function"
            ? deps.resolveShopeeShopIdsForSync("")
            : deps.listAuthorizedShopeeShopIds?.() || [];

        if (!shopIds.length) {
          console.error(
            `[Shopee Sync Queue] Không có shop ủy quyền — productId=${job.productId}`,
          );
          continue;
        }

        let anyOk = false;
        let lastMessage = "";
        for (const shopId of shopIds) {
          const result = await executeShopeeStockPriceSyncJob(mapped, {
            syncStock: job.syncStock,
            syncPrice: job.syncPrice,
            shopId,
          });
          lastMessage = result.message || lastMessage;
          if (result.ok) {
            anyOk = true;
            console.log(
              `[Shopee Sync Queue] OK productId=${job.productId} shop=${shopId} sku=${mapped.sku} — ${result.message}`,
            );
          } else {
            console.error(
              `[Shopee Sync Queue] FAIL productId=${job.productId} shop=${shopId}: ${result.message}`,
            );
          }
        }

        if (anyOk) {
          /* success for at least one shop */
        } else {
          job.attempts += 1;
          console.error(
            `[Shopee Sync Queue] FAIL attempt ${job.attempts}/${SHOPEE_SYNC_QUEUE_MAX_RETRY} productId=${job.productId} sku=${mapped.sku}: ${lastMessage}`,
          );
          if (job.attempts < SHOPEE_SYNC_QUEUE_MAX_RETRY) {
            const retryKey = `${job.productId}|stock=${job.syncStock}|price=${job.syncPrice}|shop=${job.shopId || ""}`;
            job.key = retryKey;
            if (!shopeeSyncQueueKeys.has(retryKey)) {
              shopeeSyncQueueKeys.add(retryKey);
              shopeeSyncQueue.push(job);
            }
          } else {
            console.error(
              `[Shopee Sync Queue] DROPPED sau ${SHOPEE_SYNC_QUEUE_MAX_RETRY} lần — productId=${job.productId} sku=${mapped.sku}: ${lastMessage}`,
            );
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[Shopee Sync Queue] Exception job=${job.productId}:`, err);
        job.attempts += 1;
        if (job.attempts < SHOPEE_SYNC_QUEUE_MAX_RETRY) {
          if (!shopeeSyncQueueKeys.has(job.key)) {
            shopeeSyncQueueKeys.add(job.key);
            shopeeSyncQueue.push(job);
          }
        } else {
          console.error(`[Shopee Sync Queue] DROPPED exception — ${job.productId}: ${msg}`);
        }
      }

      await sleep(SHOPEE_SYNC_QUEUE_GAP_MS);
    }
  } finally {
    shopeeSyncQueueRunning = false;
    if (shopeeSyncQueue.length > 0) {
      const kick = setTimeout(() => {
        void processShopeeSyncQueue();
      }, SHOPEE_SYNC_QUEUE_GAP_MS);
      if (typeof kick.unref === "function") kick.unref();
    }
  }
}

/** Đưa sync stock/price vào hàng đợi (chỉ khi đã Mapping + có thay đổi thật). */
export async function enqueueShopeeStockPriceSync(products, opts) {
  const syncStock = opts.syncStock === true;
  const syncPrice = opts.syncPrice === true;
  if (!syncStock && !syncPrice) return 0;
  const preferredShopId = String(opts.shopId || "").trim() || undefined;

  let enqueued = 0;
  for (const raw of Array.isArray(products) ? products : []) {
    if (!raw || typeof raw !== "object") continue;
    const productId = String(raw.id || "").trim();
    if (!productId) continue;

    const mapped = await resolveProductWithShopeeMapping(raw);
    if (!mapped) continue;

    const key = `${productId}|stock=${syncStock}|price=${syncPrice}|shop=${preferredShopId || ""}`;
    if (shopeeSyncQueueKeys.has(key)) {
      continue;
    }

    shopeeSyncQueueKeys.add(key);
    shopeeSyncQueue.push({
      key,
      productId,
      syncStock,
      syncPrice,
      shopId: preferredShopId,
      attempts: 0,
      enqueuedAt: new Date().toISOString(),
    });
    enqueued += 1;
  }

  if (enqueued > 0) {
    console.log(
      `[Shopee Sync Queue] Enqueued ${enqueued} job(s) — queue size=${shopeeSyncQueue.length} (gap=${SHOPEE_SYNC_QUEUE_GAP_MS}ms)`,
    );
    void processShopeeSyncQueue();
  }
  return enqueued;
}

/** Sau khi lưu kho: so sánh trước/sau, enqueue sync nếu Mapping Shopee. */
export async function enqueueShopeeSyncAfterProductChange(beforeRows, afterRows) {
  let stockChanged = false;
  let priceChanged = false;
  const changedProducts = [];

  for (const after of afterRows) {
    if (!after?.id) continue;
    const before = beforeRows.find((b) => String(b?.id) === String(after.id));
    const changes = detectStockPriceChanges(before || {}, after);
    if (!changes.stock && !changes.price) continue;
    if (changes.stock) stockChanged = true;
    if (changes.price) priceChanged = true;
    changedProducts.push(after);
  }

  if (changedProducts.length === 0) return 0;
  return await enqueueShopeeStockPriceSync(changedProducts, {
    syncStock: stockChanged,
    syncPrice: priceChanged,
  });
}
