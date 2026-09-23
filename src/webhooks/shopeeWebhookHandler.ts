import express, { type Router } from "express";
import { parseShopeeJson } from "../../services/shopee/jsonBig.js";
import { resolveAppBaseUrl } from "../../utils/appPaths.js";
import { verifyShopeeWebhookSignature } from "./shopeeSignature.ts";

type WebhookProcessor = (payload: Record<string, unknown>) => Promise<void>;
type QueueOverflowHandler = (payload: Record<string, unknown>) => void | Promise<void>;

const MAX_PENDING_JOBS = 200;
// Song song nhiều đơn khác nhau; cùng order_sn vẫn tuần tự. Mặc định 4 (env override).
const MAX_CONCURRENT_JOBS = Math.max(
  2,
  Math.min(8, Number(process.env.SHOPEE_WEBHOOK_MAX_CONCURRENT) || 4),
);
/** Hard cap mỗi job nền — quá hạn thì nhả slot (tránh hang → process leak cPanel). */
const WEBHOOK_JOB_TIMEOUT_MS = 45_000;

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

/** Metric in-process — log trên cPanel, không cần DB. */
const queueMetrics = {
  overflowCount: 0,
  completedJobs: 0,
  failedJobs: 0,
  lastJobDurationMs: 0,
  maxJobDurationMs: 0,
  totalJobDurationMs: 0,
};

function logQueueMetrics(context: string, pending: number, running: number): void {
  const avgMs =
    queueMetrics.completedJobs > 0
      ? Math.round(queueMetrics.totalJobDurationMs / queueMetrics.completedJobs)
      : 0;
  console.log(
    `[Shopee Webhook][Queue] ${context}` +
      ` depth=${pending} running=${running}/${MAX_CONCURRENT_JOBS}` +
      ` overflowCount=${queueMetrics.overflowCount}` +
      ` completed=${queueMetrics.completedJobs} failed=${queueMetrics.failedJobs}` +
      ` lastJobMs=${queueMetrics.lastJobDurationMs} avgJobMs=${avgMs} maxJobMs=${queueMetrics.maxJobDurationMs}`,
  );
}

export function webhookOrderKey(payload: Record<string, unknown>): string {
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
function createBoundedQueue(
  processPayload: WebhookProcessor,
  onQueueOverflow?: QueueOverflowHandler,
) {
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
      logQueueMetrics("job_batch_start", pending.length, running);

      void Promise.allSettled(
        batch.map(({ payload, orderKey }) => {
          const startedAt = Date.now();
          return withJobTimeout(processPayload(payload), WEBHOOK_JOB_TIMEOUT_MS, "webhook_job")
            .then(() => {
              const durationMs = Date.now() - startedAt;
              queueMetrics.completedJobs += 1;
              queueMetrics.lastJobDurationMs = durationMs;
              queueMetrics.totalJobDurationMs += durationMs;
              if (durationMs > queueMetrics.maxJobDurationMs) {
                queueMetrics.maxJobDurationMs = durationMs;
              }
              console.log(
                `[Shopee Webhook][Queue] job_done orderKey=${orderKey || "?"} durationMs=${durationMs}`,
              );
            })
            .catch((err) => {
              queueMetrics.failedJobs += 1;
              const durationMs = Date.now() - startedAt;
              queueMetrics.lastJobDurationMs = durationMs;
              console.error(
                `[Shopee Webhook][Queue] job_failed orderKey=${orderKey || "?"} durationMs=${durationMs}:`,
                err,
              );
              throw err;
            });
        }),
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
          logQueueMetrics("job_batch_end", pending.length, running);
          scheduleDrain();
        });
    });
  };

  return {
    enqueue(payload: Record<string, unknown>): boolean {
      if (pending.length >= MAX_PENDING_JOBS) {
        queueMetrics.overflowCount += 1;
        const orderKey = webhookOrderKey(payload);
        console.error(
          `[Shopee Webhook] Queue full — overflow persist fallback` +
            ` depth=${pending.length} running=${running}` +
            ` overflowCount=${queueMetrics.overflowCount} orderKey=${orderKey || "?"}`,
        );
        if (onQueueOverflow) {
          void Promise.resolve(onQueueOverflow(payload)).catch((overflowErr) => {
            console.error(
              "[Shopee Webhook] onQueueOverflow handler failed:",
              overflowErr?.message || overflowErr,
            );
          });
        }
        return false;
      }
      pending.push(payload);
      logQueueMetrics("enqueue", pending.length, running);
      scheduleDrain();
      return true;
    },
    getMetrics() {
      return {
        ...queueMetrics,
        pendingDepth: pending.length,
        running,
        maxConcurrent: MAX_CONCURRENT_JOBS,
      };
    },
  };
}

function ackShopeeOk(res: express.Response): void {
  if (res.headersSent || res.writableEnded) return;
  try {
    // Shopee Live Push: HTTP 200 = push thành công.
    // Kết thúc response ngay, không giữ socket chờ parse / API Shopee / MongoDB.
    res.status(200).send("success");
  } catch (ackErr) {
    console.warn("[Shopee Webhook] ACK send failed:", ackErr);
    try {
      if (!res.writableEnded) res.end();
    } catch {
      /* ignore */
    }
  }
}

function buildWebhookUrlCandidates(req: express.Request): string[] {
  const path = String(req.originalUrl || req.url || "")
    .split("?")[0]
    .trim();
  if (!path.startsWith("/")) return [];

  const candidates = new Set<string>();
  candidates.add(`${resolveAppBaseUrl().replace(/\/$/, "")}${path}`);

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
  if (host) candidates.add(`${req.protocol}://${host}${path}`);

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
        return parsed as Record<string, unknown>;
      }
      return null;
    }
    if (typeof reqBody === "string") {
      const text = reqBody.trim();
      if (!text) return null;
      const parsed: unknown = parseShopeeJson(text);
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

    req.on("data", (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalBytes += buffer.length;
      if (totalBytes > maxBytes) {
        overflow = true;
        return;
      }
      chunks.push(buffer);
    });
    req.on("end", () => {
      if (overflow) {
        console.warn(`[Shopee Webhook] Body vượt giới hạn ${maxBytes} bytes — bỏ xử lý sau ACK.`);
        resolve(null);
        return;
      }
      resolve(Buffer.concat(chunks));
    });
    req.on("error", reject);
  });
}

async function processShopeeWebhookAsync(
  queue: ReturnType<typeof createBoundedQueue>,
  snapshot: WebhookRequestSnapshot,
  rawBodyPromise: Promise<Buffer | null>,
): Promise<void> {
  const rawBody = await rawBodyPromise;
  if (!rawBody) {
    console.log("[Shopee Webhook] Empty/oversized body after ACK — nothing to process.");
    return;
  }

  const isValid = verifyShopeeWebhookSignature(
    rawBody,
    snapshot.authorization,
    snapshot.requestUrls,
  );
  if (!isValid) {
    console.warn("[Shopee Webhook] Invalid Authorization after ACK — payload ignored.");
    return;
  }

  markWebhookReceived();
  console.log(
    `[WEBHOOK RECEIVED] pid=${process.pid} ${snapshot.routeLabel} — ACK 200 sent; headers:`,
    {
      authorization: "(verified)",
      contentLength: snapshot.contentLength,
      contentType: snapshot.contentType,
      host: snapshot.host,
    },
  );
  console.log("[WEBHOOK RECEIVED] req.body (full):", rawBody.toString("utf8"));

  const payload = parseWebhookBody(rawBody);
  if (!payload) {
    console.log("[Shopee Webhook] Invalid JSON after ACK — nothing to process.");
    return;
  }

  console.log("[WEBHOOK RECEIVED] req.body (parsed object):", JSON.stringify(payload));

  const queued = queue.enqueue(payload);
  if (!queued) return;

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
}

export type ShopeeWebhookRouterOptions = {
  /** Khi queue đầy: persist tối thiểu thay vì drop im lặng. */
  onQueueOverflow?: QueueOverflowHandler;
};

/**
 * Tạo endpoint webhook Shopee public.
 * Mọi POST được ACK 200 trước; HMAC, parse, API Shopee và MongoDB chạy ngầm.
 */
export function createShopeeWebhookRouter(
  processPayload: WebhookProcessor,
  routePath: string | string[] = "/shopee",
  options: ShopeeWebhookRouterOptions = {},
): Router {
  const queue = createBoundedQueue(processPayload, options.onQueueOverflow);
  const router = express.Router();
  const paths = (Array.isArray(routePath) ? routePath : [routePath]).map((path) =>
    path.startsWith("/") ? path : `/${path}`,
  );

  console.log(
    `[Shopee Webhook] Queue config maxConcurrent=${MAX_CONCURRENT_JOBS} maxPending=${MAX_PENDING_JOBS} jobTimeoutMs=${WEBHOOK_JOB_TIMEOUT_MS}`,
  );

  // GET probe cho Shopee verification.
  router.get(paths, (_req, res) => {
    ackShopeeOk(res);
  });

  router.post(paths, (req, res) => {
    // 1) ACK vô điều kiện — không body parser / HMAC / DB nào được chặn phía trước.
    ackShopeeOk(res);

    // 2) Snapshot dữ liệu cần thiết; tuyệt đối không truyền `res` vào tiến trình nền.
    const snapshot: WebhookRequestSnapshot = {
      routeLabel: `POST ${req.originalUrl || req.url}`,
      authorization: req.get("authorization") || "",
      requestUrls: buildWebhookUrlCandidates(req),
      contentLength: req.get("content-length") || "0",
      contentType: req.get("content-type") || "",
      host: req.get("host") || "",
    };
    const rawBodyPromise = readRawWebhookBody(req);

    // 3) HMAC → parse → queue → Shopee API/MongoDB, hoàn toàn sau response.
    void processShopeeWebhookAsync(queue, snapshot, rawBodyPromise).catch((error) => {
      console.error("Lỗi xử lý ngầm Webhook Shopee:", error);
    });
  });

  return router;
}
