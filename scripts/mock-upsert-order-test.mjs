import 'dotenv/config';
import mongoose from 'mongoose';
import { createRequire } from 'module';

// Load TS module via tsx-registered path: run with `npx tsx` instead.
// This plain mjs uses native Mongo driver for a clean upsert contract test
// mirroring bulkUpsertOrdersToStore logic.

const uri = process.env.MONGODB_URI || process.env.MONGO_URL || '';
if (!uri) {
  console.error('NO_URI');
  process.exit(1);
}

const MOCK_SN = 'MOCKTESTUPSERT001';
const MOCK_ID = `shopee-${MOCK_SN}`;

const INTERNAL = new Set([
  'is_handed_over',
  'isPrinted',
  'isPrepared',
  'isHandedOverToCarrier',
  'is_handed_over_to_carrier',
  'is_handed_over_to_courier',
  'local_status',
  'localStatus',
  'internal_status',
  'handedOverAt',
  'handed_over_source',
  'handedOverSource',
  'localStatusAt',
  'local_status_updated_at',
  'is_local_return_archived',
]);

function buildUpsert(order) {
  const orderSn = String(order.orderSn || '').trim();
  const _id = order.id || `shopee-${orderSn}`;
  const rawStatus = String(order.shopee_order_status || order.order_status || '')
    .trim()
    .toUpperCase();
  const tnRaw = String(order.tracking_no || order.trackingNumber || '').trim();
  const usableTn = tnRaw && !/^0FG/i.test(tnRaw) ? tnRaw : null;
  const carrier = String(
    order.shipping_carrier || order.checkout_shipping_carrier || order.carrier || '',
  ).trim();

  const $set = {
    orderSn: orderSn || null,
    shopId: order.shopId != null ? String(order.shopId) : null,
    is_pending_shopee_check: order.is_pending_shopee_check === true,
    'data.id': _id,
    'data.channel': order.channel || 'shopee',
    'data.orderSn': orderSn || null,
  };

  if (rawStatus) {
    $set.shopee_order_status = rawStatus;
    $set['data.shopee_order_status'] = rawStatus;
  }
  if (order.status != null) {
    $set.status = String(order.status);
    $set['data.status'] = String(order.status);
  }
  if (usableTn) {
    $set.tracking_no = usableTn;
    $set['data.tracking_no'] = usableTn;
    $set['data.trackingNumber'] = usableTn;
  }
  if (carrier) {
    $set.shipping_carrier = carrier;
    $set['data.shipping_carrier'] = carrier;
  }

  for (const [key, value] of Object.entries(order)) {
    if (key === 'id' || key === '_id') continue;
    if (INTERNAL.has(key)) continue;
    if (value === undefined) continue;
    $set[`data.${key}`] = value;
  }

  const $setOnInsert = {
    is_handed_over: false,
    isPrinted: false,
    isPrepared: false,
    'data.is_handed_over': false,
    'data.isPrinted': false,
    'data.isPrepared': false,
  };

  return {
    updateOne: {
      filter: { _id },
      update: { $set, $setOnInsert },
      upsert: true,
    },
  };
}

await mongoose.connect(uri, { serverSelectionTimeoutMS: 15000 });
const col = mongoose.connection.collection('orders');
await col.deleteOne({ _id: MOCK_ID });

const mockOrder = {
  id: MOCK_ID,
  orderSn: MOCK_SN,
  channel: 'shopee',
  shopId: '4127421',
  shopName: 'LKAT-MOCK',
  shopee_order_status: 'READY_TO_SHIP',
  status: 'processed',
  tracking_no: 'GYAMOCK001',
  trackingNumber: 'GYAMOCK001',
  shipping_carrier: 'Giao Hang Nhanh',
  packageNumber: 'OFGMOCK123',
  isPrepared: true,
  isPrinted: true,
  is_handed_over: true,
  totalAmount: 1000,
  date: new Date().toISOString(),
  items: [{ productId: '1', productTitle: 'Mock item', quantity: 1, price: 1000 }],
};

await col.bulkWrite([buildUpsert(mockOrder)], { ordered: false });
const doc1 = await col.findOne({ _id: MOCK_ID });
console.log('===== AFTER INSERT =====');
console.log(
  JSON.stringify(
    {
      _id: doc1?._id,
      orderSn: doc1?.orderSn,
      shopee_order_status: doc1?.shopee_order_status,
      status: doc1?.status,
      tracking_no: doc1?.tracking_no,
      shipping_carrier: doc1?.shipping_carrier,
      is_handed_over: doc1?.is_handed_over,
      isPrinted: doc1?.isPrinted,
      isPrepared: doc1?.isPrepared,
      data_shopee_order_status: doc1?.data?.shopee_order_status,
      data_tracking_no: doc1?.data?.tracking_no,
      data_shipping_carrier: doc1?.data?.shipping_carrier,
      data_is_handed_over: doc1?.data?.is_handed_over,
      data_isPrinted: doc1?.data?.isPrinted,
      data_isPrepared: doc1?.data?.isPrepared,
    },
    null,
    2,
  ),
);

await col.updateOne(
  { _id: MOCK_ID },
  { $set: { is_handed_over: true, 'data.is_handed_over': true } },
);

await col.bulkWrite(
  [
    buildUpsert({
      ...mockOrder,
      shopee_order_status: 'READY_TO_SHIP',
      is_handed_over: false,
      isPrepared: false,
      isPrinted: false,
    }),
  ],
  { ordered: false },
);

const doc2 = await col.findOne({ _id: MOCK_ID });
console.log('===== AFTER 2nd SYNC (must KEEP is_handed_over=true) =====');
console.log(
  JSON.stringify(
    {
      shopee_order_status: doc2?.shopee_order_status,
      tracking_no: doc2?.tracking_no,
      shipping_carrier: doc2?.shipping_carrier,
      is_handed_over: doc2?.is_handed_over,
      data_is_handed_over: doc2?.data?.is_handed_over,
      preserved: doc2?.is_handed_over === true,
    },
    null,
    2,
  ),
);

const pass =
  doc1?.shopee_order_status === 'READY_TO_SHIP' &&
  doc1?.is_handed_over === false &&
  doc1?.isPrinted === false &&
  doc1?.isPrepared === false &&
  doc1?.tracking_no === 'GYAMOCK001' &&
  doc1?.shipping_carrier === 'Giao Hang Nhanh' &&
  doc2?.is_handed_over === true &&
  doc2?.shopee_order_status === 'READY_TO_SHIP';

console.log('TEST_PASS', pass);

await col.deleteOne({ _id: MOCK_ID });
console.log('cleaned mock doc');
await mongoose.disconnect();
process.exit(pass ? 0 : 1);
