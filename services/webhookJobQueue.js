/**
 * Mongo queue cho webhook Shopee.
 * HTTP chỉ insert job pending. setInterval drain gọi processor (get_order_detail + upsert).
 * Claim bằng findOneAndUpdate để nhiều process Passenger không lấy cùng một job.
 */
import WebhookJob from "../models/WebhookJob.js";
import crypto from "node:crypto";
import { safeError } from "../utils/safeProductionLog.js";
import { acquireShopeeSyncLease, releaseShopeeSyncLease, renewShopeeSyncLease } from "./orderSync/syncOrchestrator.js";

const DRAIN_INTERVAL_MS = 8_000;
const BATCH_LIMIT = 5;
const JOB_GAP_MS = 400;
const MAX_RETRY = 5;
/** Heartbeat cho running; hết hạn không được tự cướp job đang xử lý. */
const RUNNING_LEASE_MS = 4 * 60 * 1000;
/**
 * Push cũ hơn ngưỡng này bỏ qua (cron đã đồng bộ) — status trong payload cũ không được
 * kéo lùi đơn đang ở tab khác.
 */
const STALE_JOB_MAX_AGE_MS = 15 * 60 * 1000;
const STALE_SWEEP_INTERVAL_MS = 60_000;
const STALE_SKIP_LOG = "stale_job_dead_letter";

let timer = null;
let draining = false;
let processor = null;
let syncProcessor = null;
let releasePendingOwner = "";

/** API chỉ trả ACK sau khi job đã lưu thành công vào Mongo. */
export async function enqueueOrderSyncJob(payload = {}, priority = 0) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)
    || !Number.isFinite(priority) || priority < 0 || priority > 10
    || (payload.mode && !["quick", "full", "task"].includes(payload.mode))
    || (payload.shopIds && (!Array.isArray(payload.shopIds) || payload.shopIds.some((id) => !/^\d+$/.test(String(id)))))
    || (payload.lookbackSec != null && (!Number.isFinite(Number(payload.lookbackSec)) || Number(payload.lookbackSec) < 60))) {
    throw new Error("sync_job_invalid");
  }
  const jobId = `sync:${crypto.randomUUID()}`;
  const activeKey = priority === 0 ? crypto.createHash("sha256").update(JSON.stringify({
    mode: payload.mode || "incremental", task: payload.task || "", shopIds: [...(payload.shopIds || [])].sort(),
    lookbackSec: payload.lookbackSec || 0,
  })).digest("hex") : null;
  try {
    await WebhookJob.create({ jobId, kind: "sync", priority, payload, state: "pending", next_run_at: new Date(),
      ...(activeKey ? { active_key: activeKey } : {}) });
  } catch (error) {
    if (!activeKey || !isDuplicateKeyError(error)) throw error;
    return { accepted: true, busy: true, duplicate: true, background: true, message: "Job đồng bộ cùng loại đã có trong hàng đợi" };
  }
  return { accepted: true, busy: false, jobId, background: true, message: "Đã xếp hàng đồng bộ" };
}

export function setOrderSyncJobProcessor(handler) {
  syncProcessor = handler;
}

/** Kiểm tra tuổi sự kiện cả khi webhook cũ vừa được gửi lại hôm nay. */
export function webhookEventTime(payload) {
  const data = payload?.data && typeof payload.data === "object" ? payload.data : payload;
  const raw = data?.update_time ?? data?.updateTime ?? payload?.timestamp ?? data?.timestamp;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return null;
  return value < 1e12 ? value * 1000 : value;
}

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function isDuplicateKeyError(err) {
  const code = err?.code ?? err?.cause?.code;
  if (code === 11000 || code === 11001) return true;
  const msg = String(err?.message || "");
  return msg.includes("E11000") || msg.includes("duplicate key");
}

/** 1 phút, rồi 2 phút — không vượt 2 phút. */
function backoffMs(retryCount) {
  const n = Number(retryCount) || 1;
  if (n <= 1) return 60_000;
  return 120_000;
}

/**
 * @param {{ jobId: string, payload: Record<string, unknown> }} input
 * @returns {Promise<{ ok: boolean, duplicate: boolean, jobId: string }>}
 */
export async function enqueueWebhookJob(input) {
  const jobId = String(input?.jobId || "").trim();
  const payload = input?.payload;
  if (!jobId || !payload || typeof payload !== "object") {
    throw new Error("webhook_job_invalid");
  }
  const data = payload.data && typeof payload.data === "object" ? payload.data : payload;
  const shopId = String(payload.shop_id ?? payload.shopId ?? data.shop_id ?? data.shopId ?? "").trim();
  const orderSn = String(data.ordersn ?? data.order_sn ?? data.orderSn ?? payload.order_sn ?? "").trim();
  if (!/^\d+$/.test(shopId) || !/^[a-zA-Z0-9-]+$/.test(orderSn)) throw new Error("webhook_order_key_invalid");
  const stale = webhookEventTime(payload) != null && Date.now() - webhookEventTime(payload) > STALE_JOB_MAX_AGE_MS;
  try {
    await WebhookJob.create({
      jobId,
      payload,
      kind: "webhook",
      orderKey: `${shopId}:${orderSn}`,
      state: stale ? "dead-letter" : "pending",
      retry_count: 0,
      error_log: stale ? STALE_SKIP_LOG : "",
      next_run_at: new Date(),
    });
    if (stale) console.warn("[WebhookJobQueue] stale_event_dead_letter");
    return { ok: true, duplicate: false, jobId };
  } catch (err) {
    if (isDuplicateKeyError(err)) {
      return { ok: true, duplicate: true, jobId };
    }
    throw err;
  }
}

async function claimNextJob() {
  const now = new Date();
  const leaseUntil = new Date(now.getTime() + RUNNING_LEASE_MS);
  return WebhookJob.findOneAndUpdate(
    {
      $or: [
        { state: "pending", next_run_at: { $lte: now } },
        { state: "failed", next_run_at: { $lte: now }, retry_count: { $lt: MAX_RETRY } },
        // Không claim lại running: worker có thể vẫn đang chờ API/DB.
      ],
    },
    [
      {
        $set: {
          retry_count: {
            $cond: [{ $eq: ["$state", "running"] }, { $add: ["$retry_count", 1] }, "$retry_count"],
          },
          state: "running",
          claim_token: crypto.randomUUID(),
          next_run_at: leaseUntil,
        },
      },
    ],
    // Mongoose 9 chặn update dạng mảng (pipeline) nếu thiếu updatePipeline.
    { sort: { priority: -1, next_run_at: 1, _id: 1 }, returnDocument: "after", updatePipeline: true },
  ).lean();
}

let lastStaleSweepAt = 0;

/** Đánh dấu job pending/failed quá hạn là đã bỏ qua — 1 lệnh updateMany, tối đa 1 lần/phút. */
async function sweepStaleJobs() {
  const now = Date.now();
  if (now - lastStaleSweepAt < STALE_SWEEP_INTERVAL_MS) return;
  lastStaleSweepAt = now;
  const cutoff = new Date(now - STALE_JOB_MAX_AGE_MS);
  const result = await WebhookJob.updateMany(
    { kind: { $ne: "sync" }, state: { $in: ["pending", "failed"] }, createdAt: { $lt: cutoff } },
    { $set: { state: "dead-letter", error_log: STALE_SKIP_LOG, next_run_at: new Date(now) } },
  );
  if (result?.modifiedCount) {
    console.warn(
      `[WebhookJobQueue] stale sweep: bỏ qua ${result.modifiedCount} job cũ hơn ${STALE_JOB_MAX_AGE_MS / 60000} phút`,
    );
  }
}

function isStaleJob(job) {
  if (job?.kind === "sync") return false;
  const created = job?.createdAt ? new Date(job.createdAt).getTime() : NaN;
  const eventAt = webhookEventTime(job?.payload);
  return (Number.isFinite(created) && Date.now() - created > STALE_JOB_MAX_AGE_MS)
    || (eventAt != null && Date.now() - eventAt > STALE_JOB_MAX_AGE_MS);
}

async function markSucceeded(job, note = "") {
  await WebhookJob.updateOne(
    { _id: job._id, state: "running", claim_token: job.claim_token },
    { $set: { state: "succeeded", error_log: note, next_run_at: new Date() }, $unset: { active_key: "" } },
  );
}

async function markFailed(job, err) {
  const retry = Number(job.retry_count || 0) + 1;
  const message = safeError(err);
  const nextRun = new Date(Date.now() + backoffMs(retry));
  const result = await WebhookJob.updateOne(
    { _id: job._id, state: "running", claim_token: job.claim_token },
    {
      $set: {
        state: retry >= MAX_RETRY ? "dead-letter" : "failed",
        retry_count: retry,
        error_log: message,
        next_run_at: nextRun,
      },
      ...(retry >= MAX_RETRY ? { $unset: { active_key: "" } } : {}),
    },
  );
  if (!result.matchedCount) {
    console.warn(
      `[WebhookJobQueue] skip fail-write jobId=${job.jobId} — job đã bị claim lại`,
    );
    return;
  }
  console.error(
    `[WebhookJobQueue] job failed jobId=${job.jobId} retry=${retry}/${MAX_RETRY} next_run_at=${nextRun.toISOString()} — ${message}`,
  );
}

async function runClaimedJob(job) {
  if (typeof processor !== "function") {
    throw new Error("webhook_job_processor_missing");
  }
  if (isStaleJob(job)) {
    await WebhookJob.updateOne(
      { _id: job._id, state: "running", claim_token: job.claim_token },
      { $set: { state: "dead-letter", error_log: STALE_SKIP_LOG } },
    );
    console.warn("[WebhookJobQueue] stale_job_dead_letter");
    return false;
  }
  // Gia hạn theo thời gian thực; claim_token giữ quyền sở hữu qua mỗi heartbeat.
  const heartbeat = setInterval(() => {
    void WebhookJob.updateOne(
      { _id: job._id, state: "running", claim_token: job.claim_token },
      { $set: { next_run_at: new Date(Date.now() + RUNNING_LEASE_MS) } },
    ).catch(() => console.warn("[WebhookJobQueue] heartbeat_failed"));
  }, 30_000);
  heartbeat.unref?.();
  try {
    if (job.kind === "sync") {
      if (typeof syncProcessor !== "function") throw new Error("sync_processor_missing");
      const result = await syncProcessor(job.payload);
      if (result?.success === false || result?.skipped) throw new Error("sync_job_incomplete");
    } else {
      await processor(job.payload);
    }
    await markSucceeded(job);
  } finally {
    clearInterval(heartbeat);
  }
  return true;
}

export async function drainOnce(processPayload) {
  // Cho phép chạy một lượt có kiểm soát để kiểm thử hoặc vận hành nội bộ.
  if (typeof processPayload === "function") processor = processPayload;
  if (draining) return;
  if (typeof processor !== "function") return;
  draining = true;
  let leaseOwner = "";
  let leaseHeartbeat = null;
  try {
    // Nếu DB lỗi lúc finally, thử nhả lại khóa của tác vụ đã kết thúc.
    if (releasePendingOwner) {
      await releaseShopeeSyncLease(releasePendingOwner);
      releasePendingOwner = "";
    }
    // Tất cả process dùng chung khóa trước khi claim, tránh chạy cron và quick song song.
    const lease = await acquireShopeeSyncLease("shared_queue");
    if (!lease.acquired) return;
    leaseOwner = lease.owner;
    // Có khóa toàn cục nghĩa là không worker hàng đợi nào đang chạy.
    // Job running tồn dư được cách ly, không phát lại payload có thể đã ghi một phần.
    const abandoned = await WebhookJob.updateMany(
      { state: "running" },
      { $set: { state: "dead-letter", error_log: "abandoned_worker_requires_review" }, $unset: { active_key: "" } },
    );
    if (abandoned.modifiedCount) console.warn(`[WebhookJobQueue] abandoned_dead_letter count=${abandoned.modifiedCount}`);
    leaseHeartbeat = setInterval(() => {
      void renewShopeeSyncLease(leaseOwner).catch(() => console.warn("[WebhookJobQueue] global_heartbeat_failed"));
    }, 30_000);
    leaseHeartbeat.unref?.();
    try {
      await sweepStaleJobs();
    } catch (sweepErr) {
      console.error("[WebhookJobQueue] stale sweep failed:", safeError(sweepErr));
    }
    for (let i = 0; i < BATCH_LIMIT; i += 1) {
      let job = null;
      try {
        job = await claimNextJob();
      } catch (claimErr) {
        console.error(
          "[WebhookJobQueue] claim failed:",
          safeError(claimErr),
        );
        break;
      }
      if (!job) break;
      try {
        const processed = await runClaimedJob(job);
        console.log(
          processed
            ? `[WebhookJobQueue] job succeeded jobId=${job.jobId}`
            : `[WebhookJobQueue] job stale skipped jobId=${job.jobId}`,
        );
      } catch (jobErr) {
        try {
          await markFailed(job, jobErr);
        } catch (writeErr) {
          console.error(
            `[WebhookJobQueue] markFailed crashed jobId=${job.jobId}:`,
            safeError(writeErr),
          );
        }
      }
      if (i < BATCH_LIMIT - 1) {
        await delay(JOB_GAP_MS);
      }
    }
  } catch (err) {
    console.error("[WebhookJobQueue] drainOnce failed:", safeError(err));
  } finally {
    if (leaseHeartbeat) clearInterval(leaseHeartbeat);
    if (leaseOwner) {
      try { await releaseShopeeSyncLease(leaseOwner); }
      catch {
        releasePendingOwner = leaseOwner;
        console.warn("[WebhookJobQueue] release_failed_will_retry");
      }
    }
    draining = false;
  }
}

/**
 * @param {(payload: Record<string, unknown>) => Promise<void>} processPayload
 */
export function startWebhookJobDrainer(processPayload) {
  if (typeof processPayload === "function") {
    processor = processPayload;
  }
  if (timer) return;
  timer = setInterval(() => {
    void drainOnce().catch((err) => {
      console.error("[WebhookJobQueue] drain tick failed:", safeError(err));
    });
  }, DRAIN_INTERVAL_MS);
  if (typeof timer.unref === "function") timer.unref();
  console.log(
    `[WebhookJobQueue] drainer ON interval=${DRAIN_INTERVAL_MS}ms batch=${BATCH_LIMIT} gapMs=${JOB_GAP_MS}`,
  );
  void drainOnce().catch((err) => {
    console.error("[WebhookJobQueue] boot drain failed:", safeError(err));
  });
}

export function stopWebhookJobDrainer() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  console.log("[WebhookJobQueue] drainer OFF");
}
