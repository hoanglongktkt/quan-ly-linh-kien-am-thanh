import test from "node:test";
import assert from "node:assert/strict";
import { createSerialWriteQueue } from "../modules/orders/serialWriteQueue.js";
import { resolveShopeeOrderIdentities } from "../modules/orders/orderIdentity.js";
import { webhookObservation } from "../modules/operations/telemetry.js";
import { createCoalescedTask } from "../modules/orders/coalescedTask.js";

const gate = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };

test("urgent writes go before queued background writes; execution stays serial and keeps async context", async () => {
  const queue = createSerialWriteQueue();
  const hold = gate(), started = gate();
  const sequence = [];
  let active = 0, maxActive = 0;
  const work = (name) => async () => {
    active++; maxActive = Math.max(maxActive, active);
    sequence.push(name);
    if (name === "first") { started.resolve(); await hold.promise; }
    if (name === "urgent") assert.equal(webhookObservation.getStore().marker, "urgent");
    active--;
  };
  const first = queue.enqueue(work("first"));
  await started.promise;
  const slow1 = queue.enqueue(work("background1"));
  const slow2 = queue.enqueue(work("background2"));
  const urgent = webhookObservation.run({ marker: "urgent" }, () => queue.enqueue(work("urgent"), { priority: 10 }));
  hold.resolve();
  await Promise.all([first, slow1, slow2, urgent]);
  assert.deepEqual(sequence, ["first", "urgent", "background1", "background2"]);
  assert.equal(maxActive, 1);
});

test("expired queued write is removed and can never execute later", async () => {
  const queue = createSerialWriteQueue();
  const hold = gate(), started = gate();
  const first = queue.enqueue(async () => { started.resolve(); await hold.promise; });
  await started.promise;
  let ran = false;
  await assert.rejects(queue.enqueue(async () => { ran = true; }, { waitTimeoutMs: 20 }),
    { code: "mongo_write_queue_wait_timeout" });
  hold.resolve(); await first;
  await queue.enqueue(async () => {});
  assert.equal(ran, false);
});

test("execution timeout reports failure but does not start a second write over unfinished work", async () => {
  const queue = createSerialWriteQueue();
  const hold = gate(), started = gate();
  const first = queue.enqueue(async () => { started.resolve(); await hold.promise; }, { executionTimeoutMs: 20 });
  const timedOut = assert.rejects(first, { code: "mongo_write_execution_timeout" });
  await started.promise;
  let ran = false;
  const second = queue.enqueue(async () => { ran = true; });
  await timedOut;
  assert.equal(ran, false);
  hold.resolve(); await second;
  assert.equal(ran, true);
  await queue.whenIdle();
});

test("write errors release the queue for the next task", async () => {
  const queue = createSerialWriteQueue();
  const failed = queue.enqueue(async () => { throw new Error("expected"); });
  const next = queue.enqueue(async () => 42);
  await assert.rejects(failed, /expected/);
  assert.equal(await next, 42);
});

test("known identity uses indexed _id reads without rewriting mappings or legacy lookups", async () => {
  const filters = [];
  const db = { collection: () => ({
    find: () => ({ toArray: async () => [{ _id: "123:ORDER1", documentId: "legacy-id" }] }),
    bulkWrite: async () => assert.fail("existing mappings must not be rewritten"),
  }) };
  const model = { find: (filter, _projection, options) => {
    filters.push(filter);
    assert.equal(options.timeoutMS, 12000);
    return { select: () => ({ lean: async () => [{ _id: "legacy-id", shopId: "123", orderSn: "ORDER1" }] }) };
  } };
  const result = await webhookObservation.run({}, () => resolveShopeeOrderIdentities(
    [{ id: "changed-id", shopId: "123", orderSn: "ORDER1" }], db, model));
  assert.equal(result.get("123:ORDER1"), "legacy-id");
  assert.deepEqual(filters, [{ _id: { $in: ["legacy-id"] } }]);
});

test("mapped identity still rejects another shop or order", async () => {
  for (const row of [{ _id: "wrong", shopId: "456", orderSn: "ORDER1" }, { _id: "wrong", shopId: "123", orderSn: "ORDER2" }]) {
    const db = { collection: () => ({ find: () => ({ toArray: async () => [{ _id: "123:ORDER1", documentId: "wrong" }] }) }) };
    const model = { find: () => ({ select: () => ({ lean: async () => [row] }) }) };
    await assert.rejects(resolveShopeeOrderIdentities([{ shopId: "123", orderSn: "ORDER1" }], db, model), /identity_conflict/);
  }
});

test("snapshot bursts coalesce, never overlap, and refresh again for updates arriving during a read", async (t) => {
  const hold = gate(), started = gate(), finished = gate();
  let calls = 0, active = 0, maxActive = 0;
  const task = createCoalescedTask(async () => {
    active++; maxActive = Math.max(active, maxActive);
    calls++;
    if (calls === 1) { started.resolve(); await hold.promise; }
    active--;
    if (calls === 2) finished.resolve();
  }, { initialDelayMs: 1, minIntervalMs: 20 });
  t.after(() => task.cancel());
  // Keep test runtime alive while the background task's timer is unref'ed.
  const deadline = setTimeout(() => finished.resolve(), 1000);
  t.after(() => clearTimeout(deadline));
  for (let i = 0; i < 100; i++) task.request();
  await started.promise;
  for (let i = 0; i < 100; i++) task.request();
  assert.equal(calls, 1);
  hold.resolve();
  await finished.promise;
  assert.equal(calls, 2);
  assert.equal(maxActive, 1);
});
