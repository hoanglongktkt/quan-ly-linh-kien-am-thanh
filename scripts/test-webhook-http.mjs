import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { fetchWithTimeout, shopeeFetchJsonWithRetry, shopeePostJsonWithRetry } from "../modules/shopee-sync/client.js";
import { webhookObservation, syncObservation } from "../modules/operations/telemetry.js";
import { withYieldableSync, yieldSyncIfWebhookWaiting } from "../modules/shopee-sync/syncYield.js";

test("timeout aborts a real response stalled AFTER headers, for GET and POST", async (t) => {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.write('{"response":'); // Headers arrive, but the body never completes.
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); });
  const url = `http://127.0.0.1:${server.address().port}/body-stall`;
  for (const read of [
    () => shopeeFetchJsonWithRetry(url, "test", { maxAttempts: 1, timeoutMs: 80 }),
    () => shopeePostJsonWithRetry(url, {}, "test", { maxAttempts: 1, timeoutMs: 80 }),
  ]) {
    const began = performance.now();
    await assert.rejects(read());
    assert.ok(performance.now() - began < 2000, "body stall must not occupy a worker for minutes");
  }
});

test("webhooks defer HTTP retries to queue; bulk sync retains HTTP retries", async (t) => {
  for (const request of [
    () => shopeeFetchJsonWithRetry("https://example.invalid/api", "test", { maxAttempts: 3, baseDelayMs: 0 }),
    () => shopeePostJsonWithRetry("https://example.invalid/api", {}, "test", { maxAttempts: 3, baseDelayMs: 0 }),
  ]) {
    let calls = 0;
    const mock = t.mock.method(globalThis, "fetch", async () => {
      calls++;
      return calls === 1 ? new Response('{"error":"rate_limit"}', { status: 429 }) : new Response('{"response":{}}');
    });
    const first = await webhookObservation.run({}, request);
    assert.equal(first.httpStatus, 429);
    assert.equal(calls, 1);
    calls = 0;
    assert.equal((await request()).httpStatus, 200);
    assert.equal(calls, 2);
    mock.mock.restore();
  }
});

test("successful body read clears deadline and preserves external abort until body consumption", async (t) => {
  let signal;
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    signal = init.signal;
    return new Response('{"ok":true}');
  });
  const response = await fetchWithTimeout("https://example.invalid", {}, 20);
  assert.deepEqual(await response.json(), { ok: true });
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(signal.aborted, false);
  const external = new AbortController();
  const second = await fetchWithTimeout("https://example.invalid", { signal: external.signal }, 100);
  external.abort();
  assert.equal(signal.aborted, true);
  await second.text();
});

test("automatic sync has one HTTP attempt and records API stage; full sync keeps retries", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => { calls++; return new Response('{"error":"rate_limit"}', { status: 429 }); });
  const observation = { incremental: true };
  const request = () => shopeeFetchJsonWithRetry("https://example.invalid/api/v2/order/get_order_list?access_token=PRIVATE", "test", { baseDelayMs: 0 });
  assert.equal((await syncObservation.run(observation, request)).httpStatus, 429);
  assert.equal(calls, 1);
  assert.equal(observation.stage, "api_get_order_list");
  assert.ok(!JSON.stringify(observation).includes("PRIVATE"));
  calls = 0;
  await syncObservation.run({ incremental: false }, request);
  assert.equal(calls, 3);
});

test("expired sync lifecycle cannot continue at a checkpoint or start another HTTP request", async (t) => {
  t.mock.method(globalThis, "fetch", async () => assert.fail("expired sync must not start HTTP"));
  await assert.rejects(withYieldableSync({ lifecycle: { active: false },
    hasWebhook: async () => assert.fail("expired work must not query the queue") }, yieldSyncIfWebhookWaiting),
  { code: "sync_worker_cancelled" });
  await assert.rejects(withYieldableSync({ lifecycle: { active: false }, hasWebhook: async () => false },
    () => fetchWithTimeout("https://example.invalid")), { code: "sync_worker_cancelled" });
  await yieldSyncIfWebhookWaiting();
});

// Exercise the real function without starting the production server or loading secrets.
const source = fs.readFileSync(new URL("../server.ts", import.meta.url), "utf8");
const parsed = ts.createSourceFile("server.ts", source, ts.ScriptTarget.Latest, true);
const node = parsed.statements.find((item) => ts.isFunctionDeclaration(item) && item.name?.text === "fetchNormalizeShopeeOrderChunk");
const compiled = ts.transpileModule(node.getText(parsed), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

test("real order-list pagination yields before another page and does not swallow the control signal", async () => {
  const fn = parsed.statements.find((item) => ts.isFunctionDeclaration(item) && item.name?.text === "collectShopeeOrderSnsIncremental");
  const code = ts.transpileModule(fn.getText(parsed), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const read = vm.runInNewContext(`${code}; collectShopeeOrderSnsIncremental`, {
    SHOPEE_ORDER_LIST_INCREMENTAL_SEC: 600, ORDERS_PULL_PER_SHOP_MS: 60000, SHOPEE_ORDER_LIST_LOOP_SAFETY_CAP: 50,
    clampShopeeHistoryLookbackSec: (value) => value, toShopeeUnixSeconds: (value) => Math.floor(value / 1000),
    shopeeHistoryTimeFromMs: () => 0, buildShopeeOrderListTimeChunks: () => [{ timeFrom: 0, timeTo: Date.now() }],
    syncDiag() {}, yieldSyncIfWebhookWaiting,
    shopeeGetOrderList: async () => assert.fail("new webhook must run before requesting another page"),
  });
  await assert.rejects(withYieldableSync({ lifecycle: { active: true }, hasWebhook: async () => true },
    () => read("123", "mock", { allowShortLookback: true })), { code: "sync_yield_for_webhook" });
});

test("single-order webhook does not repeat failed/empty API calls or probe other shops", async () => {
  for (const result of [{ error: "rate_limit", httpStatus: 429 }, { error: "order_not_found" },
    { response: { order_list: [] } }, new Error("network"), { response: { order_list: [{ order_sn: "ORDER1" }] } }]) {
    let calls = 0, probes = 0;
    const env = {
      console: { log() {}, warn() {}, error() {} },
      normalizeShopIdKey: String, ORDER_DETAIL_FETCH_BATCH_SIZE: 20, SHOPEE_ORDER_DETAIL_MAX_ORDER_SNS: 50,
      ORDER_DETAIL_BATCH_DELAY_MS: 1000, SHOPEE_ORDER_LIST_PAGE_DELAY_MS: 500,
      shopeeGetOrderDetail: async () => { calls++; if (result instanceof Error) throw result; return result; },
      isShopeeOrderNotFoundError: (code) => code === "order_not_found", isShopeeWrongShopError: () => false,
      isShopeeInvalidTokenError: () => false, isShopeeRateLimited: (status) => status === 429,
      formatShopeeApiError: () => "api_error", delay: async () => {}, shopeeSyncDelay: async () => {},
      normalizeShopeeOrderDetail: (_shop, _name, detail) => ({ orderSn: detail.order_sn }),
      markLocalOrdersCancelledForShopeeNotFound: async () => { probes++; },
      probeOrderDetailOnOtherShops: async () => { probes++; }, MAX_CROSS_SHOP_PROBE_PER_CHUNK: 3,
    };
    const run = vm.runInNewContext(`${compiled}; fetchNormalizeShopeeOrderChunk`, env);
    const output = await run("123", "mock", "123", ["ORDER1"], { webhookFastPath: true, skipEscrow: true });
    assert.equal(calls, 1);
    assert.equal(probes, 0);
    const success = Boolean(result.response?.order_list?.length);
    assert.equal(output.errors.length, success ? 0 : 1);
    assert.equal(output.normalized.length, success ? 1 : 0);
    if (result.response?.order_list?.length === 0) {
      calls = 0;
      await run("123", "mock", "123", ["ORDER1"], { skipEscrow: true });
      assert.equal(calls, 2, "bulk sync keeps its per-order fallback");
      assert.equal(probes, 2, "bulk sync still checks not-found orders");
    }
  }
});

test("shallow webhook fallback persists the order without tracking or finance API calls", async () => {
  const shallow = parsed.statements.find((item) => ts.isFunctionDeclaration(item) && item.name?.text === "upsertShopeeWebhookShallow");
  const code = ts.transpileModule(shallow.getText(parsed), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  let writes = 0, enrichment = 0;
  const run = vm.runInNewContext(`${code}; upsertShopeeWebhookShallow`, {
    console: { log() {}, warn() {}, error() {} },
    normalizeShopeeOrder: () => ({ orderSn: "ORDER1", channel: "shopee", shopId: "123", status: "unprocessed" }),
    isMongoReady: () => true, bulkUpsertOrdersToStore: async () => { writes++; },
    invalidateOrdersRefreshCache() {}, invalidateTabCountCache() {}, queueOrdersJsonMirrorFromMongo() {}, emitNewOrder() {},
    needsShopeeTrackingEnrichment: () => true, getValidShopeeAccessToken: async () => "mock",
    enrichShopeeOrderTrackingFromApi: async (_shop, _token, order) => { enrichment++; return order; },
    enrichShopeeOrdersEscrowFinance: async () => { enrichment++; }, hasUsableShopeeTrackingNumber: () => false,
  });
  assert.equal(await run({}, [], { skipEnrichment: true }), "ORDER1");
  assert.equal(writes, 1);
  assert.equal(enrichment, 0);
  await run({}, []);
  assert.equal(enrichment, 2, "other callers retain their enrichment behavior");
});
