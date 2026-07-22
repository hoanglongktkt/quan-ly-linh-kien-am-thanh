import 'dotenv/config';
import mongoose from 'mongoose';

await mongoose.connect(process.env.MONGODB_URI || process.env.MONGO_URL, {
  serverSelectionTimeoutMS: 15000,
});
const col = mongoose.connection.collection('orders');
const byTn = await col.find({ tracking_no: 'GYAVVG7V' }).toArray();
const bySn = await col.find({ orderSn: '2607219HGSU7JB' }).toArray();
const processed = await col.countDocuments({
  $or: [{ status: 'processed' }, { 'data.status': 'processed' }],
});
console.log(
  JSON.stringify(
    {
      gyavvg7v: byTn.length,
      sn2607219HGSU7JB: bySn.length,
      statusProcessedCount: processed,
      totalOrders: await col.countDocuments({}),
    },
    null,
    2,
  ),
);
await mongoose.disconnect();
