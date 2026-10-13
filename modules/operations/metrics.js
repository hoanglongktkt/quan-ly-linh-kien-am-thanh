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

export async function collectOperationsMetrics(db, { shopId, windowMinutes }, now = new Date()) {
  const since = new Date(now.getTime() - windowMinutes * 60000);
  // Lỗi API gộp theo phút nên hai đầu cửa sổ cũng căn theo phút.
  const errorSince = new Date(Math.floor(since.getTime() / 60000) * 60000);
  const shopFilter = shopId ? { shopId } : {};
  const aggregate = (collection, pipeline) => db.collection(collection)
    .aggregate(pipeline, { maxTimeMS: 5000, allowDiskUse: false }).toArray();
  const [queue, jobs, errors] = await Promise.all([
    aggregate("webhook_jobs", [
      { $match: { ...shopFilter, state: { $in: ACTIVE_STATES } } },
      { $group: { _id: "$state", count: { $sum: 1 }, oldest: { $min: "$createdAt" } } },
    ]),
    aggregate("webhook_jobs", [
      { $match: { ...shopFilter, createdAt: { $gte: since, $lte: now } } },
      { $project: { shopId: 1, state: 1, retry_count: 1, retry_attempts: 1, kind: 1,
        latency: { $cond: [{ $and: [{ $eq: ["$kind", "webhook"] },
          { $eq: [{ $type: "$received_at" }, "date"] }, { $eq: [{ $type: "$order_persisted_at" }, "date"] }] },
          { $max: [0, { $subtract: ["$order_persisted_at", "$received_at"] }] }, null] } } },
      { $group: { _id: { $ifNull: ["$shopId", "unattributed"] }, jobs: { $sum: 1 },
        jobFailures: { $sum: { $ifNull: ["$retry_count", 0] } },
        retryAttempts: { $sum: { $ifNull: ["$retry_attempts", 0] } },
        legacyRetryJobs: { $sum: { $cond: [{ $eq: [{ $type: "$retry_attempts" }, "missing"] }, 1, 0] } },
        deadLetterJobs: { $sum: { $cond: [{ $eq: ["$state", "dead-letter"] }, 1, 0] } },
        latencySamples: { $sum: { $cond: [{ $ne: ["$latency", null] }, 1, 0] } },
        latencyTotalMs: { $sum: "$latency" }, latencyMaxMs: { $max: "$latency" } } },
      { $sort: { _id: 1 } }, { $limit: 201 },
    ]),
    aggregate("ops_api_errors", [
      { $match: { ...shopFilter, bucket_at: { $gte: errorSince, $lte: now } } },
      { $group: { _id: { shopId: "$shopId", category: "$category" }, count: { $sum: "$count" } } },
      { $sort: { "_id.shopId": 1, "_id.category": 1 } }, { $limit: 801 },
    ]),
  ]);
  const shops = new Map();
  const getShop = (id) => {
    if (!shops.has(id)) shops.set(id, { shopId: id, jobs: 0, jobFailures: 0, retryAttempts: 0,
      legacyRetryJobs: 0, deadLetterJobs: 0, latencySamples: 0, latencyTotalMs: 0, latencyMaxMs: null,
      apiErrors: 0, apiErrorsByCategory: {} });
    return shops.get(id);
  };
  for (const { _id, ...row } of jobs.slice(0, 200)) Object.assign(getShop(_id), row);
  for (const row of errors.slice(0, 800)) {
    const shop = getShop(row._id.shopId);
    shop.apiErrors += row.count;
    shop.apiErrorsByCategory[row._id.category] = row.count;
  }
  const byState = Object.fromEntries(ACTIVE_STATES.map((state) => [state, 0]));
  for (const row of queue) byState[row._id] = row.count;
  const oldest = queue.map((row) => row.oldest).filter((value) => value instanceof Date);
  return { generatedAt: now.toISOString(), window: { since: since.toISOString(), windowMinutes,
    apiErrorSince: errorSince.toISOString(), jobBasis: "createdAt", apiErrorResolutionSeconds: 60 },
    queue: { depth: Object.values(byState).reduce((sum, n) => sum + n, 0), byState,
      oldestAgeMs: oldest.length ? Math.max(0, now - Math.min(...oldest.map(Number))) : null },
    truncated: jobs.length > 200 || errors.length > 800,
    shops: [...shops.values()].map(({ latencyTotalMs, ...shop }) => ({ ...shop,
      webhookToOrderLatencyMs: { samples: shop.latencySamples,
        average: shop.latencySamples ? latencyTotalMs / shop.latencySamples : null, max: shop.latencyMaxMs } })),
  };
}
