import dns from 'node:dns/promises';
import { resolveCpanelBackend } from '../cpanelBackend.js';
import { fetchWithDiagnostics, serializeFetchError } from '../fetchDiagnostics.js';

const HEALTH_PATHS = ['/api/health', '/'];

function hintForDns(code) {
  if (code === 'ENOTFOUND' || code === 'ENODATA') {
    return 'Subdomain chưa tồn tại trên DNS. Tạo A record api.linhkienamthanh.net → IP cPanel (cùng IP hosting quanly).';
  }
  return null;
}

async function resolveDns(hostname) {
  const [a, aaaa] = await Promise.allSettled([
    dns.resolve4(hostname),
    dns.resolve6(hostname),
  ]);
  const ipv4 = a.status === 'fulfilled' ? a.value : [];
  const ipv6 = aaaa.status === 'fulfilled' ? aaaa.value : [];

  if (ipv4.length === 0 && ipv6.length === 0) {
    const err =
      a.status === 'rejected'
        ? a.reason
        : aaaa.status === 'rejected'
          ? aaaa.reason
          : new Error('ENODATA');
    const diag = serializeFetchError(err);
    return {
      ok: false,
      ipv4: [],
      ipv6: [],
      error: diag.code || 'ENOTFOUND',
      hint: hintForDns(diag.code) || diag.hint,
    };
  }

  return { ok: true, ipv4, ipv6, error: null };
}

async function probeUrl(label, url, timeoutMs) {
  const result = await fetchWithDiagnostics(label, url, {
    method: 'GET',
    headers: { Accept: 'application/json, text/plain, */*' },
    redirect: 'follow',
  }, timeoutMs);

  if (!result.ok) {
    return {
      url,
      success: false,
      latencyMs: result.latencyMs,
      error: result.error,
    };
  }

  const upstream = result.upstream;
  const text = await upstream.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }

  const healthOk = upstream.ok && (parsed?.ok === true || upstream.status === 200);
  return {
    url,
    success: healthOk,
    httpStatus: upstream.status,
    latencyMs: result.latencyMs,
    bodyPreview: parsed ?? text.slice(0, 200),
    error: healthOk ? null : {
      message: `HTTP ${upstream.status}`,
      hint: upstream.status >= 500
        ? 'Server cPanel lỗi 5xx — restart Node.js App / Passenger.'
        : 'Endpoint không trả JSON health — kiểm tra server.cjs đã deploy.',
    },
  };
}

function buildFailureMessage(baseUrl, hostname, dnsResult, fetchError) {
  if (fetchError?.code === 'ENOTFOUND' || dnsResult?.error === 'ENOTFOUND') {
    return `${hostname} chưa có DNS — thêm A record trỏ IP cPanel (Zone Editor).`;
  }
  if (fetchError?.code === 'ECONNREFUSED') {
    return `DNS OK (${dnsResult.ipv4?.join(', ') || 'N/A'}) nhưng cổng 443 không mở — start Node.js App trên cPanel.`;
  }
  if (fetchError?.hint) return fetchError.hint;
  if (fetchError?.message) return `Không kết nối được ${baseUrl}: ${fetchError.message}`;
  return `Không kết nối được ${baseUrl} — xem probes và Vercel Logs.`;
}

export async function handleHealthCpanel(_req, res) {
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

  const hostname = backend.hostname;
  const started = Date.now();
  console.log('[Health cPanel] Start', JSON.stringify({ backendUrl: backend.url, hostname }));

  const dnsResult = await resolveDns(hostname);
  if (!dnsResult.ok) {
    const payload = {
      ok: false,
      connected: false,
      cpanelBackendUrl: backend.url,
      hostname,
      dns: dnsResult,
      errorCode: dnsResult.error,
      hint: dnsResult.hint,
      latencyMs: Date.now() - started,
      checkedAt: new Date().toISOString(),
      message: `DNS không resolve được ${hostname} (${dnsResult.error}). Tạo A record trên cPanel trước.`,
    };
    console.error('[Health cPanel]', JSON.stringify(payload));
    return res.status(502).json(payload);
  }

  const probes = [];
  for (const path of HEALTH_PATHS) {
    const url = `${backend.url}${path}`;
    const probe = await probeUrl('[Health cPanel]', url, path === '/api/health' ? 12000 : 8000);
    probes.push(probe);
    if (probe.success) break;
  }

  const best = probes.find((p) => p.success) || probes[0];
  const connected = Boolean(best?.success);
  const fetchError = best?.error;

  const payload = {
    ok: connected,
    connected,
    cpanelBackendUrl: backend.url,
    hostname,
    dns: dnsResult,
    probes,
    upstreamStatus: best?.httpStatus ?? null,
    latencyMs: Date.now() - started,
    error: fetchError?.message ?? null,
    errorCode: fetchError?.code ?? null,
    hint: fetchError?.hint ?? null,
    causeMessage: fetchError?.causeMessage ?? null,
    checkedAt: new Date().toISOString(),
    message: connected
      ? `Kết nối cPanel OK qua ${best.url} (${best.latencyMs}ms)`
      : buildFailureMessage(backend.url, hostname, dnsResult, fetchError),
  };

  console.log('[Health cPanel]', JSON.stringify(payload));
  return res.status(connected ? 200 : 502).json(payload);
}
