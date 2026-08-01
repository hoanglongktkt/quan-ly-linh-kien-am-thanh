/**
 * Controllers: Shopee webhook payload processor (real-time).
 * Mount: app.use("/api/webhook", createShopeeWebhookRouter(processShopeeWebhookPayload))
 * PHẢI nằm trước express.json.
 *
 * Luồng: ACK 200 ở router → queue → processShopeeWebhookPayload (async):
 *  1) Bóc order_sn + shop_id từ payload (Shopee v2: code, shop_id, data.ordersn/order_sn)
 *  2) Gọi get_order_detail
 *  3) UPSERT vào Mongo DB
 */
import { getValidShopeeAccessToken } from "../services/shopee/auth.js";

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
  if (!order?.orderSn) return;
  if (!deps.isMongoReady()) {
    console.warn(
      `[Shopee Webhook] Mongo chưa sẵn sàng — bỏ qua upsert order_sn=${order.orderSn}`,
    );
    return;
  }
  try {
    await deps.bulkUpsertOrdersToStore([order]);
    console.log(
      `[DB UPDATED] ${label ? `(${label}) ` : ""}order_sn=${order.orderSn}` +
        ` shop_id=${order.shopId || "?"} status=${order.shopee_order_status || order.status || "?"} — upsert OK`,
    );
    try {
      deps.queueOrdersJsonMirrorFromMongo();
    } catch {
      /* ignore mirror */
    }
  } catch (mongoErr) {
    console.error(
      `[Shopee Webhook] Mongo upsert FAILED order_sn=${order.orderSn}:`,
      mongoErr?.message || mongoErr,
      mongoErr?.stack || "",
    );
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

/**
 * Gọi get_order_detail + persist (UPSERT). Thử lần lượt các shop nếu thiếu shop_id.
 * @returns {{ fetched: boolean, shopId: string, row: object|null }}
 */
async function fetchDetailAndUpsert(orderSn, preferredShopId, orders) {
  const shopCandidates = [];
  const pushShop = (id) => {
    const s = String(id || "").trim();
    if (s && !shopCandidates.includes(s)) shopCandidates.push(s);
  };
  pushShop(preferredShopId);
  pushShop(orders[0]?.shopId);
  try {
    for (const id of deps.listShopeeOAuthShopIds() || []) pushShop(id);
  } catch (listErr) {
    console.warn(
      "[Shopee Webhook] listShopeeOAuthShopIds failed:",
      listErr?.message || listErr,
    );
  }

  if (shopCandidates.length === 0) {
    console.error(
      `[Shopee Webhook] Không có shop_id nào để gọi get_order_detail order_sn=${orderSn}`,
    );
    return { fetched: false, shopId: "", row: null };
  }

  for (const shopId of shopCandidates) {
    let accessToken = null;
    try {
      accessToken = await getValidShopeeAccessToken(shopId);
    } catch (tokenErr) {
      console.warn(
        `[Shopee Webhook] getValidShopeeAccessToken shop=${shopId}:`,
        tokenErr?.message || tokenErr,
      );
      continue;
    }
    if (!accessToken) {
      console.warn(
        `[Shopee Webhook] Không có access_token shop=${shopId} — thử shop tiếp theo`,
      );
      continue;
    }

    console.log(
      `[Shopee Webhook] Calling get_order_detail order_sn=${orderSn} shop_id=${shopId}`,
    );

    try {
      const { normalized, errors } = await deps.fetchNormalizeShopeeOrderChunk(
        shopId,
        accessToken,
        shopId,
        [orderSn],
        { enrichTracking: true, skipEscrow: true },
      );

      if (!normalized?.length) {
        console.warn(
          `[Shopee Webhook] get_order_detail rỗng order_sn=${orderSn} shop=${shopId}`,
          errors?.[0] || "",
        );
        // Nếu đây là shop đúng (preferred) nhưng API rỗng — vẫn thử shop khác.
        continue;
      }

      try {
        await deps.persistShopeeOrderChunk(orders, normalized, {
          apiShopId: shopId,
          accessToken,
          skipTracking: true,
        });
        console.log(
          `[Shopee Webhook] get_order_detail + UPSERT OK order_sn=${orderSn}` +
            ` shop_id=${shopId}` +
            ` status=${normalized[0]?.shopee_order_status || ""}` +
            ` tn=${normalized[0]?.trackingNumber || "—"}`,
        );
        return { fetched: true, shopId, row: orders.find((o) => String(o.orderSn) === orderSn) || normalized[0] };
      } catch (persistErr) {
        console.error(
          `[Shopee Webhook] persistShopeeOrderChunk FAILED order_sn=${orderSn}:`,
          persistErr?.message || persistErr,
          persistErr?.stack || "",
        );
        // Fallback: merge tay rồi upsert Mongo trực tiếp.
        const row = normalized[0];
        const idx = orders.findIndex((o) => String(o.orderSn) === String(row.orderSn));
        if (idx >= 0) orders[idx] = { ...orders[idx], ...row };
        else orders.unshift(row);
        await upsertOrderToDb(orders[0] || row, "detail-fallback");
        return { fetched: true, shopId, row: orders[0] || row };
      }
    } catch (detailErr) {
      console.error(
        `[Shopee Webhook] get_order_detail EXCEPTION order_sn=${orderSn} shop=${shopId}:`,
        detailErr?.message || detailErr,
        detailErr?.stack || "",
      );
    }
  }

  return { fetched: false, shopId: preferredShopId || shopCandidates[0] || "", row: null };
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

  if (!orderSn) {
    console.log(
      `[Shopee Webhook] Non-order push skipped code=${parsed.code} kind=${parsed.eventKind}`,
    );
    return;
  }

  const orders = await loadWorkingOrdersForWebhook(orderSn);
  if (!shopId && orders[0]?.shopId) {
    shopId = String(orders[0].shopId).trim();
  }

  // 1) get_order_detail → UPSERT (ưu tiên; thử nhiều shop nếu thiếu shop_id)
  const detailResult = await fetchDetailAndUpsert(orderSn, shopId, orders);
  if (detailResult.shopId) shopId = detailResult.shopId;
  const fetchedDetail = detailResult.fetched;

  let accessToken = null;
  if (shopId) {
    try {
      accessToken = await getValidShopeeAccessToken(shopId);
    } catch {
      /* already logged in fetch path */
    }
  }

  // 2) Fallback shallow nếu get_order_detail thất bại — vẫn cố gắng UPSERT stub
  if (!fetchedDetail) {
    console.warn(
      `[Shopee Webhook] Fallback shallow normalize order_sn=${orderSn} (detail chưa lấy được)`,
    );
    try {
      await deps.upsertShopeeWebhookShallow(body, orders);
    } catch (shallowErr) {
      console.error(
        `[Shopee Webhook] upsertShopeeWebhookShallow FAILED:`,
        shallowErr?.message || shallowErr,
        shallowErr?.stack || "",
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
        await deps.enrichShopeeOrderTrackingFromApi(
          shopId,
          accessToken,
          orders[idx],
          { retries: 1, light: true },
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
