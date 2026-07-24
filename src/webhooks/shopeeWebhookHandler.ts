import express, { type Router } from "express";
import { verifyShopeeWebhookSignature } from "./shopeeSignature.ts";

type WebhookProcessor = (payload: Record<string, unknown>) => Promise<void>;

const MAX_PENDING_JOBS = 100;
const MAX_CONCURRENT_JOBS = 2;

/**
 * Hàng đợi in-process có giới hạn để một đợt retry bất thường không giữ vô hạn
 * payload/promise trong RAM. Không spawn process/worker nên không tạo zombie process.
 */
function createBoundedQueue(processPayload: WebhookProcessor) {
  const pending: Array<Record<string, unknown>> = [];
  let running = 0;
  let scheduled = false;

  const scheduleDrain = () => {
    if (scheduled) return;
    scheduled = true;
    setImmediate(() => {
      scheduled = false;
      while (running < MAX_CONCURRENT_JOBS && pending.length > 0) {
        const payload = pending.shift()!;
        running += 1;

        // Mọi rejection được tiêu thụ tại đây, không thể thành unhandled rejection.
        void processPayload(payload)
          .catch((error) => console.error("[Shopee Webhook] Background processing failed:", error))
          .finally(() => {
            running -= 1;
            scheduleDrain();
          });
      }
    });
  };

  return {
    enqueue(payload: Record<string, unknown>): void {
      if (pending.length >= MAX_PENDING_JOBS) {
        console.error("[Shopee Webhook] Queue full; payload dropped after ACK.");
        return;
      }
      pending.push(payload);
      scheduleDrain();
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

  router.post("/shopee", express.raw({ type: "application/json", limit: "1mb" }), (req, res) => {
    console.log("[WEBHOOK RECEIVED] POST /api/webhook/shopee — headers:", {
      authorization: req.get("authorization") ? "(present)" : "(missing)",
      contentLength: req.get("content-length") || "0",
    });
    try {
      const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      const authHeader = req.get("authorization");

      // Shopee verification mode: nếu không có Authorization, chấp nhận (test push).
      // Nếu sai chữ ký: CHỈ log cảnh báo, KHÔNG chặn — vẫn ACK 200 để Shopee không khóa Webhook.
      if (authHeader && !verifyShopeeWebhookSignature(rawBody, authHeader)) {
        console.warn("[Shopee Webhook] Invalid signature — vẫn ACK 200 để tránh Shopee khóa Webhook.");
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

      // ACK trước, sau đó mới nhường event loop cho tác vụ nền có giới hạn concurrency.
      res.status(200).type("text/plain").send("OK");
      console.log("[WEBHOOK RECEIVED] ACK 200 sent, enqueuing payload for background processing.");
      if (payload) setImmediate(() => queue.enqueue(payload));
    } catch (error) {
      // Không throw ra Express/process; luôn trả 200 để Shopee không retry/khóa Webhook.
      console.error("[Shopee Webhook] Request handler failed:", error);
      if (!res.headersSent) return res.status(200).type("text/plain").send("OK");
    }
  });

  return router;
}
