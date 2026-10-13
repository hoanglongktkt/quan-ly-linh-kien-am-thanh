import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { once } from "node:events";
import { evaluateOperationsHealth, createOperationsHealthCollector, healthThresholds } from "../modules/operations/health.js";
import { createOperationsRouter } from "../routes/operationsRoutes.js";
import { ensureMongoIndex, ensureOperationalIndexes } from "../modules/operations/mongoIndexes.js";
import { auditOmsIndexes } from "../modules/operations/indexAudit.js";
import WebhookJob from "../models/WebhookJob.js";

const epoch = Date.parse("2026-10-13T12:00:00Z");
const metrics = (depth = 0, progress = null, shops = []) => ({ queue: { depth, waiting: depth },
  summary: { lastJobSucceededAt: progress }, shops, truncated: false });
const token = (remainingMinutes) => ({ access_token: "PRIVATE_ACCESS", refresh_token: "PRIVATE_REFRESH",
  obtained_at: epoch / 1000 - 3600, expire_in: 3600 + remainingMinutes * 60 });

// Kiểm tra theo thời gian giả lập để không chờ nhiều phút hoặc chạm database thật.
test("queue tăng liên tục và đứng yên được phát hiện, tiến độ mới xóa cảnh báo", () => {
  let state;
  for (let minute = 0; minute <= 3; minute++) {
    const sample = evaluateOperationsHealth(metrics(minute + 1), {}, state, new Date(epoch + minute * 60000));
    state = sample.state;
    assert.equal(sample.report.alerts.some((item) => item.code === "queue_growing"), minute === 3);
  }
  const stalled = evaluateOperationsHealth(metrics(4), {}, state, new Date(epoch + 5 * 60000));
  assert.ok(stalled.report.alerts.some((item) => item.code === "queue_stalled"));
  const recovered = evaluateOperationsHealth(metrics(4, new Date(epoch + 6 * 60000)), {}, stalled.state, new Date(epoch + 6 * 60000));
  assert.equal(recovered.report.status, "ok");
  const gap = evaluateOperationsHealth(metrics(10), {}, state, new Date(epoch + 20 * 60000));
  assert.equal(gap.state.growthSamples, 0);
  assert.equal(gap.report.status, "ok");
});

test("token, watermark và webhook dùng mốc thật, có grace và không lộ bí mật", () => {
  const tokens = { "123": token(20), "456": token(-1) };
  const first = evaluateOperationsHealth(metrics(), tokens, {}, new Date(epoch));
  assert.ok(first.report.alerts.some((item) => item.code === "token_expiring" && item.shopId === "123"));
  assert.ok(first.report.alerts.some((item) => item.code === "token_expired" && item.shopId === "456"));
  assert.ok(!first.report.alerts.some((item) => item.code === "webhook_silent" || item.code === "watermark_missing"));
  const late = evaluateOperationsHealth(metrics(), tokens, first.state, new Date(epoch + 60 * 60000));
  assert.ok(late.report.alerts.some((item) => item.code === "webhook_silent"));
  assert.ok(late.report.alerts.some((item) => item.code === "watermark_missing"));
  const healthyShops = [{ shopId: "123", lastWebhookAt: new Date(epoch), lastSuccessfulSyncAt: new Date(epoch) }];
  const fresh = evaluateOperationsHealth(metrics(0, null, healthyShops), { "123": token(180) }, {}, new Date(epoch));
  assert.equal(fresh.report.status, "ok");
  assert.equal(fresh.report.shops[0].lastSuccessfulSyncAt, new Date(epoch).toISOString());
  assert.ok(!JSON.stringify([first, late, fresh]).includes("PRIVATE"));
  const invalid = evaluateOperationsHealth(metrics(), { "123": { ...token(180), obtained_at: "Infinity" } }, {}, new Date(epoch));
  assert.ok(invalid.report.alerts.some((item) => item.code === "token_expiry_unknown"));
  const disabled = evaluateOperationsHealth(metrics(), { "123": token(180) }, first.state, new Date(epoch + 60 * 60000),
    healthThresholds({ OPS_WEBHOOK_EXPECTED_MINUTES: "0" }));
  assert.ok(!disabled.report.alerts.some((item) => item.code === "webhook_silent"));
});

test("hai Passenger dùng chung một mẫu/phút; lỗi đo trả unknown và phục hồi", async () => {
  let doc = null, time = epoch, calls = 0, fail = false;
  const copy = (value) => value ? structuredClone(value) : null;
  const collection = {
    findOne: async () => copy(doc),
    updateOne: async (filter, update) => {
      if (!doc) doc = { _id: filter._id, ...update.$setOnInsert };
      if (filter.owner && filter.owner !== doc.owner) return;
      Object.assign(doc, update.$set);
    },
    findOneAndUpdate: async (filter, update) => {
      if (doc.nextCheckAt > filter.nextCheckAt.$lte) return null;
      Object.assign(doc, update.$set);
      return copy(doc);
    },
  };
  const db = { collection: (name) => { assert.equal(name, "ops_health_state"); return collection; } };
  const options = { clock: () => new Date(time), collect: async (_, query) => {
    calls++;
    assert.equal(query.includeApiErrors, false);
    if (fail) throw Error("PRIVATE_URI");
    return metrics();
  } };
  const firstProcess = createOperationsHealthCollector(options);
  const secondProcess = createOperationsHealthCollector(options);
  assert.equal((await firstProcess(db)).cached, false);
  assert.equal((await secondProcess(db)).cached, true);
  assert.equal(calls, 1);
  time += 60000; fail = true;
  await assert.rejects(firstProcess(db), /health_unavailable/);
  assert.equal((await secondProcess(db)).status, "unknown");
  assert.ok(!JSON.stringify(doc).includes("PRIVATE"));
  time += 60000; fail = false;
  assert.equal((await secondProcess(db)).status, "ok");
  assert.equal(calls, 3);
});

test("health bảo vệ token, lọc shop đúng, trả 503 khi critical/unknown; giới hạn query metrics", async (t) => {
  const savedToken = process.env.OPS_METRICS_TOKEN;
  process.env.OPS_METRICS_TOKEN = "test-observability-token".padEnd(64, "x");
  t.after(() => { if (savedToken === undefined) delete process.env.OPS_METRICS_TOKEN; else process.env.OPS_METRICS_TOKEN = savedToken; });
  let report = { status: "critical", alerts: [{ code: "token_expired", severity: "critical", shopId: "456" }],
    shops: [{ shopId: "123" }, { shopId: "456" }], stale: false };
  let calls = 0;
  const releases = [];
  const app = express();
  app.use("/api/internal/ops", createOperationsRouter({ getDb: () => ({}), collectHealth: async () => report,
    collect: async () => { calls++; await new Promise((resolve) => releases.push(resolve)); return {}; } }));
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => { releases.forEach((release) => release()); server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}/api/internal/ops`;
  const headers = { authorization: `Bearer ${process.env.OPS_METRICS_TOKEN}` };
  assert.equal((await fetch(`${base}/health`)).status, 401);
  assert.equal((await fetch(`${base}/health?shopId[$ne]=1`, { headers })).status, 400);
  assert.equal((await fetch(`${base}/health?windowMinutes=60`, { headers })).status, 400);
  assert.equal((await fetch(`${base}/health`, { headers })).status, 503);
  const filtered = await fetch(`${base}/health?shopId=123`, { headers });
  assert.equal(filtered.status, 200);
  assert.deepEqual((await filtered.json()).shops, [{ shopId: "123" }]);
  report = { ...report, status: "unknown", alerts: [] };
  assert.equal((await fetch(`${base}/health`, { headers })).status, 503);
  report = { ...report, status: "ok", stale: true };
  assert.equal((await fetch(`${base}/health`, { headers })).status, 503);
  const first = fetch(`${base}/metrics?shopId=123`, { headers });
  const second = fetch(`${base}/metrics?shopId=456`, { headers });
  // Chờ hai query vào collector, rồi kiểm tra query thứ ba bị chặn.
  for (let i = 0; i < 100 && calls < 2; i++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(calls, 2);
  assert.equal((await fetch(`${base}/metrics?shopId=789`, { headers })).status, 429);
  releases.forEach((release) => release());
  assert.equal((await first).status, 200);
  assert.equal((await second).status, 200);
});

test("thiếu compound bị chặn trước khi tạo bất kỳ index nào", async () => {
  // Giữ unique chống trùng; không tự khai báo compound trên model worker.
  const indexes = WebhookJob.schema.indexes();
  assert.equal(indexes.length, 2);
  assert.ok(indexes.every(([key, options]) => Object.keys(key).length === 1 && options.unique));
  let writes = 0;
  const db = { collection: () => ({ indexes: async () => [], createIndex: async () => { writes++; } }) };
  await assert.rejects(ensureMongoIndex(db, "orders", { shopId: 1, orderSn: 1 }, { name: "candidate" }), /compound_index_requires_review/);
  await assert.rejects(ensureOperationalIndexes(db), /compound_index_requires_review/);
  assert.equal(writes, 0);
});

test("audit explain chỉ đọc; phản ánh COLLSCAN/SORT và không in định danh mẫu", async () => {
  const explains = [];
  const db = { collection: (name) => ({
    indexes: async () => [{ name: "_id_", key: { _id: 1 }, unique: true }],
    findOne: async () => name === "orders" ? { _id: "PRIVATE_ORDER", orderSn: "PRIVATE_SN", shopId: "123" }
      : { _id: "PRIVATE_LISTING", channelId: "PRIVATE_ITEM" },
    find: () => cursor(name), aggregate: () => cursor(name),
    createIndex: () => assert.fail("Audit không tạo index"), updateOne: () => assert.fail("Audit không ghi"),
  }) };
  function cursor(name) {
    return { sort() { return this; }, limit() { return this; }, explain: async (mode) => {
      explains.push({ name, mode });
      return { queryPlanner: { winningPlan: { stage: "SORT", inputStage: { stage: "COLLSCAN" } },
        rejectedPlans: [{ stage: "IXSCAN", indexName: "not_winning" }] },
      executionStats: { nReturned: 1, totalDocsExamined: 1000, totalKeysExamined: 0, executionTimeMillis: 30 } };
    } };
  }
  const report = await auditOmsIndexes(db);
  assert.equal(report.readOnly, true);
  assert.equal(report.writePerformanceVerified, false);
  assert.ok(explains.every((item) => item.mode === "executionStats"));
  assert.ok(report.queries.every((item) => item.collectionScan && item.blockingSort));
  assert.ok(report.queries.every((item) => !item.indexes.includes("not_winning")));
  assert.ok(!JSON.stringify(report).includes("PRIVATE"));
});
