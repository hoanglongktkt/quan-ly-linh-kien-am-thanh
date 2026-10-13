import { Router } from "express";
import crypto from "node:crypto";
import mongoose from "mongoose";
import { collectOperationsMetrics, parseMetricsQuery } from "../modules/operations/metrics.js";
import { createOperationsHealthCollector, startOperationsHealthMonitor } from "../modules/operations/health.js";
import { loadShopeeTokens } from "../services/shopee/auth.js";

const getOperationsDb = () => mongoose.connection.readyState === 1 ? mongoose.connection.db : null;
const defaultHealthCollector = createOperationsHealthCollector({ getTokens: loadShopeeTokens });
export const startDefaultOperationsHealthMonitor = () => startOperationsHealthMonitor(getOperationsDb, defaultHealthCollector);

export function createOperationsRouter({ getDb = () => mongoose.connection.readyState === 1 ? mongoose.connection.db : null,
  collect = collectOperationsMetrics, collectHealth = defaultHealthCollector } = {}) {
  const router = Router();
  const cache = new Map();
  let activeQueries = 0;
  router.use((req, res, next) => {
    res.set("Cache-Control", "no-store");
    // Token vận hành riêng; không mở endpoint khi chưa cấu hình đủ mạnh.
    const expected = process.env.OPS_METRICS_TOKEN || "";
    if (expected.length < 32) return res.status(503).json({ error: "ops_metrics_not_configured" });
    const supplied = req.get("authorization")?.replace(/^Bearer /, "") || "";
    const digest = (value) => crypto.createHash("sha256").update(value).digest();
    if (!req.get("authorization")?.startsWith("Bearer ") || !crypto.timingSafeEqual(digest(supplied), digest(expected))) {
      return res.status(401).json({ error: "unauthorized" });
    }
    return next();
  });
  router.get("/health", async (req, res) => {
    // Health luôn đo toàn hệ thống; tùy chọn shop chỉ lọc kết quả đã đo.
    if (Object.keys(req.query).some((key) => key !== "shopId")) return res.status(400).json({ error: "invalid_query" });
    let options;
    try { options = parseMetricsQuery(req.query); }
    catch { return res.status(400).json({ error: "invalid_query" }); }
    const db = getDb();
    if (!db) return res.status(503).json({ error: "mongodb_not_ready" });
    try {
      const report = await collectHealth(db);
      const alerts = report.alerts.filter((item) => !options.shopId || !item.shopId || item.shopId === options.shopId);
      const status = report.stale || report.status === "unknown" ? "unknown"
        : alerts.some((item) => item.severity === "critical") ? "critical" : alerts.length ? "warning" : "ok";
      return res.status(status === "critical" || status === "unknown" ? 503 : 200).json({ ...report, status, alerts,
        shops: report.shops.filter((shop) => !options.shopId || shop.shopId === options.shopId), queueScope: "all_shops" });
    } catch {
      return res.status(503).json({ status: "unknown", error: "health_unavailable" });
    }
  });
  router.get("/metrics", async (req, res) => {
    let options;
    try { options = parseMetricsQuery(req.query); }
    catch { return res.status(400).json({ error: "invalid_query", message: "shopId: 1–20 chữ số; windowMinutes: 1–1440" }); }
    const db = getDb();
    if (!db) return res.status(503).json({ error: "mongodb_not_ready" });
    const key = JSON.stringify(options);
    const hit = cache.get(key);
    if (hit && hit.until > Date.now()) {
      try { return res.json({ ...await hit.value, cached: true }); }
      catch { return res.status(503).json({ error: "metrics_unavailable" }); }
    }
    // Cửa sổ/shop khác nhau cũng dùng chung giới hạn; tránh ồ ạt scan Mongo.
    if (activeQueries >= 2) return res.status(429).set("Retry-After", "15").json({ error: "metrics_busy" });
    // Chặn truy vấn đồng thời trùng nhau; cache ngắn để giảm tải Atlas.
    if (cache.size >= 64) cache.delete(cache.keys().next().value);
    activeQueries += 1;
    const value = Promise.resolve().then(() => collect(db, options)).finally(() => { activeQueries -= 1; });
    cache.set(key, { value, until: Date.now() + 15000 });
    try { return res.json({ ...await value, cached: false }); }
    catch {
      cache.delete(key);
      console.warn("[Operations] metrics_query_failed");
      return res.status(503).json({ error: "metrics_unavailable" });
    }
  });
  return router;
}

export default createOperationsRouter();
