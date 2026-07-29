#!/usr/bin/env node
/**
 * Dọn Atlas Free 512MB — xóa order_events / sync_jobs cũ + tạo TTL 14 ngày.
 *
 * Chạy:
 *   node scripts/cleanup-order-events.mjs
 *   node scripts/cleanup-order-events.mjs --days=7
 *   node scripts/cleanup-order-events.mjs --days=14 --ttl-only
 *
 * Env: MONGODB_URI hoặc MONGO_URL
 */
import path from "node:path";
import dotenv from "dotenv";
import mongoose from "mongoose";

const ROOT = process.cwd();
dotenv.config({ path: path.join(ROOT, ".env") });

const URI = String(process.env.MONGODB_URI || process.env.MONGO_URL || "").trim();
const TTL_SECONDS = 14 * 24 * 60 * 60; // 1_209_600

function argNum(name, fallback) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (!hit) return fallback;
  const n = Number(hit.split("=")[1]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const DAYS = argNum("days", 14);
const TTL_ONLY = process.argv.includes("--ttl-only");
const BATCH = argNum("batch", 5000);

if (!URI) {
  console.error("Thiếu MONGODB_URI / MONGO_URL");
  process.exit(1);
}

async function ensureTtl(coll, indexName, key, expireAfterSeconds) {
  const indexes = await coll.indexes();
  const hit = indexes.find((i) => i.name === indexName);
  if (hit && Number(hit.expireAfterSeconds) === Number(expireAfterSeconds)) {
    console.log(`[TTL] OK ${coll.collectionName}.${indexName} = ${expireAfterSeconds}s`);
    return false;
  }
  if (hit) {
    await coll.dropIndex(indexName).catch((e) =>
      console.warn(`[TTL] drop ${indexName}:`, e.message),
    );
  }
  await coll.createIndex(key, { name: indexName, expireAfterSeconds, background: true });
  console.log(`[TTL] Created ${coll.collectionName}.${indexName} expireAfterSeconds=${expireAfterSeconds}`);
  return true;
}

async function purgeByDate(coll, field, cutoff, label) {
  const before = await coll.countDocuments();
  let deleted = 0;
  for (let i = 0; i < 400; i += 1) {
    const rows = await coll
      .find({ [field]: { $lt: cutoff } })
      .project({ _id: 1 })
      .limit(BATCH)
      .toArray();
    if (!rows.length) break;
    const r = await coll.deleteMany({ _id: { $in: rows.map((x) => x._id) } });
    deleted += Number(r.deletedCount || 0);
    process.stdout.write(`\r[${label}] deleted=${deleted} ...`);
    if (rows.length < BATCH) break;
  }
  const after = await coll.countDocuments();
  console.log(`\n[${label}] before=${before} deleted=${deleted} after=${after} cutoff=${cutoff.toISOString()}`);
  return { before, deleted, after };
}

await mongoose.connect(URI);
console.log(`[Mongo] connected days=${DAYS} ttlOnly=${TTL_ONLY}`);

const db = mongoose.connection.db;
const orderEvents = db.collection("order_events");
const syncJobs = db.collection("sync_jobs");

await ensureTtl(orderEvents, "order_events_ttl", { occurred_at: 1 }, TTL_SECONDS);
await ensureTtl(syncJobs, "sync_jobs_ttl", { finished_at: 1 }, TTL_SECONDS);

if (!TTL_ONLY) {
  const cutoff = new Date(Date.now() - DAYS * 24 * 60 * 60 * 1000);
  await purgeByDate(orderEvents, "occurred_at", cutoff, "order_events");
  // sync_jobs: chỉ xóa job đã xong
  const beforeJobs = await syncJobs.countDocuments();
  let jobsDeleted = 0;
  for (let i = 0; i < 200; i += 1) {
    const rows = await syncJobs
      .find({
        finished_at: { $type: "date", $lt: cutoff },
        state: { $in: ["succeeded", "failed"] },
      })
      .project({ _id: 1 })
      .limit(BATCH)
      .toArray();
    if (!rows.length) break;
    const r = await syncJobs.deleteMany({ _id: { $in: rows.map((x) => x._id) } });
    jobsDeleted += Number(r.deletedCount || 0);
    if (rows.length < BATCH) break;
  }
  const afterJobs = await syncJobs.countDocuments();
  console.log(
    `[sync_jobs] before=${beforeJobs} deleted=${jobsDeleted} after=${afterJobs}`,
  );
}

// Stats các collection chính — giúp phát hiện rác khác.
const names = await db.listCollections().toArray();
console.log("\n[Collections size hint]");
for (const c of names.sort((a, b) => a.name.localeCompare(b.name))) {
  try {
    const n = await db.collection(c.name).estimatedDocumentCount();
    console.log(`  ${c.name}: ~${n} docs`);
  } catch {
    console.log(`  ${c.name}: (count failed)`);
  }
}

console.log(
  "\nGhi chú: products/channel_listings nên ở disk; orders giữ theo retention riêng; order_events+sync_jobs = log tạm.",
);
await mongoose.disconnect();
console.log("Done.");
