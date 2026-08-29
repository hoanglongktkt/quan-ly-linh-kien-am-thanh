/**
 * TikTok Shop Products — Custom App OpenAPI.
 */
import { tiktokApiRequest, tiktokApiDelay, TIKTOK_PAGE_LIMIT } from "./client.js";
import { resolveTiktokCustomAppCredentials } from "./auth.js";

const PRODUCT_DETAIL_PATH = "/product/202309/products";
const PRODUCT_SEARCH_PATH = "/product/202309/products/search";

/**
 * Chi tiết 1 sản phẩm theo product_id.
 * @param {string} productId
 * @param {{ shopId?: string }} [opts]
 */
export async function fetchTiktokProductDetail(productId, opts = {}) {
  const id = String(productId || "").trim();
  if (!id) {
    return {
      success: false,
      error: "missing_product_id",
      message: "Thiếu product_id TikTok.",
      data: null,
    };
  }

  // OpenAPI 202309: GET /product/202309/products/{product_id}
  return tiktokApiRequest("GET", `${PRODUCT_DETAIL_PATH}/${encodeURIComponent(id)}`, {
    shopId: opts.shopId,
  });
}

/**
 * Chi tiết nhiều sản phẩm — tuần tự + delay (chống rate-limit).
 * @param {string[]} productIds
 * @param {{ shopId?: string, limit?: number }} [opts]
 */
export async function fetchTiktokProductDetails(productIds, opts = {}) {
  const creds = resolveTiktokCustomAppCredentials(opts.shopId);
  if (!creds.valid) {
    return {
      success: false,
      error: "tiktok_credentials_missing",
      message: "Custom App chưa cấu hình đủ credentials.",
      products: [],
    };
  }

  const limit = Math.min(
    TIKTOK_PAGE_LIMIT,
    Math.max(1, Number(opts.limit) || TIKTOK_PAGE_LIMIT),
  );
  const ids = (Array.isArray(productIds) ? productIds : [])
    .map((id) => String(id || "").trim())
    .filter(Boolean)
    .slice(0, limit);

  const products = [];
  const errors = [];

  for (let i = 0; i < ids.length; i += 1) {
    const res = await fetchTiktokProductDetail(ids[i], { shopId: opts.shopId });
    if (res.success) {
      products.push(res.data);
    } else {
      errors.push({ product_id: ids[i], error: res.error, message: res.message });
    }
    if (i < ids.length - 1) await tiktokApiDelay();
  }

  return {
    success: errors.length === 0,
    shop_id: creds.shop_id,
    products,
    errors,
    count: products.length,
  };
}

/**
 * Tìm / liệt kê sản phẩm (1 trang) — khung sẵn cho sync catalog.
 * @param {{ shopId?: string, page_size?: number, page_token?: string, status?: string }} opts
 */
export async function fetchTiktokProductListPage(opts = {}) {
  const pageSize = Math.min(
    TIKTOK_PAGE_LIMIT,
    Math.max(1, Number(opts.page_size) || TIKTOK_PAGE_LIMIT),
  );
  const body = { page_size: pageSize };
  if (opts.page_token) body.page_token = String(opts.page_token);
  if (opts.status) body.status = String(opts.status);

  return tiktokApiRequest("POST", PRODUCT_SEARCH_PATH, {
    shopId: opts.shopId,
    body,
  });
}
