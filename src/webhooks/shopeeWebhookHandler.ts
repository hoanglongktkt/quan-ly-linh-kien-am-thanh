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

  router.post("/shopee", express.raw({ type: "application/json", limit: "1mb" }), (req, res) => {
    try {
      const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      if (!verifyShopeeWebhookSignature(rawBody, req.get("authorization"))) {
        return res.status(403).json({ error: "Invalid signature" });
      }

      let payload: Record<string, unknown>;
      try {
        const parsed: unknown = JSON.parse(rawBody.toString("utf8"));
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          return res.status(400).json({ error: "Invalid payload" });
        }
        payload = parsed as Record<string, unknown>;
      } catch {
        return res.status(400).json({ error: "Invalid payload" });
      }

      // ACK trước, sau đó mới nhường event loop cho tác vụ nền có giới hạn concurrency.
      res.status(200).type("text/plain").send("success");
      setImmediate(() => queue.enqueue(payload));
    } catch (error) {
      // Không throw ra Express/process; nếu response chưa đóng thì trả lỗi an toàn.
      console.error("[Shopee Webhook] Request handler failed:", error);
      if (!res.headersSent) return res.status(500).json({ error: "Webhook processing failed" });
    }
  });

  return router;
}
