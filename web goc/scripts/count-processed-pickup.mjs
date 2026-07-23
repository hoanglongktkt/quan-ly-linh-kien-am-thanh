import 'dotenv/config';
import fs from 'fs';
import mongoose from 'mongoose';
import { initMongo, loadOrdersFromStore } from '../src/db/mongoStore.ts';
import { matchesProcessedPickupTab } from '../src/utils/orderHandover.ts';

await initMongo(process.cwd());
const mongo = await loadOrdersFromStore();
const processedStatus = mongo.filter((o) => String(o.status) === 'processed');
const tab = mongo.filter((o) => matchesProcessedPickupTab(o));
console.log('mongo total', mongo.length);
console.log('mongo status=processed', processedStatus.length);
console.log('mongo matchesProcessedPickupTab', tab.length);
console.log(
  'sample',
  processedStatus.slice(0, 20).map((o) => `${o.orderSn}|raw=${o.shopee_order_status}|tn=${o.tracking_no || o.trackingNumber || ''}`),
);

const local = JSON.parse(fs.readFileSync('data/orders.json', 'utf8'));
const localProcessed = local.filter((o) => String(o.status) === 'processed');
const localTab = local.filter((o) => matchesProcessedPickupTab(o));
console.log('json total', local.length);
console.log('json status=processed', localProcessed.length);
console.log('json matchesProcessedPickupTab', localTab.length);
if (localTab.length) {
  console.log(
    'json tab sns',
    localTab.map((o) => o.orderSn).join(', '),
  );
}

await mongoose.disconnect();
