const ACTIVE_STATES = ["pending", "running", "failed"];

export function parseMetricsQuery(query = {}) {
  // Giới hạn cửa sổ và chỉ chấp nhận chuỗi; chặn toán tử Mongo từ query string.
  const allowed = new Set(["shopId", "windowMinutes"]);
  if (Object.keys(query).some((key) => !allowed.has(key))) throw new Error("invalid_query");
  const shopId = query.shopId;
  const window = query.windowMinutes ?? "60";
  if ((shopId !== undefined && (typeof shopId !== "string" || !/^\d{1,20}$/.test(shopId)))
    || typeof window !== "string" || !/^\d+$/.test(window)) throw new Error("invalid_query");
  const windowMinutes = Number(window);
  if (!Number.isInteger(windowMinutes) || windowMinutes < 1 || windowMinutes > 1440) throw new Error("invalid_query");
  return { shopId, windowMinutes };
}

export async function collectOperationsMetrics(db, { shopId, windowMinutes, includeApiErrors = true }, now = new Date()) {
  const since = new Date(now.getTime() - windowMinutes * 60000);
  // Lỗi API gộp theo phút nên hai đầu cửa sổ cũng căn theo phút.
  const errorSince = new Date(Math.floor(since.getTime() / 60000) * 60000);
  const shopFilter = shopId ? { shopId } : {};
  const aggregate = (collection, pipeline) => db.collection(collection)
    .aggregate(pipeline, { maxTimeMS: 5000, allowDiskUse: false }).toArray();
  const [queue, jobs, errors, watermarks] = await Promise.all([
    aggregate("webhook_jobs", [
      { $match: { ...shopFilter, state: { $in: ACTIVE_STATES } } },
      { $group: { _id: "$state", count: { $sum: 1 }, oldest: { $min: "$createdAt" } } },
    ]),
    aggregate("webhook_jobs", [
      { $match: { ...shopFilter, createdAt: { $gte: since, $lte: now } } },
      { $project: { shopId: 1, state: 1, retry_count: 1, retry_attempts: 1, kind: 1,
        received_at: 1, finished_at: 1,
        latency: { $cond: [{ $and: [{ $eq: ["$kind", "webhook"] },
          { $eq: [{ $type: "$received_at" }, "date"] }, { $eq: [{ $type: "$order_persisted_at" }, "date"] }] },
          { $max: [0, { $subtract: ["$order_persisted_at", "$received_at"] }] }, null] } } },
      { $group: { _id: { $ifNull: ["$shopId", "unattributed"] }, jobs: { $sum: 1 },
        jobFailures: { $sum: { $ifNull: ["$retry_count", 0] } },
        retryAttempts: { $sum: { $ifNull: ["$retry_attempts", 0] } },
        legacyRetryJobs: { $sum: { $cond: [{ $eq: [{ $type: "$retry_attempts" }, "missing"] }, 1, 0] } },
        deadLetterJobs: { $sum: { $cond: [{ $eq: ["$state", "dead-letter"] }, 1, 0] } },
        latencySamples: { $sum: { $cond: [{ $ne: ["$latency", null] }, 1, 0] } },
        latencyTotalMs: { $sum: "$latency" }, latencyMaxMs: { $max: "$latency" },
        // Chỉ tính webhook thật và job thành công; dead-letter không phải tiến độ xử lý.
        lastWebhookAt: { $max: { $cond: [{ $eq: ["$kind", "webhook"] }, "$received_at", null] } },
        lastJobSucceededAt: { $max: { $cond: [{ $eq: ["$state", "succeeded"] }, "$finished_at", null] } },
        lastSyncJobSucceededAt: { $max: { $cond: [{ $and: [{ $eq: ["$kind", "sync"] }, { $eq: ["$state", "succeeded"] }] }, "$finished_at", null] } } } },
      { $sort: { _id: 1 } }, { $limit: 201 },
    ]),
    includeApiErrors ? aggregate("ops_api_errors", [
      { $match: { ...shopFilter, bucket_at: { $gte: errorSince, $lte: now } } },
      { $group: { _id: { shopId: "$shopId", category: "$category" }, count: { $sum: "$count" } } },
      { $sort: { "_id.shopId": 1, "_id.category": 1 } }, { $limit: 801 },
    ]) : Promise.resolve([]),
    // Collection watermark nhỏ; lọc _id khi xem một shop, không đọc collection orders.
    db.collection("sync_orchestrator_watermarks").find(shopId ? { _id: shopId } : {}, {
      projection: { lastSuccessfulAt: 1 }, maxTimeMS: 1500,
    }).limit(201).toArray(),
  ]);
  const shops = new Map();
  const getShop = (id) => {
    if (!shops.has(id)) shops.set(id, { shopId: id, jobs: 0, jobFailures: 0, retryAttempts: 0,
      legacyRetryJobs: 0, deadLetterJobs: 0, latencySamples: 0, latencyTotalMs: 0, latencyMaxMs: null,
      apiErrors: 0, apiErrorsByCategory: {}, lastSuccessfulSyncAt: null,
      lastWebhookAt: null, lastJobSucceededAt: null, lastSyncJobSucceededAt: null });
    return shops.get(id);
  };
  for (const { _id, ...row } of jobs.slice(0, 200)) Object.assign(getShop(_id), row);
  for (const row of errors.slice(0, 800)) {
    const shop = getShop(row._id.shopId);
    shop.apiErrors += row.count;
    shop.apiErrorsByCategory[row._id.category] = row.count;
  }
  for (const row of watermarks.slice(0, 200)) getShop(String(row._id)).lastSuccessfulSyncAt = row.lastSuccessfulAt || null;
  const byState = Object.fromEntries(ACTIVE_STATES.map((state) => [state, 0]));
  for (const row of queue) byState[row._id] = row.count;
  const oldest = queue.map((row) => row.oldest).filter((value) => value instanceof Date);
  const rows = [...shops.values()];
  const latest = (field) => rows.reduce((value, row) => {
    const time = new Date(row[field] || 0).getTime();
    return Number.isFinite(time) ? Math.max(value, time) : value;
  }, 0);
  const samples = rows.reduce((sum, row) => sum + row.latencySamples, 0);
  const totalMs = rows.reduce((sum, row) => sum + row.latencyTotalMs, 0);
  return { generatedAt: now.toISOString(), window: { since: since.toISOString(), windowMinutes,
    apiErrorSince: errorSince.toISOString(), jobBasis: "createdAt", apiErrorResolutionSeconds: 60 },
    queue: { depth: Object.values(byState).reduce((sum, n) => sum + n, 0), byState,
      waiting: byState.pending + byState.failed,
      oldestAgeMs: oldest.length ? Math.max(0, now - Math.min(...oldest.map(Number))) : null },
    summary: { webhookToOrderLatencyMs: { samples, average: samples ? totalMs / samples : null },
      retryAttempts: rows.reduce((sum, row) => sum + row.retryAttempts, 0),
      lastJobSucceededAt: latest("lastJobSucceededAt") ? new Date(latest("lastJobSucceededAt")).toISOString() : null,
      lastSyncJobSucceededAt: latest("lastSyncJobSucceededAt") ? new Date(latest("lastSyncJobSucceededAt")).toISOString() : null,
      // Tổng hệ thống gồm sync thủ công; watermark theo shop giữ riêng để cảnh báo không bị che.
      lastSuccessfulSyncAt: Math.max(latest("lastSuccessfulSyncAt"), latest("lastSyncJobSucceededAt"))
        ? new Date(Math.max(latest("lastSuccessfulSyncAt"), latest("lastSyncJobSucceededAt"))).toISOString() : null },
    truncated: jobs.length > 200 || errors.length > 800 || watermarks.length > 200,
    shops: [...shops.values()].map(({ latencyTotalMs, ...shop }) => ({ ...shop,
      webhookToOrderLatencyMs: { samples: shop.latencySamples,
        average: shop.latencySamples ? latencyTotalMs / shop.latencySamples : null, max: shop.latencyMaxMs } })),
  };
}
