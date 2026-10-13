// Rà soát chỉ đọc: không có createIndex, dropIndex, syncIndexes hoặc ghi thử vào production.
export function summarizeExplain(explain) {
  const stages = new Set(), indexes = new Set();
  const visit = (value) => {
    if (!value || typeof value !== "object") return;
    if (typeof value.stage === "string") stages.add(value.stage);
    if (typeof value.indexName === "string") indexes.add(value.indexName);
    for (const child of Object.values(value)) {
      if (Array.isArray(child)) child.forEach(visit);
      else if (child && typeof child === "object") visit(child);
    }
  };
  visit(explain.queryPlanner?.winningPlan);
  visit(explain.executionStats?.executionStages);
  // Aggregate explain có thể bọc queryPlanner trong $cursor.
  for (const stage of explain.stages || []) {
    if (stage.$cursor) visit(stage.$cursor.queryPlanner?.winningPlan);
  }
  const stats = explain.executionStats || explain.stages?.find((stage) => stage.$cursor)?.$cursor?.executionStats || {};
  return { stages: [...stages], indexes: [...indexes], collectionScan: stages.has("COLLSCAN"),
    blockingSort: stages.has("SORT"), nReturned: stats.nReturned ?? null,
    totalDocsExamined: stats.totalDocsExamined ?? null, totalKeysExamined: stats.totalKeysExamined ?? null,
    executionTimeMillis: stats.executionTimeMillis ?? null };
}

export async function auditOmsIndexes(db, now = new Date()) {
  const result = { checkedAt: now.toISOString(), readOnly: true, indexes: {}, queries: [],
    writePerformanceVerified: false,
    policy: "Không thêm index. explain không đo chi phí cập nhật index; cần benchmark insert/upsert trên staging trước khi đề xuất compound mới." };
  for (const name of ["orders", "webhook_jobs", "channel_listings"]) {
    try {
      result.indexes[name] = (await db.collection(name).indexes()).map(({ name, key, unique, sparse, partialFilterExpression, expireAfterSeconds }) =>
        ({ name, key, unique: Boolean(unique || name === "_id_"), sparse: Boolean(sparse), partialFilterExpression, expireAfterSeconds }));
    } catch (error) { if (error?.code !== 26) throw error; result.indexes[name] = []; }
  }
  // Chỉ lấy định danh làm mẫu explain, không in dữ liệu đơn/khách hàng ra báo cáo.
  const order = await db.collection("orders").findOne({}, { projection: { _id: 1, orderSn: 1, shopId: 1 }, maxTimeMS: 3000 });
  const listing = await db.collection("channel_listings").findOne({}, { projection: { _id: 1, channelId: 1, sku: 1 }, maxTimeMS: 3000 });
  const plans = [
    { name: "webhook_worker_claim", collection: "webhook_jobs", filter: { $or: [
      { state: "pending", next_run_at: { $lte: now } },
      { state: "failed", next_run_at: { $lte: now }, retry_count: { $lt: 5 } },
    ] }, sort: { priority: -1, next_run_at: 1, _id: 1 }, limit: 1 },
    { name: "webhook_queue_depth", collection: "webhook_jobs", aggregate: [
      { $match: { state: { $in: ["pending", "running", "failed"] } } },
      { $group: { _id: "$state", count: { $sum: 1 }, oldest: { $min: "$createdAt" } } },
    ] },
    { name: "webhook_metrics_window", collection: "webhook_jobs", filter: { createdAt: { $gte: new Date(now - 3600000), $lte: now } } },
  ];
  if (order) {
    // Bộ lọc định danh khớp buildOrderCompoundFilter đang dùng cho bulk upsert.
    const sn = String(order.orderSn || "");
    const shopId = String(order.shopId || "");
    const identity = { $or: [{ orderSn: sn }, { _id: order._id }, { "data.orderSn": sn }] };
    const variants = [{ shopId }, { "data.shopId": shopId }, { shopId: null }, { shopId: { $exists: false } }];
    if (shopId && Number.isFinite(Number(shopId)) && String(Number(shopId)) === shopId) {
      variants.push({ shopId: Number(shopId) }, { "data.shopId": Number(shopId) });
    }
    plans.push({ name: "orders_upsert_lookup", collection: "orders",
      filter: shopId ? { $and: [identity, { $or: variants }] } : identity, limit: 1 });
    if (shopId) plans.push({ name: "orders_shop_status", collection: "orders", filter: { shopId, status: "shipping" },
      sort: { last_shopee_update_at: -1 }, limit: 50 });
  } else result.queries.push({ name: "orders_upsert_lookup", skipped: "collection_empty" });
  if (listing) {
    plans.push({ name: "listing_upsert_lookup", collection: "channel_listings", filter: { _id: listing._id }, limit: 1 });
    if (listing.channelId) plans.push({ name: "listing_channel_lookup", collection: "channel_listings", filter: { channelId: listing.channelId }, limit: 50 });
    if (listing.sku) plans.push({ name: "listing_sku_lookup", collection: "channel_listings", filter: { sku: listing.sku }, limit: 50 });
  } else result.queries.push({ name: "listing_upsert_lookup", skipped: "collection_empty" });
  // Tuần tự và có thời hạn để audit không tranh nhiều connection với worker đang ghi.
  for (const plan of plans) {
    try {
      let cursor = plan.aggregate
        ? db.collection(plan.collection).aggregate(plan.aggregate, { maxTimeMS: 3000, allowDiskUse: false })
        : db.collection(plan.collection).find(plan.filter, { maxTimeMS: 3000 });
      if (plan.sort) cursor = cursor.sort(plan.sort);
      if (plan.limit) cursor = cursor.limit(plan.limit);
      result.queries.push({ name: plan.name, collection: plan.collection,
        ...summarizeExplain(await cursor.explain("executionStats")) });
    } catch (error) {
      result.queries.push({ name: plan.name, collection: plan.collection,
        error: error?.code === 50 ? "explain_time_limit" : "explain_unavailable" });
    }
  }
  return result;
}
