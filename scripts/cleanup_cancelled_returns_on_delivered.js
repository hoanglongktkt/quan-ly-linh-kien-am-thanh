#!/usr/bin/env node
/**
 * CLEANUP — gỡ leftover YCTH CANCELLED trên đơn đã giao.
 *
 *   node scripts/cleanup_cancelled_returns_on_delivered.js
 *   node scripts/cleanup_cancelled_returns_on_delivered.js --dry-run
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import mongoose from "mongoose";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "..", ".env") });

const URI = String(process.env.MONGODB_URI || process.env.MONGO_URL || "").trim();
const VICTIM = "2608114E0WDYQE";
const dryRun = process.argv.includes("--dry-run");

function deliveredOrVictimFilter() {
  return {
    $or: [
      { logistics_status: "LOGISTICS_DELIVERY_DONE" },
      { "data.logistics_status": "LOGISTICS_DELIVERY_DONE" },
      { shopee_order_status: { $in: ["TO_CONFIRM_RECEIVE", "COMPLETED"] } },
      { "data.shopee_order_status": { $in: ["TO_CONFIRM_RECEIVE", "COMPLETED"] } },
      { status: { $in: ["completed", "COMPLETED", "delivered", "DELIVERED"] } },
      { "data.status": { $in: ["completed", "COMPLETED", "delivered", "DELIVERED"] } },
      { orderSn: VICTIM },
      { "data.orderSn": VICTIM },
      { _id: `shopee-${VICTIM}` },
    ],
  };
}

async function main() {
  if (!URI) {
    console.error("Thiếu MONGODB_URI");
    process.exit(1);
  }
  await mongoose.connect(URI, { serverSelectionTimeoutMS: 20000 });
  const col = mongoose.connection.db.collection("orders");

  const filter = {
    $and: [
      {
        $or: [
          { return_status: "CANCELLED" },
          { return_status: "cancelled" },
          { "data.return_status": "CANCELLED" },
          { "data.return_status": "cancelled" },
        ],
      },
      deliveredOrVictimFilter(),
    ],
  };

  const hits = await col
    .find(filter)
    .project({
      orderSn: 1,
      shopId: 1,
      status: 1,
      shopee_order_status: 1,
      logistics_status: 1,
      return_sn: 1,
      return_status: 1,
      return_tracking_no: 1,
      is_return: 1,
      sub_status: 1,
      "data.orderSn": 1,
    })
    .toArray();
  console.log(`[cleanup] candidates=${hits.length} dry=${dryRun}`);
  for (const d of hits) {
    console.log(
      ` - ${d.orderSn || d.data?.orderSn} shop=${d.shopId} rsn=${d.return_sn || ""} rtn=${d.return_tracking_no || ""}`,
    );
  }

  const victim = await col.findOne({
    $or: [{ orderSn: VICTIM }, { "data.orderSn": VICTIM }, { _id: `shopee-${VICTIM}` }],
  });
  if (victim && !hits.some((h) => String(h.orderSn || h.data?.orderSn) === VICTIM)) {
    console.log(`[cleanup] force include victim ${VICTIM}`);
    hits.push(victim);
  }

  if (dryRun) {
    console.log("[cleanup] DRY-RUN — không ghi DB");
    await mongoose.disconnect();
    return;
  }

  const ids = hits.map((h) => h._id).filter(Boolean);
  const result = await col.updateMany(
    {
      $or: [
        ...(ids.length ? [{ _id: { $in: ids } }] : []),
        { orderSn: VICTIM },
        { "data.orderSn": VICTIM },
        { _id: `shopee-${VICTIM}` },
      ],
    },
    {
      $unset: {
        return_sn: "",
        "data.return_sn": "",
        return_tracking_no: "",
        returnTrackingNumber: "",
        "data.return_tracking_no": "",
        "data.returnTrackingNumber": "",
        return_status: "",
        "data.return_status": "",
        shopee_cancel_return_kind: "",
        "data.shopee_cancel_return_kind": "",
        sub_status: "",
        "data.sub_status": "",
      },
      $set: {
        is_return: false,
        "data.is_return": false,
      },
    },
  );
  console.log(
    `[cleanup] matched=${result.matchedCount} modified=${result.modifiedCount}`,
  );

  const after = await col.findOne({
    $or: [{ orderSn: VICTIM }, { "data.orderSn": VICTIM }, { _id: `shopee-${VICTIM}` }],
  });
  console.log(
    `[cleanup] victim ${VICTIM}`,
    JSON.stringify(
      {
        return_sn: after?.return_sn || after?.data?.return_sn || "",
        return_tracking_no: after?.return_tracking_no || after?.data?.return_tracking_no || "",
        return_status: after?.return_status || after?.data?.return_status || "",
        is_return: after?.is_return ?? after?.data?.is_return,
        sub_status: after?.sub_status || after?.data?.sub_status || "",
      },
      null,
      2,
    ),
  );
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error("[FATAL]", err?.message || err);
  process.exit(1);
});
