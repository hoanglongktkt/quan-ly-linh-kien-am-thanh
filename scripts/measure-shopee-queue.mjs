// Read-only diagnostics. Run on cPanel with its production environment.
// No calls to Shopee, index creation, order writes, or customer payload output.
import dotenv from "dotenv";
import mongoose from "mongoose";
import { collectOperationsMetrics } from "../modules/operations/metrics.js";
import { summarizeExplain } from "../modules/operations/indexAudit.js";
import { probeWorkerProcess } from "./worker-process-probe.mjs";
dotenv.config({ quiet: true });
const windowMinutes = Number(process.argv[2] ?? 60);
if (!Number.isInteger(windowMinutes) || windowMinutes < 1 || windowMinutes > 1440) {
  console.error("Window must be an integer from 1 to 1440 minutes");
  process.exit(1);
}
const uri = process.env.MONGODB_URI || process.env.MONGO_URL || process.env.MONGO_URI;
if (!uri) { console.error("MONGODB_URI is missing"); process.exitCode = 1; }
else {
  // DNS SRV discovery can outlive the driver's selection timeout.
  const deadline = setTimeout(() => {
    console.error(JSON.stringify({ measurementFailed: true, code: "diagnostic_deadline_20s" }));
    process.exit(1);
  }, 20000);
  deadline.unref();
  const client = new mongoose.mongo.MongoClient(uri, {
    maxPoolSize: 2, serverSelectionTimeoutMS: 8000, connectTimeoutMS: 8000, socketTimeoutMS: 10000,
  });
  try {
    const began = performance.now();
    await client.connect();
    const db = client.db();
    const pingAt = performance.now();
    await db.command({ ping: 1 });
    const pingMs = Math.round(performance.now() - pingAt);
    const metrics = await collectOperationsMetrics(db, { windowMinutes });
    const rows = await db.collection("webhook_jobs").find({ kind: "webhook",
      createdAt: { $gte: new Date(Date.now() - windowMinutes * 60000) } }, {
      projection: { _id: 0, received_at: 1, createdAt: 1, started_at: 1, finished_at: 1,
        order_persisted_at: 1, retry_count: 1, worker_revision: 1, state: 1 }, maxTimeMS: 3000,
    }).sort({ createdAt: -1 }).limit(200).toArray();
    const describe = (values) => {
      const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
      const percentile = (p) => sorted.length ? sorted[Math.ceil(sorted.length * p) - 1] : null;
      return { samples: sorted.length, p50: percentile(.5), p95: percentile(.95), max: sorted.at(-1) ?? null };
    };
    const difference = (row, end, start) => row[end] && row[start]
      ? Math.max(0, new Date(row[end]) - new Date(row[start])) : NaN;
    const indexes = await db.collection("webhook_jobs").indexes();
    const lock = await db.collection("sync_orchestrator_locks").findOne({ _id: "shopee_orders_global" },
      { projection: { _id: 0, trigger: 1, acquiredAt: 1, heartbeatAt: 1, expiresAt: 1, owner: 1, pid: 1, hostname: 1 }, maxTimeMS: 1500 });
    // Optional bounded probes: a failed explain must not hide the base report.
    const probe = async (read) => {
      try { return await read(); }
      catch (error) { return { unavailable: true, code: error.code === 50 ? "time_limit" : "read_failed" }; }
    };
    const jobs = db.collection("webhook_jobs");
    const runningJobs = await probe(async () => {
      const active = await jobs.find({ state: "running" }, {
        projection: { _id: 0, kind: 1, priority: 1, createdAt: 1, received_at: 1,
          started_at: 1, next_run_at: 1, retry_count: 1, processing_stage: 1, stage_started_at: 1,
          worker_revision: 1,
          "payload.mode": 1, "payload.task": 1 },
        maxTimeMS: 1500,
      }).limit(5).toArray();
      const allowedModes = new Set(["quick", "full", "task"]);
      const allowedTasks = new Set(["rts_backfill", "return_requests", "handed_over"]);
      return active.map((job) => ({
        kind: job.kind === "sync" ? "sync" : "webhook",
        mode: allowedModes.has(job.payload?.mode) ? job.payload.mode : null,
        task: allowedTasks.has(job.payload?.task) ? job.payload.task : null,
        priority: job.priority, createdAt: job.createdAt, receivedAt: job.received_at,
        startedAt: job.started_at ?? null, heartbeatLeaseUntil: job.next_run_at,
        workerRevision: job.worker_revision ?? null,
        processingAgeMs: job.started_at ? Math.max(0, Date.now() - new Date(job.started_at)) : null,
        processingStage: /^[a-z_]{1,50}$/.test(job.processing_stage || "") ? job.processing_stage : null,
        stageAgeMs: job.stage_started_at ? Math.max(0, Date.now() - new Date(job.stage_started_at)) : null,
        retryCount: job.retry_count,
      }));
    });
    const backlogByKind = await probe(() => jobs.aggregate([
      { $match: { state: { $in: ["pending", "running", "failed"] } } },
      { $group: { _id: { kind: "$kind", state: "$state" }, count: { $sum: 1 },
        dueNow: { $sum: { $cond: [{ $lte: ["$next_run_at", new Date()] }, 1, 0] } },
        oldestCreatedAt: { $min: "$createdAt" } } },
      { $limit: 12 },
    ], { maxTimeMS: 1500, allowDiskUse: false }).toArray());
    const lastSucceeded = await probe(() => jobs.findOne({ state: "succeeded" }, {
      projection: { _id: 0, kind: 1, started_at: 1, finished_at: 1, worker_revision: 1 },
      sort: { finished_at: -1 }, maxTimeMS: 1500,
    }));
    const recentFailures = await probe(async () => (await jobs.find({ state: { $in: ["failed", "dead-letter"] } }, {
      projection: { _id: 0, kind: 1, retry_count: 1, processing_stage: 1, started_at: 1, worker_revision: 1,
        updatedAt: 1, error_log: 1 }, maxTimeMS: 1500,
    }).sort({ updatedAt: -1 }).limit(5).toArray()).map((row) => ({
      kind: row.kind === "sync" ? "sync" : "webhook", retryCount: row.retry_count,
      workerRevision: row.worker_revision ?? null,
      stage: /^[a-z_]{1,50}$/.test(row.processing_stage || "") ? row.processing_stage : null,
      startedAt: row.started_at, updatedAt: row.updatedAt,
      errorCode: /^(abandoned_worker_requires_review|stale_job_dead_letter|stale_pending_backlog|mongo_write_queue_wait_timeout|mongo_write_execution_timeout|webhook_job_timeout|shopee_http_timeout|sync_job_incomplete|sync_worker_cancelled|Mongo[A-Za-z]+Error|Error|[0-9]{1,8})$/.test(row.error_log || "") ? row.error_log : "other",
    })));
    const recentStallSnapshots = await probe(() => db.collection("ops_stall_diagnostics").find({}, {
      projection: { _id: 0, observedAt: 1, event: 1, observerPid: 1, workerRevision: 1, stage: 1,
        errorCode: 1, heartbeatGapMs: 1, abandonedCount: 1, lock: 1, runningJobs: 1, workerProcess: 1 },
      maxTimeMS: 1500,
    }).sort({ observedAt: -1 }).limit(10).toArray());
    const claimQueryPlan = await probe(async () => summarizeExplain(await jobs.find({ $or: [
      { state: "pending", next_run_at: { $lte: new Date() } },
      { state: "failed", next_run_at: { $lte: new Date() }, retry_count: { $lt: 5 } },
    ] }, { maxTimeMS: 1500 }).sort({ priority: -1, next_run_at: 1, _id: 1 }).limit(1).explain("executionStats")));
    console.log(JSON.stringify({ measuredAt: new Date(), pingMs, elapsedMs: Math.round(performance.now() - began),
      queue: metrics.queue, summary: metrics.summary,
      recentWebhookTimingMs: {
        basis: `latest 200 webhooks within ${windowMinutes} minutes; queue/processing exclude retries`,
        queueWait: describe(rows.filter((r) => !r.retry_count).map((r) => difference(r, "started_at", "received_at"))),
        processing: describe(rows.filter((r) => !r.retry_count).map((r) => difference(r, "finished_at", "started_at"))),
        firstOrderPersist: describe(rows.map((r) => difference(r, "order_persisted_at", "received_at"))),
      },
      currentWorkerProcessingMs: { workerRevision: 5,
        ...describe(rows.filter((row) => row.worker_revision === 5 && row.state === "succeeded" && !row.retry_count)
          .map((row) => difference(row, "finished_at", "started_at"))) },
      claimIndexPresent: indexes.some((i) => JSON.stringify(i.key) === JSON.stringify({ state: 1, priority: -1, next_run_at: 1, _id: 1 })),
      diagnosticVersion: 7,
      claimQueryPlan,
      queueIndexes: indexes.map(({ key, partialFilterExpression, sparse }) => ({ key,
        ...(partialFilterExpression ? { partialFilterExpression } : {}), ...(sparse ? { sparse } : {}) })),
      runningJobs, backlogByKind, lastSucceeded, recentFailures, recentStallSnapshots,
      lock: lock ? { held: !!lock.owner, trigger: lock.trigger, acquiredAt: lock.acquiredAt,
        heartbeatAt: lock.heartbeatAt, expiresAt: lock.expiresAt,
        heartbeatAgeMs: lock.heartbeatAt ? Math.max(0, Date.now() - new Date(lock.heartbeatAt)) : null,
        leaseExpired: lock.expiresAt ? new Date(lock.expiresAt).getTime() <= Date.now() : null } : null,
      workerProcess: await probeWorkerProcess(lock),
    }, null, 2));
  } catch (error) {
    // Error text can contain credentials/hosts; expose only a code/name.
    console.error(JSON.stringify({ measurementFailed: true, code: error.code || error.name }));
    process.exitCode = 1;
  } finally { await client.close(); clearTimeout(deadline); }
}
