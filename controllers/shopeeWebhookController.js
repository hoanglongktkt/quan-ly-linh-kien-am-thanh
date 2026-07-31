/**
 * Controllers: Shopee webhook payload processor (real-time).
 * Mount: app.use("/api/webhook", createShopeeWebhookRouter(processShopeeWebhookPayload))
 * PHẢI nằm trước express.json.
 *
 * Luồng: ACK 200 ở router → queue → processShopeeWebhookPayload (async):
 * parse event → load đơn Mongo theo order_sn → get_order_detail → upsert DB.
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
};

export function initShopeeWebhookController(partial) {
  deps = { ...deps, ...partial };
}

/** Load working set cho 1 order_sn: ưu tiên Mongo, bổ sung từ orders.json nếu thiếu. */
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
    console.warn(
      `[Shopee Webhook] Mongo upsert ${order.orderSn}:`,
      mongoErr?.message || mongoErr,
    );
  }
}

/**
 * Xử lý ngầm sau ACK 200 — không throw ra ngoài HTTP.
 */
export async function processShopeeWebhookPayload(body) {
  try {
    if (!body || typeof body !== "object") return;

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
    console.log(
      "[Shopee Webhook] Push event",
      JSON.stringify({
        code: parsed.code,
        eventKind: parsed.eventKind,
        shopId: parsed.shopId || null,
        orderSn: parsed.orderSn || null,
        status: parsed.status || null,
        logisticsStatus: parsed.logisticsStatus || null,
        trackingNo: parsed.trackingNo || null,
        packageNumber: parsed.packageNumber || null,
        returnSn: parsed.returnSn || null,
      }),
    );

    // Push không gắn đơn (auth/product/chat…) — chỉ log, đã ACK 200.
    if (!parsed.orderSn) {
      console.log(
        `[Shopee Webhook] Non-order push skipped code=${parsed.code} kind=${parsed.eventKind}`,
      );
      return;
    }

    // Real-time: mọi event có order_sn đều persist (tạo mới / đổi trạng thái / hủy / TN…).
    const isOrderLifecycleEvent =
      parsed.eventKind === "order_status_update" ||
      parsed.eventKind === "tracking_no_update" ||
      parsed.eventKind === "shipping_document" ||
      parsed.eventKind === "return_refund" ||
      parsed.eventKind === "package_update" ||
      deps.SHOPEE_WEBHOOK_ORDER_STATUSES.has(parsed.status) ||
      deps.isLogisticsHandedToCarrier(parsed.logisticsStatus) ||
      Boolean(parsed.trackingNo) ||
      Boolean(parsed.status);

    if (!isOrderLifecycleEvent) {
      console.log(
        `[Shopee Webhook] order_sn=${parsed.orderSn} kind=${parsed.eventKind} — vẫn xử lý real-time (fallback)`,
      );
    }

    const orders = await loadWorkingOrdersForWebhook(parsed.orderSn);
    const shopId =
      String(parsed.shopId || "").trim() ||
      String(orders[0]?.shopId || "").trim();

    let accessToken = null;
    if (shopId) {
      try {
        accessToken = await getValidShopeeAccessToken(shopId);
      } catch (tokenErr) {
        console.warn(
          `[Shopee Webhook] getValidShopeeAccessToken shop=${shopId}:`,
          tokenErr?.message || tokenErr,
        );
      }
    }

    let fetchedDetail = false;

    // Luôn gọi get_order_detail khi có token — payload push thường thiếu items/amount.
    if (shopId && accessToken) {
      try {
        const { normalized, errors } = await deps.fetchNormalizeShopeeOrderChunk(
          shopId,
          accessToken,
          shopId,
          [parsed.orderSn],
          { enrichTracking: true },
        );
        if (normalized.length > 0) {
          try {
            await deps.persistShopeeOrderChunk(orders, normalized, {
              apiShopId: shopId,
              accessToken,
            });
            fetchedDetail = true;
            console.log(
              `[Shopee Webhook] get_order_detail OK order_sn=${parsed.orderSn}` +
                ` status=${normalized[0]?.shopee_order_status || ""}` +
                ` tn=${normalized[0]?.trackingNumber || "—"}`,
            );
          } catch (persistErr) {
            console.warn(
              `[Shopee Webhook] persistShopeeOrderChunk fail — fallback shallow+upsert:`,
              persistErr?.message || persistErr,
            );
            // Merge tay rồi upsert Mongo (tránh mất event khi persist throw mongodb_not_ready).
            const row = normalized[0];
            const idx = orders.findIndex(
              (o) => String(o.orderSn) === String(row.orderSn),
            );
            if (idx >= 0) orders[idx] = { ...orders[idx], ...row };
            else orders.unshift(row);
            fetchedDetail = true;
            await upsertOrderToDb(orders[0] || row, "detail-fallback");
          }
        } else {
          console.warn(
            `[Shopee Webhook] get_order_detail rỗng order_sn=${parsed.orderSn}`,
            errors?.[0] || "",
          );
        }
      } catch (detailErr) {
        console.warn(
          `[Shopee Webhook] get_order_detail error order_sn=${parsed.orderSn}:`,
          detailErr?.message || detailErr,
        );
      }
    } else {
      console.warn(
        `[Shopee Webhook] Thiếu shop_id/token — fallback normalize thô order_sn=${parsed.orderSn}`,
      );
    }

    if (!fetchedDetail) {
      try {
        await deps.upsertShopeeWebhookShallow(body, orders);
      } catch (shallowErr) {
        console.warn(
          `[Shopee Webhook] upsertShopeeWebhookShallow:`,
          shallowErr?.message || shallowErr,
        );
      }
    }

    let idx = orders.findIndex((o) => String(o.orderSn) === parsed.orderSn);
    if (idx < 0 && (parsed.trackingNo || parsed.status || parsed.orderSn)) {
      try {
        await deps.upsertShopeeWebhookShallow(body, orders);
      } catch {
        /* ignore */
      }
      idx = orders.findIndex((o) => String(o.orderSn) === parsed.orderSn);
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
            { retries: 4 },
          );
          deps.applyShopeePushFieldsToOrder(orders[idx], parsed);
        } catch (trackErr) {
          console.warn(
            `[Shopee Webhook] Force get_tracking_number ${parsed.orderSn}:`,
            trackErr?.message || trackErr,
          );
        }
      }

      const afterTn = String(
        orders[idx].trackingNumber || orders[idx].tracking_no || "",
      );
      console.log(
        `[Shopee Webhook] Apply push fields order_sn=${parsed.orderSn}` +
          ` status=${orders[idx].status}` +
          ` raw=${orders[idx].shopee_order_status || "—"}` +
          ` tn=${afterTn || "—"} (before=${beforeTn || "—"})`,
      );

      await upsertOrderToDb(orders[idx], parsed.eventKind);
    } else {
      console.error(
        `[Shopee Webhook] Không tạo/được đơn sau xử lý order_sn=${parsed.orderSn}`,
      );
    }

    const orderAfter = orders.find((o) => String(o.orderSn) === parsed.orderSn);
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
          parsed.orderSn,
          orders,
          parsed.returnSn,
        );
        const row = orders.find((o) => String(o.orderSn) === parsed.orderSn);
        if (row) await upsertOrderToDb(row, "return/cancel");
      } catch (retErr) {
        console.warn(
          `[Shopee Webhook] applyWebhookReturnFallback:`,
          retErr?.message || retErr,
        );
      }
    }

    console.log(
      `[Shopee Webhook] Order ${parsed.orderSn} processed (event=${parsed.eventKind}).`,
    );
  } catch (error) {
    console.error("[Shopee Webhook] Async processing error:", error);
  }
}
