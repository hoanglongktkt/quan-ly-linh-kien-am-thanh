/**
 * Controllers: TikTok Shop Custom App — credentials + orders/products skeleton.
 */
import {
  upsertTiktokCustomAppCredentials,
  resolveTiktokCustomAppCredentials,
  listTiktokCredentialSummaries,
  queryParamOne,
} from "../services/tiktok/auth.js";
import { syncTiktokOrdersSkeleton, fetchTiktokOrderListPage, fetchTiktokOrderDetails } from "../services/tiktok/orders.js";
import { fetchTiktokProductDetail, fetchTiktokProductListPage } from "../services/tiktok/products.js";

/** POST /api/tiktok/custom-app/credentials — lưu App Key/Secret/Access Token thủ công. */
export async function saveCustomAppCredentials(req, res) {
  try {
    const body = req.body || {};
    const shopId = String(body.shop_id || body.shopId || "").trim();
    const result = upsertTiktokCustomAppCredentials(shopId, {
      app_key: body.app_key || body.appKey,
      app_secret: body.app_secret || body.appSecret,
      access_token: body.access_token || body.accessToken || body.apiKey,
      shop_cipher: body.shop_cipher || body.shopCipher,
      shop_name: body.shop_name || body.shopName,
    });
    return res.status(result.success ? 200 : 400).json(result);
  } catch (error) {
    console.error("[TikTok Custom App] save credentials:", error);
    return res.status(500).json({
      success: false,
      error: error?.message || "save_failed",
      message: "Không lưu được credentials Custom App.",
    });
  }
}

/** GET /api/tiktok/custom-app/status */
export async function getCustomAppStatus(req, res) {
  try {
    const shopId = queryParamOne(req.query.shop_id) || queryParamOne(req.query.shopId);
    const creds = resolveTiktokCustomAppCredentials(shopId);
    return res.json({
      success: true,
      mode: "custom_app",
      configured: creds.valid,
      shop_id: creds.shop_id || null,
      shop_name: creds.shop_name || null,
      source: creds.source,
      has_app_key: Boolean(creds.app_key),
      has_app_secret: Boolean(creds.app_secret),
      has_access_token: Boolean(creds.access_token),
      has_shop_cipher: Boolean(creds.shop_cipher),
      shops: listTiktokCredentialSummaries(),
      message: creds.valid
        ? "Custom App credentials sẵn sàng gọi OpenAPI."
        : "Chưa đủ App Key / App Secret / Access Token.",
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error?.message || "status_failed",
    });
  }
}

/**
 * POST /api/tiktok/orders/sync
 * ACK ngay — kéo đơn chạy nền (khung, chưa ghi DB).
 */
export async function syncOrders(req, res) {
  const shopId = String(req.body?.shop_id || req.body?.shopId || req.query?.shop_id || "").trim();
  const hours = Math.min(72, Math.max(1, Number(req.body?.hours) || 24));
  const now = Math.floor(Date.now() / 1000);
  const update_time_ge = now - hours * 3600;

  res.status(200).json({
    success: true,
    accepted: true,
    mode: "custom_app",
    shop_id: shopId || null,
    message: "Đã nhận yêu cầu đồng bộ đơn TikTok (Custom App). Đang chạy nền.",
  });

  setImmediate(async () => {
    try {
      const result = await syncTiktokOrdersSkeleton({
        shopId: shopId || undefined,
        update_time_ge,
        maxPages: 10,
      });
      console.log(
        "[TikTok Orders Sync BG]",
        JSON.stringify({
          success: result.success,
          shop_id: result.shop_id,
          list_count: result.list_count ?? result.count,
          detail_count: result.detail_count,
          message: result.message || result.error,
        }),
      );
    } catch (error) {
      console.error("[TikTok Orders Sync BG]", error?.stack || error);
    }
  });
}

/** GET /api/tiktok/orders/preview — 1 trang đơn (debug / kiểm tra token). */
export async function previewOrders(req, res) {
  try {
    const shopId = queryParamOne(req.query.shop_id);
    const page_size = Math.min(20, Math.max(1, Number(req.query.page_size) || 10));
    const result = await fetchTiktokOrderListPage({ shopId: shopId || undefined, page_size });
    return res.status(result.success ? 200 : 400).json({
      mode: "custom_app",
      shop_id: shopId || null,
      ...result,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error?.message || "preview_failed",
    });
  }
}

/** GET /api/tiktok/orders/:orderId — chi tiết 1 đơn. */
export async function getOrderDetail(req, res) {
  try {
    const orderId = String(req.params.orderId || "").trim();
    const shopId = queryParamOne(req.query.shop_id);
    const result = await fetchTiktokOrderDetails([orderId], { shopId: shopId || undefined });
    return res.status(result.success ? 200 : 400).json({
      mode: "custom_app",
      order_id: orderId,
      ...result,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error?.message || "order_detail_failed",
    });
  }
}

/** GET /api/tiktok/products/:productId */
export async function getProductDetail(req, res) {
  try {
    const productId = String(req.params.productId || "").trim();
    const shopId = queryParamOne(req.query.shop_id);
    const result = await fetchTiktokProductDetail(productId, { shopId: shopId || undefined });
    return res.status(result.success ? 200 : 400).json({
      mode: "custom_app",
      product_id: productId,
      ...result,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error?.message || "product_detail_failed",
    });
  }
}

/** GET /api/tiktok/products/preview — 1 trang sản phẩm. */
export async function previewProducts(req, res) {
  try {
    const shopId = queryParamOne(req.query.shop_id);
    const page_size = Math.min(20, Math.max(1, Number(req.query.page_size) || 10));
    const result = await fetchTiktokProductListPage({
      shopId: shopId || undefined,
      page_size,
    });
    return res.status(result.success ? 200 : 400).json({
      mode: "custom_app",
      shop_id: shopId || null,
      ...result,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error?.message || "products_preview_failed",
    });
  }
}
