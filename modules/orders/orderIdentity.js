// Module miền nghiệp vụ; giữ nguyên hành vi và trạng thái dùng chung.
import { observeWebhookStage, hasShortOrderDeadline } from "../operations/telemetry.js";
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
  const dbOptions = hasShortOrderDeadline() ? { timeoutMS: 12000 } : {};
  const mappings = await observeWebhookStage("db_identity_map_read", () =>
    identities.find({ _id: { $in: keys } }, dbOptions).toArray());
  for (const mapping of mappings) {
    if (keys.includes(String(mapping._id)) && mapping.documentId) result.set(String(mapping._id), String(mapping.documentId));
  }
  const unresolved = rows.filter((row) => !result.has(`${shopOf(row)}:${snOf(row)}`));
  const ids = [...new Set([...result.values(), ...unresolved.map(idOf)])];
  // Reuse durable identities. The broader legacy lookup is needed only on the
  // first encounter, never for every update to an already mapped order.
  const existingFilter = unresolved.length ? {
    $or: [{ orderSn: { $in: unresolved.map(snOf) } }, { _id: { $in: ids } }],
  } : { _id: { $in: ids } };
  const existing = await observeWebhookStage("db_identity_validate", () =>
    OrderModel.find(existingFilter, null, dbOptions).select({ _id: 1, shopId: 1, orderSn: 1 }).lean());
  const byId = new Map(existing.map((o) => [String(o._id), o]));
  const byPair = new Map(existing.map((o) => [`${o.shopId || ""}:${o.orderSn || ""}`, o]));
  const operations = new Map();
  for (const row of rows) {
    const shopId = shopOf(row);
    const orderSn = snOf(row);
    const key = `${shopId}:${orderSn}`;
    const mapped = result.get(key);
    if (mapped) {
      const current = byId.get(mapped);
      if ((current?.shopId && String(current.shopId) !== shopId)
        || (current?.orderSn && String(current.orderSn) !== orderSn)) {
        throw new Error("shopee_order_shop_identity_conflict");
      }
      continue;
    }
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
  if (operations.size) try {
    await observeWebhookStage("db_identity_map_write", () =>
      identities.bulkWrite([...operations.values()], { ordered: false, ...dbOptions }));
  } catch (error) {
    // Hai process tạo key cùng lúc: chỉ bỏ qua duplicate key, giữ mọi lỗi DB khác.
    const errors = error?.writeErrors;
    if (error?.code !== 11000 || !Array.isArray(errors) || !errors.length
      || errors.some((e) => e.code !== 11000) || error?.writeConcernErrors?.length) throw error;
  }
  if (operations.size) {
    const created = await observeWebhookStage("db_identity_map_confirm", () =>
      identities.find({ _id: { $in: [...operations.keys()] } }, dbOptions).toArray());
    for (const mapping of created) {
      if (mapping.documentId) result.set(String(mapping._id), String(mapping.documentId));
    }
  }
  if (keys.some((key) => !result.has(key))) throw new Error("shopee_order_identity_missing");
  return result;
}
