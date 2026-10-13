import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { once } from "node:events";
import mongoose from "mongoose";
import { createOperationsRouter } from "../routes/operationsRoutes.js";
import { parseMetricsQuery, collectOperationsMetrics } from "../modules/operations/metrics.js";
import { retentionSeconds, ensureMongoIndex } from "../modules/operations/mongoIndexes.js";
import { webhookObservation, markWebhookOrderPersisted } from "../modules/operations/telemetry.js";
import { shopeeFetchJsonWithRetry, shopeePostJsonWithRetry, fetchWithTimeout } from "../modules/shopee-sync/client.js";

// Kiểm thử cục bộ: không kết nối Atlas hoặc gọi Shopee thật.
test("query chặn injection, giữ shop uint64 và giới hạn cửa sổ", () => {
  assert.deepEqual(parseMetricsQuery({ shopId: "12345678901234567890" }), { shopId: "12345678901234567890", windowMinutes: 60 });
  for (const query of [{ shopId: { $ne: null } }, { windowMinutes: ["60"] }, { windowMinutes: "1441" },
    { windowMinutes: "0" }, { windowMinutes: "1e3" }, { debug: "true" }]) {
    assert.throws(() => parseMetricsQuery(query));
  }
});

test("API bảo vệ token, cache theo shop và trả lỗi DB an toàn", async (t) => {
  const oldToken = process.env.OPS_METRICS_TOKEN;
  t.after(() => { if (oldToken === undefined) delete process.env.OPS_METRICS_TOKEN; else process.env.OPS_METRICS_TOKEN = oldToken; });
  let calls = 0;
  let db = {};
  let fail = false;
  const app = express();
  app.use("/api/internal/ops", createOperationsRouter({ getDb: () => db, collect: async (_, options) => {
    calls += 1;
    if (fail) throw Error("secret database URI");
    return { shopId: options.shopId, generatedAt: "sample" };
  } }));
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); });
  const url = `http://127.0.0.1:${server.address().port}/api/internal/ops/metrics`;
  delete process.env.OPS_METRICS_TOKEN;
  assert.equal((await fetch(url)).status, 503);
  process.env.OPS_METRICS_TOKEN = "test-token-".padEnd(64, "x");
  assert.equal((await fetch(url)).status, 401);
  assert.equal((await fetch(url, { headers: { authorization: "Bearer wrong" } })).status, 401);
  const headers = { authorization: `Bearer ${process.env.OPS_METRICS_TOKEN}` };
  assert.equal((await fetch(`${url}?shopId[$ne]=1`, { headers })).status, 400);
  assert.equal((await fetch(`${url}?windowMinutes=1441`, { headers })).status, 400);
  const first = await fetch(`${url}?shopId=123`, { headers });
  assert.equal(first.headers.get("cache-control"), "no-store");
  assert.equal((await first.json()).cached, false);
  assert.equal((await (await fetch(`${url}?shopId=123`, { headers })).json()).cached, true);
  assert.equal(calls, 1);
  assert.equal((await (await fetch(`${url}?shopId=456`, { headers })).json()).shopId, "456");
  assert.equal(calls, 2);
  db = null;
  assert.equal((await fetch(url, { headers })).status, 503);
  db = {}; fail = true;
  const failed = await fetch(url, { headers });
  assert.equal(failed.status, 503);
  assert.ok(!(await failed.text()).includes("secret"));
});

test("metrics tính độ trễ có trọng số, phân biệt retry và queue hiện tại", async () => {
  const now = new Date("2026-10-13T12:30:30Z");
  const plans = [];
  const db = { collection: (name) => ({ aggregate: (pipeline, options) => {
    plans.push({ name, pipeline, options });
    return { toArray: async () => name === "ops_api_errors"
      ? [{ _id: { shopId: "123", category: "http" }, count: 3 }]
      : pipeline.some((stage) => stage.$project)
        ? [{ _id: "123", jobs: 4, retryAttempts: 2, jobFailures: 3, legacyRetryJobs: 1,
          deadLetterJobs: 1, latencySamples: 2, latencyTotalMs: 1200, latencyMaxMs: 900 },
          { _id: "unattributed", jobs: 1, latencySamples: 0, latencyTotalMs: 0, latencyMaxMs: null }]
        : [{ _id: "pending", count: 8, oldest: new Date(now.getTime() - 120000) },
          { _id: "running", count: 1 }, { _id: "failed", count: 2 }] };
  } }) };
  const result = await collectOperationsMetrics(db, { shopId: "123", windowMinutes: 60 }, now);
  assert.equal(result.queue.depth, 11);
  assert.equal(result.queue.oldestAgeMs, 120000);
  assert.equal(result.shops[0].retryAttempts, 2);
  assert.equal(result.shops[0].jobFailures, 3);
  assert.equal(result.shops[0].apiErrors, 3);
  assert.equal(result.shops[0].webhookToOrderLatencyMs.average, 600);
  assert.equal(result.shops[1].webhookToOrderLatencyMs.average, null);
  assert.equal(result.window.apiErrorSince, "2026-10-13T11:30:00.000Z");
  for (const plan of plans) {
    assert.equal(plan.pipeline[0].$match.shopId, "123");
    assert.equal(plan.options.maxTimeMS, 5000);
  }
});

test("TTL sửa bằng collMod, không drop; cấu hình lỗi phải bị chặn", async (t) => {
  const old = process.env.ORDER_EVENT_TTL_SECONDS;
  t.after(() => { if (old === undefined) delete process.env.ORDER_EVENT_TTL_SECONDS; else process.env.ORDER_EVENT_TTL_SECONDS = old; });
  for (const value of ["NaN", "0", "1.5", "Infinity", "31536001"]) {
    process.env.ORDER_EVENT_TTL_SECONDS = value;
    assert.throws(() => retentionSeconds("ORDER_EVENT_TTL_SECONDS"));
  }
  process.env.ORDER_EVENT_TTL_SECONDS = "1209600";
  assert.equal(retentionSeconds("ORDER_EVENT_TTL_SECONDS"), 1209600);
  const commands = [];
  const db = { collection: () => ({ indexes: async () => [{ name: "legacy_ttl", key: { occurred_at: 1 }, expireAfterSeconds: 10 }],
    createIndex: async () => assert.fail("Không tạo trùng key TTL"), dropIndex: async () => assert.fail("Không drop TTL") }),
    command: async (command) => commands.push(command) };
  await ensureMongoIndex(db, "order_events", { occurred_at: 1 }, { name: "order_events_ttl", expireAfterSeconds: 1209600 });
  assert.deepEqual(commands[0], { collMod: "order_events", index: { name: "legacy_ttl", expireAfterSeconds: 1209600 } });
});

test("mốc Mongo đầu tiên giữ nguyên qua lỗi và không lẫn webhook đồng thời", async () => {
  const first = {}, second = {};
  await Promise.all([
    webhookObservation.run(first, async () => { markWebhookOrderPersisted(); const saved = first.orderPersistedAt;
      await new Promise((resolve) => setTimeout(resolve, 10)); markWebhookOrderPersisted(); assert.equal(first.orderPersistedAt, saved); }),
    webhookObservation.run(second, async () => { await Promise.resolve(); markWebhookOrderPersisted(); }),
  ]);
  assert.ok(first.orderPersistedAt instanceof Date);
  assert.ok(second.orderPersistedAt instanceof Date);
  assert.notEqual(first.orderPersistedAt, second.orderPersistedAt);
  const observation = {};
  await assert.rejects(webhookObservation.run(observation, async () => { markWebhookOrderPersisted(); throw Error("later_failure"); }));
  assert.ok(observation.orderPersistedAt instanceof Date);
});

test("Shopee đếm từng lần API lỗi, không đếm đôi và không lưu token", async (t) => {
  const oldDb = mongoose.connection.db, oldState = mongoose.connection.readyState;
  const writes = [];
  mongoose.connection.db = { collection: (name) => ({ updateOne: async (filter, update, options) => writes.push({ name, filter, update, options }) }) };
  mongoose.connection.readyState = 1;
  t.after(() => { mongoose.connection.db = oldDb; mongoose.connection.readyState = oldState; });
  let responses = [];
  t.mock.method(globalThis, "fetch", async () => {
    const response = responses.shift();
    if (response instanceof Error) throw response;
    return response;
  });
  const url = "https://partner.shopeemobile.com/api/v2/order/get_order_detail?shop_id=12345678901234567890&access_token=PRIVATE&sign=PRIVATE";
  responses = [new Response('{"error":"rate_limit_exceeded"}', { status: 429 }),
    new Response('{"error":"rate_limit_exceeded"}', { status: 429 }), new Response('{"response":{}}')];
  await shopeeFetchJsonWithRetry(url, "test", { maxAttempts: 3, baseDelayMs: 0 });
  assert.equal(writes.length, 2);
  responses = [new Response('{"error":"invalid_request"}')];
  await shopeePostJsonWithRetry(url, {}, "test", { maxAttempts: 1 });
  responses = [new Response("invalid JSON")];
  await shopeeFetchJsonWithRetry(url, "test", { maxAttempts: 1 });
  responses = [Error("network")];
  await assert.rejects(fetchWithTimeout(url));
  assert.deepEqual(writes.map((row) => row.update.$setOnInsert.category), ["http", "http", "application", "parse", "network"]);
  assert.ok(writes.every((row) => row.update.$setOnInsert.shopId === "12345678901234567890"));
  assert.ok(!JSON.stringify(writes).includes("PRIVATE"));
  assert.ok(writes.every((row) => row.update.$setOnInsert.expires_at instanceof Date && row.options.timeoutMS === 1500));
  mongoose.connection.db.collection = () => ({ updateOne: async () => { throw Error("DB unavailable"); } });
  responses = [new Response('{"error":"bad_request"}', { status: 400 })];
  assert.equal((await shopeeFetchJsonWithRetry(url, "test", { maxAttempts: 1 })).httpStatus, 400);
});
