/**
 * Controllers: WooCommerce Orders Sync
 * Fetch orders from WooCommerce REST API and persist to internal order store.
 */
import {
  updateWooOrderStatus,
} from "../services/wooCommerce.js";
import { createWooCommerceOrderSync, scheduleWooCommerceOrderSync } from "../services/wooCommerceOrderSync.js";
import { createWooCommerceSyncState } from "../services/wooCommerceSyncState.js";

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
  orderSync = createWooCommerceOrderSync({
    loadChannelSettings: () => deps.loadChannelSettings(),
    isMongoReady: () => deps.isMongoReady(),
    persistOrders: (orders) => deps.persistWooOrdersToStore(orders),
    state: createWooCommerceSyncState(),
  });
}

let orderSync;
let stopAutomaticSync;

export function startWooCommerceOrderSync() {
  if (!stopAutomaticSync) stopAutomaticSync = scheduleWooCommerceOrderSync({ run: (opts) => orderSync.run(opts) });
}

export function stopWooCommerceOrderSync() {
  stopAutomaticSync?.();
  stopAutomaticSync = undefined;
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
  try {
    const result = await orderSync.run({
      shopId: req.body?.shopId,
      lookback_days: req.body?.lookback_days ?? req.body?.days,
      per_page: req.body?.per_page,
      trigger: "manual",
    });
    const status = result.error === "woo_sync_busy" ? 409
      : result.error === "mongodb_not_ready" ? 503
      : result.shopsFailed > 0 ? 500 : 200;
    return res.status(status).json(result);
  } catch (err) {
    console.error("[WooCommerce Sync] Fatal error:", err?.message || err);
    return res.status(500).json({ success: false, error: "woo_sync_fatal", message: err?.message || "Đồng bộ WooCommerce thất bại." });
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

    // 2. Update local store FIRST — return 200 to frontend immediately
    if (deps.patchOrderInStore) {
      await deps.patchOrderInStore(orderId, { status: internalStatus });
    }

    // Respond to frontend IMMEDIATELY — do NOT await WooCommerce API
    res.status(200).json({
      success: true,
      message: `Đã cập nhật đơn WooCommerce #${wooOrderId} → ${internalStatus}`,
      internalStatus,
    });

    // 3. Fire-and-forget: sync to WooCommerce API in background
    updateWooOrderStatus(shopConfig, wooOrderId, mapInternalStatusToWoo(internalStatus))
      .then((wooResult) => {
        if (!wooResult.success) {
          console.error(`[WooCommerce BG Sync] Failed to sync #${wooOrderId}: ${wooResult.message}`);
        } else {
          console.log(`[WooCommerce BG Sync] Synced #${wooOrderId} → ${wooResult.wooStatus}`);
        }
      })
      .catch((err) => {
        console.error(`[WooCommerce BG Sync] Error syncing #${wooOrderId}:`, err?.message || err);
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

