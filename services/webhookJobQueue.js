/**
 * Mongo queue cho webhook Shopee.
 * HTTP chỉ insert job pending. setInterval drain gọi processor (get_order_detail + upsert).
 * Claim bằng findOneAndUpdate để nhiều process Passenger không lấy cùng một job.
 */
import WebhookJob from "../models/WebhookJob.js";

const DRAIN_INTERVAL_MS = 8_000;
const BATCH_LIMIT = 5;
const JOB_GAP_MS = 400;
const MAX_RETRY = 5;
/** Lease khi state=running. Hết hạn thì job được claim lại (process chết giữa chừng). */
const RUNNING_LEASE_MS = 4 * 60 * 1000;

let timer = null;
let draining = false;
let processor = null;

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
  try {
    await WebhookJob.create({
      jobId,
      payload,
      state: "pending",
      retry_count: 0,
      error_log: "",
      next_run_at: new Date(),
    });
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
        { state: "running", next_run_at: { $lte: now }, retry_count: { $lt: MAX_RETRY } },
      ],
    },
    [
      {
        $set: {
          retry_count: {
            $cond: [{ $eq: ["$state", "running"] }, { $add: ["$retry_count", 1] }, "$retry_count"],
          },
          state: "running",
          next_run_at: leaseUntil,
        },
      },
    ],
    { sort: { next_run_at: 1, _id: 1 }, new: true },
  ).lean();
}

async function markSucceeded(job) {
  await WebhookJob.updateOne(
    { _id: job._id, state: "running", next_run_at: job.next_run_at },
    { $set: { state: "succeeded", error_log: "", next_run_at: new Date() } },
  );
}

async function markFailed(job, err) {
  const retry = Number(job.retry_count || 0) + 1;
  const message = String(err?.message || err || "webhook_job_failed").slice(0, 2000);
  const nextRun = new Date(Date.now() + backoffMs(retry));
  const result = await WebhookJob.updateOne(
    { _id: job._id, state: "running", next_run_at: job.next_run_at },
    {
      $set: {
        state: "failed",
        retry_count: retry,
        error_log: message,
        next_run_at: nextRun,
      },
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
  await processor(job.payload);
  await markSucceeded(job);
}

async function drainOnce() {
  if (draining) return;
  if (typeof processor !== "function") return;
  draining = true;
  try {
    for (let i = 0; i < BATCH_LIMIT; i += 1) {
      let job = null;
      try {
        job = await claimNextJob();
      } catch (claimErr) {
        console.error(
          "[WebhookJobQueue] claim failed:",
          claimErr?.message || claimErr,
        );
        break;
      }
      if (!job) break;
      try {
        await runClaimedJob(job);
        console.log(`[WebhookJobQueue] job succeeded jobId=${job.jobId}`);
      } catch (jobErr) {
        try {
          await markFailed(job, jobErr);
        } catch (writeErr) {
          console.error(
            `[WebhookJobQueue] markFailed crashed jobId=${job.jobId}:`,
            writeErr?.message || writeErr,
          );
        }
      }
      if (i < BATCH_LIMIT - 1) {
        await delay(JOB_GAP_MS);
      }
    }
  } catch (err) {
    console.error("[WebhookJobQueue] drainOnce failed:", err?.message || err);
  } finally {
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
      console.error("[WebhookJobQueue] drain tick failed:", err?.message || err);
    });
  }, DRAIN_INTERVAL_MS);
  if (typeof timer.unref === "function") timer.unref();
  console.log(
    `[WebhookJobQueue] drainer ON interval=${DRAIN_INTERVAL_MS}ms batch=${BATCH_LIMIT} gapMs=${JOB_GAP_MS}`,
  );
  void drainOnce().catch((err) => {
    console.error("[WebhookJobQueue] boot drain failed:", err?.message || err);
  });
}

export function stopWebhookJobDrainer() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  console.log("[WebhookJobQueue] drainer OFF");
}
