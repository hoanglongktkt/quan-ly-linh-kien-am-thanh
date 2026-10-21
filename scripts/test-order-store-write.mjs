import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

// Build the real repository with a test-only model injection hook. Production
// source and the shipped server do not contain this hook or connect to a DB.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = await fs.readFile(path.join(root, "src/db/mongoStore.ts"), "utf8");
const output = path.join(root, "tmp/test-order-store-models.mjs");
await build({ stdin: { contents: source + `
export function __bindModelsForTest(orders, meta, db) {
  const previous = { OrderModel, MetaModel, requireMongo, db: mongoose.connection.db };
  OrderModel = orders; MetaModel = meta; requireMongo = () => {};
  mongoose.connection.db = db;
  return () => { OrderModel = previous.OrderModel; MetaModel = previous.MetaModel;
    requireMongo = previous.requireMongo; mongoose.connection.db = previous.db; };
}
export { webhookObservation as __testObservation };
`, loader: "ts", resolveDir: path.join(root, "src/db") },
bundle: true, platform: "node", format: "esm", packages: "external", outfile: output, logLevel: "silent" });
const store = await import(pathToFileURL(output).href);

test("canonical order persistence preserves warehouse flags and uses indexed identities with driver deadlines", async () => {
  const current = { _id: "legacy-abc", shopId: "123", orderSn: "ABC", status: "processed",
    isPrinted: true, isPrepared: true, shopee_order_status: "PROCESSED", last_shopee_update_at: new Date(),
    data: { items: [{ sku: "OLD", quantity: 1 }], isPrinted: true, isPrepared: true } };
  const reads = [], writes = [], metadata = [];
  const query = (filter, _projection, options) => {
    reads.push({ filter, options });
    return { select: () => ({ lean: async () => [current] }) };
  };
  const model = { find: query, bulkWrite: async (ops, options) => {
    writes.push({ ops, options }); return { matchedCount: 1, modifiedCount: 1, upsertedCount: 0 };
  } };
  const meta = { findByIdAndUpdate: async (...args) => { metadata.push(args); } };
  const db = { collection: (name) => {
    assert.equal(name, "shopee_order_idempotency");
    return { find: () => ({ toArray: async () => [{ _id: "123:ABC", documentId: "legacy-abc" }] }),
      bulkWrite: async () => assert.fail("must reuse existing identity") };
  } };
  const restore = store.__bindModelsForTest(model, meta, db);
  try {
    const observation = {};
    await store.__testObservation.run(observation, () => store.bulkUpsertOrdersToStore([
      { id: "replacement-id", channel: "shopee", shopId: "123", orderSn: "ABC",
        shopee_order_status: "READY_TO_SHIP", status: "unprocessed", last_shopee_update_at: new Date(),
        items: [], isPrinted: false, isPrepared: false },
    ]));
    assert.equal(writes.length, 1);
    const update = writes[0].ops[0].updateOne;
    assert.deepEqual(update.filter.$and[0], { _id: "legacy-abc" });
    assert.equal(update.upsert, false, "watermark CAS must still protect updates");
    assert.equal(update.update.$set.isPrinted, undefined);
    assert.equal(update.update.$set["data.isPrinted"], undefined);
    assert.equal(update.update.$set.isPrepared, undefined);
    assert.equal(update.update.$set.status, undefined, "prepared order must not regress to unprocessed");
    assert.equal(update.update.$set["data.items"], undefined, "empty push must not wipe products");
    assert.ok(reads.every((r) => !r.filter.$or && r.filter._id && r.options.timeoutMS === 12000));
    assert.equal(writes[0].options.timeoutMS, 12000);
    assert.equal(metadata[0][2].timeoutMS, 12000);
    assert.ok(observation.orderPersistedAt instanceof Date);
  } finally { restore(); }
});
