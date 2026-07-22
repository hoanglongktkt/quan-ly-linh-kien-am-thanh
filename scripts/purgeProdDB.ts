/**
 * ONE-SHOT — xóa rỗng collection `orders` trên MongoDB Production
 * (cùng URI mà app/cPanel đang dùng).
 *
 * Chạy:
 *   npx tsx scripts/purgeProdDB.ts
 *
 * Biến môi trường (đọc từ .env):
 *   MONGODB_URI | MONGO_URL | MONGO_URI
 */
import "dotenv/config";
import mongoose, { Schema, type Model } from "mongoose";

const uri = String(
  process.env.MONGODB_URI || process.env.MONGO_URL || process.env.MONGO_URI || "",
).trim();

if (!uri) {
  console.error("[purgeProdDB] THIẾU MONGODB_URI / MONGO_URL / MONGO_URI trong .env — dừng.");
  process.exit(1);
}

function maskUri(raw: string): string {
  return raw.replace(/:\/\/([^:]+):([^@]+)@/, "://$1:***@");
}

function hostFromUri(raw: string): string {
  try {
    const u = new URL(raw.replace(/^mongodb(\+srv)?:\/\//, "https://"));
    return u.host || "(unknown-host)";
  } catch {
    const m = raw.match(/@([^/?]+)/);
    return m?.[1] || "(unknown-host)";
  }
}

type OrderDoc = {
  _id: string;
  orderSn?: string | null;
  data?: unknown;
};

const OrderSchema = new Schema<OrderDoc>(
  {
    _id: { type: String, required: true },
    orderSn: { type: String, default: null },
    data: { type: Schema.Types.Mixed, required: false },
  },
  { collection: "orders", versionKey: false },
);

const Order: Model<OrderDoc> =
  (mongoose.models.Order as Model<OrderDoc>) ||
  mongoose.model<OrderDoc>("Order", OrderSchema);

console.log(`[purgeProdDB] ĐANG KẾT NỐI VÀO DB: host=${hostFromUri(uri)} uri=${maskUri(uri)}`);

await mongoose.connect(uri, { serverSelectionTimeoutMS: 25_000 });

const dbName = mongoose.connection.db?.databaseName || "(unknown-db)";
const host = hostFromUri(uri);
console.log(`ĐANG KẾT NỐI VÀO DB: ${dbName} @ ${host}`);

const before = await Order.countDocuments({});
console.log(`[purgeProdDB] orders trước xóa: ${before}`);

const result = await Order.deleteMany({});
console.log(`[purgeProdDB] Order.deleteMany({}) — deletedCount=${result.deletedCount}`);

const after = await Order.countDocuments({});
console.log(`[purgeProdDB] orders sau xóa: ${after}`);

if (after !== 0) {
  console.error("[purgeProdDB] THẤT BẠI — collection orders chưa về 0!");
  await mongoose.disconnect();
  process.exit(1);
}

console.log("[purgeProdDB] XÁC NHẬN: collection orders = 0 document trên Production URI.");
await mongoose.disconnect();
process.exit(0);
