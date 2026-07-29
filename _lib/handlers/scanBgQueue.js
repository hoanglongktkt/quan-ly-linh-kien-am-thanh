/**
 * POST/GET orders/scan-bg-* — proxy cPanel (worker chạy trên backend thật).
 */
import { buildCpanelTarget, resolveProxyTimeoutMs } from '../cpanelProxy.js';
import { resolveCpanelBackend } from '../cpanelBackend.js';
import { fetchWithDiagnostics } from '../fetchDiagnostics.js';

async function proxy(req, res, pathPart, method) {
  const auth = req.headers?.authorization || req.headers?.Authorization || '';
  if (!auth) {
    return res.status(401).json({ success: false, message: 'Unauthorized' });
  }
  const backend = resolveCpanelBackend();
  if (!backend.ok) {
    return res.status(503).json({ success: false, message: backend.error });
  }

  const timeoutMs = resolveProxyTimeoutMs(pathPart);
  const target = buildCpanelTarget(backend.url, pathPart, method === 'GET' ? req.query || {} : {});
  const result = await fetchWithDiagnostics(
    '[Scan BG]',
    target,
    {
      method,
      headers: {
        Authorization: auth,
        'Content-Type': 'application/json',
      },
      body: method === 'GET' ? undefined : JSON.stringify(req.body || {}),
    },
    timeoutMs,
  );

  if (!result.ok) {
    return res.status(502).json({
      success: false,
      message: result.error?.message || 'Không kết nối được backend cPanel.',
    });
  }

  const text = await result.upstream.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    return res.status(502).json({ success: false, message: 'Backend trả phản hồi không hợp lệ.' });
  }
  return res.status(result.upstream.status || 200).json(data);
}

export async function handleScanBgEnqueue(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, message: 'Method Not Allowed' });
  }
  return proxy(req, res, 'orders/scan-bg-enqueue', 'POST');
}

export async function handleScanBgStatus(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ success: false, message: 'Method Not Allowed' });
  }
  return proxy(req, res, 'orders/scan-bg-status', 'GET');
}

export async function handleScanBgAck(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, message: 'Method Not Allowed' });
  }
  return proxy(req, res, 'orders/scan-bg-ack', 'POST');
}
