// Module chẩn đoán nhẹ cho sự cố đứng worker/heartbeat trên cPanel.
// Tuyệt đối không lưu token, chữ ký, URL có query bí mật hoặc dữ liệu khách hàng.
import os from "node:os";
import mongoose from "mongoose";
import { safeError } from "../../utils/safeProductionLog.js";
import { probeWorkerProcess } from "../../scripts/worker-process-probe.mjs";

export const STALL_DIAGNOSTICS_COLLECTION = "ops_stall_diagnostics";
export const MAX_STALL_SNAPSHOTS = 50;
export const STALL_HEARTBEAT_WARN_MS = 90_000;
const MIN_CAPTURE_INTERVAL_MS = 45_000;

let lastCaptureByKey = new Map();

function sanitizeStage(stage) {
  return typeof stage === "string" && /^[a-z0-9_:-]{1,60}$/i.test(stage) ? stage : null;
}

function sanitizeMode(mode) {
  return ["quick", "full", "task"].includes(mode) ? mode : null;
}

function sanitizeTask(task) {
  return ["rts_backfill", "return_requests", "handed_over"].includes(task) ? task : null;
}

export function sanitizeRunningJobForDiag(job, nowMs = Date.now()) {
  if (!job || typeof job !== "object") return null;
  const startedMs = job.started_at ? new Date(job.started_at).getTime() : NaN;
  const stageMs = job.stage_started_at ? new Date(job.stage_started_at).getTime() : NaN;
  const leaseMs = job.next_run_at ? new Date(job.next_run_at).getTime() : NaN;
  return {
    kind: job.kind === "sync" ? "sync" : "webhook",
    mode: sanitizeMode(job.payload?.mode),
    task: sanitizeTask(job.payload?.task),
    priority: Number.isFinite(Number(job.priority)) ? Number(job.priority) : 0,
    workerRevision: Number.isInteger(job.worker_revision) ? job.worker_revision : null,
    processingStage: sanitizeStage(job.processing_stage),
    startedAt: Number.isFinite(startedMs) ? new Date(startedMs) : null,
    processingAgeMs: Number.isFinite(startedMs) ? Math.max(0, nowMs - startedMs) : null,
    stageStartedAt: Number.isFinite(stageMs) ? new Date(stageMs) : null,
    stageAgeMs: Number.isFinite(stageMs) ? Math.max(0, nowMs - stageMs) : null,
    heartbeatLeaseUntil: Number.isFinite(leaseMs) ? new Date(leaseMs) : null,
    leaseExpired: Number.isFinite(leaseMs) ? leaseMs <= nowMs : null,
    retryCount: Number.isFinite(Number(job.retry_count)) ? Number(job.retry_count) : 0,
  };
}

export function sanitizeLockForDiag(lock, nowMs = Date.now()) {
  if (!lock || typeof lock !== "object") return null;
  const hbMs = lock.heartbeatAt ? new Date(lock.heartbeatAt).getTime() : NaN;
  const expMs = lock.expiresAt ? new Date(lock.expiresAt).getTime() : NaN;
  const acqMs = lock.acquiredAt ? new Date(lock.acquiredAt).getTime() : NaN;
  return {
    held: Boolean(lock.owner),
    ownerPid: Number.isInteger(lock.pid) && lock.pid > 0 ? lock.pid : null,
    sameHost: typeof lock.hostname === "string" ? lock.hostname === os.hostname() : null,
    trigger: typeof lock.trigger === "string" ? lock.trigger.slice(0, 40) : null,
    workerRevision: Number.isInteger(lock.workerRevision) ? lock.workerRevision : null,
    acquiredAt: Number.isFinite(acqMs) ? new Date(acqMs) : null,
    heartbeatAt: Number.isFinite(hbMs) ? new Date(hbMs) : null,
    heartbeatAgeMs: Number.isFinite(hbMs) ? Math.max(0, nowMs - hbMs) : null,
    expiresAt: Number.isFinite(expMs) ? new Date(expMs) : null,
    leaseExpired: Number.isFinite(expMs) ? expMs <= nowMs : null,
  };
}

/**
 * Ghi nhận bản chụp chẩn đoán có giới hạn dung lượng (tối đa MAX_STALL_SNAPSHOTS bản ghi).
 * Không ném lỗi ra ngoài để không ảnh hưởng luồng xử lý đơn.
 */
export async function recordStallDiagnostic(event, details = {}, options = {}) {
  try {
    const db = options.db || (mongoose.connection.readyState === 1 ? mongoose.connection.db : null);
    if (!db) return false;
    const now = options.now instanceof Date ? options.now : new Date();
    const nowMs = now.getTime();
    const safeEvent = String(event || "stall_observed").replace(/[^a-zA-Z0-9_.-]/g, "").slice(0, 60) || "stall_observed";
    const dedupeKey = String(options.dedupeKey || `${safeEvent}:${details.lock?.owner || details.lock?.pid || "global"}`);
    if (!options.force) {
      const prevAt = lastCaptureByKey.get(dedupeKey) || 0;
      if (nowMs - prevAt < MIN_CAPTURE_INTERVAL_MS) return false;
    }
    lastCaptureByKey.set(dedupeKey, nowMs);
    if (lastCaptureByKey.size > 100) {
      const oldestKey = lastCaptureByKey.keys().next().value;
      if (oldestKey) lastCaptureByKey.delete(oldestKey);
    }

    const lockDoc = details.lock !== undefined
      ? details.lock
      : await db.collection("sync_orchestrator_locks").findOne(
          { _id: "shopee_orders_global" },
          { projection: { owner: 1, pid: 1, hostname: 1, trigger: 1, workerRevision: 1, acquiredAt: 1, heartbeatAt: 1, expiresAt: 1 }, maxTimeMS: 1500 },
        ).catch(() => null);

    const runningDocs = details.runningJobs !== undefined
      ? details.runningJobs
      : await db.collection("webhook_jobs").find(
          { state: "running" },
          {
            projection: {
              _id: 0, kind: 1, priority: 1, started_at: 1, next_run_at: 1, retry_count: 1,
              processing_stage: 1, stage_started_at: 1, worker_revision: 1,
              "payload.mode": 1, "payload.task": 1,
            },
            maxTimeMS: 1500,
          },
        ).limit(3).toArray().catch(() => []);

    const workerProcess = details.workerProcess !== undefined
      ? details.workerProcess
      : lockDoc?.owner
        ? await probeWorkerProcess(lockDoc, { sampleMs: options.sampleMs ?? 250 }).catch(() => null)
        : { sameHost: null, pid: null, exists: null, probeStatus: "no_lock_owner" };

    const doc = {
      observedAt: now,
      event: safeEvent,
      observerPid: process.pid,
      workerRevision: Number.isInteger(details.workerRevision) ? details.workerRevision : 6,
      stage: sanitizeStage(details.stage),
      errorCode: details.error ? safeError(details.error) : (typeof details.errorCode === "string" ? safeError({ code: details.errorCode }) : null),
      heartbeatGapMs: Number.isFinite(Number(details.heartbeatGapMs)) ? Math.round(Number(details.heartbeatGapMs)) : null,
      abandonedCount: Number.isFinite(Number(details.abandonedCount)) ? Math.round(Number(details.abandonedCount)) : null,
      lock: sanitizeLockForDiag(lockDoc, nowMs),
      runningJobs: Array.isArray(runningDocs) ? runningDocs.slice(0, 3).map((j) => sanitizeRunningJobForDiag(j, nowMs)).filter(Boolean) : [],
      workerProcess,
    };

    const coll = db.collection(STALL_DIAGNOSTICS_COLLECTION);
    await coll.insertOne(doc, { maxTimeMS: 1500, timeoutMS: 2000 });

    // Giữ tối đa MAX_STALL_SNAPSHOTS bản ghi gần nhất mà không cần tạo index mới trên production.
    const allIds = await coll.find({}, { projection: { _id: 1, observedAt: 1 }, maxTimeMS: 1500 })
      .sort({ observedAt: -1, _id: -1 })
      .limit(MAX_STALL_SNAPSHOTS + 20)
      .toArray()
      .catch(() => []);
    if (allIds.length > MAX_STALL_SNAPSHOTS) {
      const overflowIds = allIds.slice(MAX_STALL_SNAPSHOTS).map((r) => r._id);
      await coll.deleteMany({ _id: { $in: overflowIds } }, { maxTimeMS: 1500 }).catch(() => {});
    }
    return true;
  } catch {
    console.warn("[Operations] stall_diagnostic_write_failed");
    return false;
  }
}

export function resetStallDiagnosticsDedupeForTest() {
  lastCaptureByKey.clear();
}
