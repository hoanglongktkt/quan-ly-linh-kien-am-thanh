import { Router } from "express";
import crypto from "node:crypto";
import mongoose from "mongoose";
import { collectOperationsMetrics, parseMetricsQuery } from "../modules/operations/metrics.js";

export function createOperationsRouter({ getDb = () => mongoose.connection.readyState === 1 ? mongoose.connection.db : null,
  collect = collectOperationsMetrics } = {}) {
  const router = Router();
  const cache = new Map();
  router.get("/metrics", async (req, res) => {
    res.set("Cache-Control", "no-store");
    // Token vận hành riêng; không mở endpoint khi chưa cấu hình đủ mạnh.
    const expected = process.env.OPS_METRICS_TOKEN || "";
    if (expected.length < 32) return res.status(503).json({ error: "ops_metrics_not_configured" });
    const supplied = req.get("authorization")?.replace(/^Bearer /, "") || "";
    const digest = (value) => crypto.createHash("sha256").update(value).digest();
    if (!req.get("authorization")?.startsWith("Bearer ") || !crypto.timingSafeEqual(digest(supplied), digest(expected))) {
      return res.status(401).json({ error: "unauthorized" });
    }
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
    // Chặn truy vấn đồng thời trùng nhau; cache ngắn để giảm tải Atlas.
    if (cache.size >= 64) cache.delete(cache.keys().next().value);
    const value = collect(db, options);
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
