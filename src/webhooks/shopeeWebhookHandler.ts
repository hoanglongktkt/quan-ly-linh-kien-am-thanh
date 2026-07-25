import express, { type Router } from "express";
import { verifyShopeeWebhookSignature } from "./shopeeSignature.ts";

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
      for (let i = 0; i < pending.length && batch.length < capacity;) {
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
        console.error("[Shopee Webhook] Queue full; request must be retried by Shopee.");
        return false;
      }
      pending.push(payload);
      scheduleDrain();
      return true;
    },
  };
}

/**
 * Tạo endpoint POST /api/webhook/shopee.
 * Response được đóng trước khi payload được đưa vào queue; vì vậy I/O DB/API chậm
 * không giữ socket Shopee mở và không kích hoạt retry hàng loạt.
 */
export function createShopeeWebhookRouter(processPayload: WebhookProcessor): Router {
  const queue = createBoundedQueue(processPayload);
  const router = express.Router();

  // GET probe cho Shopee verification (một số webhook yêu cầu GET trả 200).
  router.get("/shopee", (_req, res) => {
    res.status(200).type("text/plain").send("success");
  });

  router.post("/shopee", express.raw({ type: "*/*", limit: "1mb" }), (req, res) => {
    console.log("[WEBHOOK RECEIVED] POST /api/webhook/shopee — headers:", {
      authorization: req.get("authorization") ? "(present)" : "(missing)",
      contentLength: req.get("content-length") || "0",
      host: req.get("host") || "",
      xfProto: req.get("x-forwarded-proto") || "",
    });
    try {
      const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      const authHeader = req.get("authorization");

      // Shopee HMAC = URL + "|" + rawBody. URL phải khớp Push URL đã đăng ký trên Console.
      const configured =
        String(process.env.SHOPEE_WEBHOOK_URL || process.env.APP_URL || process.env.API_BASE_URL || "")
          .trim()
          .replace(/\/$/, "");
      const forwardedProto = String(req.get("x-forwarded-proto") || "")
        .split(",")[0]
        .trim();
      const proto = forwardedProto || req.protocol || "https";
      const host = String(req.get("x-forwarded-host") || req.get("host") || "")
        .split(",")[0]
        .trim();
      const pathName = String(req.originalUrl || req.url || "/api/webhook/shopee").split("?")[0];
      const urlCandidates = [
        configured ? `${configured}/api/webhook/shopee` : "",
        configured ? `${configured}${pathName}` : "",
        host ? `${proto}://${host}${pathName}` : "",
        host ? `https://${host}${pathName}` : "",
        host ? `http://${host}${pathName}` : "",
        "https://quanly.linhkienamthanh.net/api/webhook/shopee",
        "https://api.linhkienamthanh.net/api/webhook/shopee",
      ].filter(Boolean);

      if (!verifyShopeeWebhookSignature(rawBody, authHeader, urlCandidates)) {
        console.warn("[Shopee Webhook] Missing or invalid signature; request rejected.");
        return res.status(401).type("text/plain").send("Unauthorized");
      }

      let payload: Record<string, unknown> | null = null;
      try {
        const parsed: unknown = JSON.parse(rawBody.toString("utf8"));
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          payload = parsed as Record<string, unknown>;
        } else {
          console.warn("[Shopee Webhook] Payload không hợp lệ (không phải object) — vẫn ACK 200.");
        }
      } catch (parseErr) {
        console.warn("[Shopee Webhook] JSON parse failed — vẫn ACK 200:", parseErr);
      }

      if (!payload) {
        return res.status(400).type("text/plain").send("Invalid JSON payload");
      }
      // Chỉ ACK sau khi payload đã được nhận vào queue. Nếu queue đầy, Shopee sẽ retry
      // thay vì đơn bị mất vĩnh viễn sau HTTP 200.
      if (!queue.enqueue(payload)) {
        return res.status(503).type("text/plain").send("Webhook queue busy");
      }
      res.status(200).type("text/plain").send("OK");
      console.log("[WEBHOOK RECEIVED] ACK 200 sent; payload queued for background processing.");
    } catch (error) {
      console.error("[Shopee Webhook] Request handler failed:", error);
      if (!res.headersSent) return res.status(500).type("text/plain").send("Internal Server Error");
    }
  });

  return router;
}
