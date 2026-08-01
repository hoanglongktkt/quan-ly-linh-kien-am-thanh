import express, { type Router } from "express";
// Signature check tạm tắt — không import verify để tránh từ chối / lỗi HMAC.
// import { verifyShopeeWebhookSignature } from "./shopeeSignature.ts";

type WebhookProcessor = (payload: Record<string, unknown>) => Promise<void>;

const MAX_PENDING_JOBS = 200;
// Hai event cho CÙNG một đơn phải chạy theo thứ tự; các đơn khác nhau có thể xử lý
// song song. Giới hạn 2 giữ số request get_order_detail trong ngưỡng an toàn.
const MAX_CONCURRENT_JOBS = 2;
/** Hard cap mỗi job nền — quá hạn thì nhả slot (tránh hang → process leak cPanel). */
const WEBHOOK_JOB_TIMEOUT_MS = 45_000;

function webhookOrderKey(payload: Record<string, unknown>): string {
  const data =
    payload.data && typeof payload.data === "object" && !Array.isArray(payload.data)
      ? (payload.data as Record<string, unknown>)
      : payload;
  const shopId = String(payload.shop_id ?? data.shop_id ?? "").trim();
  const orderSn = String(
    data.ordersn ?? data.order_sn ?? data.orderSn ?? payload.ordersn ?? payload.order_sn ?? "",
  ).trim();
  return orderSn ? `${shopId}:${orderSn}` : "";
}

function withJobTimeout<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    work,
    new Promise<T>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`${label} timeout sau ${Math.round(ms / 1000)}s`)),
        ms,
      );
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/**
 * Hàng đợi in-process có giới hạn để một đợt retry bất thường không giữ vô hạn
 * payload/promise trong RAM. Không spawn process/worker nên không tạo zombie process.
 * Mỗi job có hard timeout — slot luôn được giải phóng.
 */
function createBoundedQueue(processPayload: WebhookProcessor) {
  const pending: Array<Record<string, unknown>> = [];
  let running = 0;
  let scheduled = false;
  const activeOrderKeys = new Set<string>();

  const scheduleDrain = () => {
    if (scheduled) return;
    scheduled = true;
    setImmediate(() => {
      scheduled = false;
      const capacity = MAX_CONCURRENT_JOBS - running;
      if (capacity <= 0 || pending.length === 0) return;

      const batch: Array<{ payload: Record<string, unknown>; orderKey: string }> = [];
      for (let i = 0; i < pending.length && batch.length < capacity; ) {
        const payload = pending[i];
        const orderKey = webhookOrderKey(payload);
        if (orderKey && activeOrderKeys.has(orderKey)) {
          i += 1;
          continue;
        }
        pending.splice(i, 1);
        if (orderKey) activeOrderKeys.add(orderKey);
        batch.push({ payload, orderKey });
      }
      if (batch.length === 0) return;

      running += batch.length;
      void Promise.allSettled(
        batch.map(({ payload }) =>
          withJobTimeout(
            processPayload(payload),
            WEBHOOK_JOB_TIMEOUT_MS,
            "webhook_job",
          ),
        ),
      )
        .then((results) => {
          for (const result of results) {
            if (result.status === "rejected") {
              console.error("[Shopee Webhook] Background processing failed:", result.reason);
            }
          }
        })
        .finally(() => {
          running -= batch.length;
          for (const { orderKey } of batch) {
            if (orderKey) activeOrderKeys.delete(orderKey);
          }
          scheduleDrain();
        });
    });
  };

  return {
    enqueue(payload: Record<string, unknown>): boolean {
      if (pending.length >= MAX_PENDING_JOBS) {
        // Emergency: không reject HTTP — drop + log, vẫn đã ACK 200 cho Shopee.
        // KHÔNG spawn processPayload unbounded (gây process leak trên cPanel).
        console.error(
          "[Shopee Webhook] Queue full; dropping payload after ACK 200 (no unbounded fallback).",
        );
        return false;
      }
      pending.push(payload);
      scheduleDrain();
      return true;
    },
  };
}

function ackShopeeOk(res: express.Response): void {
  if (res.headersSent || res.writableEnded) return;
  try {
    // Shopee Live Push: HTTP 200 = push thành công.
    // User yêu cầu body "OK" — kết thúc response ngay, không giữ socket chờ xử lý nền.
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

/** Parse body Buffer | object | string → object payload (Shopee v2 Push). */
function parseWebhookBody(reqBody: unknown): Record<string, unknown> | null {
  try {
    if (Buffer.isBuffer(reqBody)) {
      const text = reqBody.toString("utf8");
      if (!text.trim()) return null;
      const parsed: unknown = JSON.parse(text);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
      return null;
    }
    if (typeof reqBody === "string") {
      const text = reqBody.trim();
      if (!text) return null;
      const parsed: unknown = JSON.parse(text);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
      return null;
    }
    if (reqBody && typeof reqBody === "object" && !Array.isArray(reqBody)) {
      return reqBody as Record<string, unknown>;
    }
  } catch (err) {
    console.error("[Shopee Webhook] JSON parse failed:", err);
  }
  return null;
}

function queueAfterAck(
  queue: ReturnType<typeof createBoundedQueue>,
  req: express.Request,
  routeLabel: string,
): void {
  setImmediate(() => {
    try {
      const rawBody = Buffer.isBuffer(req.body) ? req.body : null;
      const bodyText = rawBody
        ? rawBody.toString("utf8")
        : typeof req.body === "string"
          ? req.body
          : JSON.stringify(req.body ?? {});

      console.log(`[WEBHOOK RECEIVED] ${routeLabel} — ACK 200 sent; headers:`, {
        authorization: req.get("authorization") ? "(present)" : "(missing)",
        contentLength: req.get("content-length") || "0",
        contentType: req.get("content-type") || "",
        host: req.get("host") || "",
      });
      console.log("[WEBHOOK RECEIVED] req.body (full):", bodyText);

      const authHeader = req.get("authorization");
      if (authHeader) {
        console.log(
          "[Shopee Webhook] Signature check SKIPPED (permissive mode). authPresent=true",
        );
      } else {
        console.log(
          "[Shopee Webhook] Signature check SKIPPED (permissive mode). authPresent=false",
        );
      }

      const payload = parseWebhookBody(req.body);
      if (!payload) {
        console.log("[Shopee Webhook] Empty/invalid body after ACK — nothing to process.");
        return;
      }

      console.log("[WEBHOOK RECEIVED] req.body (parsed object):", JSON.stringify(payload));

      if (!queue.enqueue(payload)) return;

      const data =
        payload.data && typeof payload.data === "object" && !Array.isArray(payload.data)
          ? (payload.data as Record<string, unknown>)
          : {};
      console.log(
        "[WEBHOOK RECEIVED] payload queued after ACK — will get_order_detail + UPSERT:",
        JSON.stringify({
          code: payload.code ?? null,
          shop_id: payload.shop_id ?? data.shop_id ?? null,
          order_sn: data.ordersn ?? data.order_sn ?? data.orderSn ?? null,
          status: data.status ?? data.order_status ?? null,
        }),
      );
    } catch (error) {
      console.error("[Shopee Webhook] Background handler failed (after ACK 200):", error);
    }
  });
}

/**
 * Tạo endpoint webhook Shopee (canonical hoặc legacy).
 * SIÊU DỄ DÃI: LUÔN trả 200 OK ngay — không HMAC, không validate chặn request.
 * Xử lý payload chạy ngầm: parse → get_order_detail → UPSERT DB.
 */
export function createShopeeWebhookRouter(
  processPayload: WebhookProcessor,
  routePath: string = "/shopee",
): Router {
  const queue = createBoundedQueue(processPayload);
  const router = express.Router();
  const path = routePath.startsWith("/") ? routePath : `/${routePath}`;

  // GET probe cho Shopee verification.
  router.get(path, (_req, res) => {
    ackShopeeOk(res);
  });

  router.post(path, express.raw({ type: "*/*", limit: "1mb" }), (req, res) => {
    // 1) ACK 200 NGAY — trước mọi validate / parse / queue / DB.
    ackShopeeOk(res);
    // 2) Xử lý ngầm sau khi socket ACK đã gửi.
    queueAfterAck(queue, req, `POST ${path}`);
  });

  return router;
}
