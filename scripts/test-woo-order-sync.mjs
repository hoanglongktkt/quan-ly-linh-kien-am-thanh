import assert from "node:assert/strict";
import test from "node:test";
import { createWooCommerceOrderSync, scheduleWooCommerceOrderSync, wooShopSyncKey, wooSyncEnabled, wooSyncIntervalMs } from "../services/wooCommerceOrderSync.js";
import { createWooCommerceSyncState } from "../services/wooCommerceSyncState.js";
import { fetchWooCommerceOrders } from "../services/wooCommerce.js";

const initialNow = Date.parse("2026-10-26T10:00:00Z");
const shop = { platform: "woocommerce", shopId: "ck_test", apiKey: "cs_test", wooUrl: "https://woo.example", shopName: "Test Woo", connected: true };

function fixture(extra = {}) {
  let time = initialNow;
  const records = new Map();
  const calls = [];
  const saved = [];
  const state = {
    async claim(key, token, { incremental, intervalMs }) {
      const row = records.get(key) || {};
      if (row.owner || (incremental && row.lastAutoStartedAt && time - row.lastAutoStartedAt < intervalMs)) return null;
      records.set(key, { ...row, owner: token, ...(incremental ? { lastAutoStartedAt: time } : {}) });
      return structuredClone(row);
    },
    async renew(key, token) { assert.equal(records.get(key).owner, token); },
    async save(key, token, patch) { assert.equal(records.get(key).owner, token); Object.assign(records.get(key), patch); },
    async release(key, token) { assert.equal(records.get(key).owner, token); delete records.get(key).owner; },
  };
  const deps = {
    state, now: () => time, sleep: async () => {},
    isMongoReady: () => true, loadChannelSettings: () => ({ shops: [shop] }),
    fetchOrders: async (_shop, opts) => { calls.push(opts); return { orders: [{ id: "woo-1", status: "pending_pack" }], totalPages: 1 }; },
    persistOrders: async (orders) => { saved.push(...orders); return orders.length; },
    ...extra,
  };
  return { deps, records, calls, saved, advance: (ms) => { time += ms; }, sync: createWooCommerceOrderSync(deps) };
}

test("first automatic run imports seven days, then only changes with overlap", async () => {
  const f = fixture();
  assert.equal((await f.sync.run({ incremental: true })).totalOrdersImported, 1);
  assert.equal(f.calls[0].modifiedAfter, "2026-10-19T10:00:00.000Z");
  assert.equal(f.calls[0].modifiedBefore, "2026-10-26T09:59:55.000Z");
  assert.equal(f.calls[0].orderby, "modified");
  assert.equal(f.calls[0].datesAreGmt, true);
  f.advance(61_000);
  assert.equal((await f.sync.run({ incremental: true })).success, true);
  assert.equal(f.calls[1].modifiedAfter, "2026-10-26T09:57:55.000Z");
  assert.equal(f.calls[1].after, undefined); // Old orders modified now are included.
});

test("saved checkpoints survive creating a new runner after restart", async () => {
  const f = fixture();
  await f.sync.run({ incremental: true });
  f.advance(61_000);
  await createWooCommerceOrderSync(f.deps).run({ incremental: true });
  assert.equal(f.calls[1].modifiedAfter, "2026-10-26T09:57:55.000Z");
});

test("a backlog continues beyond the old ten-page limit without advancing too early", async () => {
  const calls = [];
  const f = fixture({ fetchOrders: async (_shop, opts) => {
    calls.push(opts);
    return { orders: [{ id: `woo-${opts.page}` }], totalPages: 12 };
  } });
  await f.sync.run({ incremental: true });
  const key = wooShopSyncKey(shop);
  assert.equal(f.records.get(key).pendingWindow.page, 6);
  assert.equal(f.records.get(key).cursorAt, undefined);
  f.advance(61_000);
  await createWooCommerceOrderSync(f.deps).run({ incremental: true });
  assert.equal(f.records.get(key).pendingWindow.page, 11);
  f.advance(61_000);
  await f.sync.run({ incremental: true });
  assert.equal(f.records.get(key).pendingWindow, null);
  assert.equal(f.records.get(key).cursorAt, calls[0].modifiedBefore);
  assert.deepEqual(calls.map((c) => c.page), Array.from({ length: 12 }, (_, i) => i + 1));
  assert.equal(new Set(calls.map((c) => c.modifiedBefore)).size, 1);
});

for (const failure of ["api", "persist", "partial-save", "invalid-list"]) {
  test(`${failure} failure keeps checkpoint and retries the failed page`, async () => {
    let fail = true;
    const f = fixture({
      fetchOrders: async () => {
        if (fail && failure === "api") throw new Error("API unavailable");
        return { orders: fail && failure === "invalid-list" ? null : [{ id: "woo-1" }], totalPages: 1 };
      },
      persistOrders: async (orders) => {
        if (fail && failure === "persist") throw new Error("DB unavailable");
        return fail && failure === "partial-save" ? 0 : orders.length;
      },
    });
    const first = await f.sync.run({ incremental: true });
    assert.equal(first.success, false);
    const key = wooShopSyncKey(shop);
    assert.equal(f.records.get(key).cursorAt, undefined);
    assert.equal(f.records.get(key).owner, undefined);
    fail = false;
    f.advance(61_000);
    assert.equal((await f.sync.run({ incremental: true })).success, true);
    assert.ok(f.records.get(key).cursorAt);
    assert.equal(f.records.get(key).lastError, null);
  });
}

test("manual and automatic runs cannot overlap in one process", async () => {
  let finishFetch;
  const f = fixture({ fetchOrders: () => new Promise((resolve) => { finishFetch = resolve; }) });
  const auto = f.sync.run({ incremental: true });
  await new Promise((r) => setImmediate(r));
  assert.equal((await f.sync.run()).error, "woo_sync_busy");
  finishFetch({ orders: [], totalPages: 1 });
  await auto;
});

test("different processes share the store lease and the interval guard", async () => {
  const f = fixture();
  let finishFetch;
  const first = createWooCommerceOrderSync({ ...f.deps, fetchOrders: () => new Promise((resolve) => { finishFetch = resolve; }) }).run({ incremental: true });
  await new Promise((r) => setImmediate(r));
  const other = createWooCommerceOrderSync(f.deps);
  assert.equal((await other.run()).skipped, true);
  finishFetch({ orders: [], totalPages: 1 });
  await first;
  assert.equal((await other.run({ incremental: true })).skipped, true);
  assert.equal(f.calls.length, 0);
});

test("manual lookback does not skip or overwrite a pending automatic window", async () => {
  const f = fixture();
  const key = wooShopSyncKey(shop);
  const pending = { after: "2026-10-10T00:00:00Z", before: "2026-10-12T00:00:00Z", page: 4 };
  f.records.set(key, { cursorAt: "2026-10-10T00:00:00Z", pendingWindow: pending });
  assert.equal((await f.sync.run({ lookback_days: 14 })).success, true);
  assert.equal(f.calls[0].after, "2026-10-12T10:00:00.000Z");
  assert.deepEqual(f.records.get(key).pendingWindow, pending);
  assert.equal(f.records.get(key).cursorAt, "2026-10-10T00:00:00Z");
});

test("disconnected shops are excluded; one failing shop does not stop others", async () => {
  const shops = [shop, { ...shop, wooUrl: "https://second.example", shopId: "ck_second" }, { ...shop, connected: false }];
  const seen = [];
  const f = fixture({ loadChannelSettings: () => ({ shops }), fetchOrders: async (s) => {
    seen.push(s.shopId);
    if (s.shopId === shop.shopId) throw new Error("first unavailable");
    return { orders: [], totalPages: 1 };
  } });
  const r = await f.sync.run({ incremental: true });
  assert.equal(r.shopsFailed, 1);
  assert.equal(r.shopsSynced, 1);
  assert.deepEqual(seen, ["ck_test", "ck_second"]);
});

test("no shops and database unavailable do not call the remote API", async () => {
  const empty = fixture({ loadChannelSettings: () => ({ shops: [] }) });
  assert.equal((await empty.sync.run()).error, "no_woo_shops");
  const down = fixture({ isMongoReady: () => false });
  assert.equal((await down.sync.run()).error, "mongodb_not_ready");
  assert.equal(down.calls.length, 0);
});

test("scheduler runs without browser activity, starts after 15s, and stops cleanly", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  const prev = process.env.AUTO_WOO_ORDER_SYNC;
  const previousMs = process.env.AUTO_WOO_ORDER_SYNC_MS;
  delete process.env.AUTO_WOO_ORDER_SYNC;
  delete process.env.AUTO_WOO_ORDER_SYNC_MS;
  try {
    const calls = [];
    const stop = scheduleWooCommerceOrderSync({ run: async (opts) => { calls.push(opts); } });
    t.mock.timers.tick(14_999);
    assert.equal(calls.length, 0);
    t.mock.timers.tick(1);
    assert.equal(calls.length, 1);
    t.mock.timers.tick(45_000);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].incremental, true);
    stop();
    t.mock.timers.tick(120_000);
    assert.equal(calls.length, 2);
  } finally {
    if (prev == null) delete process.env.AUTO_WOO_ORDER_SYNC; else process.env.AUTO_WOO_ORDER_SYNC = prev;
    if (previousMs == null) delete process.env.AUTO_WOO_ORDER_SYNC_MS; else process.env.AUTO_WOO_ORDER_SYNC_MS = previousMs;
  }
});

test("automatic sync defaults on with bounded interval and credential-free keys", () => {
  assert.equal(wooSyncEnabled({}), true);
  assert.equal(wooSyncEnabled({ AUTO_WOO_ORDER_SYNC: " OFF " }), false);
  assert.equal(wooSyncIntervalMs({}), 60_000);
  assert.equal(wooSyncIntervalMs({ AUTO_WOO_ORDER_SYNC_MS: "NaN" }), 60_000);
  assert.equal(wooSyncIntervalMs({ AUTO_WOO_ORDER_SYNC_MS: "1" }), 30_000);
  assert.equal(wooSyncIntervalMs({ AUTO_WOO_ORDER_SYNC_MS: "99999999" }), 600_000);
  assert.equal(wooShopSyncKey(shop).includes(shop.shopId), false);
  assert.equal(wooShopSyncKey(shop), wooShopSyncKey({ ...shop, wooUrl: shop.wooUrl + "/", shopId: "rotated-key" }));
});

test("Mongo state uses an atomic lease, does not store credentials, and detects lost ownership", async () => {
  const calls = [];
  const collection = {
    async updateOne(filter, update, opts) { calls.push({ filter, update, opts }); return { matchedCount: 1 }; },
    async findOneAndUpdate(filter, update, opts) { calls.push({ filter, update, opts }); return { _id: "test-key", owner: "token" }; },
  };
  const state = createWooCommerceSyncState(() => collection);
  assert.equal((await state.claim("test-key", "token", { incremental: true, intervalMs: 60_000 })).owner, "token");
  assert.ok(calls[1].filter.leaseUntil.$lte instanceof Date);
  assert.equal(calls[1].filter.$or.length, 2);
  assert.equal(calls[1].opts.returnDocument, "after");
  await state.renew("test-key", "token");
  assert.equal(calls[2].filter.owner, "token");
  collection.updateOne = async () => ({ matchedCount: 0 });
  await assert.rejects(() => state.save("test-key", "other", { cursorAt: "now" }), /lease_lost/);
});

test("Woo API uses modification filters and real pagination headers", async (t) => {
  let url;
  t.mock.method(globalThis, "fetch", async (input) => {
    url = new URL(input);
    return new Response("[]", { headers: { "x-wp-totalpages": "12", "x-wp-total": "550" } });
  });
  const result = await fetchWooCommerceOrders(shop, {
    modifiedAfter: "2026-10-26T09:00:00Z", modifiedBefore: "2026-10-26T10:00:00Z",
    datesAreGmt: true, orderby: "modified", order: "asc", perPage: 50, page: 3,
  });
  assert.equal(url.searchParams.get("modified_after"), "2026-10-26T09:00:00Z");
  assert.equal(url.searchParams.get("dates_are_gmt"), "true");
  assert.equal(url.searchParams.get("orderby"), "modified");
  assert.equal(result.totalPages, 12);
  assert.equal(result.totalOrders, 550);
});

test("Woo API rejects HTTP 200 HTML and HTTP errors instead of treating them as zero orders", async (t) => {
  const mock = t.mock.method(globalThis, "fetch", async () => new Response("<html>login</html>"));
  await assert.rejects(() => fetchWooCommerceOrders(shop), /invalid order list/);
  mock.mock.mockImplementation(async () => new Response('{"message":"unauthorized"}', { status: 401 }));
  await assert.rejects(() => fetchWooCommerceOrders(shop), /unauthorized/);
});

test("fallback pagination handles full pages and defaults without prematurely stopping", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify(Array.from({ length: 100 }, (_, i) => ({ id: i + 1 })))));
  const log = t.mock.method(console, "log", () => {});
  const r = await fetchWooCommerceOrders(shop);
  assert.equal(r.totalPages, 2);
  assert.equal(r.orders.length, 100);
  log.mock.restore();
});

test("Woo API timeout covers downloading the response body", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.mock.method(globalThis, "fetch", async (_url, { signal }) => ({
    ok: true, status: 200, headers: new Headers(),
    text: () => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })))),
  }));
  const pending = fetchWooCommerceOrders(shop);
  const rejection = assert.rejects(pending, /timeout/);
  await Promise.resolve();
  t.mock.timers.tick(15_000);
  await rejection;
});
