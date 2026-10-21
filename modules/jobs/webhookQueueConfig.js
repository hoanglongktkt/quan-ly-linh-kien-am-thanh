// Keep a single cross-process worker; tune only its bounded pacing.
export function webhookQueueConfig(env = process.env) {
  const bounded = (name, fallback, min, max) => {
    const raw = env[name];
    const value = raw == null || String(raw).trim() === "" ? NaN : Number(raw);
    return Number.isInteger(value) ? Math.max(min, Math.min(max, value)) : fallback;
  };
  return {
    intervalMs: bounded("SHOPEE_WEBHOOK_DRAIN_INTERVAL_MS", 3000, 2000, 30000),
    batchLimit: bounded("SHOPEE_WEBHOOK_BATCH_LIMIT", 8, 1, 10),
    jobGapMs: bounded("SHOPEE_WEBHOOK_JOB_GAP_MS", 150, 100, 2000),
  };
}
