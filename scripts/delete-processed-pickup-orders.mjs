/**
 * Xóa toàn bộ đơn match tab "Chờ lấy hàng (Đã xử lý)".
 * Chạy: npx tsx scripts/delete-processed-pickup-orders.mjs
 */
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import mongoose from 'mongoose';
import {
  initMongo,
  loadOrdersFromStore,
  deleteOrdersFromStore,
  flushDbWrites,
  isMongoReady,
} from '../src/db/mongoStore.ts';
import { matchesProcessedPickupTab, isShopeeShippingStatus, isShopeeCompletedStatus, isShopeeCancelledLikeStatus } from '../src/utils/orderHandover.ts';

function isProcessedPickupLike(order) {
  if (matchesProcessedPickupTab(order)) return true;
  // Fallback: document mỏng thiếu shopee_order_status nhưng UI vẫn hiện status=processed
  if (String(order?.channel || '') !== 'shopee' && order?.channel != null) return false;
  if (String(order?.status || '') !== 'processed') return false;
  if (isShopeeShippingStatus(order)) return false;
  if (isShopeeCompletedStatus(order)) return false;
  if (isShopeeCancelledLikeStatus(order)) return false;
  return true;
}

const ORDERS_JSON = path.join(process.cwd(), 'data', 'orders.json');

function loadLocalOrders() {
  if (!fs.existsSync(ORDERS_JSON)) return [];
  try {
    const raw = JSON.parse(fs.readFileSync(ORDERS_JSON, 'utf8'));
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

function saveLocalOrders(orders) {
  fs.mkdirSync(path.dirname(ORDERS_JSON), { recursive: true });
  fs.writeFileSync(ORDERS_JSON, JSON.stringify(orders), 'utf8');
}

const ok = await initMongo(process.cwd());
console.log('[Delete Processed Pickup] mongoReady=', ok, isMongoReady());

const mongoOrders = ok ? await loadOrdersFromStore() : [];
const localOrders = loadLocalOrders();

// Gộp theo orderSn — ưu tiên bản có đủ field để match tab
const bySn = new Map();
for (const o of [...localOrders, ...mongoOrders]) {
  const sn = String(o?.orderSn || '').replace(/^shopee-/i, '').trim();
  if (!sn) continue;
  const prev = bySn.get(sn);
  if (!prev) {
    bySn.set(sn, o);
    continue;
  }
  // Prefer richer doc
  const prevKeys = Object.keys(prev).length;
  const nextKeys = Object.keys(o).length;
  if (nextKeys >= prevKeys) bySn.set(sn, { ...prev, ...o });
}

const all = Array.from(bySn.values());
const targets = all.filter((o) => isProcessedPickupLike(o));

console.log(`[Delete Processed Pickup] totalMerged=${all.length} matchedProcessedPickup=${targets.length}`);
const sns = targets.map((o) => String(o.orderSn || '').trim()).filter(Boolean);
const ids = targets.map((o) => String(o.id || `shopee-${o.orderSn}`).trim()).filter(Boolean);
console.log('[Delete Processed Pickup] orderSns=', sns.join(', ') || '(none)');

if (targets.length === 0) {
  console.log('[Delete Processed Pickup] Không có đơn nào để xóa.');
  await mongoose.disconnect().catch(() => {});
  process.exit(0);
}

// 1) Xóa Mongo
let mongoDeleted = 0;
if (ok && isMongoReady()) {
  mongoDeleted = await deleteOrdersFromStore([...ids, ...sns]);
  await flushDbWrites();
}
console.log(`[Delete Processed Pickup] Mongo deleted=${mongoDeleted}`);

// 2) Xóa local JSON
const snSet = new Set(sns.map((s) => s.replace(/^shopee-/i, '').toUpperCase()));
const idSet = new Set(ids.map((s) => s.toUpperCase()));
const before = localOrders.length;
const kept = localOrders.filter((o) => {
  const sn = String(o?.orderSn || '')
    .replace(/^shopee-/i, '')
    .trim()
    .toUpperCase();
  const id = String(o?.id || '')
    .trim()
    .toUpperCase();
  if (sn && snSet.has(sn)) return false;
  if (id && idSet.has(id)) return false;
  return true;
});
saveLocalOrders(kept);
console.log(
  `[Delete Processed Pickup] JSON before=${before} after=${kept.length} removed=${before - kept.length}`,
);

// 3) Verify còn bao nhiêu match
const afterMongo = ok ? await loadOrdersFromStore() : [];
const afterLocal = loadLocalOrders();
const remainMongo = afterMongo.filter((o) => isProcessedPickupLike(o)).length;
const remainLocal = afterLocal.filter((o) => isProcessedPickupLike(o)).length;
console.log(
  `[Delete Processed Pickup] remain processedPickup — mongo=${remainMongo} json=${remainLocal}`,
);
console.log('DONE', {
  matched: targets.length,
  mongoDeleted,
  jsonRemoved: before - kept.length,
  remainMongo,
  remainLocal,
});

await mongoose.disconnect().catch(() => {});
process.exit(0);
