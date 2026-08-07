/**
 * Controllers: WooCommerce Orders Sync
 * Fetch orders from WooCommerce REST API and persist to internal order store.
 */
import {
  fetchWooCommerceOrders,
  resolveWooCredentials,
  updateWooOrderStatus,
  mapWooOrderToInternal,
} from "../services/wooCommerce.js";

let deps = {
  loadChannelSettings: () => ({ shops: [] }),
  persistWooOrdersToStore: async (orders) => {
    throw new Error("persistWooOrdersToStore not initialized — set deps in initWooCommerceOrdersController");
  },
  isMongoReady: () => false,
  findOrderByKey: async () => null,
  patchOrderInStore: async () => null,
};

export function initWooCommerceOrdersController(partial) {
  deps = { ...deps, ...partial };
}

/**
 * Map internal order status → WooCommerce API status string.
 */
function mapInternalStatusToWoo(internalStatus) {
  const map = {
    completed: "completed",
    "on-hold": "on-hold",
    cancelled: "cancelled",
    pending_confirm: "pending",
    pending_pack: "processing",
    processing: "processing",
    unprocessed: "processing",
    processed: "processing",
    return_pending: "refunded",
    return_received: "refunded",
  };
  return map[internalStatus] || "on-hold";
}

/**
 * Map WooCommerce shop config from channel_settings to wooCommerce service format.
 * Settings stores: shopId = Consumer Key (ck_...), apiKey = Consumer Secret (cs_...),
 * apiSecret = optional extra secret.
 */
function resolveWooShopConfig(shop) {
  return {
    wooUrl: shop.wooUrl || "",
    shopId: shop.shopId || "",
    apiKey: shop.apiKey || "",
    apiSecret: shop.apiSecret || "",
    shopName: shop.shopName || "",
    connected: shop.connected !== false,
  };
}

/**
 * POST /api/woocommerce/orders/sync
 * Sync orders from one or all WooCommerce shops.
 * Body: { shopId? (specific shop), lookback_days? (default 7), page? }
 */
export async function syncWooCommerceOrders(req, res) {
  const t0 = Date.now();
  try {
    const targetShopId = req.body?.shopId
      ? String(req.body.shopId).trim()
      : null;
    const lookbackDays = Math.max(1, Math.min(30, Number(req.body?.lookback_days || req.body?.days || 7)));
    const perPage = Math.min(100, Math.max(10, Number(req.body?.per_page || 50)));

    const settings = deps.loadChannelSettings();
    const shops = (settings?.shops || []).filter(
      (s) => s.platform === "woocommerce" && s.connected !== false
    );

    const filtered = targetShopId
      ? shops.filter((s) => String(s.shopId || s.id || "") === targetShopId)
      : shops;

    if (filtered.length === 0) {
      return res.status(200).json({
        success: false,
        error: "no_woo_shops",
        message: targetShopId
          ? `Không tìm thấy shop WooCommerce với shopId="${targetShopId}"`
          : "Chưa có shop WooCommerce nào được kết nối và bật đồng bộ.",
      });
    }

    const afterDate = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000).toISOString();
    const allResults = [];
    const allErrors = [];
    let totalOrdersImported = 0;

    for (const shop of filtered) {
      const shopConfig = resolveWooShopConfig(shop);
      const shopLabel = `${shop.shopName || shopConfig.wooUrl} [${shop.shopId}]`;

      try {
        let page = 1;
        let hasMore = true;
        let shopImported = 0;
        let shopPageErrors = 0;

        while (hasMore) {
          const result = await fetchWooCommerceOrders(shopConfig, {
            after: afterDate,
            perPage,
            page,
          });

          const orders = result.orders || [];
          if (orders.length === 0) {
            hasMore = false;
            break;
          }

          try {
            const saved = await deps.persistWooOrdersToStore(orders);
            shopImported += saved;
            totalOrdersImported += saved;
          } catch (persistErr) {
            console.error(`[WooCommerce Sync] persist error shop=${shopLabel}:`, persistErr?.message || persistErr);
            shopPageErrors++;
            allErrors.push({
              shopId: shop.shopId,
              shopName: shop.shopName,
              error: persistErr?.message || "Lỗi lưu đơn vào database",
              page,
            });
          }

          hasMore = page < result.totalPages && page < 10;
          page++;
        }

        allResults.push({
          shopId: shop.shopId,
          shopName: shop.shopName,
          wooUrl: shopConfig.wooUrl,
          imported: shopImported,
          errors: shopPageErrors,
          success: true,
        });

        console.log(`[WooCommerce Sync] shop=${shopLabel} imported=${shopImported} errors=${shopPageErrors}`);
      } catch (err) {
        const errMsg = err?.message || String(err);
        console.error(`[WooCommerce Sync] shop=${shopLabel} ERROR: ${errMsg}`);
        allErrors.push({
          shopId: shop.shopId,
          shopName: shop.shopName,
          error: errMsg,
        });
        allResults.push({
          shopId: shop.shopId,
          shopName: shop.shopName,
          imported: 0,
          errors: 1,
          success: false,
          error: errMsg,
        });
      }
    }

    const ms = Date.now() - t0;
    const successShops = allResults.filter((r) => r.success).length;
    const failedShops = allResults.filter((r) => !r.success).length;

    return res.status(failedShops === filtered.length ? 500 : 200).json({
      success: failedShops === 0,
      message:
        failedShops === 0
          ? `Đồng bộ WooCommerce hoàn tất — ${totalOrdersImported} đơn từ ${successShops} shop`
          : `${successShops}/${filtered.length} shop đồng bộ thành công`,
      totalOrdersImported,
      shops: allResults,
      errors: allErrors,
      durationMs: ms,
      shopsSynced: successShops,
      shopsFailed: failedShops,
    });
  } catch (err) {
    const ms = Date.now() - t0;
    console.error("[WooCommerce Sync] Fatal error:", err?.message || err);
    return res.status(500).json({
      success: false,
      error: "woo_sync_fatal",
      message: err?.message || "Lỗi không xác định",
      durationMs: ms,
    });
  }
}

/**
 * GET /api/woocommerce/orders/test-connection
 * Test connection to a specific WooCommerce shop.
 * Query: ?shopId=
 */
export async function testWooCommerceConnectionHandler(req, res) {
  try {
    const { testWooCommerceConnection: testConn } = await import("../services/wooCommerce.js");
    const targetShopId = req.query?.shopId
      ? String(req.query.shopId).trim()
      : null;

    const settings = deps.loadChannelSettings();
    const shops = (settings?.shops || []).filter(
      (s) => s.platform === "woocommerce"
    );

    const shop = targetShopId
      ? shops.find((s) => String(s.shopId || s.id || "") === targetShopId)
      : shops[0];

    if (!shop) {
      return res.status(404).json({
        success: false,
        error: "shop_not_found",
        message: targetShopId
          ? `Không tìm thấy shop WooCommerce với shopId="${targetShopId}"`
          : "Không có shop WooCommerce nào được cấu hình",
      });
    }

    const shopConfig = resolveWooShopConfig(shop);
    const result = await testConn(shopConfig);

    return res.status(result.success ? 200 : 400).json(result);
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: err?.message || "Lỗi kiểm tra kết nối",
    });
  }
}

/**
 * POST /api/woocommerce/orders/update-status
 * Update WooCommerce order status in both local store and WooCommerce API.
 * Body: { orderId (internal id/wooOrderId/wooId), internalStatus (completed | on-hold | cancelled), shopId? }
 */
export async function updateWooCommerceOrderStatus(req, res) {
  try {
    const { orderId, internalStatus, shopId } = req.body || {};

    if (!orderId) {
      return res.status(400).json({ success: false, error: "missing_order_id", message: "Thiếu orderId" });
    }
    if (!internalStatus) {
      return res.status(400).json({ success: false, error: "missing_status", message: "Thiếu trạng thái" });
    }

    // 1. Load channel settings to find the WooCommerce shop config
    const settings = deps.loadChannelSettings();
    const shops = (settings?.shops || []).filter(
      (s) => s.platform === "woocommerce" && s.connected !== false
    );

    // Find shop by shopId param or from order's stored shopId
    let targetShop = null;
    if (shopId) {
      targetShop = shops.find((s) => String(s.shopId || s.id || "") === String(shopId).trim());
    }
    // If no shopId param, try to find from the order in store
    if (!targetShop && orderId) {
      const order = await deps.findOrderByKey(orderId);
      if (order && order.shopId) {
        targetShop = shops.find((s) => String(s.shopId || s.id || "") === String(order.shopId).trim());
      }
      // Fallback: use first connected WooCommerce shop
      if (!targetShop) targetShop = shops[0];
    }

    if (!targetShop) {
      return res.status(404).json({
        success: false,
        error: "no_shop",
        message: "Không tìm thấy shop WooCommerce để cập nhật",
      });
    }

    const shopConfig = resolveWooShopConfig(targetShop);
    const wooOrderId = String(orderId).replace(/^woo-/i, "").replace(/^WOO-/i, "").trim();

    // 2. Update WooCommerce API first (so it's the source of truth)
    const wooResult = await updateWooOrderStatus(shopConfig, wooOrderId, mapInternalStatusToWoo(internalStatus));
    if (!wooResult.success) {
      return res.status(400).json({
        success: false,
        error: "woo_api_error",
        message: `Lỗi cập nhật WooCommerce: ${wooResult.message}`,
      });
    }

    // 3. Update local store (MongoDB + orders.json)
    if (deps.patchOrderInStore) {
      await deps.patchOrderInStore(orderId, { status: internalStatus, wooStatus: wooResult.wooStatus });
    }

    return res.status(200).json({
      success: true,
      message: `Đã cập nhật đơn WooCommerce #${wooOrderId} → ${internalStatus}`,
      wooStatus: wooResult.wooStatus,
      internalStatus,
    });
  } catch (err) {
    console.error("[WooCommerce UpdateStatus] Error:", err?.message || err);
    return res.status(500).json({
      success: false,
      error: "fatal",
      message: err?.message || "Lỗi không xác định",
    });
  }
}

