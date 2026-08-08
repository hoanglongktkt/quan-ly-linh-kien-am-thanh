/**
 * WooCommerce REST API Service
 * Handles: fetch orders, publish product, update stock/price
 */
import crypto from "crypto";

/**
 * Build Basic Auth header for WooCommerce REST API v3.
 * Uses Consumer Key (ck_...) as username, Consumer Secret (cs_...) as password.
 */
export function buildWooAuthHeader(consumerKey, consumerSecret) {
  return "Basic " + Buffer.from(`${consumerKey}:${consumerSecret}`).toString("base64");
}

/**
 * Build WooCommerce REST API URL with query params.
 */
function buildWooUrl(baseUrl, endpoint, params = {}) {
  const base = String(baseUrl).replace(/\/$/, "");
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") qs.set(k, String(v));
  }
  const qsStr = qs.toString() ? `?${qs.toString()}` : "";
  return `${base}/wp-json/wc/v3/${endpoint}${qsStr}`;
}

/**
 * Generic WooCommerce REST API request.
 */
async function wooFetch(url, options = {}, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        ...(options.headers || {}),
      },
    });
    clearTimeout(timer);
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { json = { raw: text }; }
    return { ok: res.ok, status: res.status, data: json };
  } catch (e) {
    clearTimeout(timer);
    if (e?.name === "AbortError") {
      throw new Error(`WooCommerce API timeout (>${timeoutMs}ms)`);
    }
    throw e;
  }
}

// ─── ORDERS ─────────────────────────────────────────────────────────────────

/**
 * WooCommerce order status → internal order status mapping.
 */
function mapWooOrderStatus(wooStatus) {
  const s = String(wooStatus || "").toLowerCase();
  const map = {
    "pending": "pending_confirm",
    "on-hold": "pending_confirm",
    "processing": "pending_pack",
    "completed": "completed",
    "cancelled": "cancelled",
    "refunded": "return_pending",
    "failed": "failed",
    "any": "pending_confirm",
  };
  return map[s] || "pending_confirm";
}

/**
 * Map WooCommerce order line item → internal line item structure.
 */
function mapWooLineItem(item) {
  return {
    productId: String(item.product_id || ""),
    name: item.name || "",
    productTitle: item.name || "",
    modelName: item.name || "",
    quantity: Number(item.quantity || 0),
    price: Number(item.price || item.subtotal / (item.quantity || 1) || 0),
    total: Number(item.total || 0),
    sku: item.sku || "",
    productImage: item.image?.src || item.image_url || "",
  };
}

/**
 * Convert a WooCommerce order object → internal order structure.
 *
 * Mapping từ WooCommerce REST API v3 → Schema Database nội bộ.
 * Đảm bảo TẤT CẢ trường bắt buộc của OrderSchema (mongoStore.ts) đều có mặt.
 */
export function mapWooOrderToInternal(wooOrder, shopConfig) {
  // ── DEBUG: Log payload nhận về từ WooCommerce ─────────────────────────────
  console.log(`[WooCommerce Map] Raw order keys: ${Object.keys(wooOrder || {}).join(", ")}`);
  console.log(`[WooCommerce Map] wooOrder.id=${wooOrder?.id} wooOrder.number=${wooOrder?.number} wooOrder.status=${wooOrder?.status}`);

  // WooCommerce REST API v3 trả billing/shipping trực tiếp (không phải billing_address)
  const billing = wooOrder.billing || {};
  const shipping = wooOrder.shipping || {};

  // ── Nguồn gốc: BẮT BUỘC ───────────────────────────────────────────────────
  const source = "woocommerce";
  const channel = "woocommerce";

  // ── Mã đơn hàng ───────────────────────────────────────────────────────────
  // _id trong MongoDB phải là String. Dùng String() để cover cả trường hợp id=0
  const wooOrderIdRaw = wooOrder.id != null ? String(wooOrder.id) : "";
  const wooOrderId = wooOrderIdRaw.trim() || String(wooOrder.number || "").trim();
  const id = `woo-${wooOrderId}`;
  const orderSn = `WOO-${wooOrder.number || wooOrderId}`;

  // ── Trạng thái: map từ wooStatus sang internal status ───────────────────────
  const internalStatus = mapWooOrderStatus(wooOrder.status);
  const wooStatus = String(wooOrder.status || "").trim();
  console.log(`[WooCommerce Map] wooStatus="${wooStatus}" → internalStatus="${internalStatus}"`);

  // ── Thông tin khách hàng (BẮT BUỘC) ────────────────────────────────────────
  const customerName =
    [billing.first_name, billing.last_name].filter(Boolean).join(" ").trim() ||
    [shipping.first_name, shipping.last_name].filter(Boolean).join(" ").trim() ||
    "Khách WooCommerce";

  const customerPhone = String(billing.phone || shipping.phone || "").trim();
  const customerEmail = String(billing.email || "").trim();

  const shippingAddressStr = [
    shipping.address_1,
    shipping.address_2,
    shipping.city,
    shipping.state,
    shipping.postcode,
    shipping.country,
  ].filter(Boolean).join(", ");
  const billingAddressStr = [
    billing.address_1,
    billing.address_2,
    billing.city,
    billing.state,
    billing.postcode,
    billing.country,
  ].filter(Boolean).join(", ");
  const customerAddress = shippingAddressStr || billingAddressStr || "";

  // ── Danh sách sản phẩm (Line Items) ────────────────────────────────────────
  const rawLineItems = Array.isArray(wooOrder.line_items) ? wooOrder.line_items : [];
  console.log(`[WooCommerce Map] line_items count=${rawLineItems.length}`);
  const lineItems = rawLineItems.map((item, idx) => {
    const mapped = mapWooLineItem(item);
    console.log(`[WooCommerce Map]   item[${idx}]: productId=${mapped.productId} name="${mapped.name}" qty=${mapped.quantity} total=${mapped.total}`);
    return mapped;
  });

  // ── Tổng tiền ─────────────────────────────────────────────────────────────
  const totalAmount = Number(wooOrder.total || 0);
  const subtotal = Number(wooOrder.subtotal || wooOrder.total || 0);
  const shippingFee = Number(wooOrder.shipping_total || 0);
  const discount = Number(wooOrder.discount_total || 0);

  // ── Shop config ────────────────────────────────────────────────────────────
  const shopIdValue = String(shopConfig.shopId || shopConfig.consumerKey || "").trim();
  const shopNameValue = String(shopConfig.shopName || shopConfig.consumerKey || "WooCommerce").trim();

  // ── Ngày tháng ────────────────────────────────────────────────────────────
  const orderDate = wooOrder.date_created
    ? new Date(wooOrder.date_created).toISOString()
    : new Date().toISOString();
  const dateModified = wooOrder.date_modified
    ? new Date(wooOrder.date_modified).toISOString()
    : orderDate;

  const mappedOrder = {
    // ── Schema fields (MongoDB _id là required) ────────────────────────────
    _id: id,
    id,
    orderSn,
    order_sn: orderSn,
    source,
    channel,

    // ── Shop ─────────────────────────────────────────────────────────────────
    shopId: shopIdValue || null,
    shopName: shopNameValue,

    // ── WooCommerce IDs ───────────────────────────────────────────────────────
    wooOrderId,
    wooOrderNumber: String(wooOrder.number || wooOrderId),

    // ── Status: internal status + raw WooCommerce status ──────────────────────
    status: internalStatus,
    wooStatus,
    // Schema dùng order_status/woo_order_status làm alias — gán tường minh
    order_status: wooStatus,
    woo_order_status: wooStatus,
    // Tránh Shopee-specific field bị ghi đè nhầm
    shopee_order_status: null,

    // ── Khách hàng (BẮT BUỘC — UI dùng trực tiếp) ───────────────────────────
    customerName,
    customerPhone,
    customerEmail,
    customerAddress,

    // ── Địa chỉ đầy đủ ──────────────────────────────────────────────────────
    shippingAddress: shippingAddressStr,
    billingAddress: billingAddressStr,
    billing: {
      first_name: billing.first_name || "",
      last_name: billing.last_name || "",
      phone: billing.phone || "",
      email: billing.email || "",
      address_1: billing.address_1 || "",
      address_2: billing.address_2 || "",
      city: billing.city || "",
      state: billing.state || "",
      postcode: billing.postcode || "",
      country: billing.country || "",
    },
    shipping: {
      first_name: shipping.first_name || "",
      last_name: shipping.last_name || "",
      phone: shipping.phone || "",
      address_1: shipping.address_1 || "",
      address_2: shipping.address_2 || "",
      city: shipping.city || "",
      state: shipping.state || "",
      postcode: shipping.postcode || "",
      country: shipping.country || "",
    },

    // ── Sản phẩm ─────────────────────────────────────────────────────────────
    lineItems,
    items: lineItems,
    itemsCount: lineItems.reduce((s, i) => s + i.quantity, 0),

    // ── Tiền ──────────────────────────────────────────────────────────────────
    totalAmount,
    total: totalAmount,
    revenue: totalAmount,
    subtotal,
    shippingFee,
    discount,
    paymentMethod: wooOrder.payment_method_title || wooOrder.payment_method || "",
    paymentStatus: wooOrder.date_paid ? "paid" : "pending",

    // ── Ngày ──────────────────────────────────────────────────────────────────
    date: orderDate,
    orderDate,
    dateModified,
    createdAt: orderDate,
    updatedAt: dateModified,

    // ── Meta ──────────────────────────────────────────────────────────────────
    currency: wooOrder.currency || "VND",
    currencySymbol: wooOrder.currency_symbol || "₫",
    notes: wooOrder.customer_note || "",
    last_synced_at: new Date().toISOString(),
  };

  // ── DEBUG: Log kết quả mapping ─────────────────────────────────────────────
  console.log(`[WooCommerce Map] ✅ Mapped: id=${id} orderSn=${orderSn} channel=${channel} status=${internalStatus} customerName="${customerName}" totalAmount=${totalAmount} lineItems=${lineItems.length}`);
  console.log(`[WooCommerce Map]   customerPhone="${customerPhone}" customerAddress="${customerAddress}" billing.first_name="${billing.first_name}" billing.phone="${billing.phone}" billing.city="${billing.city}"`);

  return mappedOrder;
}

/**
 * Fetch orders from WooCommerce store.
 * @param {object} shopConfig - { wooUrl, shopId (consumerKey), apiSecret (consumerSecret), shopName }
 * @param {object} opts - { after (ISO date), before, perPage (default 100), page }
 * @returns {Promise<{orders: object[], totalPages: number, totalOrders: number}>}
 */
/**
 * Resolve credentials from shop config.
 * Settings stores: shopId = Consumer Key (ck_...), apiKey = Consumer Secret (cs_...),
 * apiSecret = optional secondary secret.
 */
export function resolveWooCredentials(shopConfig) {
  const wooUrl = String(shopConfig?.wooUrl || "").replace(/\/$/, "");
  const consumerKey = String(shopConfig?.shopId || shopConfig?.consumerKey || "").trim();
  const consumerSecret = String(
    shopConfig?.apiSecret || shopConfig?.apiKey || shopConfig?.consumerSecret || ""
  ).trim();
  return { wooUrl, consumerKey, consumerSecret };
}

export async function fetchWooCommerceOrders(shopConfig, opts = {}) {
  const { wooUrl, consumerKey, consumerSecret } = resolveWooCredentials(shopConfig);
  const shopName = shopConfig?.shopName || "";

  if (!wooUrl || !consumerKey) {
    throw new Error("Thiếu wooUrl hoặc Consumer Key (shopId) của WooCommerce");
  }
  if (!consumerSecret) {
    throw new Error("Thiếu Consumer Secret (apiKey/apiSecret) của WooCommerce");
  }

  const page = Math.max(1, Number(opts.page || 1));
  const perPage = Math.min(100, Math.max(1, Number(opts.perPage || 100)));

  const params = {
    per_page: perPage,
    page,
    orderby: "date",
    order: "desc",
  };
  if (opts.after) params.after = opts.after;
  if (opts.before) params.before = opts.before;
  if (opts.status) params.status = opts.status;

  const url = buildWooUrl(wooUrl, "orders", params);
  // Prefer Basic Auth; also append query keys as fallback for hosts that strip Authorization
  const authUrl = `${url}${url.includes("?") ? "&" : "?"}consumer_key=${encodeURIComponent(consumerKey)}&consumer_secret=${encodeURIComponent(consumerSecret)}`;
  const auth = buildWooAuthHeader(consumerKey, consumerSecret);

  const result = await wooFetch(authUrl, {
    method: "GET",
    headers: { Authorization: auth },
  });

  if (!result.ok) {
    const errMsg = result.data?.message || result.data?.code || `HTTP ${result.status}`;
    throw new Error(`WooCommerce Orders API lỗi: ${errMsg}`);
  }

  const orders = Array.isArray(result.data) ? result.data : [];
  // totalPages/total from response body when available; otherwise assume 1 page if < perPage
  const totalPages = orders.length < (opts.perPage || 100) ? 1 : Math.max(1, page + 1);
  const totalOrders = orders.length;

  return {
    orders: orders.map((o) => mapWooOrderToInternal(o, { ...shopConfig, shopName, shopId: consumerKey })),
    totalPages,
    totalOrders,
  };
}

// ─── PRODUCT PUBLISHING ─────────────────────────────────────────────────────

/**
 * Build image payload for WooCommerce product.
 */
function buildWooImages(images = []) {
  return images
    .filter((img) => img && (img.src || img.url))
    .map((img, idx) => ({
      src: img.src || img.url,
      position: idx,
      ...(img.name ? { name: img.name } : {}),
    }));
}

/**
 * Build categories payload for WooCommerce product.
 */
function buildWooCategories(categories = []) {
  return categories
    .filter((c) => c && (c.id || c.name))
    .map((c) => ({
      id: c.id ? Number(c.id) : undefined,
      name: c.name,
      ...(c.slug ? { slug: c.slug } : {}),
    }));
}

/**
 * Publish / create a product on WooCommerce.
 * Returns { success, wooProductId, wooUrl, message }
 */
export async function publishProductToWooCommerce(shopConfig, productData) {
  const { wooUrl, consumerKey, consumerSecret } = resolveWooCredentials(shopConfig);

  if (!wooUrl || !consumerKey) {
    return { success: false, message: "Thiếu wooUrl hoặc Consumer Key" };
  }
  if (!consumerSecret) {
    return { success: false, message: "Thiếu Consumer Secret" };
  }

  const {
    name = "Sản phẩm không tên",
    sku = "",
    description = "",
    shortDescription = "",
    regular_price = "",
    sale_price = "",
    stock_quantity = null,
    manage_stock = true,
    stock_status = "instock",
    categories = [],
    images = [],
    weight = "",
    dimensions = {},
    status = "publish",
    attributes = [],
    tags = [],
    virtual = false,
    downloadable = false,
  } = productData;

  const payload = {
    name,
    type: "simple",
    status,
    sku,
    description,
    short_description: shortDescription,
    regular_price: String(regular_price),
    ...(sale_price ? { sale_price: String(sale_price) } : {}),
    stock_quantity: stock_quantity != null ? Math.max(0, Math.round(Number(stock_quantity))) : undefined,
    manage_stock,
    stock_status: stock_quantity === 0 ? "outofstock" : (stock_status || "instock"),
    categories: buildWooCategories(categories),
    images: buildWooImages(images),
    ...(weight ? { weight: String(weight) } : {}),
    ...(dimensions?.length || dimensions?.width || dimensions?.height
      ? {
          dimensions: {
            length: dimensions.length || "",
            width: dimensions.width || "",
            height: dimensions.height || "",
          },
        }
      : {}),
    ...(attributes.length > 0
      ? {
          attributes: attributes.map((a) => ({
            id: a.id ? Number(a.id) : undefined,
            name: a.name,
            options: Array.isArray(a.options) ? a.options : [a.options].filter(Boolean),
            visible: a.visible !== false,
            variation: a.variation || false,
          })),
        }
      : {}),
    ...(tags.length > 0
      ? { tags: tags.map((t) => (typeof t === "string" ? { name: t } : t)) }
      : {}),
    virtual,
    downloadable,
  };

  const baseUrl = buildWooUrl(wooUrl, "products");
  const url = `${baseUrl}${baseUrl.includes("?") ? "&" : "?"}consumer_key=${encodeURIComponent(consumerKey)}&consumer_secret=${encodeURIComponent(consumerSecret)}`;
  const auth = buildWooAuthHeader(consumerKey, consumerSecret);

  const result = await wooFetch(url, {
    method: "POST",
    headers: { Authorization: auth },
    body: JSON.stringify(payload),
  });

  if (!result.ok) {
    const errMsg = result.data?.message || result.data?.code || `HTTP ${result.status}`;
    return { success: false, message: `WooCommerce từ chối tạo sản phẩm: ${errMsg}` };
  }

  const created = result.data;
  return {
    success: true,
    wooProductId: String(created.id || ""),
    wooProductUrl: created.permalink || `${wooUrl}/?p=${created.id}`,
    message: `Đăng bán WooCommerce thành công (ID: ${created.id})`,
  };
}

/**
 * Update stock & price of an existing WooCommerce product.
 * Returns { success, message }
 */
export async function updateWooProductStockPrice(shopConfig, wooProductId, updateData) {
  const { wooUrl, consumerKey, consumerSecret } = resolveWooCredentials(shopConfig);

  if (!wooUrl || !consumerKey) {
    return { success: false, message: "Thiếu wooUrl hoặc Consumer Key" };
  }
  if (!consumerSecret) {
    return { success: false, message: "Thiếu Consumer Secret" };
  }

  const payload = {};
  if (updateData.regular_price != null) {
    payload.regular_price = String(Math.max(0, Number(updateData.regular_price)));
  }
  if (updateData.sale_price != null) {
    payload.sale_price = String(Math.max(0, Number(updateData.sale_price)));
  }
  if (updateData.stock_quantity != null) {
    payload.stock_quantity = Math.max(0, Math.round(Number(updateData.stock_quantity)));
    payload.manage_stock = true;
    payload.stock_status = payload.stock_quantity === 0 ? "outofstock" : "instock";
  }
  if (updateData.status != null) {
    payload.status = updateData.status;
  }

  const baseUrl = buildWooUrl(wooUrl, `products/${wooProductId}`);
  const url = `${baseUrl}${baseUrl.includes("?") ? "&" : "?"}consumer_key=${encodeURIComponent(consumerKey)}&consumer_secret=${encodeURIComponent(consumerSecret)}`;
  const auth = buildWooAuthHeader(consumerKey, consumerSecret);

  const result = await wooFetch(url, {
    method: "PUT",
    headers: { Authorization: auth },
    body: JSON.stringify(payload),
  });

  if (!result.ok) {
    const errMsg = result.data?.message || result.data?.code || `HTTP ${result.status}`;
    return { success: false, message: `WooCommerce cập nhật thất bại: ${errMsg}` };
  }

  return { success: true, message: `Cập nhật WooCommerce ID ${wooProductId} thành công` };
}

/**
 * Update WooCommerce order status via REST API.
 * @param {object} shopConfig - { wooUrl, shopId/consumerKey, apiSecret/apiKey }
 * @param {string|number} wooOrderId - WooCommerce order ID
 * @param {string} status - Woo status: completed | on-hold | cancelled | processing | pending
 * @returns {Promise<{success: boolean, message: string, wooStatus?: string}>}
 */
export async function updateWooOrderStatus(shopConfig, wooOrderId, status) {
  const { wooUrl, consumerKey, consumerSecret } = resolveWooCredentials(shopConfig);
  const orderId = String(wooOrderId || "").trim();
  const nextStatus = String(status || "").trim().toLowerCase();

  if (!wooUrl || !consumerKey) {
    return { success: false, message: "Thiếu wooUrl hoặc Consumer Key" };
  }
  if (!consumerSecret) {
    return { success: false, message: "Thiếu Consumer Secret" };
  }
  if (!orderId) {
    return { success: false, message: "Thiếu WooCommerce order ID" };
  }
  if (!nextStatus) {
    return { success: false, message: "Thiếu trạng thái WooCommerce" };
  }

  const baseUrl = buildWooUrl(wooUrl, `orders/${orderId}`);
  const url = `${baseUrl}${baseUrl.includes("?") ? "&" : "?"}consumer_key=${encodeURIComponent(consumerKey)}&consumer_secret=${encodeURIComponent(consumerSecret)}`;
  const auth = buildWooAuthHeader(consumerKey, consumerSecret);

  const result = await wooFetch(url, {
    method: "PUT",
    headers: { Authorization: auth },
    body: JSON.stringify({ status: nextStatus }),
  });

  if (!result.ok) {
    const errMsg = result.data?.message || result.data?.code || `HTTP ${result.status}`;
    return { success: false, message: `Cập nhật trạng thái WooCommerce thất bại: ${errMsg}` };
  }

  return {
    success: true,
    wooStatus: result.data?.status || nextStatus,
    message: `Đã cập nhật đơn Woo #${orderId} → ${result.data?.status || nextStatus}`,
  };
}

/**
 * Test WooCommerce connection.
 * Returns { success, storeName, version }
 */
export async function testWooCommerceConnection(shopConfig) {
  const { wooUrl, consumerKey, consumerSecret } = resolveWooCredentials(shopConfig);

  if (!wooUrl || !consumerKey) {
    return { success: false, message: "Thiếu wooUrl hoặc Consumer Key" };
  }
  if (!consumerSecret) {
    return { success: false, message: "Thiếu Consumer Secret" };
  }

  const baseUrl = buildWooUrl(wooUrl, "system_status");
  const url = `${baseUrl}${baseUrl.includes("?") ? "&" : "?"}consumer_key=${encodeURIComponent(consumerKey)}&consumer_secret=${encodeURIComponent(consumerSecret)}`;
  const auth = buildWooAuthHeader(consumerKey, consumerSecret);

  const result = await wooFetch(url, {
    method: "GET",
    headers: { Authorization: auth },
  });

  if (!result.ok) {
    const errMsg = result.data?.message || result.data?.code || `HTTP ${result.status}`;
    return { success: false, message: `Kết nối thất bại: ${errMsg}` };
  }

  const data = result.data?.environment || {};
  return {
    success: true,
    storeName: data.site_title || data.name || shopConfig.shopName || "",
    version: data.version || "",
    message: `Kết nối thành công (WooCommerce ${data.version || "?"})`,
  };
}
