#!/usr/bin/env node
/**
 * READ-ONLY — điều tra mã hoàn ảo SPXVN069880087028
 * gán nhầm vào đơn 2608114E0WDYQE.
 *
 *   node scripts/investigate_leaked_return_tn.js
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import mongoose from "mongoose";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
dotenv.config({ path: path.join(ROOT, ".env") });

const URI = String(process.env.MONGODB_URI || process.env.MONGO_URL || "").trim();
const LEAKED_TN = "SPXVN069880087028";
const VICTIM_SN = "2608114E0WDYQE";
const OUTBOUND_TN = "SPXVN066210499938";
const SHOP_NAME = {
  "4127421": "LKAT / Âm thanh",
  "831052930": "AuDIO / AUDIO",
};

function shopLabel(id) {
  const key = String(id ?? "").trim();
  return `${key || "(empty)"} = ${SHOP_NAME[key] || "?"}`;
}

function pick(doc, keys) {
  const out = {};
  for (const k of keys) {
    const parts = k.split(".");
    let cur = doc;
    for (const p of parts) cur = cur?.[p];
    if (cur !== undefined && cur !== null && cur !== "") out[k] = cur;
  }
  return out;
}

function summarize(doc) {
  if (!doc) return null;
  const shopId = doc.shopId ?? doc.data?.shopId;
  return {
    _id: doc._id,
    orderSn: doc.orderSn || doc.data?.orderSn,
    shopId,
    shop: shopLabel(shopId),
    shopName: doc.shopName || doc.data?.shopName,
    status: doc.status || doc.data?.status,
    shopee_order_status: doc.shopee_order_status || doc.data?.shopee_order_status,
    logistics_status: doc.logistics_status || doc.data?.logistics_status,
    sub_status: doc.sub_status || doc.data?.sub_status,
    is_return: doc.is_return ?? doc.data?.is_return,
    is_rts: doc.is_rts ?? doc.data?.is_rts,
    shopee_cancel_return_kind:
      doc.shopee_cancel_return_kind || doc.data?.shopee_cancel_return_kind,
    return_sn: doc.return_sn || doc.data?.return_sn || "",
    return_status: doc.return_status || doc.data?.return_status || "",
    tracking_no: doc.tracking_no || doc.trackingNumber || doc.data?.tracking_no || "",
    return_tracking_no:
      doc.return_tracking_no ||
      doc.returnTrackingNumber ||
      doc.data?.return_tracking_no ||
      "",
    return_create_time: doc.return_create_time || doc.data?.return_create_time,
    return_update_time: doc.return_update_time || doc.data?.return_update_time,
    last_synced_at: doc.last_synced_at,
    updatedAt: doc.updatedAt,
    date: doc.data?.date || doc.date,
  };
}

function tnOr(code) {
  const c = String(code || "").trim().toUpperCase();
  return {
    $or: [
      { tracking_no: c },
      { trackingNumber: c },
      { "data.tracking_no": c },
      { "data.trackingNumber": c },
      { return_tracking_no: c },
      { returnTrackingNumber: c },
      { "data.return_tracking_no": c },
      { "data.returnTrackingNumber": c },
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
  console.log("=== INVESTIGATE LEAKED RETURN TN (READ-ONLY) ===");

  const leakedHits = await col.find(tnOr(LEAKED_TN)).toArray();
  console.log(`\n[1] Hits cho ${LEAKED_TN}: ${leakedHits.length}`);
  for (const doc of leakedHits) {
    const s = summarize(doc);
    const fields = [];
    const tn = String(s.tracking_no || "").toUpperCase();
    const rtn = String(s.return_tracking_no || "").toUpperCase();
    if (tn === LEAKED_TN) fields.push("tracking_no/chiều đi");
    if (rtn === LEAKED_TN) fields.push("return_tracking_no/chiều hoàn");
    console.log(JSON.stringify({ ...s, matched_as: fields }, null, 2));
  }

  const victim = await col.findOne({
    $or: [
      { orderSn: VICTIM_SN },
      { "data.orderSn": VICTIM_SN },
      { _id: `shopee-${VICTIM_SN}` },
    ],
  });
  console.log(`\n[2] Đơn nạn nhân ${VICTIM_SN}: ${victim ? "FOUND" : "NOT FOUND"}`);
  if (victim) {
    console.log(JSON.stringify(summarize(victim), null, 2));
    const extra = pick(victim, [
      "return_sn",
      "data.return_sn",
      "return_tracking_no",
      "data.return_tracking_no",
      "returnTrackingNumber",
      "data.returnTrackingNumber",
      "tracking_no",
      "trackingNumber",
      "packageNumber",
      "package_number",
    ]);
    console.log("[2b] raw return/tracking fields:", JSON.stringify(extra, null, 2));
  }

  const outboundHits = await col.find(tnOr(OUTBOUND_TN)).toArray();
  console.log(`\n[3] Hits cho outbound ${OUTBOUND_TN}: ${outboundHits.length}`);
  for (const doc of outboundHits) console.log(JSON.stringify(summarize(doc), null, 2));

  const victimReturnSn = String(
    victim?.return_sn || victim?.data?.return_sn || "",
  ).trim();
  if (victimReturnSn) {
    const sameRsn = await col
      .find({
        $or: [{ return_sn: victimReturnSn }, { "data.return_sn": victimReturnSn }],
      })
      .toArray();
    console.log(
      `\n[4] Cùng return_sn=${victimReturnSn}: ${sameRsn.length} đơn`,
    );
    for (const doc of sameRsn) console.log(JSON.stringify(summarize(doc), null, 2));
  } else {
    console.log("\n[4] Nạn nhân KHÔNG có return_sn (hoặc rỗng).");
  }

  const dupPipeline = [
    {
      $project: {
        orderSn: { $ifNull: ["$orderSn", "$data.orderSn"] },
        shopId: { $ifNull: ["$shopId", "$data.shopId"] },
        shopName: { $ifNull: ["$shopName", "$data.shopName"] },
        status: { $ifNull: ["$status", "$data.status"] },
        return_sn: { $ifNull: ["$return_sn", "$data.return_sn"] },
        rtn: {
          $toUpper: {
            $ifNull: [
              "$return_tracking_no",
              { $ifNull: ["$returnTrackingNumber", "$data.return_tracking_no"] },
            ],
          },
        },
      },
    },
    { $match: { rtn: { $type: "string", $ne: "" } } },
    {
      $group: {
        _id: "$rtn",
        count: { $sum: 1 },
        orders: {
          $push: {
            orderSn: "$orderSn",
            shopId: "$shopId",
            shopName: "$shopName",
            status: "$status",
            return_sn: "$return_sn",
          },
        },
      },
    },
    { $match: { count: { $gt: 1 } } },
    { $sort: { count: -1 } },
    { $limit: 30 },
  ];
  const dups = await col.aggregate(dupPipeline, { maxTimeMS: 30000 }).toArray();
  console.log(`\n[5] return_tracking_no trùng >1 đơn: ${dups.length} mã`);
  for (const row of dups) {
    console.log(JSON.stringify(row, null, 2));
  }

  if (victim) {
    const hasRsn = Boolean(victimReturnSn);
    const status = String(victim.status || victim.data?.status || "");
    const shopeeStatus = String(
      victim.shopee_order_status || victim.data?.shopee_order_status || "",
    );
    console.log("\n[6] Vì sao nạn nhân lọt backfill?");
    console.log(
      JSON.stringify(
        {
          has_return_sn: hasRsn,
          return_sn: victimReturnSn || "(empty)",
          status,
          shopee_order_status: shopeeStatus,
          missingReturnFilter_khop_return_sn: hasRsn,
          missingReturnFilter_co_loc_status: false,
          orderNeedsRealReturnTracking_hasReturnCtx:
            hasRsn ||
            /cancel|return/i.test(status) ||
            /CANCELLED|IN_CANCEL|TO_RETURN/i.test(shopeeStatus),
        },
        null,
        2,
      ),
    );
  }

  const completedWithReturnSn = await col.countDocuments({
    $and: [
      {
        $or: [
          { return_sn: { $exists: true, $nin: [null, ""] } },
          { "data.return_sn": { $exists: true, $nin: [null, ""] } },
        ],
      },
      {
        $or: [
          { status: { $in: ["completed", "COMPLETED", "delivered", "shipped"] } },
          { shopee_order_status: "COMPLETED" },
          { "data.shopee_order_status": "COMPLETED" },
        ],
      },
    ],
  });
  console.log(
    `\n[7] Đơn COMPLETED/delivered vẫn còn return_sn rác: ${completedWithReturnSn}`,
  );

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error("[FATAL]", err?.message || err);
  process.exit(1);
});
