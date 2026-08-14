/**
 * POST orders/:id/confirm-return-received | orders/confirm-return-received
 * Nút [Xác nhận đã nhận hoàn] — ghi cờ kho RETURN_RECEIVED.
 * Ưu tiên proxy cPanel; fallback PATCH /orders/:id.
 */
import { buildCpanelTarget } from '../cpanelProxy.js';
import { resolveCpanelBackend } from '../cpanelBackend.js';
import { fetchWithDiagnostics } from '../fetchDiagnostics.js';

function buildReturnReceivedPatch() {
  const now = new Date().toISOString();
  return {
    local_status: 'RETURN_RECEIVED',
    localStatus: 'RETURN_RECEIVED',
    internal_status: 'RETURN_RECEIVED',
    scanFlag: 'RETURN_RECEIVED',
    localStatusAt: now,
    local_status_updated_at: now,
    is_local_return_archived: false,
    is_handed_over: false,
    isHandedOverToCarrier: false,
    is_handed_over_to_carrier: false,
    is_handed_over_to_courier: false,
    status: 'return_received',
  };
}

async function fetchJson(backendUrl, req, pathPart, init = {}, timeoutMs = 30000) {
  const target = buildCpanelTarget(backendUrl, pathPart, init.query || {});
  const headers = {
    Authorization: req.headers?.authorization || req.headers?.Authorization || '',
    'Content-Type': 'application/json',
    ...(init.headers || {}),
  };

  const result = await fetchWithDiagnostics('[Confirm Return Received]', target, {
    method: init.method || 'GET',
    headers,
    body: init.body,
  }, timeoutMs);

  if (!result.ok) {
    throw new Error(result.error?.message || 'Không kết nối được backend cPanel.');
  }

  const text = await result.upstream.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`Backend trả phản hồi không hợp lệ cho ${pathPart}.`);
  }

  return { ok: result.upstream.ok, status: result.upstream.status, data };
}

export async function handleConfirmReturnReceived(req, res, orderIdFromPath) {
  const backend = await resolveCpanelBackend();
  if (!backend?.url) {
    return res.status(503).json({
      success: false,
      error: 'cpanel_unavailable',
      message: 'Không kết nối được backend cPanel.',
    });
  }

  const body = req.body || {};
  const key = String(
    orderIdFromPath ||
      body.orderId ||
      body.id ||
      body.orderSn ||
      body.order_sn ||
      '',
  ).trim();
  if (!key) {
    return res.status(400).json({
      success: false,
      error: 'missing_order_id',
      message: 'Thiếu orderId hoặc orderSn.',
    });
  }

  const payload = JSON.stringify({
    ...body,
    orderId: body.orderId || key,
    orderSn: body.orderSn || body.order_sn || key.replace(/^shopee-/i, ''),
    local_status: 'RETURN_RECEIVED',
  });

  try {
    const direct = await fetchJson(
      backend.url,
      req,
      `orders/${encodeURIComponent(key)}/confirm-return-received`,
      { method: 'POST', body: payload },
    );
    if (direct.ok) {
      return res.status(200).json(direct.data);
    }
  } catch (err) {
    console.warn('[Confirm Return Received] dedicated route:', err?.message || err);
  }

  try {
    const fallback = await fetchJson(
      backend.url,
      req,
      'orders/confirm-return-received',
      { method: 'POST', body: payload },
    );
    if (fallback.ok) {
      return res.status(200).json(fallback.data);
    }
  } catch (err) {
    console.warn('[Confirm Return Received] body route:', err?.message || err);
  }

  try {
    const patched = await fetchJson(
      backend.url,
      req,
      `orders/${encodeURIComponent(key)}`,
      { method: 'PATCH', body: JSON.stringify(buildReturnReceivedPatch()) },
    );
    if (!patched.ok) {
      return res.status(patched.status || 502).json({
        success: false,
        error: 'confirm_return_failed',
        message: patched.data?.message || 'Không xác nhận được nhận hàng hoàn.',
      });
    }
    return res.status(200).json({
      success: true,
      local_status: 'RETURN_RECEIVED',
      order: patched.data,
    });
  } catch (patchErr) {
    return res.status(502).json({
      success: false,
      error: 'confirm_return_failed',
      message: patchErr?.message || 'Không xác nhận được nhận hàng hoàn.',
    });
  }
}
