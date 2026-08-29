/**
 * TikTok Shop Orders — Custom App OpenAPI.
 * Khung lấy danh sách + chi tiết đơn; có giới hạn trang / delay chống treo.
 */
import {
  tiktokApiRequest,
  tiktokApiDelay,
  TIKTOK_PAGE_LIMIT,
  TIKTOK_MAX_PAGES,
} from "./client.js";
import { resolveTiktokCustomAppCredentials } from "./auth.js";

const ORDER_SEARCH_PATH = "/order/202309/orders/search";
const ORDER_DETAIL_PATH = "/order/202309/orders/detail";

/**
 * Lấy 1 trang danh sách đơn hàng.
 * @param {{ shopId?: string, page_size?: number, page_token?: string, order_status?: string, create_time_ge?: number, create_time_lt?: number, update_time_ge?: number, update_time_lt?: number }} opts
 */
export async function fetchTiktokOrderListPage(opts = {}) {
  const pageSize = Math.min(
    TIKTOK_PAGE_LIMIT,
    Math.max(1, Number(opts.page_size) || TIKTOK_PAGE_LIMIT),
  );
  const body = {
    page_size: pageSize,
  };
  if (opts.page_token) body.page_token = String(opts.page_token);
  if (opts.order_status) body.order_status = String(opts.order_status);
  if (opts.create_time_ge != null) body.create_time_ge = Number(opts.create_time_ge);
  if (opts.create_time_lt != null) body.create_time_lt = Number(opts.create_time_lt);
  if (opts.update_time_ge != null) body.update_time_ge = Number(opts.update_time_ge);
  if (opts.update_time_lt != null) body.update_time_lt = Number(opts.update_time_lt);

  return tiktokApiRequest("POST", ORDER_SEARCH_PATH, {
    shopId: opts.shopId,
    body,
  });
}

/**
 * Chi tiết đơn theo danh sách order_id (tối đa ~50/lần theo OpenAPI).
 * @param {string[]} orderIds
 * @param {{ shopId?: string }} [opts]
 */
export async function fetchTiktokOrderDetails(orderIds, opts = {}) {
  const ids = (Array.isArray(orderIds) ? orderIds : [])
    .map((id) => String(id || "").trim())
    .filter(Boolean)
    .slice(0, TIKTOK_PAGE_LIMIT);

  if (!ids.length) {
    return {
      success: false,
      error: "missing_order_ids",
      message: "Thiếu order_id để lấy chi tiết đơn TikTok.",
      data: null,
    };
  }

  return tiktokApiRequest("POST", ORDER_DETAIL_PATH, {
    shopId: opts.shopId,
    body: { ids },
  });
}

/**
 * Kéo danh sách đơn có phân trang — BẮT BUỘC có max pages + delay.
 * @param {{ shopId?: string, maxPages?: number, page_size?: number, order_status?: string, create_time_ge?: number, create_time_lt?: number, update_time_ge?: number, update_time_lt?: number, onPage?: Function }} opts
 */
export async function fetchTiktokOrdersPaginated(opts = {}) {
  const creds = resolveTiktokCustomAppCredentials(opts.shopId);
  if (!creds.valid) {
    return {
      success: false,
      error: "tiktok_credentials_missing",
      message: "Custom App chưa cấu hình đủ App Key / Secret / Access Token.",
      orders: [],
      pages: 0,
    };
  }

  const maxPages = Math.min(
    TIKTOK_MAX_PAGES,
    Math.max(1, Number(opts.maxPages) || TIKTOK_MAX_PAGES),
  );
  const orders = [];
  let pageToken = "";
  let pages = 0;

  for (let i = 0; i < maxPages; i += 1) {
    const page = await fetchTiktokOrderListPage({
      shopId: opts.shopId,
      page_size: opts.page_size,
      page_token: pageToken || undefined,
      order_status: opts.order_status,
      create_time_ge: opts.create_time_ge,
      create_time_lt: opts.create_time_lt,
      update_time_ge: opts.update_time_ge,
      update_time_lt: opts.update_time_lt,
    });

    pages += 1;
    if (!page.success) {
      return {
        success: false,
        error: page.error,
        message: page.message,
        orders,
        pages,
        last_page: page,
      };
    }

    const list =
      page.data?.orders ||
      page.data?.order_list ||
      page.data?.list ||
      (Array.isArray(page.data) ? page.data : []);
    if (Array.isArray(list) && list.length) {
      orders.push(...list);
    }

    if (typeof opts.onPage === "function") {
      try {
        await opts.onPage({ pageIndex: i, list, raw: page });
      } catch {
        /* ignore page hook errors */
      }
    }

    const next =
      page.data?.next_page_token ||
      page.data?.page_token ||
      page.data?.next_page ||
      "";
    if (!next || !list?.length) break;
    pageToken = String(next);
    await tiktokApiDelay();
  }

  return {
    success: true,
    shop_id: creds.shop_id,
    orders,
    count: orders.length,
    pages,
    truncated: pages >= maxPages,
  };
}

/**
 * Đồng bộ khung: list → detail (chưa ghi DB — TODO map vào order store).
 */
export async function syncTiktokOrdersSkeleton(opts = {}) {
  const listResult = await fetchTiktokOrdersPaginated(opts);
  if (!listResult.success) return listResult;

  const orderIds = listResult.orders
    .map((o) => o?.id || o?.order_id || o?.orderId)
    .filter(Boolean)
    .map(String);

  const details = [];
  for (let i = 0; i < orderIds.length; i += TIKTOK_PAGE_LIMIT) {
    const chunk = orderIds.slice(i, i + TIKTOK_PAGE_LIMIT);
    const detailRes = await fetchTiktokOrderDetails(chunk, { shopId: opts.shopId });
    if (detailRes.success) {
      const rows =
        detailRes.data?.orders ||
        detailRes.data?.order_list ||
        (Array.isArray(detailRes.data) ? detailRes.data : []);
      if (Array.isArray(rows)) details.push(...rows);
    }
    if (i + TIKTOK_PAGE_LIMIT < orderIds.length) {
      await tiktokApiDelay();
    }
  }

  return {
    success: true,
    shop_id: listResult.shop_id,
    list_count: listResult.count,
    detail_count: details.length,
    pages: listResult.pages,
    // TODO: map `details` → schema Order nội bộ + persist Mongo (giống Shopee sync).
    orders: details.length ? details : listResult.orders,
    message:
      "Khung sync Custom App OK. Chưa ghi DB — bước tiếp theo map đơn TikTok vào order store.",
  };
}
