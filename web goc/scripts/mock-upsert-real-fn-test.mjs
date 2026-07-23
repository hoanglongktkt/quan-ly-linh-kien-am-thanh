import 'dotenv/config';
import mongoose from 'mongoose';
import { initMongo, bulkUpsertOrdersToStore, flushDbWrites, isMongoReady } from '../src/db/mongoStore.ts';

const MOCK_SN = 'MOCKTESTUPSERT002';
const MOCK_ID = `shopee-${MOCK_SN}`;

const ok = await initMongo(process.cwd());
console.log('initMongo', ok, isMongoReady());
if (!ok) process.exit(1);

const col = mongoose.connection.collection('orders');
await col.deleteOne({ _id: MOCK_ID });

await bulkUpsertOrdersToStore([
  {
    id: MOCK_ID,
    orderSn: MOCK_SN,
    channel: 'shopee',
    shopId: '4127421',
    shopee_order_status: 'READY_TO_SHIP',
    status: 'processed',
    tracking_no: 'GYAMOCK002',
    shipping_carrier: 'SPX Express',
    is_handed_over: true,
    isPrinted: true,
    isPrepared: true,
    items: [{ productId: 'x', productTitle: 't', quantity: 1, price: 1 }],
  },
]);
await flushDbWrites();

const doc1 = await col.findOne({ _id: MOCK_ID });
console.log('===== REAL bulkUpsertOrdersToStore INSERT =====');
console.log(
  JSON.stringify(
    {
      shopee_order_status: doc1?.shopee_order_status,
      status: doc1?.status,
      tracking_no: doc1?.tracking_no,
      shipping_carrier: doc1?.shipping_carrier,
      is_handed_over: doc1?.is_handed_over,
      isPrinted: doc1?.isPrinted,
      isPrepared: doc1?.isPrepared,
      data_shopee_order_status: doc1?.data?.shopee_order_status,
      data_is_handed_over: doc1?.data?.is_handed_over,
      data_tracking_no: doc1?.data?.tracking_no,
      data_shipping_carrier: doc1?.data?.shipping_carrier,
    },
    null,
    2,
  ),
);

await col.updateOne(
  { _id: MOCK_ID },
  { $set: { is_handed_over: true, 'data.is_handed_over': true } },
);

await bulkUpsertOrdersToStore([
  {
    id: MOCK_ID,
    orderSn: MOCK_SN,
    channel: 'shopee',
    shopId: '4127421',
    shopee_order_status: 'READY_TO_SHIP',
    status: 'processed',
    tracking_no: 'GYAMOCK002',
    shipping_carrier: 'SPX Express',
    is_handed_over: false,
    isPrinted: false,
    isPrepared: false,
  },
]);
await flushDbWrites();

const doc2 = await col.findOne({ _id: MOCK_ID });
console.log('===== REAL 2nd SYNC (must KEEP is_handed_over=true) =====');
console.log(
  JSON.stringify(
    {
      shopee_order_status: doc2?.shopee_order_status,
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
  doc1?.tracking_no === 'GYAMOCK002' &&
  doc1?.shipping_carrier === 'SPX Express' &&
  doc2?.is_handed_over === true &&
  doc2?.shopee_order_status === 'READY_TO_SHIP';

console.log('REAL_FN_TEST_PASS', pass);
await col.deleteOne({ _id: MOCK_ID });
await mongoose.disconnect();
process.exit(pass ? 0 : 1);
