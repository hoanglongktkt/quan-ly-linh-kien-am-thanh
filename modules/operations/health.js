import crypto from "node:crypto";
import { collectOperationsMetrics } from "./metrics.js";

const STATE_ID = "shopee_oms";
const DB_OPTIONS = { maxTimeMS: 1500, timeoutMS: 2000 };

export function healthThresholds(env = process.env) {
  // Cấu hình sai dùng mặc định; 0 chỉ được dùng để tắt cảnh báo thiếu webhook.
  const minutes = (name, fallback, min = 1) => {
    const value = Number(env[name] ?? fallback);
    return Number.isInteger(value) && value >= min && value <= 1440 ? value * 60000 : fallback * 60000;
  };
  return { sampleIntervalMs: 60000, queueStallMs: minutes("OPS_QUEUE_STALL_MINUTES", 5),
    tokenWarningMs: minutes("OPS_TOKEN_WARNING_MINUTES", 30),
    watermarkStallMs: minutes("OPS_WATERMARK_STALL_MINUTES", 30),
    webhookExpectedMs: minutes("OPS_WEBHOOK_EXPECTED_MINUTES", 60, 0) };
}

function timestamp(value) {
  const time = value ? new Date(value).getTime() : 0;
  return Number.isFinite(time) && time > 0 ? time : 0;
}

export function evaluateOperationsHealth(metrics, tokens = {}, previous = {}, now = new Date(), thresholds = healthThresholds()) {
  const time = now.getTime();
  const alerts = [];
  const alert = (code, severity, message, shopId) => alerts.push({ code, severity, message, ...(shopId ? { shopId } : {}) });
  const progress = Math.max(timestamp(metrics.summary?.lastJobSucceededAt), timestamp(previous.lastProgressAt));
  const contiguous = previous.checkedAt && time - timestamp(previous.checkedAt) <= thresholds.sampleIntervalMs * 3;
  const advancing = progress > timestamp(previous.lastProgressAt);
  // Không kết luận queue tăng liên tục khi bỏ lỡ nhiều lượt kiểm tra.
  const growthSamples = contiguous && !advancing && metrics.queue.depth > (previous.queueDepth ?? 0)
    ? (previous.growthSamples || 0) + 1 : 0;
  const noProgressSince = metrics.queue.depth === 0 || advancing || !contiguous
    ? time : timestamp(previous.noProgressSince) || time;
  if (metrics.queue.depth > 0 && time - noProgressSince >= thresholds.queueStallMs) {
    alert("queue_stalled", "critical", "Hàng đợi còn job nhưng không có job hoàn tất trong thời gian cho phép.");
  }
  if (growthSamples >= 3) alert("queue_growing", "critical", "Hàng đợi tăng qua ít nhất 3 khoảng kiểm tra liên tiếp và không có job hoàn tất.");
  if (metrics.truncated) alert("metrics_incomplete", "warning", "Số liệu vượt giới hạn nhóm; cần kiểm tra riêng từng shop.");

  const metricShops = new Map(metrics.shops.map((shop) => [shop.shopId, shop]));
  const shopIds = [...new Set([...Object.keys(tokens), ...metricShops.keys()])].filter((id) => /^\d{1,20}$/.test(id));
  if (shopIds.length > 200) alert("shops_truncated", "warning", "Chỉ kiểm tra sức khỏe tối đa 200 shop.");
  const shops = [];
  const shopState = {};
  for (const shopId of shopIds.slice(0, 200)) {
    const token = tokens[shopId] || {};
    const metric = metricShops.get(shopId) || {};
    const old = previous.shops?.[shopId] || {};
    const monitoredSince = timestamp(old.monitoredSince) || time;
    const lastWebhookAt = Math.max(timestamp(metric.lastWebhookAt), timestamp(old.lastWebhookAt));
    const lastSyncAt = timestamp(metric.lastSuccessfulSyncAt);
    const obtainedAt = Number(token.obtained_at);
    const expireIn = Number(token.expire_in);
    const rawExpiry = obtainedAt > 0 && expireIn > 0 ? (obtainedAt + expireIn) * 1000 : 0;
    const expiresAt = Number.isFinite(rawExpiry) && rawExpiry <= 8640000000000000 ? rawExpiry : 0;
    // Chỉ trả boolean và thời hạn; tuyệt đối không lưu/đưa token ra API hoặc log.
    const configured = Object.hasOwn(tokens, shopId);
    if (configured) {
      if (!token.access_token) alert("token_missing", "critical", "Shop thiếu access token; kiểm tra kết nối OAuth.", shopId);
      else if (!Number.isFinite(expiresAt) || !expiresAt) alert("token_expiry_unknown", "warning", "Thiếu mốc hết hạn token để kiểm tra.", shopId);
      else if (expiresAt <= time) alert("token_expired", "critical", "Access token đã hết hạn; kiểm tra cơ chế refresh hoặc OAuth lại.", shopId);
      else if (expiresAt - time <= thresholds.tokenWarningMs) alert("token_expiring", "warning", "Access token sắp hết hạn; kiểm tra refresh tự động.", shopId);
      if (time - (lastSyncAt || monitoredSince) >= thresholds.watermarkStallMs) {
        alert(lastSyncAt ? "watermark_stalled" : "watermark_missing", "warning", "Chưa có mốc đồng bộ thành công mới trong thời gian cho phép.", shopId);
      }
      if (thresholds.webhookExpectedMs > 0 && time - (lastWebhookAt || monitoredSince) >= thresholds.webhookExpectedMs) {
        alert("webhook_silent", "warning", "Không nhận webhook đơn hàng trong khoảng thời gian kỳ vọng.", shopId);
      }
    }
    const iso = (value) => value && Number.isFinite(value) ? new Date(value).toISOString() : null;
    shops.push({ shopId, lastSuccessfulSyncAt: iso(lastSyncAt), lastWebhookAt: iso(lastWebhookAt),
      accessTokenExpiresAt: iso(expiresAt), hasRefreshToken: Boolean(token.refresh_token), configured });
    shopState[shopId] = { monitoredSince: iso(monitoredSince), lastWebhookAt: iso(lastWebhookAt) };
  }
  const status = alerts.some((item) => item.severity === "critical") ? "critical" : alerts.length ? "warning" : "ok";
  return { report: { status, checkedAt: now.toISOString(), thresholds, queue: metrics.queue, alerts, shops },
    state: { checkedAt: now.toISOString(), queueDepth: metrics.queue.depth, growthSamples,
      lastProgressAt: progress ? new Date(progress).toISOString() : null,
      noProgressSince: new Date(noProgressSince).toISOString(), shops: shopState } };
}

export function createOperationsHealthCollector({ getTokens = () => ({}), collect = collectOperationsMetrics,
  getThresholds = healthThresholds, clock = () => new Date() } = {}) {
  return async (db) => {
    const now = clock();
    const thresholds = getThresholds();
    const collection = db.collection("ops_health_state");
    let previous = await collection.findOne({ _id: STATE_ID }, DB_OPTIONS);
    if (!previous) {
      try {
        // _id duy nhất là đủ; không cần thêm index cho collection giám sát nhỏ.
        await collection.updateOne({ _id: STATE_ID }, { $setOnInsert: { nextCheckAt: new Date(0) } }, { ...DB_OPTIONS, upsert: true });
      } catch (error) { if (error?.code !== 11000) throw error; }
      previous = await collection.findOne({ _id: STATE_ID }, DB_OPTIONS);
    }
    const owner = crypto.randomUUID();
    const claim = await collection.findOneAndUpdate({ _id: STATE_ID, nextCheckAt: { $lte: now } },
      { $set: { owner, nextCheckAt: new Date(now.getTime() + thresholds.sampleIntervalMs) } },
      { ...DB_OPTIONS, returnDocument: "after", includeResultMetadata: false });
    if (!claim) {
      if (!previous?.report) throw new Error("health_sample_pending");
      return { ...previous.report, cached: true,
        stale: now.getTime() - timestamp(previous.report.checkedAt) > thresholds.sampleIntervalMs * 2 };
    }
    try {
      const windowMinutes = Math.max(60, thresholds.webhookExpectedMs / 60000);
      // Health không cần aggregate log API; giảm tải cho collection ghi lỗi liên tục.
      const metrics = await collect(db, { windowMinutes, includeApiErrors: false }, now);
      const result = evaluateOperationsHealth(metrics, getTokens(), previous?.state, now, thresholds);
      await collection.updateOne({ _id: STATE_ID, owner }, { $set: { state: result.state, report: result.report } }, DB_OPTIONS);
      // Chỉ log khi cảnh báo thay đổi; không in token hoặc lỗi DB chứa URI.
      const fingerprint = (report) => JSON.stringify((report?.alerts || []).map(({ code, shopId }) => [code, shopId]));
      if (fingerprint(result.report) !== fingerprint(previous?.report)) {
        console.warn("[OMS Health]", result.report.status, fingerprint(result.report));
      }
      return { ...result.report, cached: false, stale: false };
    } catch {
      // Đánh dấu không đo được; không trả lại kết quả khỏe cũ như một kết quả mới.
      const report = { status: "unknown", checkedAt: now.toISOString(),
        alerts: [{ code: "health_collection_failed", severity: "warning", message: "Không đọc được số liệu giám sát; kiểm tra MongoDB và log vận hành." }], shops: [] };
      await collection.updateOne({ _id: STATE_ID, owner }, { $set: { report } }, DB_OPTIONS).catch(() => {});
      throw new Error("health_unavailable");
    }
  };
}

export function startOperationsHealthMonitor(getDb, collectHealth) {
  let running = false;
  const tick = async () => {
    if (running) return;
    const db = getDb();
    if (!db) return;
    running = true;
    try { await collectHealth(db); }
    catch { console.warn("[OMS Health] health_sample_unavailable"); }
    finally { running = false; }
  };
  // Một mẫu/phút cho toàn bộ Passenger; timer không giữ process sống khi app dừng.
  const timer = setInterval(() => { void tick(); }, 60000);
  timer.unref?.();
  void tick();
  return () => clearInterval(timer);
}
