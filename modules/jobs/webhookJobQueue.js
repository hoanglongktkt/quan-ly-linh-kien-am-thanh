// Module miền nghiệp vụ; giữ nguyên hành vi và trạng thái dùng chung.
/**
 * Mongo queue cho webhook Shopee.
 * HTTP chỉ insert job pending. setInterval drain gọi processor (get_order_detail + upsert).
 * Claim bằng findOneAndUpdate để nhiều process Passenger không lấy cùng một job.
 */
import WebhookJob from "../../models/WebhookJob.js";
import crypto from "node:crypto";
import { webhookObservation, syncObservation } from "../operations/telemetry.js";
import { recordStallDiagnostic } from "../operations/stallDiagnostics.js";
import { withYieldableSync } from "../shopee-sync/syncYield.js";
import { safeError } from "../../utils/safeProductionLog.js";
import { acquireShopeeSyncLease, releaseShopeeSyncLease, renewShopeeSyncLease } from "../shopee-sync/syncOrchestrator.js";
import { webhookQueueConfig } from "./webhookQueueConfig.js";

const { intervalMs: DRAIN_INTERVAL_MS, batchLimit: BATCH_LIMIT, jobGapMs: JOB_GAP_MS } = webhookQueueConfig();
export const WORKER_REVISION = 5;
const MAX_RETRY = 5;
/** Heartbeat cho running; hết hạn không được tự cướp job đang xử lý. */
const RUNNING_LEASE_MS = 4 * 60 * 1000;
/**
 * Chặn một webhook/API/Mongo bị treo giữ khóa toàn cục vô hạn.
 * 4 phút vẫn đủ cho get_order_detail retry + fallback tuần tự của một đơn.
 */
const JOB_EXECUTION_TIMEOUT_MS = 4 * 60 * 1000;
/**
 * Push cũ hơn ngưỡng này bỏ qua (cron đã đồng bộ) — status trong payload cũ không được
 * kéo lùi đơn đang ở tab khác.
 */
const STALE_JOB_MAX_AGE_MS = 15 * 60 * 1000;
/** Backlog pending quá 60 phút đã được incremental sync bù; bỏ để ưu tiên đơn mới. */
const PENDING_BACKLOG_MAX_AGE_MS = 60 * 60 * 1000;
const STALE_SWEEP_INTERVAL_MS = 60_000;
const STALE_SKIP_LOG = "stale_job_dead_letter";

let timer = null;
let draining = false;
let processor = null;
let syncProcessor = null;
let releasePendingOwner = "";
let wakeTimer = null;
let wakeRequested = false;

// Coalesce bursts, but do not make a newly persisted order wait for the poll.
function wakeDrainer(delayMs = 0) {
  if (draining) { wakeRequested = true; return; }
  if (!timer || wakeTimer) return;
  wakeTimer = setTimeout(() => {
    wakeTimer = null;
    void drainOnce();
  }, delayMs);
  wakeTimer.unref?.();
}

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
  const activeKey = priority < 10 ? crypto.createHash("sha256").update(JSON.stringify({
    mode: payload.mode || "incremental", task: payload.task || "", shopIds: [...(payload.shopIds || [])].sort(),
    lookbackSec: payload.lookbackSec || 0,
  })).digest("hex") : null;
  try {
    await WebhookJob.create({ jobId, kind: "sync", priority, payload, state: "pending", next_run_at: new Date(),
      ...(payload.shopIds?.length === 1 ? { shopId: String(payload.shopIds[0]) } : {}),
      ...(activeKey ? { active_key: activeKey } : {}) });
  } catch (error) {
    if (!activeKey || !isDuplicateKeyError(error)) throw error;
    return { accepted: true, busy: true, duplicate: true, background: true, message: "Job đồng bộ cùng loại đã có trong hàng đợi" };
  }
  wakeDrainer();
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

/**
 * Giới hạn thời gian một job chiếm worker. Promise gốc có thể kết thúc muộn,
 * nhưng job đã đổi khỏi running nên không thể ghi đè kết quả retry mới.
 */
export function withJobExecutionTimeout(promise, timeoutMs = JOB_EXECUTION_TIMEOUT_MS) {
  const safeTimeoutMs = Math.max(1, Number(timeoutMs) || JOB_EXECUTION_TIMEOUT_MS);
  let timeout = null;
  const deadline = new Promise((_, reject) => {
    timeout = setTimeout(
      () => reject(Object.assign(new Error(`webhook_job_timeout_${safeTimeoutMs}ms`), { code: "webhook_job_timeout" })),
      safeTimeoutMs,
    );
    timeout.unref?.();
  });
  return Promise.race([Promise.resolve(promise), deadline]).finally(() => {
    if (timeout) clearTimeout(timeout);
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
 * @param {{ jobId: string, payload: Record<string, unknown>, receivedAt?: Date, orderPersistedAt?: Date }} input
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
  const receivedAt = input.receivedAt ?? new Date();
  if (!(receivedAt instanceof Date) || !Number.isFinite(receivedAt.getTime()) || receivedAt.getTime() > Date.now()) {
    throw new Error("webhook_received_at_invalid");
  }
  const eventAt = webhookEventTime(payload);
  // Chỉ loại push vốn đã cũ tại thời điểm nhận; không loại đơn mới vì phải chờ full-sync.
  const stale = eventAt != null && receivedAt.getTime() - eventAt > STALE_JOB_MAX_AGE_MS;
  const orderPersistedAt = input.orderPersistedAt;
  if (
    orderPersistedAt != null &&
    (!(orderPersistedAt instanceof Date) || !Number.isFinite(orderPersistedAt.getTime()))
  ) {
    throw new Error("webhook_order_persisted_at_invalid");
  }
  try {
    await WebhookJob.create({
      jobId,
      payload,
      kind: "webhook",
      // Webhook mới phải được lấy trước cron/full-sync đang chờ trong queue.
      priority: 100,
      shopId,
      received_at: receivedAt,
      ...(orderPersistedAt ? { order_persisted_at: orderPersistedAt } : {}),
      ...(stale ? { finished_at: new Date() } : {}),
      orderKey: `${shopId}:${orderSn}`,
      state: stale ? "dead-letter" : "pending",
      retry_count: 0,
      error_log: stale ? STALE_SKIP_LOG : "",
      next_run_at: new Date(),
    });
    if (stale) console.warn("[WebhookJobQueue] stale_event_dead_letter");
    if (!stale) wakeDrainer();
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
  const claim = (extra = {}) => WebhookJob.findOneAndUpdate(
    {
      ...extra,
      $or: [
        { state: "pending", next_run_at: { $lte: now } },
        { state: "failed", next_run_at: { $lte: now }, retry_count: { $lt: MAX_RETRY } },
        // Không claim lại running: worker có thể vẫn đang chờ API/DB.
      ],
    },
    [
      {
        $set: {
          // Chỉ tính retry thực sự được worker chạy, không nhầm với số lần lỗi.
          retry_attempts: { $add: [{ $ifNull: ["$retry_attempts", 0] }, { $cond: [{ $eq: ["$state", "failed"] }, 1, 0] }] },
          retry_count: {
            $cond: [{ $eq: ["$state", "running"] }, { $add: ["$retry_count", 1] }, "$retry_count"],
          },
          state: "running",
          started_at: now,
          worker_revision: 5,
          processing_stage: "starting",
          stage_started_at: now,
          claim_token: crypto.randomUUID(),
          next_run_at: leaseUntil,
        },
      },
    ],
    // Mongoose 9 chặn update dạng mảng (pipeline) nếu thiếu updatePipeline.
    { sort: { priority: -1, next_run_at: 1, _id: 1 }, returnDocument: "after", updatePipeline: true },
  ).lean();
  // A backlog from before restart must not keep today's new pushes waiting
  // behind dozens of expensive retries. Claims remain atomic and sequential.
  const fresh = await claim({ kind: "webhook", received_at: { $gte: new Date(now.getTime() - 120_000) } });
  return fresh || claim();
}

let lastStaleSweepAt = 0;

/** Đánh dấu job pending/failed quá hạn là đã bỏ qua — 1 lệnh updateMany, tối đa 1 lần/phút. */
async function sweepStaleJobs() {
  const now = Date.now();
  if (now - lastStaleSweepAt < STALE_SWEEP_INTERVAL_MS) return;
  lastStaleSweepAt = now;
  const cutoff = new Date(now - STALE_JOB_MAX_AGE_MS);
  const pendingCutoff = new Date(now - PENDING_BACKLOG_MAX_AGE_MS);
  const result = await WebhookJob.updateMany(
    // Pending mới có thể đang chờ full-sync; chỉ dọn retry lỗi đã quá hạn.
    { kind: { $ne: "sync" }, state: "failed", createdAt: { $lt: cutoff } },
    { $set: { state: "dead-letter", error_log: STALE_SKIP_LOG, next_run_at: new Date(now), finished_at: new Date(now) } },
  );
  if (result?.modifiedCount) {
    console.warn(
      `[WebhookJobQueue] stale sweep: bỏ qua ${result.modifiedCount} job cũ hơn ${STALE_JOB_MAX_AGE_MS / 60000} phút`,
    );
  }
  const pendingResult = await WebhookJob.updateMany(
    {
      kind: "webhook",
      state: "pending",
      createdAt: { $lt: pendingCutoff },
    },
    {
      $set: {
        state: "dead-letter",
        error_log: "stale_pending_backlog",
        next_run_at: new Date(now),
        finished_at: new Date(now),
      },
    },
  );
  if (pendingResult?.modifiedCount) {
    console.warn(
      `[WebhookJobQueue] pending backlog: bỏ qua ${pendingResult.modifiedCount} job cũ hơn ${PENDING_BACKLOG_MAX_AGE_MS / 60000} phút`,
    );
  }
}

function isStaleJob(job) {
  if (job?.kind === "sync") return false;
  const eventAt = webhookEventTime(job?.payload);
  const receivedAt = job?.received_at ? new Date(job.received_at).getTime() : NaN;
  // Thời gian chờ queue không biến một webhook mới thành webhook cũ.
  return eventAt != null && Number.isFinite(receivedAt)
    ? receivedAt - eventAt > STALE_JOB_MAX_AGE_MS
    : false;
}

async function markSucceeded(job, note = "") {
  await WebhookJob.updateOne(
    { _id: job._id, state: "running", claim_token: job.claim_token },
    { $set: { state: "succeeded", error_log: note, next_run_at: new Date(), finished_at: new Date(),
      ...(job.processing_stage ? { processing_stage: job.processing_stage, stage_started_at: job.stage_started_at } : {}),
      ...(job.order_persisted_at ? { order_persisted_at: job.order_persisted_at } : {}) }, $unset: { active_key: "" } },
  );
}

async function markFailed(job, err) {
  const retry = Number(job.retry_count || 0) + 1;
  const message = safeError(err);
  // New-order detail may not be available on the first push. Retry promptly,
  // then back off; keep the slower schedule for expensive bulk sync jobs.
  const retryDelay = job.kind === "sync" ? backoffMs(retry)
    : [5_000, 15_000, 30_000, 60_000, 120_000][Math.min(retry - 1, 4)];
  const nextRun = new Date(Date.now() + retryDelay);
  const result = await WebhookJob.updateOne(
    { _id: job._id, state: "running", claim_token: job.claim_token },
    {
      $set: {
        state: retry >= MAX_RETRY ? "dead-letter" : "failed",
        retry_count: retry,
        error_log: message,
        ...(job.processing_stage ? { processing_stage: job.processing_stage, stage_started_at: job.stage_started_at } : {}),
        next_run_at: nextRun,
        ...(retry >= MAX_RETRY ? { finished_at: new Date() } : {}),
        ...(job.order_persisted_at ? { order_persisted_at: job.order_persisted_at } : {}),
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

async function runClaimedJob(job, lifecycle = { active: true }) {
  let observation = null;
  if (typeof processor !== "function") {
    throw new Error("webhook_job_processor_missing");
  }
  if (isStaleJob(job)) {
    await WebhookJob.updateOne(
      { _id: job._id, state: "running", claim_token: job.claim_token },
      { $set: { state: "dead-letter", error_log: STALE_SKIP_LOG, finished_at: new Date() } },
    );
    console.warn("[WebhookJobQueue] stale_job_dead_letter");
    return false;
  }
  let lastHeartbeatAt = Date.now();
  // Gia hạn theo thời gian thực; claim_token giữ quyền sở hữu qua mỗi heartbeat.
  const heartbeat = setInterval(() => {
    const nowMs = Date.now();
    const gapMs = nowMs - lastHeartbeatAt;
    lastHeartbeatAt = nowMs;
    if (gapMs >= 75_000) {
      void recordStallDiagnostic("job_heartbeat_lag", {
        stage: observation?.stage || job.processing_stage || "starting",
        heartbeatGapMs: gapMs,
        runningJobs: [job],
      });
    }
    void WebhookJob.updateOne(
      { _id: job._id, state: "running", claim_token: job.claim_token },
      { $set: { next_run_at: new Date(nowMs + RUNNING_LEASE_MS),
        ...(observation?.stage ? { processing_stage: observation.stage, stage_started_at: observation.stageStartedAt } : {}) } },
    ).then((res) => {
      // Nếu job đã bị worker khác cách ly sau khi lease hết hạn, dừng ngay công việc cũ.
      if (res && res.matchedCount === 0) lifecycle.active = false;
    }).catch(() => console.warn("[WebhookJobQueue] heartbeat_failed"));
  }, 30_000);
  heartbeat.unref?.();
  try {
    const hasPendingWebhook = async () => Boolean(await WebhookJob.findOne({ kind: "webhook", $or: [
      { state: "pending", next_run_at: { $lte: new Date() } },
      { state: "failed", next_run_at: { $lte: new Date() }, retry_count: { $lt: MAX_RETRY } },
    ] }).select({ _id: 1 }).setOptions({ maxTimeMS: 1500, timeoutMS: 2000 }).lean());
    if (job.kind === "sync") {
      if (typeof syncProcessor !== "function") throw new Error("sync_processor_missing");
      const backgroundSync = !job.payload?.mode || job.payload?.mode === "task";
      observation = { incremental: backgroundSync, stage: "sync_run", stageStartedAt: new Date() };
      const work = () => syncObservation.run(observation, () => syncProcessor(job.payload));
      let result;
      try {
        // Mọi job sync (gồm cả quick/full/task) đều nhận lifecycle để dừng ngay khi hết hạn/mất khóa;
        // riêng incremental và task định kỳ nhường hàng đợi khi có webhook mới.
        result = await withYieldableSync({
          lifecycle,
          hasWebhook: backgroundSync ? hasPendingWebhook : null,
        }, work);
      } finally {
        job.processing_stage = observation.stage;
        job.stage_started_at = observation.stageStartedAt;
      }
      if (result?.success === false || result?.skipped) throw Object.assign(new Error("sync_job_incomplete"), { code: "sync_job_incomplete" });
    } else {
      observation = { orderPersistedAt: job.order_persisted_at || null,
        receivedAt: job.received_at || job.createdAt };
      try {
        await withYieldableSync({ lifecycle, hasWebhook: null }, () =>
          webhookObservation.run(observation, () => processor(job.payload)),
        );
      } finally {
        // Giữ mốc lưu đơn dù bước xử lý tiếp theo ném lỗi và cần retry.
        if (observation.orderPersistedAt) job.order_persisted_at = observation.orderPersistedAt;
        if (observation.stage) {
          job.processing_stage = observation.stage;
          job.stage_started_at = observation.stageStartedAt;
        }
      }
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
  let batchFull = false;
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
      { $set: { state: "dead-letter", error_log: "abandoned_worker_requires_review", finished_at: new Date() }, $unset: { active_key: "" } },
    );
    if (abandoned.modifiedCount) {
      console.warn(`[WebhookJobQueue] abandoned_dead_letter count=${abandoned.modifiedCount}`);
      void recordStallDiagnostic("abandoned_running_job_isolated", {
        abandonedCount: abandoned.modifiedCount,
        errorCode: "abandoned_worker_requires_review",
      }, { force: true });
    }
    let currentLifecycle = null;
    let leaseLost = false;
    leaseHeartbeat = setInterval(() => {
      void renewShopeeSyncLease(leaseOwner).then((ok) => {
        if (!ok) {
          leaseLost = true;
          if (currentLifecycle) currentLifecycle.active = false;
          console.warn("[WebhookJobQueue] global_lease_lost_cancelling_active_job");
        }
      }).catch(() => console.warn("[WebhookJobQueue] global_heartbeat_failed"));
    }, 30_000);
    leaseHeartbeat.unref?.();
    try {
      await sweepStaleJobs();
    } catch (sweepErr) {
      console.error("[WebhookJobQueue] stale sweep failed:", safeError(sweepErr));
    }
    for (let i = 0; i < BATCH_LIMIT; i += 1) {
      if (leaseLost) break;
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
      batchFull = i === BATCH_LIMIT - 1;
      const started = Date.now();
      const received = new Date(job.received_at || job.createdAt).getTime();
      let outcome = "succeeded";
      const lifecycle = { active: true };
      currentLifecycle = lifecycle;
      try {
        // Một job treo không được giữ khóa toàn cục và chặn mọi đơn phía sau.
        const processed = await withJobExecutionTimeout(runClaimedJob(job, lifecycle));
        console.log(
          processed
            ? `[WebhookJobQueue] job succeeded jobId=${job.jobId}`
            : `[WebhookJobQueue] job stale skipped jobId=${job.jobId}`,
        );
      } catch (jobErr) {
        outcome = "failed";
        if (jobErr?.code === "webhook_job_timeout") {
          void recordStallDiagnostic("webhook_job_timeout", {
            stage: job.processing_stage || "starting",
            error: jobErr,
            runningJobs: [job],
          }, { force: true });
        }
        try {
          if (jobErr?.code === "sync_yield_for_webhook") {
            outcome = "yielded";
            await WebhookJob.updateOne({ _id: job._id, state: "running", claim_token: job.claim_token }, {
              $set: { state: "pending", next_run_at: new Date(Date.now() + 500), error_log: "",
                processing_stage: "sync_yielded", stage_started_at: new Date() },
            });
          } else await markFailed(job, jobErr);
        } catch (writeErr) {
          console.error(
            `[WebhookJobQueue] markFailed crashed jobId=${job.jobId}:`,
            safeError(writeErr),
          );
        }
      } finally {
        lifecycle.active = false;
        currentLifecycle = null;
      }
      console.log("[WebhookJobQueue] timing", JSON.stringify({
        kind: job.kind || "webhook", outcome,
        queueWaitMs: Number.isFinite(received) ? Math.max(0, started - received) : null,
        processingMs: Date.now() - started,
      }));
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
    // Continue a backlog after yielding the event loop and releasing the lease.
    const shouldWake = batchFull || wakeRequested;
    wakeRequested = false;
    if (shouldWake) wakeDrainer(JOB_GAP_MS);
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
  if (wakeTimer) {
    clearTimeout(wakeTimer);
    wakeTimer = null;
  }
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  console.log("[WebhookJobQueue] drainer OFF");
}
