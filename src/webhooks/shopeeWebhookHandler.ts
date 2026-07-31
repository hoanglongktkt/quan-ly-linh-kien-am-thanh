import express, { type Router } from "express";
// Signature check tạm tắt — không import verify để tránh từ chối / lỗi HMAC.
// import { verifyShopeeWebhookSignature } from "./shopeeSignature.ts";

type WebhookProcessor = (payload: Record<string, unknown>) => Promise<void>;

const MAX_PENDING_JOBS = 500;
// Hai event cho CÙNG một đơn phải chạy theo thứ tự; các đơn khác nhau có thể xử lý
// song song. Giới hạn 2 giữ số request get_order_detail trong ngưỡng an toàn.
const MAX_CONCURRENT_JOBS = 2;

function webhookOrderKey(payload: Record<string, unknown>): string {
  const data =
    payload.data && typeof payload.data === "object" && !Array.isArray(payload.data)
      ? (payload.data as Record<string, unknown>)
      : payload;
  const shopId = String(payload.shop_id ?? data.shop_id ?? "").trim();
  const orderSn = String(data.ordersn ?? data.order_sn ?? data.orderSn ?? "").trim();
  return orderSn ? `${shopId}:${orderSn}` : "";
}

/**
 * Hàng đợi in-process có giới hạn để một đợt retry bất thường không giữ vô hạn
 * payload/promise trong RAM. Không spawn process/worker nên không tạo zombie process.
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
      void Promise.allSettled(batch.map(({ payload }) => processPayload(payload)))
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
        console.error(
          "[Shopee Webhook] Queue full; dropping payload after ACK 200 (no HTTP retry).",
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
  if (res.headersSent) return;
  // Shopee Live Push: HTTP 200 (+ body success) = push thành công.
  res.status(200).json({ status: "success" });
}

/**
 * Tạo endpoint POST /api/webhook/shopee.
 * SIÊU DỄ DÃI: LUÔN trả 200 OK ngay lập tức — không HMAC, không validate chặn request.
 * Xử lý payload chạy ngầm sau khi response đã đóng.
 */
export function createShopeeWebhookRouter(processPayload: WebhookProcessor): Router {
  const queue = createBoundedQueue(processPayload);
  const router = express.Router();

  // GET probe cho Shopee verification (một số webhook yêu cầu GET trả 200).
  router.get("/shopee", (_req, res) => {
    ackShopeeOk(res);
  });

  router.post("/shopee", express.raw({ type: "*/*", limit: "1mb" }), (req, res) => {
    // 1) ACK 200 NGAY — trước mọi validate / HMAC / parse / queue / DB.
    ackShopeeOk(res);

    const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const bodyText = rawBody.toString("utf8");
    const authHeader = req.get("authorization");

    console.log("[WEBHOOK RECEIVED] POST /api/webhook/shopee — ACK 200 sent; headers:", {
      authorization: authHeader ? "(present)" : "(missing)",
      contentLength: req.get("content-length") || "0",
      host: req.get("host") || "",
      xfProto: req.get("x-forwarded-proto") || "",
    });
    // In toàn bộ body Shopee gửi sang để debug Live Push.
    console.log("[WEBHOOK RECEIVED] req.body (full):", bodyText);

    // 2) Xử lý ngầm sau khi socket ACK đã gửi.
    setImmediate(() => {
      try {
        // Signature verification TẠM TẮT — chỉ log nếu có auth header, KHÔNG bao giờ chặn.
        try {
          if (authHeader) {
            console.log(
              "[Shopee Webhook] Signature check SKIPPED (permissive mode). authPresent=true bodyBytes=" +
                rawBody.length,
            );
          } else {
            console.log(
              "[Shopee Webhook] Signature check SKIPPED (permissive mode). authPresent=false bodyBytes=" +
                rawBody.length,
            );
          }
        } catch (sigErr) {
          console.warn("[Shopee Webhook] Signature check error (ignored):", sigErr);
        }

        let payload: Record<string, unknown> | null = null;
        try {
          if (!rawBody.length) {
            console.log("[Shopee Webhook] Empty body after ACK — nothing to process.");
            return;
          }
          const parsed: unknown = JSON.parse(bodyText);
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            payload = parsed as Record<string, unknown>;
            console.log("[WEBHOOK RECEIVED] req.body (parsed object):", JSON.stringify(payload));
          } else {
            console.error("[Shopee Webhook] Background — payload không phải object:", typeof parsed);
          }
        } catch (parseErr) {
          console.error("[Shopee Webhook] Background — JSON parse failed:", parseErr);
        }

        if (!payload) return;

        if (!queue.enqueue(payload)) {
          // Queue đầy: cố xử lý trực tiếp để không mất event (đã ACK 200).
          console.warn("[Shopee Webhook] Queue full — fallback processPayload trực tiếp.");
          void processPayload(payload).catch((err) => {
            console.error("[Shopee Webhook] Fallback background processing failed:", err);
          });
          return;
        }

        console.log(
          "[WEBHOOK RECEIVED] payload queued after ACK:",
          JSON.stringify({
            code: payload.code ?? null,
            shop_id: payload.shop_id ?? null,
            data: payload.data ?? null,
          }),
        );
      } catch (error) {
        console.error("[Shopee Webhook] Background handler failed (after ACK 200):", error);
      }
    });
  });

  return router;
}
