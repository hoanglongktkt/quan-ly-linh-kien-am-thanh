/**
 * Đẩy tracking_no từ Mongo Atlas → production orders.json qua PATCH API.
 * Chữa lỗi: script sync chỉ ghi Mongo, production API đọc JSON → GHN không hiện.
 *
 *   node scripts/push-mongo-tracking-to-prod.mjs
 *   node scripts/push-mongo-tracking-to-prod.mjs --sn=2607219HGSU7JB
 */
import dotenv from "dotenv";
import mongoose from "mongoose";

dotenv.config({ quiet: true });

const URI = String(process.env.MONGODB_URI || process.env.MONGO_URL || "").trim();
const BASE = String(process.env.APP_URL || process.env.APP_BASE_URL || "")
  .trim()
  .replace(/\/$/, "");
const USER = String(process.env.ADMIN_USERNAME || "").trim();
const PASS = String(process.env.ADMIN_PASSWORD || "").trim();

function arg(name) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split("=").slice(1).join("=") : "";
}

async function main() {
  if (!URI || !BASE || !USER || !PASS) {
    console.error("Thiếu MONGODB_URI / APP_URL / ADMIN_USERNAME / ADMIN_PASSWORD");
    process.exit(1);
  }

  const onlySn = String(arg("sn") || "").trim();

  await mongoose.connect(URI, { serverSelectionTimeoutMS: 20000 });
  const col = mongoose.connection.db.collection("orders");

  // Mirror top-level → data trước
  const needMirror = await col
    .find({ tracking_no: { $exists: true, $nin: [null, ""] } })
    .project({ _id: 1, tracking_no: 1, "data.tracking_no": 1, "data.trackingNumber": 1 })
    .toArray();
  let mirrored = 0;
  for (const d of needMirror) {
    const tn = String(d.tracking_no || "").trim();
    if (!tn || /^0FG/i.test(tn)) continue;
    const dataTn = String(d.data?.tracking_no || d.data?.trackingNumber || "").trim();
    if (dataTn === tn) continue;
    await col.updateOne(
      { _id: d._id },
      { $set: { "data.tracking_no": tn, "data.trackingNumber": tn } },
    );
    mirrored++;
  }
  console.log(`[Mongo] mirrored top→data: ${mirrored}`);

  const docs = await col
    .find({ tracking_no: { $exists: true, $nin: [null, ""] } })
    .project({ orderSn: 1, tracking_no: 1, "data.orderSn": 1 })
    .toArray();
  const map = new Map();
  for (const d of docs) {
    const sn = String(d.orderSn || d.data?.orderSn || "")
      .replace(/^shopee-/i, "")
      .trim();
    const tn = String(d.tracking_no || "").trim();
    if (!sn || !tn || /^0FG/i.test(tn)) continue;
    if (onlySn && sn !== onlySn) continue;
    map.set(sn, tn);
  }
  console.log(`[Mongo] tracking map size=${map.size}`);

  const login = await (
    await fetch(`${BASE}/api/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: USER, password: PASS }),
    })
  ).json();
  if (!login?.token) {
    console.error("Login failed", login);
    process.exit(1);
  }
  const headers = {
    Authorization: `Bearer ${login.token}`,
    "Content-Type": "application/json",
    "Cache-Control": "no-cache",
  };

  // Thử endpoint hydrate mới (nếu đã deploy)
  try {
    const hyd = await fetch(`${BASE}/api/orders/hydrate-tracking`, {
      method: "POST",
      headers,
    });
    if (hyd.ok) {
      const body = await hyd.json();
      console.log("[Prod] hydrate-tracking OK", body);
    } else {
      console.log(`[Prod] hydrate-tracking HTTP ${hyd.status} — fallback PATCH từng đơn`);
    }
  } catch (err) {
    console.log("[Prod] hydrate-tracking skip:", err?.message || err);
  }

  const ordersRes = await fetch(`${BASE}/api/orders?t=${Date.now()}`, {
    headers,
    cache: "no-store",
  });
  const ordersJson = await ordersRes.json();
  const orders = Array.isArray(ordersJson) ? ordersJson : ordersJson.orders || [];
  console.log(`[Prod] orders loaded=${orders.length}`);

  let patched = 0;
  let already = 0;
  let missingOnProd = 0;
  let failed = 0;

  const bySn = new Map(
    orders.map((o) => [String(o.orderSn || "").replace(/^shopee-/i, "").trim(), o]),
  );

  for (const [sn, tn] of map.entries()) {
    const o = bySn.get(sn);
    if (!o) {
      missingOnProd++;
      if (sn === onlySn || missingOnProd <= 5) {
        console.log(`  skip (không có trên prod JSON): ${sn} → ${tn}`);
      }
      continue;
    }
    const cur = String(o.trackingNumber || o.tracking_no || "").trim();
    if (cur && !/^0FG/i.test(cur)) {
      already++;
      continue;
    }
    const id = o.id || `shopee-${sn}`;
    try {
      const res = await fetch(`${BASE}/api/orders/${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers,
        body: JSON.stringify({
          tracking_no: tn,
          trackingNumber: tn,
        }),
      });
      if (!res.ok) {
        failed++;
        const text = await res.text();
        console.log(`  FAIL ${sn}: HTTP ${res.status} ${text.slice(0, 120)}`);
        continue;
      }
      patched++;
      console.log(`  OK ${sn} → ${tn}`);
    } catch (err) {
      failed++;
      console.log(`  FAIL ${sn}:`, err?.message || err);
    }
  }

  // Verify target order
  const checkSn = onlySn || "2607219HGSU7JB";
  const after = await (
    await fetch(`${BASE}/api/orders?t=${Date.now()}`, { headers, cache: "no-store" })
  ).json();
  const list = Array.isArray(after) ? after : after.orders || [];
  const hit = list.find((o) => String(o.orderSn) === checkSn);
  console.log("\n========== TỔNG KẾT ==========");
  console.log(`Patched:          ${patched}`);
  console.log(`Already had tn:   ${already}`);
  console.log(`Missing on prod:  ${missingOnProd}`);
  console.log(`Failed:           ${failed}`);
  console.log(
    `Verify ${checkSn}:`,
    hit
      ? `tn=${hit.trackingNumber || hit.tracking_no || "(empty)"}`
      : "(không thấy trên /api/orders)",
  );
  console.log("==============================\n");

  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error(err);
  try {
    await mongoose.disconnect();
  } catch {
    /* ignore */
  }
  process.exit(1);
});
