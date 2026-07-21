/**
 * POST orders/:id/hand-over-carrier | orders/hand-over-carrier
 * Ghi nhận bàn giao ĐVVC (local_status = HANDED_OVER).
 * Ưu tiên proxy cPanel; fallback PATCH local_status nếu route cũ 404.
 */
import { buildCpanelTarget } from '../cpanelProxy.js';
import { resolveCpanelBackend } from '../cpanelBackend.js';
import { fetchWithDiagnostics } from '../fetchDiagnostics.js';

function buildHandedOverPatch() {
  const now = new Date().toISOString();
  return {
    local_status: 'HANDED_OVER',
    localStatus: 'HANDED_OVER',
    localStatusAt: now,
    local_status_updated_at: now,
    isHandedOverToCarrier: true,
    is_handed_over_to_carrier: true,
    handedOverAt: now,
  };
}

async function fetchJson(backendUrl, req, pathPart, init = {}, timeoutMs = 60000) {
  const target = buildCpanelTarget(backendUrl, pathPart, init.query || {});
  const headers = {
    Authorization: req.headers?.authorization || req.headers?.Authorization || '',
    'Content-Type': 'application/json',
    ...(init.headers || {}),
  };

  const result = await fetchWithDiagnostics('[Hand Over Carrier]', target, {
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

function resolveOrderKey(req, orderIdFromPath) {
  const body = req.body || {};
  return String(
    orderIdFromPath ||
      body.orderId ||
      body.id ||
      body.order_sn ||
      body.orderSn ||
      '',
  ).trim();
}

export async function handleHandOverCarrier(req, res, orderIdFromPath = '') {
  if (req.method !== 'POST' && req.method !== 'PUT' && req.method !== 'PATCH') {
    return res.status(405).json({ success: false, message: 'Method Not Allowed' });
  }

  const auth = req.headers?.authorization || req.headers?.Authorization || '';
  if (!auth) {
    return res.status(401).json({ success: false, message: 'Unauthorized' });
  }

  try {
    const backend = resolveCpanelBackend();
    if (!backend.ok) {
      return res.status(503).json({ success: false, message: backend.error });
    }

    const orderKey = resolveOrderKey(req, orderIdFromPath);
    const code = String(req.body?.code || req.body?.scanCode || req.body?.q || '').trim();

    if (!orderKey && !code) {
      return res.status(400).json({
        success: false,
        error: 'Thiếu orderId hoặc mã quét (code).',
        message: 'Thiếu orderId hoặc mã quét (code).',
      });
    }

    // 1) Proxy native cPanel hand-over endpoint.
    try {
      const pathPart = orderKey
        ? `orders/${encodeURIComponent(orderKey)}/hand-over-carrier`
        : 'orders/hand-over-carrier';
      const direct = await fetchJson(backend.url, req, pathPart, {
        method: 'POST',
        body: JSON.stringify(req.body || { orderId: orderKey, code }),
      });
      if (direct.ok && direct.data?.success !== false) {
        return res.status(200).json({
          success: true,
          order: direct.data?.order || direct.data,
          ...direct.data,
        });
      }
      const msg = String(direct.data?.message || direct.data?.error || '');
      if (direct.status !== 404 && !msg.includes('API không tồn tại')) {
        return res.status(direct.status || 500).json({
          success: false,
          message: msg || 'hand_over_carrier_failed',
          error: msg || 'hand_over_carrier_failed',
        });
      }
      console.warn('[Hand Over Carrier] cPanel chưa có route — fallback PATCH');
    } catch (directErr) {
      console.warn('[Hand Over Carrier] direct proxy failed, fallback:', directErr?.message || directErr);
    }

    // 2) Fallback: resolve order + PATCH local_status = HANDED_OVER.
    let order = null;
    if (orderKey) {
      const lookup = await fetchJson(backend.url, req, `orders/${encodeURIComponent(orderKey)}`, {
        method: 'GET',
      }).catch(() => null);
      if (lookup?.ok && (lookup.data?.id || lookup.data?.orderSn)) {
        order = lookup.data?.order || lookup.data;
      }
      if (!order) {
        const bySn = await fetchJson(backend.url, req, 'orders/lookup', {
          method: 'GET',
          query: { code: orderKey },
        }).catch(() => null);
        order =
          bySn?.data?.order ||
          (bySn?.ok && bySn?.data?.id ? bySn.data : null) ||
          null;
      }
    } else if (code) {
      const byCode = await fetchJson(backend.url, req, 'orders/lookup', {
        method: 'GET',
        query: { code },
      });
      order =
        byCode.data?.order ||
        (byCode.ok && byCode.data?.id ? byCode.data : null) ||
        null;
    }

    if (!order?.id) {
      return res.status(404).json({
        success: false,
        error: 'Không tìm thấy đơn hàng.',
        message: 'Không tìm thấy đơn hàng.',
      });
    }

    const already =
      String(order.local_status || order.localStatus || '').toUpperCase() === 'HANDED_OVER' ||
      Boolean(order.isHandedOverToCarrier || order.is_handed_over_to_carrier);
    if (already) {
      return res.status(200).json({ success: true, order });
    }

    const patch = buildHandedOverPatch();
    const patched = await fetchJson(backend.url, req, `orders/${encodeURIComponent(order.id)}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    });

    if (!patched.ok) {
      const reason = patched.data?.message || patched.data?.error || 'PATCH thất bại';
      return res.status(patched.status || 500).json({
        success: false,
        error: reason,
        message: reason,
      });
    }

    const saved = patched.data?.id ? patched.data : { ...order, ...patch };
    console.log(`[Hand Over Carrier] fallback PATCH đơn ${saved.orderSn || saved.id} → HANDED_OVER`);
    return res.status(200).json({ success: true, order: saved });
  } catch (err) {
    console.error('[Hand Over Carrier]', err);
    return res.status(500).json({
      success: false,
      message: err?.message || 'Không thể ghi nhận bàn giao ĐVVC.',
      error: err?.message || 'hand_over_failed',
    });
  }
}
