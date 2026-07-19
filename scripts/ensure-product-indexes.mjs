/**
 * Tạo index cho collection products (Kho Gốc) — sku / data.sku / data.title / children.sku
 * Chạy: node scripts/ensure-product-indexes.mjs
 */
import mongoose from 'mongoose';
import dotenv from 'dotenv';

dotenv.config();

const uri = String(process.env.MONGODB_URI || process.env.MONGO_URL || '').trim();
if (!uri) {
  console.error('Thiếu MONGODB_URI');
  process.exit(1);
}

const schema = new mongoose.Schema(
  {
    _id: String,
    sku: { type: String, index: true },
    data: mongoose.Schema.Types.Mixed,
  },
  { collection: 'products', versionKey: false },
);
schema.index({ 'data.sku': 1 });
schema.index({ 'data.title': 1 });
schema.index({ 'data.children.sku': 1 });
schema.index({ 'data.children_models.sku': 1 });

const Product = mongoose.models.Product || mongoose.model('Product', schema);

await mongoose.connect(uri);
const result = await Product.syncIndexes();
console.log('Product indexes synced:', result);
const indexes = await Product.collection.indexes();
console.log(JSON.stringify(indexes, null, 2));
await mongoose.disconnect();
