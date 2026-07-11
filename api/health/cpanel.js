/**
 * GET /api/health/cpanel — kiểm tra CPANEL_BACKEND_URL trên Vercel có truy cập được không.
 */
export default async function handler(_req, res) {
  const base = String(process.env.CPANEL_BACKEND_URL || '').replace(/\/$/, '');

  if (!base) {
    return res.status(503).json({
      ok: false,
      error: 'CPANEL_BACKEND_URL chưa được set trên Vercel',
    });
  }

  const started = Date.now();
  try {
    const upstream = await fetch(`${base}/api/health`, {
      method: 'GET',
      signal: AbortSignal.timeout(8000),
    });
    const ms = Date.now() - started;
    const text = await upstream.text();
    return res.status(200).json({
      ok: upstream.ok,
      cpanelBackendUrl: base,
      upstreamStatus: upstream.status,
      latencyMs: ms,
      upstreamBodyPreview: text.slice(0, 200),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return res.status(502).json({
      ok: false,
      cpanelBackendUrl: base,
      error: message,
      latencyMs: Date.now() - started,
    });
  }
}
