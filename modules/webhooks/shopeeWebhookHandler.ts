import { markWebhookReceived } from "./stats.ts";
export { getShopeeWebhookStats } from "./stats.ts";
export { webhookOrderKey } from "./payload.ts";
import { unwrapWebhookData, parseWebhookBody, buildWebhookJobId } from "./payload.ts";
import { ackShopeeOk, readAuthorizationHeader, buildWebhookUrlCandidates, readRawWebhookBody } from "./request.ts";
// Module miền nghiệp vụ; giữ nguyên hành vi và trạng thái dùng chung.
import { safeError } from "../../utils/safeProductionLog.js";
import express, { type Router } from "express";
import { verifyShopeeWebhookSignature } from "./shopeeSignature.ts";
import { ingestShopeeChatPush } from "../../services/shopee/chat.js";
import { enqueueWebhookJob } from "../jobs/webhookJobQueue.js";
import { webhookObservation } from "../operations/telemetry.js";

type WebhookProcessor = (payload: Record<string, unknown>) => Promise<void>;
type QueueOverflowHandler = (payload: Record<string, unknown>) => void | Promise<void>;
/** Ghi nông order_sn/shop/status trước khi xếp hàng get_order_detail. Lỗi không được chặn enqueue. */
type EagerStubHandler = (payload: Record<string, unknown>) => boolean | Promise<boolean>;

type WebhookRequestSnapshot = {
  receivedAt: Date;
  routeLabel: string;
  authorization: string;
  requestUrls: string[];
  contentLength: string;
  contentType: string;
  host: string;
};

async function processShopeeWebhookAsync(
  snapshot: WebhookRequestSnapshot,
  rawBodyPromise: Promise<Buffer | null>,
  eagerStubOrder?: EagerStubHandler,
  onQueueOverflow?: QueueOverflowHandler,
): Promise<void> {
  try {
    const rawBody = await rawBodyPromise;
    const bodyBytes = rawBody?.length ?? 0;
    console.log(`[Shopee Webhook] raw bodyBytes=${bodyBytes} after ACK`);
    if (!rawBody || bodyBytes === 0) {
      console.log("[Shopee Webhook] Empty/oversized body after ACK — nothing to process.");
      return;
    }

    const isValid = verifyShopeeWebhookSignature(
      rawBody,
      snapshot.authorization,
      snapshot.requestUrls,
    );
    const isVerified = isValid;
    console.log("[WEBHOOK] HMAC valid:", isVerified);
    if (!isVerified) {
      console.warn(
        "[Shopee Webhook] HMAC unverified after ACK — vẫn parse + get_order_detail (Shopee API là nguồn chân lý).",
      );
    }

    markWebhookReceived();
    console.log(
      `[WEBHOOK RECEIVED] pid=${process.pid} ${snapshot.routeLabel} — ACK 200 sent; headers:`,
      {
        authorization: isValid ? "(verified)" : "(unverified — continue)",
        contentLength: snapshot.contentLength,
        contentType: snapshot.contentType,
        host: snapshot.host,
        bodyBytes,
      },
    );
    // Không ghi raw payload chứa thông tin khách hàng vào log.

    const payload = parseWebhookBody(rawBody);
    if (!payload) {
      console.log("[Shopee Webhook] Invalid JSON after ACK — nothing to process.");
      return;
    }



    const data = unwrapWebhookData(payload);
    const code = Number(payload.code ?? data.code);
    const routeLabel = String(snapshot.routeLabel || "");
    const isChatPush = code === 10 || routeLabel.includes("/chat-webhook");
    if (isChatPush) {
      try {
        await ingestShopeeChatPush(payload);
      } catch (chatErr) {
        console.error(
          "[Shopee Chat Webhook] ingest failed:",
          chatErr instanceof Error ? chatErr.message : chatErr,
        );
      }
      return;
    }
    const orderSn = String(
      data.ordersn ??
        data.order_sn ??
        data.orderSn ??
        payload.ordersn ??
        payload.order_sn ??
        payload.orderSn ??
        "",
    ).trim();
    const status = String(
      data.status ??
        data.order_status ??
        data.orderStatus ??
        payload.status ??
        payload.order_status ??
        "",
    )
      .trim()
      .toUpperCase();
    const isOrderStatusPush = code === 3 || Boolean(status);

    // Mọi trạng thái có order_sn đều phải đồng bộ lại chi tiết để cập nhật DB.
    // UNPAID/READY_TO_SHIP là đơn mới thường gặp; các trạng thái khác là chuyển trạng thái.
    if (!orderSn) {
      console.log(
        `[Shopee Webhook] Non-order push skipped code=${Number.isFinite(code) ? code : "?"}` +
          ` status=${status || "?"} — missing order_sn`,
      );
      return;
    }

    console.log("[WEBHOOK] Nhận event mới:", orderSn, status || "");

    // Ghi bản tối thiểu ngay để UI thấy đơn mới; detail đầy đủ vẫn chạy trong worker.
    let eagerPersistedAt: Date | undefined;
    if (eagerStubOrder) {
      try {
        const persisted = await webhookObservation.run({ receivedAt: snapshot.receivedAt }, () => eagerStubOrder(payload));
        if (persisted) eagerPersistedAt = new Date();
      } catch (stubErr) {
        // Không chặn enqueue: worker còn có thể lấy detail và lưu lại đầy đủ.
        console.error("[Shopee Webhook] eager stub failed:", safeError(stubErr));
      }
    }

    const shopId = String(payload.shop_id ?? data.shop_id ?? "").trim();
    const updateTime = String(
      data.update_time ??
        data.updateTime ??
        payload.timestamp ??
        data.timestamp ??
        "0",
    ).trim();
    const jobId = buildWebhookJobId(shopId, orderSn, status, updateTime);
    const queuedMeta = {
      jobId,
      code: Number.isFinite(code) ? code : null,
      shop_id: shopId || null,
      order_sn: orderSn,
      status: status || null,
      update_time: updateTime || "0",
      event_type:
        status === "UNPAID" || status === "READY_TO_SHIP"
          ? "new_order"
          : isOrderStatusPush
            ? "status_change"
            : "order_related",
    };
    try {
      const queued = await enqueueWebhookJob({
        jobId,
        payload,
        receivedAt: snapshot.receivedAt,
        orderPersistedAt: eagerPersistedAt,
      });
      if (queued.duplicate) {
        console.log(
          "[WEBHOOK] idempotent skip — jobId đã có, ACK thành công:",
          JSON.stringify(queuedMeta),
        );
        return;
      }
      console.log(
        "[WEBHOOK RECEIVED] order payload inserted webhook_jobs pending — worker sẽ get_order_detail + UPSERT:",
        JSON.stringify(queuedMeta),
      );
    } catch (queueErr) {
      console.error(
        "[WEBHOOK] enqueue webhook_jobs failed:",
        safeError(queueErr),
      );
      if (onQueueOverflow) {
        try {
          await onQueueOverflow(payload);
        } catch (overflowErr) {
          console.error(
            "[WEBHOOK] overflow fallback failed:",
            safeError(overflowErr),
          );
        }
      }
    }
  } catch (error) {
    console.error(
      "[Shopee Webhook] processShopeeWebhookAsync failed after ACK:",
      safeError(error),
    );
  }
}

export type ShopeeWebhookRouterOptions = {
  /** Khi queue đầy: persist tối thiểu thay vì drop im lặng. */
  onQueueOverflow?: QueueOverflowHandler;
  /** Upsert stub (order_sn, shop_id, status, update_time) trước khi enqueue detail. */
  eagerStubOrder?: EagerStubHandler;
};

/**
 * Tạo endpoint webhook Shopee public.
 * Mọi POST được ACK 200 trước; HMAC, parse, API Shopee và MongoDB chạy ngầm.
 */
export function createShopeeWebhookRouter(
  _processPayload: WebhookProcessor,
  routePath: string | string[] = "/shopee",
  options: ShopeeWebhookRouterOptions = {},
): Router {
  const router = express.Router();
  const paths = (Array.isArray(routePath) ? routePath : [routePath]).map((path) =>
    path.startsWith("/") ? path : `/${path}`,
  );

  console.log(
    "[Shopee Webhook] Queue config mongo=webhook_jobs drainer=setInterval (không xếp RAM)",
  );

  // GET probe cho Shopee verification.
  router.get(paths, (_req, res) => {
    ackShopeeOk(res);
  });

  router.post(paths, (req, res) => {
    // Lấy mốc ngay khi vào handler, trước đọc body và gửi ACK.
    const receivedAt = new Date();
    console.log("[WEBHOOK TRIGGERED]");
    console.log(
      "[WEBHOOK TRIGGERED] meta",
      JSON.stringify({
        url: req.originalUrl || req.url,
        contentType: req.get("content-type") || "",
        contentLength: req.get("content-length") || "0",
        authorizationPresent: Boolean(readAuthorizationHeader(req)),
        bodyAlreadyParsed: req.body != null,
      }),
    );

    // 1) Gắn listener đọc raw body TRƯỚC ACK — tránh Node _dump() nuốt stream.
    const rawBodyPromise = readRawWebhookBody(req);
    const rawBodyWatch = setTimeout(() => {
      console.error(
        "[WEBHOOK] SILENT? raw body chưa emit end sau 8s — listener có thể gắn sau khi stream đã bị consume. ACK đã gửi nên Shopee không retry.",
      );
    }, 8_000);
    // Xử lý cả nhánh reject để tránh unhandled rejection làm process thoát.
    void rawBodyPromise.then(() => clearTimeout(rawBodyWatch), () => clearTimeout(rawBodyWatch));

    // 2) ACK 200 ngay — không chờ HMAC / API Shopee / MongoDB.
    ackShopeeOk(res);

    // 3) Snapshot; tuyệt đối không truyền `res` vào tiến trình nền.
    const snapshot: WebhookRequestSnapshot = {
      // Đo từ HTTP tiếp nhận, bao gồm thời gian đọc body và chờ hàng đợi.
      receivedAt,
      routeLabel: `POST ${req.originalUrl || req.url}`,
      authorization: readAuthorizationHeader(req),
      requestUrls: buildWebhookUrlCandidates(req),
      contentLength: req.get("content-length") || "0",
      contentType: req.get("content-type") || "",
      host: req.get("host") || "",
    };

    // 4) HMAC → parse → insert webhook_jobs. get_order_detail chạy ở drainer.
    void processShopeeWebhookAsync(
      snapshot,
      rawBodyPromise,
      options.eagerStubOrder,
      options.onQueueOverflow,
    ).catch((error) => {
      console.error("Lỗi xử lý ngầm Webhook Shopee:", safeError(error));
    });
  });

  return router;
}
