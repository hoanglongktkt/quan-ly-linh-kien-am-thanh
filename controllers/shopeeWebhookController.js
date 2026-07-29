/**
 * Controllers: Shopee webhook payload processor.
 * Phase 6 — tách từ server.ts.
 * Mount: app.use("/api/webhook", createShopeeWebhookRouter(processShopeeWebhookPayload))
 * PHẢI nằm trước express.json.
 */
import { getValidShopeeAccessToken } from "../services/shopee/auth.js";

let deps = {
  parseShopeePushEvent: () => ({}),
  SHOPEE_WEBHOOK_ORDER_STATUSES: new Set(),
  isLogisticsHandedToCarrier: () => false,
  loadOrders: () => [],
  saveOrders: () => {},
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

export async function processShopeeWebhookPayload(body) {
  try {
    if (!body || typeof body !== "object") return;

    console.log("[WEBHOOK RECEIVED] processShopeeWebhookPayload payload:", JSON.stringify(body));

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

    if (!parsed.orderSn) {
      console.error(
        `[Shopee Webhook] REJECTED — thiếu order_sn (code=${parsed.code}) payload=${JSON.stringify(body).slice(0, 800)}`,
      );
      return;
    }
    const shouldPersist =
      parsed.eventKind === "order_status_update" ||
      parsed.eventKind === "tracking_no_update" ||
      parsed.eventKind === "shipping_document" ||
      parsed.eventKind === "return_refund" ||
      deps.SHOPEE_WEBHOOK_ORDER_STATUSES.has(parsed.status) ||
      deps.isLogisticsHandedToCarrier(parsed.logisticsStatus);
    if (!shouldPersist) {
      console.error(
        `[StateMachine] Webhook REJECTED — status/event không cần persist ` +
          `order_sn=${parsed.orderSn} status=${parsed.status || "empty"} ` +
          `logistics=${parsed.logisticsStatus || "-"} code=${parsed.code} kind=${parsed.eventKind}`,
      );
      return;
    }

    const orders = deps.loadOrders();
    const shopId = parsed.shopId;
    let accessToken = null;
    if (shopId) {
      accessToken = await getValidShopeeAccessToken(shopId);
    }

    const shouldFetchDetail =
      parsed.eventKind === "order_status_update" ||
      parsed.eventKind === "tracking_no_update" ||
      parsed.eventKind === "shipping_document" ||
      parsed.eventKind === "return_refund";

    if (shouldFetchDetail && shopId && accessToken) {
      const { normalized, errors } = await deps.fetchNormalizeShopeeOrderChunk(
        shopId,
        accessToken,
        shopId,
        [parsed.orderSn],
        { enrichTracking: true },
      );
      if (normalized.length > 0) {
        await deps.persistShopeeOrderChunk(orders, normalized, {
          apiShopId: shopId,
          accessToken,
        });
        console.log(
          `[Shopee Webhook] get_order_detail OK order_sn=${parsed.orderSn} status=${normalized[0]?.shopee_order_status || ""} tn=${normalized[0]?.trackingNumber || "—"}`,
        );
      } else {
        console.warn(
          `[Shopee Webhook] get_order_detail rỗng order_sn=${parsed.orderSn}`,
          errors?.[0] || "",
        );
        await deps.upsertShopeeWebhookShallow(body, orders);
        deps.saveOrders(orders);
      }
    } else {
      if (!shopId || !accessToken) {
        console.warn(
          `[Shopee Webhook] Thiếu shop_id/token — fallback normalize thô order_sn=${parsed.orderSn}`,
        );
      }
      await deps.upsertShopeeWebhookShallow(body, orders);
      deps.saveOrders(orders);
    }

    let idx = orders.findIndex((o) => String(o.orderSn) === parsed.orderSn);
    if (idx < 0 && (parsed.trackingNo || parsed.status)) {
      await deps.upsertShopeeWebhookShallow(body, orders);
      idx = orders.findIndex((o) => String(o.orderSn) === parsed.orderSn);
    }
    if (idx >= 0) {
      const beforeTn = String(orders[idx].trackingNumber || orders[idx].tracking_no || "");
      deps.applyShopeePushFieldsToOrder(orders[idx], parsed);

      if (
        shopId &&
        accessToken &&
        (parsed.eventKind === "tracking_no_update" ||
          parsed.eventKind === "shipping_document" ||
          !deps.hasUsableShopeeTrackingNumber(orders[idx]))
      ) {
        try {
          await deps.enrichShopeeOrderTrackingFromApi(shopId, accessToken, orders[idx], {
            retries: 4,
          });
          deps.applyShopeePushFieldsToOrder(orders[idx], parsed);
        } catch (trackErr) {
          console.warn(
            `[Shopee Webhook] Force get_tracking_number ${parsed.orderSn}:`,
            trackErr?.message || trackErr,
          );
        }
      }

      const afterTn = String(orders[idx].trackingNumber || orders[idx].tracking_no || "");
      console.log(
        `[Shopee Webhook] Apply push fields order_sn=${parsed.orderSn} status=${orders[idx].status} raw=${orders[idx].shopee_order_status || "—"} tn=${afterTn || "—"} (before=${beforeTn || "—"})`,
      );
      deps.saveOrders(orders);
      if (deps.isMongoReady()) {
        try {
          await deps.bulkUpsertOrdersToStore([orders[idx]]);
          console.log(
            `[DB UPDATED] order_sn=${parsed.orderSn} shop_id=${shopId || orders[idx]?.shopId || "?"} status=${orders[idx]?.shopee_order_status || "?"} — upsert OK`,
          );
        } catch (mongoErr) {
          console.warn(
            `[Shopee Webhook] Mongo upsert ${parsed.orderSn}:`,
            mongoErr?.message || mongoErr,
          );
        }
      }
    }

    const orderAfter = orders.find((o) => String(o.orderSn) === parsed.orderSn);
    const needReturnFallback =
      parsed.eventKind === "return_refund" ||
      Boolean(parsed.returnSn) ||
      parsed.status === "TO_RETURN" ||
      (orderAfter != null &&
        String(orderAfter.shopee_order_status || "").toUpperCase() === "TO_RETURN") ||
      (orderAfter != null &&
        (orderAfter.status === "return_pending" || orderAfter.status === "return_received"));

    if (needReturnFallback && shopId && accessToken) {
      await deps.applyWebhookReturnFallback(
        shopId,
        accessToken,
        parsed.orderSn,
        orders,
        parsed.returnSn,
      );
      deps.saveOrders(orders);
      if (deps.isMongoReady()) {
        const row = orders.find((o) => String(o.orderSn) === parsed.orderSn);
        if (row) {
          try {
            await deps.bulkUpsertOrdersToStore([row]);
            console.log(
              `[DB UPDATED] (return/cancel) order_sn=${parsed.orderSn} shop_id=${row?.shopId || "?"} status=${row?.shopee_order_status || "?"} — upsert OK`,
            );
          } catch (mongoErr) {
            console.warn(
              `[Shopee Webhook] Mongo upsert return ${parsed.orderSn}:`,
              mongoErr?.message || mongoErr,
            );
          }
        }
      }
    }

    console.log(`[Shopee Webhook] Order ${parsed.orderSn} processed (event=${parsed.eventKind}).`);
  } catch (error) {
    console.error("[Shopee Webhook] Async processing error:", error);
  }
}
