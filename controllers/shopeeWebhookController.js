/**
 * Controllers: Shopee webhook payload processor (real-time).
 * Mount: app.use("/api/shopee", createShopeeWebhookRouter(processShopeeWebhookPayload, "/webhook"))
 * → canonical POST/GET /api/shopee/webhook
 * PHẢI nằm trước express.json.
 *
 * Luồng: ACK 200 ở router → queue → processShopeeWebhookPayload (async):
 *  1) Bóc order_sn + shop_id từ payload (Shopee v2: code, shop_id, data.ordersn/order_sn)
 *  2) Kiểm tra / refresh access_token → gọi get_order_detail
 *  3) UPSERT vào Mongo DB
 */
import {
  getValidShopeeAccessToken,
  getShopeeAccessTokenForApi,
  refreshShopeeAccessTokenLocked,
  loadShopeeTokens,
  getShopeeTokenRecord,
  normalizeShopIdKey,
  resolveShopeeTokenShopId,
  isShopeeInvalidTokenError,
  getShopeeUnauthorizedShopMessage,
  ShopeeRefreshTokenExpiredError,
} from "../services/shopee/auth.js";

let deps = {
  parseShopeePushEvent: () => ({}),
  SHOPEE_WEBHOOK_ORDER_STATUSES: new Set(),
  isLogisticsHandedToCarrier: () => false,
  loadOrders: () => [],
  saveOrders: () => {},
  loadOrdersFromStore: async () => [],
  queueOrdersJsonMirrorFromMongo: () => {},
  fetchNormalizeShopeeOrderChunk: async () => ({ normalized: [], errors: [] }),
  persistShopeeOrderChunk: async () => {},
  upsertShopeeWebhookShallow: async () => {},
  applyShopeePushFieldsToOrder: () => {},
  hasUsableShopeeTrackingNumber: () => false,
  enrichShopeeOrderTrackingFromApi: async () => {},
  isMongoReady: () => false,
  bulkUpsertOrdersToStore: async () => {},
  applyWebhookReturnFallback: async () => {},
  listShopeeOAuthShopIds: () => [],
};

export function initShopeeWebhookController(partial) {
  deps = { ...deps, ...partial };
}

/** Hard cap xử lý 1 webhook — tránh hang vô hạn giữ slot queue / socket nội bộ. */
const WEBHOOK_PROCESS_TIMEOUT_MS = 40_000;

/** Load working set cho 1 order_sn: ưu tiên Mongo theo order_sn (KHÔNG full-scan orders.json). */
async function loadWorkingOrdersForWebhook(orderSn) {
  const sn = String(orderSn || "").trim();
  const orders = [];
  const seen = new Set();

  const pushUnique = (row) => {
    if (!row || typeof row !== "object") return;
    const key = String(row.orderSn || row.order_sn || "").trim();
    if (!key || seen.has(key)) return;
    seen.add(key);
    orders.push(row);
  };

  if (deps.isMongoReady()) {
    try {
      const mongoRows = await deps.loadOrdersFromStore({ orderSns: [sn] });
      for (const row of Array.isArray(mongoRows) ? mongoRows : []) pushUnique(row);
      return orders;
    } catch (err) {
      console.warn(
        `[Shopee Webhook] loadOrdersFromStore ${sn}:`,
        err?.message || err,
      );
    }
  }

  try {
    const jsonRows = deps.loadOrders() || [];
    for (const row of jsonRows) {
      if (String(row?.orderSn || "").trim() === sn) pushUnique(row);
    }
  } catch (err) {
    console.warn(`[Shopee Webhook] loadOrders JSON ${sn}:`, err?.message || err);
  }

  return orders;
}

async function upsertOrderToDb(order, label = "") {
  if (!order?.orderSn) {
    console.log("💾 Kết quả lưu DB:", "thất bại — thiếu orderSn");
    return false;
  }
  if (!deps.isMongoReady()) {
    console.warn(
      `[Shopee Webhook] Mongo chưa sẵn sàng — bỏ qua upsert order_sn=${order.orderSn}`,
    );
    console.log("💾 Kết quả lưu DB:", `thất bại — Mongo chưa sẵn sàng (order_sn=${order.orderSn})`);
    return false;
  }
  try {
    await deps.bulkUpsertOrdersToStore([order]);
    console.log(
      `[DB UPDATED] ${label ? `(${label}) ` : ""}order_sn=${order.orderSn}` +
        ` shop_id=${order.shopId || "?"} status=${order.shopee_order_status || order.status || "?"} — upsert OK`,
    );
    console.log(
      "💾 Kết quả lưu DB:",
      `thành công — order_sn=${order.orderSn} shop_id=${order.shopId || "?"} label=${label || "webhook"}`,
    );
    try {
      deps.queueOrdersJsonMirrorFromMongo();
    } catch {
      /* ignore mirror */
    }
    return true;
  } catch (mongoErr) {
    console.error(
      `[Shopee Webhook] Mongo upsert FAILED order_sn=${order.orderSn}:`,
      mongoErr?.message || mongoErr,
      mongoErr?.stack || "",
    );
    console.log(
      "💾 Kết quả lưu DB:",
      `lỗi — order_sn=${order.orderSn}: ${mongoErr?.message || mongoErr}`,
    );
    return false;
  }
}

/** Bóc order_sn / shop_id từ envelope Shopee v2 (kể cả khi parseShopeePushEvent thiếu). */
function extractOrderSnAndShopId(body, parsed) {
  const data =
    body?.data && typeof body.data === "object" && !Array.isArray(body.data)
      ? body.data
      : body || {};
  const pkg0 = Array.isArray(data.package_list) ? data.package_list[0] : undefined;

  const orderSn = String(
    parsed?.orderSn ||
      data.ordersn ||
      data.order_sn ||
      data.orderSn ||
      body?.ordersn ||
      body?.order_sn ||
      body?.orderSn ||
      pkg0?.ordersn ||
      pkg0?.order_sn ||
      "",
  ).trim();

  const shopId = String(
    parsed?.shopId ||
      body?.shop_id ||
      body?.shopId ||
      data.shop_id ||
      data.shopId ||
      "",
  ).trim();

  return { orderSn, shopId };
}

/** Kiểm tra token trong DB: còn hạn hay cần refresh (access_token Shopee ~4h). */
function inspectShopTokenStatus(shopId) {
  const key = normalizeShopIdKey(shopId);
  if (!key) {
    return {
      shopId: "",
      hasRecord: false,
      hasAccessToken: false,
      hasRefreshToken: false,
      needsRefresh: true,
      reason: "missing_shop_id",
    };
  }
  const tokens = loadShopeeTokens();
  const record = getShopeeTokenRecord(tokens, key);
  if (!record) {
    return {
      shopId: key,
      hasRecord: false,
      hasAccessToken: false,
      hasRefreshToken: false,
      needsRefresh: true,
      reason: "no_token_record",
    };
  }
  const now = Math.floor(Date.now() / 1000);
  const obtainedAt = Number(record.obtained_at) || 0;
  const expireIn = Number(record.expire_in) || 14400;
  const age = obtainedAt > 0 ? now - obtainedAt : null;
  const expired =
    !record.access_token || (obtainedAt > 0 && now - obtainedAt >= expireIn - 60);
  return {
    shopId: key,
    hasRecord: true,
    hasAccessToken: Boolean(record.access_token),
    hasRefreshToken: Boolean(record.refresh_token),
    needsRefresh: expired,
    ageSeconds: age,
    expireIn,
    reason: expired
      ? record.refresh_token
        ? "access_token_expired_need_refresh"
        : "expired_and_no_refresh_token"
      : "access_token_fresh",
  };
}

/**
 * Lấy access_token hợp lệ: nếu hết hạn → BẮT BUỘC refresh rồi mới dùng.
 * @returns {{ ok: boolean, token?: string, apiShopId?: string, fileKey?: string, message?: string, refreshed?: boolean }}
 */
async function resolveWebhookShopAuth(shopId) {
  // Đa shop: resolve đúng token record theo shop_id payload (linked/oauth alias).
  const resolved = resolveShopeeTokenShopId(shopId);
  const key =
    normalizeShopIdKey(resolved || shopId) || String(resolved || shopId || "").trim();
  if (!key) {
    return {
      ok: false,
      message: getShopeeUnauthorizedShopMessage(),
      refreshed: false,
    };
  }
  if (resolved && resolved !== String(shopId || "").trim()) {
    console.log(
      `[Shopee Webhook] resolveShopeeTokenShopId: payload=${shopId} → token_key=${resolved}`,
    );
  }
  const status = inspectShopTokenStatus(key);

  console.log(
    "🔑 Trạng thái Token:",
    `shop_id=${key || "?"} có_record=${status.hasRecord} có_access_token=${status.hasAccessToken} có_refresh_token=${status.hasRefreshToken} cần_refresh=${status.needsRefresh} lý_do=${status.reason}` +
      (status.ageSeconds != null ? ` age=${status.ageSeconds}s/expire_in=${status.expireIn}s` : ""),
  );

  if (!status.hasRecord) {
    return {
      ok: false,
      message: getShopeeUnauthorizedShopMessage(),
      refreshed: false,
    };
  }

  if (!status.hasRefreshToken && status.needsRefresh) {
    return {
      ok: false,
      message: `Shop ${key}: access_token hết hạn và thiếu refresh_token. Vào mục Cài đặt → Ủy quyền lại Shop Shopee.`,
      refreshed: false,
    };
  }

  try {
    let refreshed = false;
    let auth = null;

    if (status.needsRefresh) {
      console.log(
        `🔑 Token hết hạn shop_id=${key} — gọi Refresh Token trước get_order_detail...`,
      );
      try {
        const newToken = await refreshShopeeAccessTokenLocked(key, { force: true });
        if (newToken) {
          refreshed = true;
          auth = await getShopeeAccessTokenForApi(key);
          console.log(`🔑 Refresh Token OK shop_id=${key} — đã lưu DB, dùng token mới.`);
        }
      } catch (refreshErr) {
        console.error(
          `🔑 Refresh Token THẤT BẠI shop_id=${key}:`,
          refreshErr?.message || refreshErr,
        );
        if (refreshErr instanceof ShopeeRefreshTokenExpiredError) {
          return {
            ok: false,
            message: `Shop ${key}: refresh_token hết hạn — ${getShopeeUnauthorizedShopMessage()}`,
            refreshed: false,
          };
        }
      }
    }

    if (!auth?.token) {
      auth = await getShopeeAccessTokenForApi(key);
    }
    if (!auth?.token) {
      // Fallback cuối: getValidShopeeAccessToken (cũng auto-refresh nếu hết hạn).
      const fallback = await getValidShopeeAccessToken(key);
      if (!fallback) {
        console.log(
          "🔑 Trạng thái Token:",
          `KHÔNG lấy được access_token hợp lệ cho shop_id=${key}`,
        );
        return {
          ok: false,
          message: `Không lấy được access_token hợp lệ cho shop_id=${key}. Vào mục Cài đặt → Ủy quyền lại Shop.`,
          refreshed,
        };
      }
      return {
        ok: true,
        token: fallback,
        apiShopId: key,
        fileKey: key,
        refreshed,
      };
    }

    console.log(
      "🔑 Trạng thái Token:",
      `OK — lấy được access_token shop_id=${auth.fileKey} api_shop_id=${auth.apiShopId} refreshed=${refreshed}`,
    );
    return {
      ok: true,
      token: auth.token,
      apiShopId: auth.apiShopId || key,
      fileKey: auth.fileKey || key,
      refreshed,
    };
  } catch (err) {
    console.error(`🔑 Lỗi resolve token shop_id=${key}:`, err?.message || err);
    return {
      ok: false,
      message: err?.message || String(err),
      refreshed: false,
    };
  }
}

/**
 * Gọi get_order_detail + persist (UPSERT).
 * Đa shop: ƯU TIÊN shop_id từ payload webhook → lấy đúng token shop đó.
 * Chỉ fallback shop khác khi payload thiếu shop_id hoặc shop đó thất bại.
 */
async function fetchDetailAndUpsert(orderSn, preferredShopId, orders) {
  const payloadShopId = String(preferredShopId || "").trim();
  const shopCandidates = [];
  const pushShop = (id) => {
    const s = String(id || "").trim();
    if (s && !shopCandidates.includes(s)) shopCandidates.push(s);
  };

  // 1) shop_id từ payload Webhook — resolve token key đa shop rồi ưu tiên
  if (payloadShopId) {
    const resolvedPayload = resolveShopeeTokenShopId(payloadShopId);
    pushShop(resolvedPayload || payloadShopId);
    if (resolvedPayload && resolvedPayload !== payloadShopId) {
      pushShop(payloadShopId);
    }
    console.log(
      `📦 Webhook nhận đơn: ${orderSn} của shop: ${payloadShopId}` +
        (resolvedPayload ? ` (token_key=${resolvedPayload})` : "") +
        ` — dùng resolveShopeeTokenShopId để lấy token`,
    );
  } else {
    console.warn(
      `📦 Webhook order_sn=${orderSn} THIẾU shop_id trong payload — sẽ thử các shop đã ủy quyền`,
    );
    const fromOrder = resolveShopeeTokenShopId(orders[0]?.shopId) || orders[0]?.shopId;
    pushShop(fromOrder);
    try {
      for (const id of deps.listShopeeOAuthShopIds() || []) pushShop(id);
    } catch (listErr) {
      console.warn(
        "[Shopee Webhook] listShopeeOAuthShopIds failed:",
        listErr?.message || listErr,
      );
    }
  }

  if (shopCandidates.length === 0) {
    console.error(
      `[Shopee Webhook] Không có shop_id nào để gọi get_order_detail order_sn=${orderSn}`,
    );
    console.log(
      "📥 Kết quả gọi API get_order_detail:",
      `lỗi — không có shop ủy quyền. ${getShopeeUnauthorizedShopMessage()}`,
    );
    return { fetched: false, shopId: "", row: null, accessToken: null };
  }

  const tryFetchForShop = async (shopId) => {
    console.log(`📦 Webhook kéo chi tiết: order_sn=${orderSn} shop_id=${shopId}`);

    const auth = await resolveWebhookShopAuth(shopId);
    if (!auth.ok || !auth.token) {
      console.warn(
        `[Shopee Webhook] Bỏ qua shop=${shopId} — ${auth.message || "không có token"}`,
      );
      return null;
    }

    const apiShopId = auth.apiShopId || shopId;
    const fileKey = auth.fileKey || shopId;
    let accessToken = auth.token;

    console.log(
      `[Shopee Webhook] Calling get_order_detail order_sn=${orderSn} shop_id=${apiShopId} fileKey=${fileKey}`,
    );

    let normalized = [];
    let errors = [];
    try {
      const chunk = await deps.fetchNormalizeShopeeOrderChunk(
        apiShopId,
        accessToken,
        fileKey,
        [orderSn],
        { enrichTracking: true, skipEscrow: true },
      );
      normalized = chunk.normalized || [];
      errors = chunk.errors || [];

      const authFail = errors.some(
        (e) =>
          Number(e?.httpStatus) === 401 ||
          Number(e?.httpStatus) === 403 ||
          isShopeeInvalidTokenError(e?.error, e?.message),
      );
      if (authFail) {
        console.warn(
          `🔑 get_order_detail báo token lỗi shop=${fileKey} — force refresh + retry 1 lần`,
        );
        try {
          const refreshed = await refreshShopeeAccessTokenLocked(fileKey, { force: true });
          if (refreshed) {
            accessToken = refreshed;
            const retry = await deps.fetchNormalizeShopeeOrderChunk(
              apiShopId,
              accessToken,
              fileKey,
              [orderSn],
              { enrichTracking: true, skipEscrow: true },
            );
            normalized = retry.normalized || [];
            errors = retry.errors || [];
          }
        } catch (retryRefreshErr) {
          console.error(
            `🔑 Force refresh sau get_order_detail fail:`,
            retryRefreshErr?.message || retryRefreshErr,
          );
        }
      }
    } catch (detailErr) {
      console.error(
        `[Shopee Webhook] get_order_detail EXCEPTION order_sn=${orderSn} shop=${shopId}:`,
        detailErr?.message || detailErr,
        detailErr?.stack || "",
      );
      console.log(
        "📥 Kết quả gọi API get_order_detail:",
        `lỗi exception — order_sn=${orderSn} shop=${shopId}: ${detailErr?.message || detailErr}`,
      );
      return null;
    }

    if (!normalized?.length) {
      const errMsg = errors?.[0]
        ? `${errors[0].error || ""} ${errors[0].message || ""}`.trim()
        : "response rỗng";
      console.warn(
        `[Shopee Webhook] get_order_detail rỗng order_sn=${orderSn} shop=${shopId}`,
        errMsg,
      );
      console.log(
        "📥 Kết quả gọi API get_order_detail:",
        `lỗi API — order_sn=${orderSn} shop=${shopId}: ${errMsg || "empty"}`,
      );
      return null;
    }

    console.log(
      "📥 Kết quả gọi API get_order_detail:",
      `thành công — order_sn=${orderSn} shop=${apiShopId} status=${normalized[0]?.shopee_order_status || normalized[0]?.status || "?"} tn=${normalized[0]?.trackingNumber || "—"}`,
    );

    try {
      await deps.persistShopeeOrderChunk(orders, normalized, {
        apiShopId,
        accessToken,
        skipTracking: true,
      });
      console.log(
        `[Shopee Webhook] get_order_detail + UPSERT OK order_sn=${orderSn}` +
          ` shop_id=${apiShopId}` +
          ` status=${normalized[0]?.shopee_order_status || ""}` +
          ` tn=${normalized[0]?.trackingNumber || "—"}`,
      );
      console.log(
        "💾 Kết quả lưu DB:",
        `thành công (persistShopeeOrderChunk) — order_sn=${orderSn}`,
      );
      return {
        fetched: true,
        shopId: apiShopId,
        row: orders.find((o) => String(o.orderSn) === orderSn) || normalized[0],
        accessToken,
      };
    } catch (persistErr) {
      console.error(
        `[Shopee Webhook] persistShopeeOrderChunk FAILED order_sn=${orderSn}:`,
        persistErr?.message || persistErr,
        persistErr?.stack || "",
      );
      const row = normalized[0];
      const idx = orders.findIndex((o) => String(o.orderSn) === String(row.orderSn));
      if (idx >= 0) orders[idx] = { ...orders[idx], ...row };
      else orders.unshift(row);
      await upsertOrderToDb(orders[0] || row, "detail-fallback");
      return {
        fetched: true,
        shopId: apiShopId,
        row: orders[0] || row,
        accessToken,
      };
    }
  };

  // Thử shop payload trước
  for (const shopId of shopCandidates) {
    try {
      const result = await tryFetchForShop(shopId);
      if (result?.fetched) return result;
    } catch (shopLoopErr) {
      console.error(
        `[Shopee Webhook] fetchDetailAndUpsert EXCEPTION order_sn=${orderSn} shop=${shopId}:`,
        shopLoopErr?.message || shopLoopErr,
        shopLoopErr?.stack || "",
      );
    }
  }

  // Payload có shop_id nhưng fail → fallback các shop ủy quyền còn lại (1 lần)
  if (payloadShopId) {
    const fallbackShops = [];
    try {
      for (const id of deps.listShopeeOAuthShopIds() || []) {
        const s = String(id || "").trim();
        if (s && s !== payloadShopId && !fallbackShops.includes(s)) fallbackShops.push(s);
      }
    } catch {
      /* ignore */
    }
    for (const shopId of fallbackShops) {
      try {
        console.warn(
          `[Shopee Webhook] Fallback shop_id=${shopId} sau khi payload shop=${payloadShopId} thất bại`,
        );
        const result = await tryFetchForShop(shopId);
        if (result?.fetched) return result;
      } catch (fbErr) {
        console.error(
          `[Shopee Webhook] Fallback EXCEPTION shop=${shopId}:`,
          fbErr?.message || fbErr,
        );
      }
    }
  }

  console.log(
    "📥 Kết quả gọi API get_order_detail:",
    `thất bại — không shop nào trả được chi tiết order_sn=${orderSn} (đã thử: ${shopCandidates.join(", ")})`,
  );
  return {
    fetched: false,
    shopId: preferredShopId || shopCandidates[0] || "",
    row: null,
    accessToken: null,
  };
}

/**
 * Core xử lý 1 payload (sau ACK 200). Caller bọc timeout.
 */
async function processShopeeWebhookPayloadInner(body) {
  if (!body || typeof body !== "object") {
    console.warn("[Shopee Webhook] processShopeeWebhookPayload — body không phải object");
    return;
  }

  console.log(
    "[WEBHOOK RECEIVED] processShopeeWebhookPayload payload:",
    JSON.stringify(body),
  );

  if (String(process.env.SHOPEE_WEBHOOK_ORDERS_ENABLED || "1").trim() === "0") {
    const peek = deps.parseShopeePushEvent(body);
    console.log(
      `[Shopee Webhook] IGNORED (disabled) order_sn=${peek.orderSn || "?"} code=${peek.code}`,
    );
    return;
  }

  const parsed = deps.parseShopeePushEvent(body);
  const extracted = extractOrderSnAndShopId(body, parsed);
  const orderSn = extracted.orderSn;
  let shopId = extracted.shopId;

  // Type 3 (Order Status) + type 4 (Tracking No) — luôn kéo get_order_detail khi có ordersn.
  const codeNum = Number(parsed.code);
  const isOrderPush =
    codeNum === 3 ||
    codeNum === 4 ||
    parsed.eventKind === "order_status_update" ||
    parsed.eventKind === "tracking_no_update" ||
    parsed.eventKind === "shipping_document" ||
    parsed.eventKind === "package_update" ||
    Boolean(orderSn);

  console.log("📦 Webhook nhận đơn:", orderSn || "(không có order_sn)", "của shop:", shopId || "(không có shop_id)");

  console.log(
    "[Shopee Webhook] Push event",
    JSON.stringify({
      code: parsed.code,
      eventKind: parsed.eventKind,
      shopId: shopId || null,
      orderSn: orderSn || null,
      status: parsed.status || null,
      logisticsStatus: parsed.logisticsStatus || null,
      trackingNo: parsed.trackingNo || null,
      packageNumber: parsed.packageNumber || null,
      returnSn: parsed.returnSn || null,
    }),
  );

  if (!orderSn || !isOrderPush) {
    console.log(
      `[Shopee Webhook] Non-order push skipped code=${parsed.code} kind=${parsed.eventKind}`,
    );
    return;
  }

  try {
    const orders = await loadWorkingOrdersForWebhook(orderSn);
    if (!shopId && orders[0]?.shopId) {
      shopId = String(orders[0].shopId).trim();
    }
    // Đa shop: map shop_id payload → đúng token key trước khi gọi API.
    const resolvedShop = resolveShopeeTokenShopId(shopId);
    if (resolvedShop) shopId = resolvedShop;

    // 1) Token check + refresh → get_order_detail → UPSERT (lưu kèm shop_id)
    const detailResult = await fetchDetailAndUpsert(orderSn, shopId, orders);
    if (detailResult.shopId) shopId = detailResult.shopId;
    const fetchedDetail = detailResult.fetched;
    let accessToken = detailResult.accessToken || null;

    if (!accessToken && shopId) {
      try {
        const auth = await resolveWebhookShopAuth(shopId);
        accessToken = auth.ok ? auth.token : null;
      } catch (tokenErr) {
        console.warn(
          `[Shopee Webhook] resolveWebhookShopAuth sau detail:`,
          tokenErr?.message || tokenErr,
        );
      }
    }

    // 2) Fallback shallow nếu get_order_detail thất bại — vẫn cố gắng UPSERT stub
    if (!fetchedDetail) {
      console.warn(
        `[Shopee Webhook] Fallback shallow normalize order_sn=${orderSn} (detail chưa lấy được)`,
      );
      try {
        await deps.upsertShopeeWebhookShallow(body, orders);
        console.log("💾 Kết quả lưu DB:", `shallow fallback đã gọi — order_sn=${orderSn}`);
      } catch (shallowErr) {
        console.error(
          `[Shopee Webhook] upsertShopeeWebhookShallow FAILED:`,
          shallowErr?.message || shallowErr,
          shallowErr?.stack || "",
        );
        console.log(
          "💾 Kết quả lưu DB:",
          `shallow fallback lỗi — ${shallowErr?.message || shallowErr}`,
        );
      }
    }

    let idx = orders.findIndex((o) => String(o.orderSn) === orderSn);
    if (idx < 0 && (parsed.trackingNo || parsed.status || orderSn)) {
      try {
        await deps.upsertShopeeWebhookShallow(body, orders);
      } catch {
        /* ignore */
      }
      idx = orders.findIndex((o) => String(o.orderSn) === orderSn);
    }

    if (idx >= 0) {
      const beforeTn = String(
        orders[idx].trackingNumber || orders[idx].tracking_no || "",
      );
      try {
        deps.applyShopeePushFieldsToOrder(orders[idx], parsed);
      } catch (applyErr) {
        console.warn(
          `[Shopee Webhook] applyShopeePushFieldsToOrder:`,
          applyErr?.message || applyErr,
        );
      }

      if (
        shopId &&
        accessToken &&
        (parsed.eventKind === "tracking_no_update" ||
          parsed.eventKind === "shipping_document" ||
          parsed.eventKind === "package_update" ||
          !deps.hasUsableShopeeTrackingNumber(orders[idx]))
      ) {
        try {
          const row = orders[idx];
          const cancelReturn =
            String(row?.status || "").toLowerCase() === "cancelled" ||
            String(row?.status || "").toLowerCase() === "return_pending" ||
            String(row?.status || "").toLowerCase() === "return_received" ||
            ["CANCELLED", "IN_CANCEL", "TO_RETURN"].includes(
              String(row?.shopee_order_status || "").toUpperCase(),
            ) ||
            Boolean(row?.return_sn) ||
            parsed.eventKind === "return_refund" ||
            Boolean(parsed.returnSn);
          await deps.enrichShopeeOrderTrackingFromApi(
            shopId,
            accessToken,
            orders[idx],
            { retries: cancelReturn ? 2 : 1, light: !cancelReturn },
          );
          deps.applyShopeePushFieldsToOrder(orders[idx], parsed);
        } catch (trackErr) {
          console.warn(
            `[Shopee Webhook] Force get_tracking_number ${orderSn}:`,
            trackErr?.message || trackErr,
          );
        }
      }

      const afterTn = String(
        orders[idx].trackingNumber || orders[idx].tracking_no || "",
      );
      console.log(
        `[Shopee Webhook] Apply push fields order_sn=${orderSn}` +
          ` status=${orders[idx].status}` +
          ` raw=${orders[idx].shopee_order_status || "—"}` +
          ` tn=${afterTn || "—"} (before=${beforeTn || "—"})`,
      );

      await upsertOrderToDb(orders[idx], parsed.eventKind || "webhook");
    } else {
      console.error(
        `[Shopee Webhook] Không tạo/được đơn sau xử lý order_sn=${orderSn} — DB không được cập nhật`,
      );
      console.log(
        "💾 Kết quả lưu DB:",
        `thất bại — không có row order_sn=${orderSn} sau xử lý`,
      );
    }

    const orderAfter = orders.find((o) => String(o.orderSn) === orderSn);
    const needReturnFallback =
      parsed.eventKind === "return_refund" ||
      Boolean(parsed.returnSn) ||
      parsed.status === "TO_RETURN" ||
      (orderAfter != null &&
        String(orderAfter.shopee_order_status || "").toUpperCase() === "TO_RETURN") ||
      (orderAfter != null &&
        (orderAfter.status === "return_pending" ||
          orderAfter.status === "return_received"));

    if (needReturnFallback && shopId && accessToken) {
      try {
        await deps.applyWebhookReturnFallback(
          shopId,
          accessToken,
          orderSn,
          orders,
          parsed.returnSn,
        );
        const row = orders.find((o) => String(o.orderSn) === orderSn);
        if (row) await upsertOrderToDb(row, "return/cancel");
      } catch (retErr) {
        console.warn(
          `[Shopee Webhook] applyWebhookReturnFallback:`,
          retErr?.message || retErr,
        );
      }
    }

    console.log(
      `[Shopee Webhook] Order ${orderSn} processed (event=${parsed.eventKind}, detail=${fetchedDetail}).`,
    );
  } catch (processErr) {
    console.error(
      `[Shopee Webhook] processShopeeWebhookPayloadInner EXCEPTION order_sn=${orderSn}:`,
      processErr?.message || processErr,
      processErr?.stack || "",
    );
    console.log(
      "💾 Kết quả lưu DB:",
      `exception — ${processErr?.message || processErr}`,
    );
  }
}

/**
 * Xử lý ngầm sau ACK 200 — không throw ra ngoài HTTP.
 * Hard timeout: quá hạn thì dừng (slot queue được giải phóng ở router).
 */
export async function processShopeeWebhookPayload(body) {
  let timer;
  try {
    await Promise.race([
      processShopeeWebhookPayloadInner(body),
      new Promise((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                `webhook_process timeout sau ${WEBHOOK_PROCESS_TIMEOUT_MS / 1000}s`,
              ),
            ),
          WEBHOOK_PROCESS_TIMEOUT_MS,
        );
      }),
    ]);
  } catch (error) {
    console.error(
      "[Shopee Webhook] Async processing error:",
      error?.message || error,
      error?.stack || "",
    );
  } finally {
    if (timer) clearTimeout(timer);
  }
}
