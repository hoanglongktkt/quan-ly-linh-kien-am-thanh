#!/usr/bin/env node
/**
 * READ-ONLY follow-up: return_sn 2608140B8KY4TDN có phải là order_sn đơn khác?
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import mongoose from "mongoose";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "..", ".env") });
const URI = String(process.env.MONGODB_URI || process.env.MONGO_URL || "").trim();
const CODE = "2608140B8KY4TDN";
const SHOP_NAME = { "4127421": "LKAT / Âm thanh", "831052930": "AuDIO / AUDIO" };

function summarize(doc) {
  if (!doc) return null;
  const shopId = String(doc.shopId ?? doc.data?.shopId ?? "");
  return {
    _id: doc._id,
    orderSn: doc.orderSn || doc.data?.orderSn,
    shopId,
    shop: `${shopId} = ${SHOP_NAME[shopId] || "?"}`,
    shopName: doc.shopName || doc.data?.shopName,
    status: doc.status || doc.data?.status,
    shopee_order_status: doc.shopee_order_status || doc.data?.shopee_order_status,
    logistics_status: doc.logistics_status || doc.data?.logistics_status,
    sub_status: doc.sub_status || doc.data?.sub_status,
    is_return: doc.is_return ?? doc.data?.is_return,
    shopee_cancel_return_kind: doc.shopee_cancel_return_kind || doc.data?.shopee_cancel_return_kind,
    return_sn: doc.return_sn || doc.data?.return_sn || "",
    return_status: doc.return_status || doc.data?.return_status || "",
    tracking_no: doc.tracking_no || doc.trackingNumber || doc.data?.tracking_no || "",
    return_tracking_no:
      doc.return_tracking_no || doc.returnTrackingNumber || doc.data?.return_tracking_no || "",
    date: doc.data?.date || doc.date,
  };
}

async function main() {
  await mongoose.connect(URI, { serverSelectionTimeoutMS: 20000 });
  const col = mongoose.connection.db.collection("orders");
  const c = String(CODE);

  const asOrder = await col
    .find({
      $or: [{ orderSn: c }, { "data.orderSn": c }, { _id: `shopee-${c}` }],
    })
    .toArray();
  console.log(`[A] ${c} với tư cách orderSn: ${asOrder.length}`);
  for (const d of asOrder) console.log(JSON.stringify(summarize(d), null, 2));

  const anywhere = await col
    .find({
      $or: [
        { orderSn: c },
        { "data.orderSn": c },
        { _id: `shopee-${c}` },
        { return_sn: c },
        { "data.return_sn": c },
        { tracking_no: c },
        { return_tracking_no: c },
      ],
    })
    .toArray();
  console.log(`\n[B] ${c} xuất hiện bất kỳ field: ${anywhere.length}`);
  for (const d of anywhere) {
    console.log(JSON.stringify(summarize(d), null, 2));
  }

  const completedGarbage = await col
    .find({
      $and: [
        {
          $or: [
            { return_sn: { $exists: true, $nin: [null, ""] } },
            { "data.return_sn": { $exists: true, $nin: [null, ""] } },
          ],
        },
        {
          $or: [
            { logistics_status: "LOGISTICS_DELIVERY_DONE" },
            { "data.logistics_status": "LOGISTICS_DELIVERY_DONE" },
            { shopee_order_status: "COMPLETED" },
            { "data.shopee_order_status": "COMPLETED" },
            { shopee_order_status: "TO_CONFIRM_RECEIVE" },
            { "data.shopee_order_status": "TO_CONFIRM_RECEIVE" },
          ],
        },
      ],
    })
    .project({
      orderSn: 1,
      shopId: 1,
      shopName: 1,
      status: 1,
      shopee_order_status: 1,
      logistics_status: 1,
      sub_status: 1,
      is_return: 1,
      return_sn: 1,
      return_status: 1,
      tracking_no: 1,
      return_tracking_no: 1,
      "data.orderSn": 1,
      "data.shopId": 1,
    })
    .limit(40)
    .toArray();
  console.log(`\n[C] DELIVERY_DONE/COMPLETED/TO_CONFIRM còn return_sn: ${completedGarbage.length}`);
  for (const d of completedGarbage) console.log(JSON.stringify(summarize(d), null, 2));

  await mongoose.disconnect();
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
