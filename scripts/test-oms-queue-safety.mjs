import test from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import WebhookJob from "../models/WebhookJob.js";
import { drainOnce, enqueueWebhookJob, enqueueOrderSyncJob, setOrderSyncJobProcessor, withJobExecutionTimeout, startWebhookJobDrainer, stopWebhookJobDrainer } from "../services/webhookJobQueue.js";
import { acquireShopeeSyncLease, renewShopeeSyncLease } from "../services/orderSync/syncOrchestrator.js";
import { withOrderWorkLock } from "../services/orderSync/orderWorkLock.js";
import { resolveShopeeOrderIdentities } from "../services/orderSync/orderIdentity.js";
import { safeError, safeTokenMetadata } from "../utils/safeProductionLog.js";
import { markWebhookOrderPersisted } from "../modules/operations/telemetry.js";
import { initOrderSyncService, triggerBackgroundOrderSync } from "../modules/shopee-sync/orderSyncService.js";
import { webhookQueueConfig } from "../modules/jobs/webhookQueueConfig.js";
import { yieldSyncIfWebhookWaiting, assertSyncActive, withYieldableSync } from "../modules/shopee-sync/syncYield.js";

test("webhook pacing has conservative defaults and hard limits", () => {
  assert.deepEqual(webhookQueueConfig({}), { intervalMs: 3000, batchLimit: 8, jobGapMs: 150 });
  assert.deepEqual(webhookQueueConfig({ SHOPEE_WEBHOOK_DRAIN_INTERVAL_MS: "1", SHOPEE_WEBHOOK_BATCH_LIMIT: "999", SHOPEE_WEBHOOK_JOB_GAP_MS: "0" }),
    { intervalMs: 2000, batchLimit: 10, jobGapMs: 100 });
  assert.deepEqual(webhookQueueConfig({ SHOPEE_WEBHOOK_DRAIN_INTERVAL_MS: "oops", SHOPEE_WEBHOOK_BATCH_LIMIT: "", SHOPEE_WEBHOOK_JOB_GAP_MS: "NaN" }), webhookQueueConfig({}));
});

// Fake Mongo trong bộ nhớ: kiểm thử không kết nối hoặc thay đổi dữ liệu thật.
test("OMS: khóa, job cũ, ưu tiên, retry và idempotency", async (t) => {
  const collections = new Map();
  let indexCalls = 0;
  const db = { collection(name) {
    if (!collections.has(name)) {
      const rows = new Map();
      collections.set(name, {
        rows, createIndex: async () => { indexCalls++; },
        findOne: async (f) => rows.get(f._id) || null,
        insertOne: async (row) => {
          if (rows.has(row._id)) throw Object.assign(new Error("duplicate"), { code: 11000 });
          rows.set(row._id, { ...row });
        },
        findOneAndUpdate: async (f, u) => {
          const row = rows.get(f._id);
          if (!row || (row.owner && row.expiresAt?.getTime() !== 0)) return null;
          Object.assign(row, u.$set); return { ...row };
        },
        updateOne: async (f, u) => {
          let row = rows.get(f._id);
          if (f.owner && row?.owner !== f.owner) return { modifiedCount: 0 };
          if (!row && u.$setOnInsert) { row = { _id: f._id, ...u.$setOnInsert }; rows.set(f._id, row); }
          if (!row) return { modifiedCount: 0 };
          Object.assign(row, u.$set || {}); return { modifiedCount: 1 };
        },
        deleteOne: async (f) => { if (rows.get(f._id)?.owner === f.owner) rows.delete(f._id); },
        bulkWrite: async (ops) => {
          for (const { updateOne: op } of ops) {
            if (!rows.has(op.filter._id)) rows.set(op.filter._id, { _id: op.filter._id, ...op.update.$setOnInsert });
          }
        },
        find: (f) => ({ toArray: async () => [...rows.values()].filter((r) => f._id.$in.includes(r._id)) }),
      });
    }
    return collections.get(name);
  } };
  const oldDb = mongoose.connection.db;
  const oldState = mongoose.connection.readyState;
  mongoose.connection.db = db;
  mongoose.connection.readyState = 1;
  t.after(() => { mongoose.connection.db = oldDb; mongoose.connection.readyState = oldState; });
  const jobs = [];
  t.mock.method(WebhookJob, "findOne", () => ({ select: () => ({ setOptions: () => ({ lean: async () =>
    jobs.find((j) => j.kind === "webhook" && j.next_run_at <= new Date()
      && (j.state === "pending" || (j.state === "failed" && j.retry_count < 5))) || null }) }) }));
  t.mock.method(WebhookJob, "create", async (row) => {
    if (jobs.some((j) => j.jobId === row.jobId || (row.active_key && j.active_key === row.active_key))) {
      throw Object.assign(new Error("duplicate"), { code: 11000 });
    }
    const job = { _id: String(jobs.length), createdAt: new Date(), retry_count: 0, retry_attempts: 0, ...row };
    jobs.push(job); return job;
  });
  t.mock.method(WebhookJob, "updateMany", async (filter, update) => {
    let count = 0;
    for (const job of jobs) {
      const matches = filter.state === "running" ? job.state === "running"
        : job.kind !== "sync" && job.state === filter.state && job.createdAt < filter.createdAt.$lt;
      if (matches) {
        Object.assign(job, update.$set);
        for (const key of Object.keys(update.$unset || {})) delete job[key];
        count++;
      }
    }
    return { modifiedCount: count };
  });
  t.mock.method(WebhookJob, "updateOne", async (f, u) => {
    const job = jobs.find((j) => j._id === f._id && j.state === f.state && j.claim_token === f.claim_token);
    if (!job) return { matchedCount: 0 };
    Object.assign(job, u.$set);
    for (const key of Object.keys(u.$unset || {})) delete job[key];
    return { matchedCount: 1 };
  });
  t.mock.method(WebhookJob, "findOneAndUpdate", (filter, pipeline, options) => ({ lean: async () => {
    assert.ok(!filter.$or.some((f) => f.state === "running"));
    assert.equal(options.sort.priority, -1);
    const candidates = jobs.filter((j) => (!filter.kind || j.kind === filter.kind)
      && (!filter.received_at || j.received_at >= filter.received_at.$gte)
      && j.next_run_at <= new Date()
      && (j.state === "pending" || (j.state === "failed" && j.retry_count < 5)));
    candidates.sort((a, b) => (b.priority || 0) - (a.priority || 0));
    const job = candidates[0];
    if (!job) return null;
    if (job.state === "failed") job.retry_attempts += 1;
    Object.assign(job, { state: "running", claim_token: pipeline[0].$set.claim_token,
      started_at: pipeline[0].$set.started_at,
      worker_revision: pipeline[0].$set.worker_revision,
      next_run_at: pipeline[0].$set.next_run_at });
    return { ...job };
  } }));
  const push = (sn, age = 0) => ({ shop_id: "123", data: { ordersn: sn, update_time: Math.floor((Date.now() - age) / 1000) } });

  await t.test("job treo bị timeout để worker tiếp tục xử lý hàng đợi", async () => {
    await assert.rejects(
      withJobExecutionTimeout(new Promise(() => {}), 20),
      /webhook_job_timeout_20ms/,
    );
  });

  await t.test("payload nhiều ngày được cách ly ngay và không ghi thành công", async () => {
    await enqueueWebhookJob({ jobId: "old", payload: push("OLD", 3 * 86400000) });
    assert.equal(jobs[0].state, "dead-letter");
    assert.equal((await enqueueWebhookJob({ jobId: "old", payload: push("OLD") })).duplicate, true);
    await assert.rejects(enqueueWebhookJob({ jobId: "bad", payload: { data: { ordersn: "X" } } }));
  });
  await t.test("webhook mới chạy trước job đồng bộ và job tồn dư được cách ly", async () => {
    jobs.push({ _id: "orphan", state: "running", jobId: "orphan" });
    await enqueueWebhookJob({ jobId: "fresh", payload: push("FRESH") });
    await enqueueOrderSyncJob({ mode: "quick" }, 10);
    const sequence = [];
    setOrderSyncJobProcessor(async () => { sequence.push("quick"); return { success: true }; });
    await drainOnce(async () => { sequence.push("webhook"); });
    assert.deepEqual(sequence, ["webhook", "quick"]);
    assert.equal(jobs.find((j) => j._id === "orphan").state, "dead-letter");
    assert.equal(jobs.find((j) => j.jobId === "fresh").state, "succeeded");
  });
  await t.test("webhook mới không bị loại chỉ vì chờ queue quá 15 phút", async () => {
    const receivedAt = new Date(Date.now() - 20 * 60_000);
    await enqueueWebhookJob({
      jobId: "waited-fresh",
      payload: {
        shop_id: "123",
        data: { ordersn: "WAITED", update_time: Math.floor(receivedAt.getTime() / 1000) },
      },
      receivedAt,
      orderPersistedAt: receivedAt,
    });
    const waited = jobs.find((j) => j.jobId === "waited-fresh");
    waited.createdAt = receivedAt;
    await drainOnce(async () => {});
    assert.equal(waited.priority, 100);
    assert.equal(waited.state, "succeeded");
    assert.equal(waited.order_persisted_at, receivedAt);
  });
  await t.test("fresh webhook takes priority over pre-restart backlog without dropping the old job", async () => {
    const oldReceived = new Date(Date.now() - 30 * 60000);
    await enqueueWebhookJob({ jobId: "backlogged", receivedAt: oldReceived,
      payload: { shop_id: "123", data: { ordersn: "BACKLOG", update_time: Math.floor(oldReceived.getTime() / 1000) } } });
    jobs.find((j) => j.jobId === "backlogged").next_run_at = oldReceived;
    await enqueueWebhookJob({ jobId: "new-arrival", payload: push("NEW") });
    const seen = [];
    await drainOnce(async (payload) => { seen.push(payload.data.ordersn); });
    assert.deepEqual(seen, ["NEW", "BACKLOG"]);
    assert.equal(jobs.find((j) => j.jobId === "backlogged").state, "succeeded");
  });
  await t.test("heartbeat gia hạn khóa trước khi worker khác thử nhận", async () => {
    await enqueueWebhookJob({ jobId: "slow", payload: push("SLOW") });
    let finish;
    let notifyStarted;
    const started = new Promise((r) => { notifyStarted = r; });
    const work = drainOnce(async () => { notifyStarted(); await new Promise((r) => { finish = r; }); });
    await started;
    const lock = db.collection("sync_orchestrator_locks").rows.get("shopee_orders_global");
    lock.expiresAt = new Date(Date.now() - 600000);
    assert.equal(await renewShopeeSyncLease(lock.owner), true);
    assert.equal((await acquireShopeeSyncLease("competing")).acquired, false);
    assert.ok(lock.expiresAt > new Date());
    assert.equal(jobs.find((j) => j.jobId === "slow").state, "running");
    finish(); await work;
    assert.equal(jobs.find((j) => j.jobId === "slow").state, "succeeded");
  });
  await t.test("khóa cặp shop + đơn chống đồng thời và nhả khi lỗi", async () => {
    await withOrderWorkLock("123", "LOCK", async () => {
      await assert.rejects(withOrderWorkLock("123", "LOCK", async () => {}), /order_work_locked/);
      await withOrderWorkLock("456", "LOCK", async () => {});
    });
    await assert.rejects(withOrderWorkLock("123", "LOCK", async () => { throw Error("failed"); }));
    await withOrderWorkLock("123", "LOCK", async () => {});
  });
  await t.test("retry lưu mã lỗi an toàn và hết retry chuyển dead-letter", async () => {
    await enqueueWebhookJob({ jobId: "failure", payload: push("FAIL") });
    const job = jobs.find((j) => j.jobId === "failure"); job.retry_count = 4;
    await drainOnce(async () => { throw Error("access_token=SECRET raw_payload PRIVATE"); });
    assert.equal(job.state, "dead-letter");
    assert.ok(!job.error_log.includes("SECRET"));
    assert.ok(!safeError(new Error("SECRET")).includes("SECRET"));
    assert.ok(!JSON.stringify(safeTokenMetadata({ access_token: "SECRET", refresh_token: "SECRET" })).includes("SECRET"));
  });
  await t.test("giữ mốc lưu đơn qua retry; TTL chỉ bắt đầu khi job kết thúc", async () => {
    const receivedAt = new Date(Date.now() - 5000);
    await enqueueWebhookJob({ jobId: "latency-retry", payload: push("LATENCY"), receivedAt });
    const job = jobs.find((row) => row.jobId === "latency-retry");
    await drainOnce(async () => { markWebhookOrderPersisted(); throw Error("later_failure"); });
    assert.equal(job.state, "failed");
    assert.equal(job.retry_attempts, 0);
    assert.equal(job.finished_at, undefined);
    assert.equal(job.received_at, receivedAt);
    assert.equal(job.shopId, "123");
    const firstPersistedAt = job.order_persisted_at;
    assert.ok(job.next_run_at.getTime() - Date.now() <= 5000);
    assert.ok(job.next_run_at.getTime() - Date.now() > 0);
    assert.ok(firstPersistedAt instanceof Date);
    job.next_run_at = new Date(0);
    await drainOnce(async () => { markWebhookOrderPersisted(); });
    assert.equal(job.state, "succeeded");
    assert.equal(job.retry_attempts, 1);
    assert.equal(job.order_persisted_at, firstPersistedAt);
    assert.ok(job.finished_at instanceof Date);
  });
  await t.test("identity giữ _id cũ và cùng cặp luôn dùng một _id", async () => {
    const model = { find: () => ({ select: () => ({ lean: async () => [{ _id: "legacy-id", shopId: "123", orderSn: "ID" }] }) }) };
    const first = await resolveShopeeOrderIdentities([{ id: "new-id", shopId: "123", orderSn: "ID" }], db, model);
    const second = await resolveShopeeOrderIdentities([{ id: "different", shopId: "123", orderSn: "ID" }], db, model);
    assert.equal(first.get("123:ID"), "legacy-id"); assert.equal(second.get("123:ID"), "legacy-id");
    await assert.rejects(resolveShopeeOrderIdentities([{ id: "legacy-id", shopId: "456", orderSn: "ID" }], db, model), /identity_conflict/);
  });
  await t.test("cron cùng loại không tạo backlog trùng và có thể chạy lại sau hoàn tất", async () => {
    const payload = { trigger: "cron", lookbackSec: 7200 };
    const first = await enqueueOrderSyncJob(payload);
    const second = await enqueueOrderSyncJob({ ...payload, trigger: "interval" });
    assert.ok(first.accepted); assert.equal(second.duplicate, true);
    await drainOnce(async () => {});
    assert.ok(!(await enqueueOrderSyncJob(payload)).duplicate);
  });
  await t.test("rescue pulls for the same shop and range coalesce across different webhook failures", async () => {
    const payload = { shopIds: ["123"], lookbackSec: 600, useWatermark: false, reconcileActive: false };
    const first = await enqueueOrderSyncJob({ ...payload, trigger: "webhook_detail_fail" }, 5);
    const second = await enqueueOrderSyncJob({ ...payload, trigger: "webhook_tracking_deferred" }, 5);
    assert.ok(first.jobId);
    assert.equal(second.duplicate, true);
    await drainOnce(async () => {});
  });
  await t.test("a running sync yields to a newly queued webhook and resumes the same job without a retry", async () => {
    const ack = await enqueueOrderSyncJob({ shopIds: ["123"], lookbackSec: 600, trigger: "yield-test" }, 5);
    const sequence = [];
    let runs = 0, active = 0, maxActive = 0;
    setOrderSyncJobProcessor(async () => {
      active++; maxActive = Math.max(maxActive, active);
      try {
        runs++; sequence.push(`sync:${runs}`);
        if (runs === 1) await enqueueWebhookJob({ jobId: "arrived-during-sync", payload: push("DURING") });
        await yieldSyncIfWebhookWaiting();
        return { success: true };
      } finally { active--; }
    });
    await drainOnce(async () => { active++; maxActive = Math.max(maxActive, active); sequence.push("webhook"); active--; });
    const job = jobs.find((j) => j.jobId === ack.jobId);
    assert.equal(job.state, "pending");
    assert.equal(job.retry_count, 0);
    assert.ok(job.active_key);
    assert.deepEqual(sequence, ["sync:1", "webhook"]);
    job.next_run_at = new Date(0);
    await drainOnce(async () => {});
    assert.equal(job.state, "succeeded");
    assert.equal(job.retry_attempts, 0);
    assert.equal(maxActive, 1);
    assert.deepEqual(sequence, ["sync:1", "webhook", "sync:2"]);
  });
  await t.test("incremental recovery skips historical scans unless explicitly requested", async () => {
    const calls = [];
    initOrderSyncService({ createSyncJob: async () => ({ id: "" }), finishSyncJob: async () => {},
      isOrdersPullLocked: () => false, listShopIds: () => ["123"],
      pullIncrementalOrdersFromShopee: async (opts) => { calls.push(opts); return { success: true, perShop: [] }; } });
    await triggerBackgroundOrderSync({ trigger: "webhook_detail_fail", shopIds: ["123"], lookbackSec: 600, useWatermark: false });
    await drainOnce(async () => {});
    assert.equal(calls[0].includeHistoryReconcile, false);
    await triggerBackgroundOrderSync({ trigger: "manual", shopIds: ["123"], lookbackSec: 600, useWatermark: false, includeHistoryReconcile: true });
    await drainOnce(async () => {});
    assert.equal(calls[1].includeHistoryReconcile, true);
  });
  await t.test("cron yields between shops to a newly arrived webhook and deduplicates each shop", async () => {
    setOrderSyncJobProcessor(async () => ({ success: true }));
    await drainOnce(async () => {});
    initOrderSyncService({ listShopIds: () => ["123", "456", "123"] });
    const ack = await triggerBackgroundOrderSync({ trigger: "cron", lookbackSec: 7200 });
    assert.equal(ack.jobIds.length, 2);
    const duplicate = await triggerBackgroundOrderSync({ trigger: "interval", lookbackSec: 7200 });
    assert.equal(duplicate.busy, true);
    const sequence = [];
    setOrderSyncJobProcessor(async (payload) => {
      sequence.push(`sync:${payload.shopIds[0]}`);
      if (payload.shopIds[0] === "123") await enqueueWebhookJob({ jobId: "between-shops", payload: push("BETWEEN") });
      return { success: true };
    });
    await drainOnce(async () => { sequence.push("webhook"); });
    assert.deepEqual(sequence, ["sync:123", "webhook", "sync:456"]);
    assert.ok(jobs.find((j) => j.jobId === "between-shops").started_at instanceof Date);
    assert.equal(jobs.find((j) => j.jobId === "between-shops").worker_revision, 5);
    assert.equal(indexCalls, 2, "coordinator indexes are initialized once, not on every queue tick");
  });
  await t.test("background task sync jobs (mode=task) also yield to newly arrived webhooks and cancel on inactive lifecycle", async () => {
    const sequence = [];
    let runs = 0;
    setOrderSyncJobProcessor(async (payload) => {
      runs++;
      sequence.push(`task:${payload.task}:${runs}`);
      if (runs === 1) await enqueueWebhookJob({ jobId: "arrived-during-task", payload: push("TASK-YIELD") });
      await yieldSyncIfWebhookWaiting();
      return { success: true };
    });
    const ack = await enqueueOrderSyncJob({ mode: "task", task: "handed_over", trigger: "cron" }, 0);
    await drainOnce(async () => { sequence.push("webhook"); });
    const job = jobs.find((j) => j.jobId === ack.jobId);
    assert.equal(job.state, "pending");
    assert.equal(job.retry_count, 0);
    assert.deepEqual(sequence, ["task:handed_over:1", "webhook"]);
    job.next_run_at = new Date(0);
    await drainOnce(async () => {});
    assert.equal(job.state, "succeeded");
    assert.deepEqual(sequence, ["task:handed_over:1", "webhook", "task:handed_over:2"]);

    const lifecycle = { active: false };
    await assert.rejects(
      withYieldableSync({ lifecycle, hasWebhook: null }, async () => {
        assertSyncActive();
      }),
      { code: "sync_worker_cancelled" },
    );
  });
  await t.test("new pushes wake the worker and continue beyond one batch without waiting for the poll", async () => {
    const seen = [];
    await drainOnce(async (payload) => { seen.push(payload.data.ordersn); });
    startWebhookJobDrainer();
    t.after(stopWebhookJobDrainer);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const count = 12;
    const burstStart = performance.now();
    for (let i = 0; i < count; i++) {
      await enqueueWebhookJob({ jobId: `burst-${i}`, payload: push(`BURST${i}`) });
    }
    const deadline = Date.now() + 10000;
    while (seen.length < count && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(seen.length, count);
    console.log(JSON.stringify({ benchmark: "12-webhook-burst-mocked-Mongo-no-network", elapsedMs: Math.round(performance.now() - burstStart) }));
    // Wait for the current batch to release its lease before restoring Mongo.
    await new Promise((resolve) => setTimeout(resolve, 500));
    stopWebhookJobDrainer();
  });
});
