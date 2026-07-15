/**
 * Init Local Cache Master — quét DB (products.json + channel_listings.json)
 * rồi GHI vào data/local_inventory.json.
 *
 * Chạy: node scripts/init-local-inventory.mjs
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(__dirname, "..");
const DATA_DIR = path.join(APP_ROOT, "data");
const PRODUCTS_PATH = path.join(DATA_DIR, "products.json");
const LISTINGS_PATH = path.join(DATA_DIR, "channel_listings.json");
const CACHE_PATH = path.join(DATA_DIR, "local_inventory.json");

function readJsonArray(filePath) {
  try {
    if (!fs.existsSync(filePath)) return [];
    const raw = fs.readFileSync(filePath, "utf-8");
    if (!raw || !raw.trim()) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    console.error(`[init-local-inventory] Không đọc được ${filePath}:`, err?.message || err);
    return [];
  }
}

function initLocalInventory() {
  fs.mkdirSync(DATA_DIR, { recursive: true });

  const products = readJsonArray(PRODUCTS_PATH);
  const listings = readJsonArray(LISTINGS_PATH);
  const payload = {
    updatedAt: new Date().toISOString(),
    products,
    listings,
  };

  const tmpPath = `${CACHE_PATH}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(payload), "utf-8");
  fs.renameSync(tmpPath, CACHE_PATH);
  try {
    fs.chmodSync(CACHE_PATH, 0o664);
  } catch {
    /* Windows / shared host */
  }

  if (!fs.existsSync(CACHE_PATH)) {
    throw new Error(`Không tạo được file: ${CACHE_PATH}`);
  }

  const bytes = fs.statSync(CACHE_PATH).size;
  console.log(
    `[init-local-inventory] OK — products=${products.length}, listings=${listings.length}, bytes=${bytes}`
  );
  console.log(`[init-local-inventory] Wrote: ${CACHE_PATH}`);
  return payload;
}

initLocalInventory();
