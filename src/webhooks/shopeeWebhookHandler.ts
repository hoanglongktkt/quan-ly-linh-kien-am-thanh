import express, { type Router } from "express";
import { parseShopeeJson } from "../../services/shopee/jsonBig.js";
import { resolveAppBaseUrl } from "../../utils/appPaths.js";
import { verifyShopeeWebhookSignature } from "./shopeeSignature.ts";
import { ingestShopeeChatPush } from "../../services/shopee/chat.js";
import { enqueueWebhookJob } from "../../services/webhookJobQueue.js";

type WebhookProcessor = (payload: Record<string, unknown>) => Promise<void>;
type QueueOverflowHandler = (payload: Record<string, unknown>) => void | Promise<void>;
/** Ghi nông order_sn/shop/status trước khi xếp hàng get_order_detail. Lỗi không được chặn enqueue. */
type EagerStubHandler = (payload: Record<string, unknown>) => void | Promise<void>;

/** Mốc push cuối cùng — /api/health dùng để biết webhook còn sống hay đã chết. */
let lastWebhookAt = 0;

function markWebhookReceived(): void {
  lastWebhookAt = Date.now();
}

export function getShopeeWebhookStats(): {
  pid: number;
  lastWebhookAt: string | null;
} {
  return {
    pid: process.pid,
    lastWebhookAt: lastWebhookAt ? new Date(lastWebhookAt).toISOString() : null,
  };
}

function unwrapWebhookData(payload: Record<string, unknown>): Record<string, unknown> {
  const raw = payload.data;
  if (typeof raw === "string" && raw.trim()) {
    try {
      const parsed: unknown = parseShopeeJson(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      /* giữ envelope */
    }
  }
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  return payload;
}

function coerceWebhookPayload(payload: Record<string, unknown>): Record<string, unknown> {
  const data = unwrapWebhookData(payload);
  if (data === payload) return payload;
  if (payload.data && typeof payload.data === "object" && !Array.isArray(payload.data)) {
    return payload;
  }
  return { ...payload, data };
}

export function webhookOrderKey(payload: Record<string, unknown>): string {
  const data = unwrapWebhookData(payload);
  const shopId = String(payload.shop_id ?? data.shop_id ?? "").trim();
  const orderSn = String(
    data.ordersn ?? data.order_sn ?? data.orderSn ?? payload.ordersn ?? payload.order_sn ?? "",
  ).trim();
  return orderSn ? `${shopId}:${orderSn}` : "";
}

function ackShopeeOk(res: express.Response): void {
  if (res.headersSent || res.writableEnded) return;
  try {
    // Shopee Live Push: HTTP 200 = push thành công.
    // Kết thúc response ngay, không giữ socket chờ parse / API Shopee / MongoDB.
    res.status(200).send("OK");
  } catch (ackErr) {
    console.warn("[Shopee Webhook] ACK send failed:", ackErr);
    try {
      if (!res.writableEnded) res.end();
    } catch {
      /* ignore */
    }
  }
}

function readAuthorizationHeader(req: express.Request): string {
  const headers = req.headers as Record<string, unknown>;
  return String(
    req.get("authorization") ||
      req.get("Authorization") ||
      headers.authorization ||
      headers.Authorization ||
      headers.http_authorization ||
      process.env.HTTP_AUTHORIZATION ||
      "",
  ).trim();
}

function buildWebhookUrlCandidates(req: express.Request): string[] {
  const path = String(req.originalUrl || req.url || "")
    .split("?")[0]
    .trim();
  const candidates = new Set<string>();
  const base = resolveAppBaseUrl().replace(/\/$/, "");
  const configured = String(process.env.SHOPEE_WEBHOOK_URL || "").trim();
  if (configured) candidates.add(configured.replace(/\/$/, ""));
  candidates.add(`${base}/api/shopee/webhook`);

  if (path.startsWith("/")) {
    candidates.add(`${base}${path}`);

    const forwardedProto = String(req.get("x-forwarded-proto") || "")
      .split(",")[0]
      .trim();
    const forwardedHost = String(req.get("x-forwarded-host") || "")
      .split(",")[0]
      .trim();
    if (forwardedProto && forwardedHost) {
      candidates.add(`${forwardedProto}://${forwardedHost}${path}`);
    }

    const host = String(req.get("host") || "").trim();
    if (host) {
      candidates.add(`${req.protocol}://${host}${path}`);
      candidates.add(`https://${host}${path}`);
      candidates.add(`http://${host}${path}`);
    }
  }

  return [...candidates];
}

/** Parse body Buffer | object | string → object payload (Shopee v2 Push). uint64 → string. */
function parseWebhookBody(reqBody: unknown): Record<string, unknown> | null {
  try {
    if (Buffer.isBuffer(reqBody)) {
      const text = reqBody.toString("utf8");
      if (!text.trim()) return null;
      const parsed: unknown = parseShopeeJson(text);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return coerceWebhookPayload(parsed as Record<string, unknown>);
      }
      return null;
    }
    if (typeof reqBody === "string") {
      const text = reqBody.trim();
      if (!text) return null;
      const parsed: unknown = parseShopeeJson(text);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return coerceWebhookPayload(parsed as Record<string, unknown>);
      }
      return null;
    }
    if (reqBody && typeof reqBody === "object" && !Array.isArray(reqBody)) {
      return coerceWebhookPayload(reqBody as Record<string, unknown>);
    }
  } catch (err) {
    console.error("[Shopee Webhook] JSON parse failed:", err);
  }
  return null;
}

type WebhookRequestSnapshot = {
  routeLabel: string;
  authorization: string;
  requestUrls: string[];
  contentLength: string;
  contentType: string;
  host: string;
};

function readRawWebhookBody(req: express.Request): Promise<Buffer | null> {
  const maxBytes = 1024 * 1024;
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let overflow = false;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      req.removeListener("data", onData);
      req.removeListener("end", onEnd);
      req.removeListener("error", onError);
    };

    timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error("Webhook body stream timeout"));
    }, 10_000);

    const onData = (chunk: Buffer | string) => {
      if (settled) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalBytes += buffer.length;
      if (totalBytes > maxBytes) {
        overflow = true;
        return;
      }
      chunks.push(buffer);
    };

    const onEnd = () => {
      if (settled) return;
      settled = true;
      cleanup();
      if (overflow) {
        console.warn(`[Shopee Webhook] Body vượt giới hạn ${maxBytes} bytes — bỏ xử lý sau ACK.`);
        resolve(null);
        return;
      }
      resolve(Buffer.concat(chunks));
    };

    const onError = (err: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };

    req.on("data", onData);
    req.on("end", onEnd);
    req.on("error", onError);
  });
}

function buildWebhookJobId(
  shopId: string,
  orderSn: string,
  status: string,
  updateTime: string,
): string {
  const clean = (value: string, fallback: string) => {
    const text = String(value || "").trim().replace(/[^\w.:-]/g, "");
    return text || fallback;
  };
  return [
    clean(shopId, "0"),
    clean(orderSn, "0"),
    clean(status, "UNKNOWN"),
    clean(updateTime, "0"),
  ].join("_");
}

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
    console.log("[WEBHOOK RECEIVED] req.body (full):", rawBody.toString("utf8"));

    const payload = parseWebhookBody(rawBody);
    if (!payload) {
      console.log("[Shopee Webhook] Invalid JSON after ACK — nothing to process.");
      return;
    }

    console.log("[WEBHOOK RECEIVED] req.body (parsed object):", JSON.stringify(payload));

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

    if (eagerStubOrder) {
      try {
        await eagerStubOrder(payload);
      } catch (stubErr) {
        console.error("[WEBHOOK DB ERROR]:", stubErr);
        console.error("Stub order error:", stubErr);
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
      const queued = await enqueueWebhookJob({ jobId, payload });
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
        queueErr instanceof Error ? queueErr.message : queueErr,
      );
      if (onQueueOverflow) {
        try {
          await onQueueOverflow(payload);
        } catch (overflowErr) {
          console.error(
            "[WEBHOOK] overflow fallback failed:",
            overflowErr instanceof Error ? overflowErr.message : overflowErr,
          );
        }
      }
    }
  } catch (error) {
    console.error(
      "[Shopee Webhook] processShopeeWebhookAsync failed after ACK:",
      error instanceof Error ? error.stack || error.message : error,
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
    console.log("\n--- [WEBHOOK TRIGGERED] ---", JSON.stringify(req.body));
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
    void rawBodyPromise.finally(() => clearTimeout(rawBodyWatch));

    // 2) ACK 200 ngay — không chờ HMAC / API Shopee / MongoDB.
    ackShopeeOk(res);

    // 3) Snapshot; tuyệt đối không truyền `res` vào tiến trình nền.
    const snapshot: WebhookRequestSnapshot = {
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
      console.error("Lỗi xử lý ngầm Webhook Shopee:", error);
    });
  });

  return router;
}
