/** Ánh xạ shop + đơn sang _id hiện có, unique bằng _id của collection riêng. */
export async function resolveShopeeOrderIdentities(orders, db, OrderModel) {
  const rows = orders.filter((o) => String(o.channel || "shopee").toLowerCase() === "shopee"
    && String(o.shopId ?? o.shop_id ?? "").trim() && String(o.orderSn ?? o.order_sn ?? "").trim());
  const result = new Map();
  if (!rows.length) return result;
  const identities = db.collection("shopee_order_idempotency");
  const snOf = (o) => String(o.orderSn ?? o.order_sn ?? "").trim();
  const shopOf = (o) => String(o.shopId ?? o.shop_id ?? "").trim();
  const idOf = (o) => String(o.id || `shopee-${snOf(o)}`).trim();
  const keys = [...new Set(rows.map((o) => `${shopOf(o)}:${snOf(o)}`))];
  // Đọc theo lô để tránh thêm nhiều truy vấn cho mỗi đơn khi cron chạy.
  const existing = await OrderModel.find({
    $or: [{ orderSn: { $in: rows.map(snOf) } }, { _id: { $in: rows.map(idOf) } }],
  }).select({ _id: 1, shopId: 1, orderSn: 1 }).lean();
  const byId = new Map(existing.map((o) => [String(o._id), o]));
  const byPair = new Map(existing.map((o) => [`${o.shopId || ""}:${o.orderSn || ""}`, o]));
  const operations = new Map();
  for (const row of rows) {
    const shopId = shopOf(row);
    const orderSn = snOf(row);
    const key = `${shopId}:${orderSn}`;
    const current = byPair.get(key) || byPair.get(`:${orderSn}`);
    const documentId = current ? String(current._id) : idOf(row);
    const collision = byId.get(documentId);
    if (collision?.shopId && String(collision.shopId) !== shopId) {
      throw new Error("shopee_order_shop_identity_conflict");
    }
    operations.set(key, { updateOne: {
      filter: { _id: key },
      update: { $setOnInsert: { documentId, shopId, orderSn, createdAt: new Date() } },
      upsert: true,
    } });
  }
  try {
    await identities.bulkWrite([...operations.values()], { ordered: false });
  } catch (error) {
    // Hai process tạo key cùng lúc: chỉ bỏ qua duplicate key, giữ mọi lỗi DB khác.
    const errors = error?.writeErrors;
    if (error?.code !== 11000 || !Array.isArray(errors) || !errors.length
      || errors.some((e) => e.code !== 11000) || error?.writeConcernErrors?.length) throw error;
  }
  const mappings = await identities.find({ _id: { $in: keys } }).toArray();
  for (const mapping of mappings) {
    if (mapping.documentId) result.set(String(mapping._id), String(mapping.documentId));
  }
  if (keys.some((key) => !result.has(key))) throw new Error("shopee_order_identity_missing");
  return result;
}
