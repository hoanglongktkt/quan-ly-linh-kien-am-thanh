/**
 * Debug độc lập: tìm return_sn + tracking_number cho 1 order_sn qua API backend.
 *
 * Cách chạy (cần server đang chạy + admin token):
 *   set ADMIN_TOKEN=... && node scripts/debug-return-order.mjs
 *   node scripts/debug-return-order.mjs --order=260703PQ2D6RUK --base=http://localhost:3000
 */
const orderSn =
  process.argv.find((a) => a.startsWith("--order="))?.split("=")[1] ||
  process.env.ORDER_SN ||
  "260703PQ2D6RUK";
const base =
  process.argv.find((a) => a.startsWith("--base="))?.split("=")[1] ||
  process.env.APP_BASE_URL ||
  "http://localhost:3000";
const token = process.env.ADMIN_TOKEN || process.env.TOKEN || "";

async function main() {
  if (!token) {
    console.error("Thiếu ADMIN_TOKEN (Bearer admin JWT). Ví dụ:");
    console.error('  set ADMIN_TOKEN=eyJ... && node scripts/debug-return-order.mjs');
    process.exit(1);
  }
  const url = `${base.replace(/\/$/, "")}/api/shopee/debug/return-by-order?order_sn=${encodeURIComponent(orderSn)}`;
  console.log(`[debug-return-order] GET ${url}`);
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    console.error("Non-JSON response:", text.slice(0, 500));
    process.exit(1);
  }
  console.log(JSON.stringify(json, null, 2));
  if (json.return_detail_raw) {
    console.log("\n===== return_detail_raw.tracking_number =====");
    console.log(json.return_detail_raw?.response?.tracking_number || json.tracking_number_extracted);
  }
  process.exit(json.ok && json.tracking_number_extracted ? 0 : 2);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
