// Watchdog bên ngoài tiến trình Passenger cho cPanel Cron Job (chạy mỗi 1–2 phút rồi thoát).
// Nhiệm vụ:
// 1. Phát hiện khi worker giữ khóa nhưng heartbeat quá hạn (>90s) hoặc job running quá hạn,
//    lập tức chụp trạng thái PID (/proc/<pid>/stat, cpuTicksDelta, rssMb) vào ops_stall_diagnostics.
// 2. Phát hiện khi hàng đợi có job dueNow chờ >20s mà không có worker chạy (Passenger đã tắt process do idle)
//    hoặc khi worker bị đứng, rồi gọi GET /api/health/ để Passenger đánh thức tiến trình.
// Tuyệt đối không xóa hàng đợi, không cưỡng ép mở khóa còn hạn và không lộ token/dữ liệu khách hàng.
import dotenv from "dotenv";
import mongoose from "mongoose";
import { probeWorkerProcess } from "./worker-process-probe.mjs";
import { recordStallDiagnostic, STALL_HEARTBEAT_WARN_MS } from "../modules/operations/stallDiagnostics.js";

dotenv.config({ quiet: true });

export async function evaluateAndHealWorkerWatchdog({
  db,
  now = new Date(),
  wakeUrl = "",
  probeFn = probeWorkerProcess,
  fetchFn = globalThis.fetch,
} = {}) {
  const nowMs = now.getTime();
  const lock = await db.collection("sync_orchestrator_locks").findOne(
    { _id: "shopee_orders_global" },
    { projection: { owner: 1, pid: 1, hostname: 1, trigger: 1, workerRevision: 1, acquiredAt: 1, heartbeatAt: 1, expiresAt: 1 }, maxTimeMS: 2000 },
  );
  const runningJobs = await db.collection("webhook_jobs").find(
    { state: "running" },
    {
      projection: {
        _id: 0, kind: 1, priority: 1, started_at: 1, next_run_at: 1, retry_count: 1,
        processing_stage: 1, stage_started_at: 1, worker_revision: 1,
        "payload.mode": 1, "payload.task": 1,
      },
      maxTimeMS: 2000,
    },
  ).limit(3).toArray();

  const dueWaitingJob = await db.collection("webhook_jobs").findOne(
    {
      $or: [
        { state: "pending", next_run_at: { $lte: now } },
        { state: "failed", next_run_at: { $lte: now }, retry_count: { $lt: 5 } },
      ],
    },
    { projection: { _id: 0, kind: 1, createdAt: 1, received_at: 1, next_run_at: 1 }, sort: { priority: -1, next_run_at: 1, _id: 1 }, maxTimeMS: 2000 },
  );

  const lockHeld = Boolean(lock?.owner);
  const heartbeatAgeMs = lockHeld && lock?.heartbeatAt ? Math.max(0, nowMs - new Date(lock.heartbeatAt).getTime()) : null;
  const lockLeaseExpired = lockHeld && lock?.expiresAt ? new Date(lock.expiresAt).getTime() <= nowMs : false;
  const runningJobOverdue = runningJobs.some((job) => {
    const leaseUntil = job?.next_run_at ? new Date(job.next_run_at).getTime() : NaN;
    const startedAt = job?.started_at ? new Date(job.started_at).getTime() : NaN;
    return (Number.isFinite(leaseUntil) && leaseUntil <= nowMs) || (Number.isFinite(startedAt) && nowMs - startedAt >= STALL_HEARTBEAT_WARN_MS);
  });
  const waitingOriginMs = dueWaitingJob
    ? new Date(dueWaitingJob.received_at || dueWaitingJob.next_run_at || dueWaitingJob.createdAt || now).getTime()
    : NaN;
  const dueWaitingAgeMs = Number.isFinite(waitingOriginMs) ? Math.max(0, nowMs - waitingOriginMs) : 0;
  const idleWithWaitingQueue = !lockHeld && Boolean(dueWaitingJob) && dueWaitingAgeMs >= 15_000;
  const heartbeatOverdue = lockHeld && heartbeatAgeMs != null && heartbeatAgeMs >= STALL_HEARTBEAT_WARN_MS;

  let stallRecorded = false;
  let workerProcess = null;
  if (heartbeatOverdue || lockLeaseExpired || runningJobOverdue) {
    workerProcess = lockHeld ? await probeFn(lock, { sampleMs: 500 }) : { sameHost: null, pid: null, exists: null, probeStatus: "no_lock_owner" };
    const event = lockLeaseExpired
      ? "watchdog_lock_lease_expired"
      : runningJobOverdue
        ? "watchdog_job_overdue"
        : "watchdog_heartbeat_overdue";
    stallRecorded = await recordStallDiagnostic(
      event,
      {
        lock,
        runningJobs,
        workerProcess,
        heartbeatGapMs: heartbeatAgeMs,
        stage: runningJobs[0]?.processing_stage || null,
      },
      { db, now, force: true },
    );
  }

  const shouldWake = Boolean(wakeUrl) && (idleWithWaitingQueue || heartbeatOverdue || lockLeaseExpired || runningJobOverdue);
  let wakeResult = null;
  if (shouldWake && typeof fetchFn === "function") {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    const began = performance.now();
    try {
      const response = await fetchFn(wakeUrl, { signal: controller.signal, headers: { " cache-control": "no-cache" } });
      wakeResult = { ok: response.ok, status: response.status, elapsedMs: Math.round(performance.now() - began) };
    } catch (err) {
      wakeResult = { ok: false, status: null, errorCode: err?.code || err?.name || "wake_failed", elapsedMs: Math.round(performance.now() - began) };
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    checkedAt: now,
    lockHeld,
    heartbeatAgeMs,
    lockLeaseExpired,
    runningCount: runningJobs.length,
    runningJobOverdue,
    idleWithWaitingQueue,
    dueWaitingAgeMs: dueWaitingJob ? dueWaitingAgeMs : null,
    stallRecorded,
    shouldWake,
    wakeResult,
  };
}

const isDirectRun = Boolean(process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/").split("/").pop()));
if (isDirectRun) {
  const uri = process.env.MONGODB_URI || process.env.MONGO_URL || process.env.MONGO_URI;
  const baseUrl = String(
    process.env.KEEP_ALIVE_BASE_URL ||
      process.env.APP_URL ||
      process.env.API_BASE_URL ||
      "https://quanly.linhkienamthanh.net",
  ).trim().replace(/\/$/, "");
  const wakeUrl = `${baseUrl}/api/health/`;

  if (!uri) {
    console.error(JSON.stringify({ watchdogFailed: true, code: "missing_mongodb_uri" }));
    process.exit(1);
  }
  const deadline = setTimeout(() => {
    console.error(JSON.stringify({ watchdogFailed: true, code: "watchdog_deadline_20s" }));
    process.exit(1);
  }, 20_000);
  deadline.unref();

  const client = new mongoose.mongo.MongoClient(uri, {
    maxPoolSize: 1,
    serverSelectionTimeoutMS: 8000,
    connectTimeoutMS: 8000,
    socketTimeoutMS: 10000,
  });
  try {
    await client.connect();
    const report = await evaluateAndHealWorkerWatchdog({ db: client.db(), wakeUrl });
    if (report.stallRecorded || report.shouldWake) {
      console.log(JSON.stringify(report));
    }
  } catch (error) {
    console.error(JSON.stringify({ watchdogFailed: true, code: error?.code || error?.name || "watchdog_error" }));
    process.exitCode = 1;
  } finally {
    await client.close().catch(() => {});
    clearTimeout(deadline);
  }
}
