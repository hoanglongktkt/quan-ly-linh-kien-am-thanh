/**
 * Ghi min_price (giá bán thấp nhất) và total_stock (tổng tồn) lên root mỗi sản phẩm.
 * Chạy 1 lần: node scripts/backfill-inventory-sort-fields.mjs
 */
import fs from "fs";
import path from "path";
import mongoose from "mongoose";
import dotenv from "dotenv";

dotenv.config();

const BATCH = 200;
const PAUSE_MS = 40;

function variationRows(product) {
  for (const key of ["children", "children_models", "models", "variations"]) {
    const list = product?.[key];
    if (Array.isArray(list) && list.length > 0) return list;
  }
  return [];
}

function readPrice(row) {
  const n = Number(row?.sellingPrice ?? row?.price ?? row?.original_price);
  return Number.isFinite(n) ? n : 0;
}

function readStock(row) {
  const n = Number(row?.stock ?? row?.current_stock ?? row?.normal_stock);
  return Number.isFinite(n) ? n : 0;
}

function metrics(product) {
  const rows = variationRows(product);
  if (rows.length === 0) return { min_price: readPrice(product), total_stock: readStock(product) };
  let min = Infinity;
  let stock = 0;
  for (let i = 0; i < rows.length; i++) {
    const price = readPrice(rows[i]);
    if (price < min) min = price;
    stock += readStock(rows[i]);
  }
  return { min_price: Number.isFinite(min) ? min : 0, total_stock: stock };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function backfillMongo() {
  const uri = String(process.env.MONGODB_URI || process.env.MONGO_URL || "").trim();
  if (!uri) {
    console.log("Bỏ qua Mongo — thiếu MONGODB_URI");
    return;
  }
  const schema = new mongoose.Schema(
    { _id: String, sku: String, data: mongoose.Schema.Types.Mixed },
    { collection: "products", versionKey: false },
  );
  const Product = mongoose.models.ProductBackfill || mongoose.model("ProductBackfill", schema);
  await mongoose.connect(uri);
  const cursor = Product.find({}).select({ _id: 1, data: 1 }).lean().cursor();
  let batch = [];
  let updated = 0;
  let seen = 0;
  const flush = async () => {
    if (batch.length === 0) return;
    await Product.bulkWrite(batch, { ordered: false });
    updated += batch.length;
    batch = [];
    await sleep(PAUSE_MS);
  };
  for await (const doc of cursor) {
    seen += 1;
    if (seen > 500000) break;
    const data = doc?.data && typeof doc.data === "object" ? doc.data : {};
    const next = metrics(data);
    if (data.min_price === next.min_price && data.total_stock === next.total_stock) continue;
    batch.push({
      updateOne: {
        filter: { _id: doc._id },
        update: { $set: { "data.min_price": next.min_price, "data.total_stock": next.total_stock } },
      },
    });
    if (batch.length >= BATCH) await flush();
  }
  await flush();
  console.log(`Mongo backfill: seen=${seen} updated=${updated}`);
  await mongoose.disconnect();
}

function backfillDisk() {
  const file = path.join(process.cwd(), "data", "products.json");
  if (!fs.existsSync(file)) {
    console.log("Bỏ qua disk — không có data/products.json");
    return;
  }
  const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  const list = Array.isArray(parsed) ? parsed : [];
  let updated = 0;
  for (let i = 0; i < list.length; i++) {
    const next = metrics(list[i]);
    if (list[i].min_price === next.min_price && list[i].total_stock === next.total_stock) continue;
    list[i].min_price = next.min_price;
    list[i].total_stock = next.total_stock;
    updated += 1;
  }
  if (updated > 0) {
    const tmp = `${file}.tmp.${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(list), "utf8");
    fs.renameSync(tmp, file);
  }
  console.log(`Disk backfill: count=${list.length} updated=${updated}`);
}

const storage = String(process.env.PRODUCTS_STORAGE || "").trim().toLowerCase();
const diskMode = storage !== "mongo" && storage !== "atlas";
if (diskMode) backfillDisk();
await backfillMongo();
