/**
 * GET /api/health/cpanel — ping thực tế backend cPanel từ Vercel.
 */
import { resolveCpanelBackend } from '../lib/cpanelBackend.js';

export default async function handler(_req, res) {
  const backend = resolveCpanelBackend();

  if (!backend.ok) {
    return res.status(503).json({
      ok: false,
      connected: false,
      error: backend.error,
      cpanelBackendUrl: null,
      checkedAt: new Date().toISOString(),
    });
  }

  const target = `${backend.url}/api/health`;
  const started = Date.now();
  console.log('[Health cPanel] Ping →', target);

  try {
    const upstream = await fetch(target, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(10000),
    });
    const ms = Date.now() - started;
    const text = await upstream.text();
    let parsed = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = null;
    }

    const connected = upstream.ok && parsed?.ok === true;
    const payload = {
      ok: connected,
      connected,
      cpanelBackendUrl: backend.url,
      upstreamStatus: upstream.status,
      latencyMs: ms,
      upstreamBody: parsed ?? text.slice(0, 300),
      checkedAt: new Date().toISOString(),
      message: connected
        ? `Kết nối cPanel OK (${ms}ms)`
        : `Backend phản hồi HTTP ${upstream.status} — kiểm tra Node/Passenger trên cPanel`,
    };

    console.log('[Health cPanel]', JSON.stringify(payload));
    return res.status(connected ? 200 : 502).json(payload);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const payload = {
      ok: false,
      connected: false,
      cpanelBackendUrl: backend.url,
      error: message,
      latencyMs: Date.now() - started,
      checkedAt: new Date().toISOString(),
      message: `Không kết nối được ${backend.url}: ${message}`,
    };
    console.error('[Health cPanel]', JSON.stringify(payload));
    return res.status(502).json(payload);
  }
}
