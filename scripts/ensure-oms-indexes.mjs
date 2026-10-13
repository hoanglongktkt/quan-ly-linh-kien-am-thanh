import mongoose from "mongoose";
import { connectDB } from "../config/db.js";
import { operationalIndexPlan, ensureOperationalIndexes } from "../modules/operations/mongoIndexes.js";
import { safeError } from "../utils/safeProductionLog.js";

// --apply bị chặn nếu thiếu compound đã rà soát; không áp dụng toàn bộ gợi ý vô điều kiện.
const args = new Set(process.argv.slice(2));
try {
  if ([...args].some((arg) => !["--check", "--apply", "--backfill-jobs"].includes(arg))
    || (args.has("--check") && args.has("--apply"))
    || (args.has("--backfill-jobs") && !args.has("--apply"))) throw Error("invalid_arguments");
  const plan = operationalIndexPlan();
  for (const [collection, indexes] of plan) {
    for (const [key, options] of indexes) {
      console.log(JSON.stringify({ collection, key, options, requiresReview: Object.keys(key).length > 1 }));
    }
  }
  if (args.has("--apply") || args.has("--check")) {
    await connectDB();
    const db = mongoose.connection.db;
    if (args.has("--apply")) {
      console.log("Indexes:", await ensureOperationalIndexes(db));
      if (args.has("--backfill-jobs")) {
        // Bổ sung shop cho lịch sử; không bịa received_at hay số retry quá khứ.
        const shops = await db.collection("webhook_jobs").updateMany(
          { kind: "webhook", shopId: { $exists: false } },
          [{ $set: { shopId: { $convert: { input: { $ifNull: ["$payload.shop_id", "$payload.data.shop_id"] },
            to: "string", onError: null, onNull: null } } } }], { maxTimeMS: 30000 },
        );
        // Job cũ đã kết thúc mới được TTL; tuyệt đối không gắn mốc cho job còn chạy.
        const terminal = await db.collection("webhook_jobs").updateMany(
          { state: { $in: ["succeeded", "dead-letter"] }, finished_at: { $exists: false } },
          [{ $set: { finished_at: { $convert: { input: { $ifNull: ["$updatedAt", "$createdAt"] },
            to: "date", onError: null, onNull: null } } } }], { maxTimeMS: 30000 },
        );
        console.log("Backfill:", { shops: shops.modifiedCount, terminalJobs: terminal.modifiedCount });
      }
    }
    for (const [collection] of plan) {
      let indexes = [];
      try { indexes = await db.collection(collection).indexes(); }
      catch (error) { if (error?.code !== 26) throw error; }
      console.log(collection, JSON.stringify(indexes.map(({ name, key, expireAfterSeconds }) => ({ name, key, expireAfterSeconds }))));
      const expected = plan.find(([name]) => name === collection)[1];
      for (const [key, options] of expected) {
        const found = indexes.find((index) => JSON.stringify(index.key) === JSON.stringify(key));
        // --check báo thiếu index hoặc TTL lệch để vận hành dễ phát hiện.
        const matches = found && (options.expireAfterSeconds === undefined || found.expireAfterSeconds === options.expireAfterSeconds);
        if (!matches) { console.error("Index missing/mismatch:", collection, options.name); process.exitCode = 1; }
      }
    }
  }
} catch (error) {
  // Không in lỗi kết nối thô vì có thể chứa URI và mật khẩu.
  console.error("Index operation failed:", safeError(error));
  process.exitCode = 1;
} finally {
  await mongoose.disconnect();
}
