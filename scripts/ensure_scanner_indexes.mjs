/**
 * Tạo compound index phục vụ scanner-sync / lookup nhanh trên collection orders.
 * Chạy trên server (hoặc local có MONGODB_URI):
 *   node scripts/ensure_scanner_indexes.mjs
 */
import mongoose from 'mongoose';
import dotenv from 'dotenv';

dotenv.config();

const uri = String(process.env.MONGODB_URI || process.env.MONGO_URL || '').trim();
if (!uri) {
  console.error('Thiếu MONGODB_URI hoặc MONGO_URL trong .env');
  process.exit(1);
}

const OrderSchema = new mongoose.Schema({}, { collection: 'orders', versionKey: false, strict: false });

// Scanner handover — TO_SHIP + chưa bàn giao
OrderSchema.index(
  { shopee_order_status: 1, is_handed_over: 1, status: 1 },
  { name: 'scanner_handover_status' },
);
// Scanner handover — pool đơn hủy
OrderSchema.index(
  { status: 1, shopee_order_status: 1, last_shopee_update_at: -1 },
  { name: 'scanner_cancelled_status' },
);
// Scanner return — kind + ngày (lookback 30 ngày)
OrderSchema.index(
  { shopee_cancel_return_kind: 1, last_shopee_update_at: -1 },
  { name: 'scanner_return_kind_date' },
);
// RTS partial
OrderSchema.index(
  { is_rts: 1, last_shopee_update_at: -1 },
  {
    name: 'scanner_rts_date',
    partialFilterExpression: { is_rts: true },
  },
);
// Lookup quét mã — exact match tracking / orderSn
OrderSchema.index({ 'data.tracking_no': 1 });
OrderSchema.index({ 'data.trackingNumber': 1 });
OrderSchema.index({ 'data.orderSn': 1 });
OrderSchema.index({ 'data.order_sn': 1 });
OrderSchema.index({ 'data.internalTrackingCode': 1 });
OrderSchema.index({ return_sn: 1 });
OrderSchema.index({ 'data.return_sn': 1 });

const Order = mongoose.models.ScannerOrderIndex || mongoose.model('ScannerOrderIndex', OrderSchema);

await mongoose.connect(uri);
console.log('[ensure_scanner_indexes] Connected — syncing indexes on orders...');
const result = await Order.syncIndexes();
console.log('Indexes synced:', result);
const indexes = await Order.collection.indexes();
const scannerNames = [
  'scanner_handover_status',
  'scanner_cancelled_status',
  'scanner_return_kind_date',
  'scanner_rts_date',
];
for (const name of scannerNames) {
  const found = indexes.some((ix) => ix.name === name);
  console.log(`  ${found ? '✓' : '✗'} ${name}`);
}
console.log(`Total indexes on orders: ${indexes.length}`);
await mongoose.disconnect();
console.log('Done.');
