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

const PRODUCT_PRICES_UPDATE_PATH = (productId) =>
  `${PRODUCT_DETAIL_PATH}/${encodeURIComponent(String(productId))}/prices/update`;
const PRODUCT_INVENTORY_UPDATE_PATH = (productId) =>
  `${PRODUCT_DETAIL_PATH}/${encodeURIComponent(String(productId))}/inventory/update`;

/**
 * Tìm SKU TikTok khớp với SKU kho nội bộ.
 * @param {object} productData — response.data từ fetchTiktokProductDetail
 * @param {string} localSku
 */
export function resolveTiktokSkuFromDetail(productData, localSku) {
  const skus = productData?.skus || productData?.sku_list || [];
  if (!Array.isArray(skus) || skus.length === 0) return null;

  const local = String(localSku || "").trim().toLowerCase();
  if (local) {
    const matched = skus.find((s) => {
      const sellerSku = String(s.seller_sku || s.sellerSku || s.external_sku_id || "").trim().toLowerCase();
      return sellerSku && sellerSku === local;
    });
    if (matched) return matched;
  }

  if (skus.length === 1) return skus[0];
  return skus.find((s) => s.id) || skus[0];
}

function getTiktokSkuCurrency(sku) {
  const price = sku?.price || sku?.original_price || {};
  const currency = String(price.currency || price.currency_type || "VND").trim();
  return currency || "VND";
}

function getTiktokWarehouseId(sku) {
  const inv = sku?.inventory;
  if (Array.isArray(inv) && inv.length > 0 && inv[0]?.warehouse_id) {
    return String(inv[0].warehouse_id);
  }
  return null;
}

/**
 * Cập nhật tồn kho SKU TikTok Shop.
 * POST /product/202309/products/{product_id}/inventory/update
 */
export async function updateTiktokProductInventory(productId, skuId, quantity, opts = {}) {
  const pid = String(productId || "").trim();
  const sid = String(skuId || "").trim();
  if (!pid || !sid) {
    return { success: false, message: "Thiếu product_id hoặc sku_id TikTok." };
  }

  const qty = Math.max(0, Math.round(Number(quantity) || 0));
  const inventoryEntry = { quantity: qty };
  if (opts.warehouseId) {
    inventoryEntry.warehouse_id = String(opts.warehouseId);
  }

  const res = await tiktokApiRequest("POST", PRODUCT_INVENTORY_UPDATE_PATH(pid), {
    shopId: opts.shopId,
    body: {
      skus: [{ id: sid, inventory: [inventoryEntry] }],
    },
  });

  if (!res.success) {
    return { success: false, message: res.message || "TikTok inventory/update thất bại" };
  }
  return { success: true, message: `Cập nhật tồn kho TikTok thành công (qty=${qty})`, data: res.data };
}

/**
 * Cập nhật giá SKU TikTok Shop.
 * POST /product/202309/products/{product_id}/prices/update
 */
export async function updateTiktokProductPrices(productId, skuId, priceAmount, currency, opts = {}) {
  const pid = String(productId || "").trim();
  const sid = String(skuId || "").trim();
  if (!pid || !sid) {
    return { success: false, message: "Thiếu product_id hoặc sku_id TikTok." };
  }

  const amount = String(Math.max(0, Math.round(Number(priceAmount) || 0)));
  const curr = String(currency || "VND").trim() || "VND";

  const res = await tiktokApiRequest("POST", PRODUCT_PRICES_UPDATE_PATH(pid), {
    shopId: opts.shopId,
    body: {
      skus: [
        {
          id: sid,
          price: { amount, currency: curr },
        },
      ],
    },
  });

  if (!res.success) {
    return { success: false, message: res.message || "TikTok prices/update thất bại" };
  }
  return { success: true, message: `Cập nhật giá TikTok thành công (${amount} ${curr})`, data: res.data };
}

/**
 * Đồng bộ kho + giá 1 SKU lên TikTok Shop (dùng cho bulk-channel-sync).
 * @param {object} localProduct — sản phẩm kho nội bộ (có tiktokId, sku, stock, sellingPrice)
 * @param {{ shopId?: string }} [opts]
 * @returns {Promise<Array<{productId:string,sku:string,channel:string,action:string,success:boolean,message:string}>>}
 */
export async function syncTiktokProductStockPrice(localProduct, opts = {}) {
  const base = {
    productId: String(localProduct?.id || ""),
    sku: String(localProduct?.sku || ""),
    channel: "tiktok",
  };

  const tiktokProductId = String(localProduct?.tiktokId || "").trim();
  if (!tiktokProductId) {
    const msg = "Thiếu ID liên kết TikTok - Bỏ qua";
    return [
      { ...base, action: "update_stock", success: false, message: msg },
      { ...base, action: "update_price", success: false, message: msg },
    ];
  }

  const shopId = String(opts.shopId || "").trim() || undefined;
  const creds = resolveTiktokCustomAppCredentials(shopId);
  if (!creds.valid) {
    const msg = "Chưa cấu hình TikTok Shop (App Key/Secret/Access Token)";
    return [
      { ...base, action: "auth", success: false, message: msg },
    ];
  }

  const detailRes = await fetchTiktokProductDetail(tiktokProductId, { shopId: creds.shop_id });
  if (!detailRes.success) {
    const msg = detailRes.message || "Không lấy được chi tiết sản phẩm TikTok";
    return [
      { ...base, action: "update_stock", success: false, message: msg },
      { ...base, action: "update_price", success: false, message: msg },
    ];
  }

  const productData = detailRes.data || {};
  const matchedSku = resolveTiktokSkuFromDetail(productData, localProduct.sku);
  if (!matchedSku?.id) {
    const msg = `Không tìm thấy SKU TikTok khớp "${localProduct.sku || ""}" trên sản phẩm ${tiktokProductId}`;
    return [
      { ...base, action: "update_stock", success: false, message: msg },
      { ...base, action: "update_price", success: false, message: msg },
    ];
  }

  const skuId = String(matchedSku.id);
  const warehouseId = getTiktokWarehouseId(matchedSku);
  const currency = getTiktokSkuCurrency(matchedSku);
  const stock = Math.max(0, Math.round(Number(localProduct.stock) || 0));
  const price = Math.max(0, Math.round(Number(localProduct.sellingPrice) || 0));

  const stockRes = await updateTiktokProductInventory(tiktokProductId, skuId, stock, {
    shopId: creds.shop_id,
    warehouseId,
  });

  if (!stockRes.success) {
    return [
      { ...base, action: "update_stock", success: false, message: stockRes.message },
      { ...base, action: "update_price", success: false, message: "Bỏ qua cập nhật giá do lỗi tồn kho" },
    ];
  }

  await tiktokApiDelay(300);

  const priceRes = await updateTiktokProductPrices(tiktokProductId, skuId, price, currency, {
    shopId: creds.shop_id,
  });

  return [
    { ...base, action: "update_stock", success: true, message: stockRes.message },
    {
      ...base,
      action: "update_price",
      success: priceRes.success,
      message: priceRes.success ? priceRes.message : priceRes.message,
    },
  ];
}
