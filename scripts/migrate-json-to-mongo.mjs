/**
 * One-time migration: JSON (products / channel_listings / local_inventory backups)
 * → MongoDB Atlas.
 *
 * Usage:
 *   set MONGODB_URI=mongodb+srv://...
 *   node scripts/migrate-json-to-mongo.mjs
 */
import mongoose from "mongoose";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(__dirname, "..");
dotenv.config({ path: path.join(APP_ROOT, ".env") });

const DATA_DIR = path.join(APP_ROOT, "data");
const URI = String(process.env.MONGODB_URI || process.env.MONGO_URL || "").trim();

const ProductSchema = new mongoose.Schema(
  {
    _id: { type: String, required: true },
    sku: { type: String, default: null },
    data: { type: mongoose.Schema.Types.Mixed, required: true },
  },
  { collection: "products", versionKey: false }
);

const ListingSchema = new mongoose.Schema(
  {
    _id: { type: String, required: true },
    channelId: { type: String, default: null },
    platform: { type: String, default: null },
    sku: { type: String, default: null },
    status: { type: String, default: null },
    linkedProductId: { type: String, default: null },
    data: { type: mongoose.Schema.Types.Mixed, required: true },
  },
  { collection: "channel_listings", versionKey: false }
);

function findLatest(baseName) {
  const direct = path.join(DATA_DIR, baseName);
  if (fs.existsSync(direct)) return direct;
  if (!fs.existsSync(DATA_DIR)) return null;
  const prefix = `${baseName}.migrated.`;
  const matches = fs
    .readdirSync(DATA_DIR)
    .filter((f) => f.startsWith(prefix))
    .sort();
  if (matches.length === 0) return null;
  return path.join(DATA_DIR, matches[matches.length - 1]);
}

function readJsonArray(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return [];
  const raw = fs.readFileSync(filePath, "utf-8");
  if (!raw || !raw.trim()) return [];
  const parsed = JSON.parse(raw);
  return Array.isArray(parsed) ? parsed : [];
}

function readLocalInventory(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return { products: [], listings: [] };
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    return {
      products: Array.isArray(parsed?.products) ? parsed.products : [],
      listings: Array.isArray(parsed?.listings) ? parsed.listings : [],
    };
  } catch {
    return { products: [], listings: [] };
  }
}

function mergeById(primary, secondary) {
  const map = new Map();
  for (const row of [...secondary, ...primary]) {
    if (!row || typeof row !== "object") continue;
    const id = String(row.id || "").trim();
    if (!id) continue;
    map.set(id, row);
  }
  return Array.from(map.values());
}

function renameToMigrated(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return;
  if (path.basename(filePath).includes(".migrated.")) return;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dest = `${filePath}.migrated.${stamp}`;
  fs.renameSync(filePath, dest);
  console.log(`[Migrate] Renamed ${path.basename(filePath)} → ${path.basename(dest)}`);
}

async function main() {
  if (!URI) {
    console.error("[Migrate] Thiếu MONGODB_URI trong .env");
    process.exit(1);
  }

  const productsPath = findLatest("products.json");
  const listingsPath = findLatest("channel_listings.json");
  const invPath = findLatest("local_inventory.json");

  const fromProducts = readJsonArray(productsPath);
  const fromListings = readJsonArray(listingsPath);
  const localInv = readLocalInventory(invPath);
  const products = mergeById(fromProducts, localInv.products);
  const listings = mergeById(fromListings, localInv.listings);

  console.log(`[Migrate] APP_ROOT=${APP_ROOT}`);
  console.log(
    `[Migrate] Sources — products=${fromProducts.length}, listings=${fromListings.length}, inv.products=${localInv.products.length}`
  );
  console.log(`[Migrate] Merged — products=${products.length}, listings=${listings.length}`);

  await mongoose.connect(URI, { serverSelectionTimeoutMS: 20000 });
  const Product = mongoose.models.Product || mongoose.model("Product", ProductSchema);
  const Listing = mongoose.models.ChannelListing || mongoose.model("ChannelListing", ListingSchema);

  await Product.deleteMany({});
  await Listing.deleteMany({});

  if (products.length > 0) {
    await Product.insertMany(
      products
        .filter((p) => p && String(p.id || "").trim())
        .map((p) => ({
          _id: String(p.id).trim(),
          sku: p.sku != null ? String(p.sku) : null,
          data: p,
        })),
      { ordered: false }
    );
  }

  if (listings.length > 0) {
    await Listing.insertMany(
      listings
        .filter((r) => r && String(r.id || "").trim())
        .map((r) => ({
          _id: String(r.id).trim(),
          channelId: r.channelId != null ? String(r.channelId) : null,
          platform: r.platform != null ? String(r.platform) : null,
          sku: r.sku != null ? String(r.sku) : null,
          status: r.status != null ? String(r.status) : null,
          linkedProductId: r.linkedProductId != null ? String(r.linkedProductId) : null,
          data: r,
        })),
      { ordered: false }
    );
  }

  const pc = await Product.countDocuments();
  const lc = await Listing.countDocuments();
  console.log(`[Migrate] Verified MongoDB products=${pc}, listings=${lc}`);

  renameToMigrated(productsPath);
  renameToMigrated(listingsPath);
  renameToMigrated(invPath);

  const sqlitePath = path.join(APP_ROOT, "database.sqlite");
  if (fs.existsSync(sqlitePath)) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    fs.renameSync(sqlitePath, `${sqlitePath}.legacy.${stamp}`);
    console.log("[Migrate] Archived database.sqlite");
  }

  await mongoose.disconnect();
  console.log("[Migrate] DONE — MongoDB Atlas sẵn sàng.");
}

main().catch((err) => {
  console.error("[Migrate] FAILED:", err);
  process.exit(1);
});
