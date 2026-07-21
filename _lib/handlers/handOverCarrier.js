/**
 * POST orders/:id/hand-over-carrier | orders/hand-over-carrier | orders/hand-over-carrier/bulk
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

function extractBulkKeys(body) {
  const rawIds = Array.isArray(body?.orderIds)
    ? body.orderIds
    : Array.isArray(body?.ids)
      ? body.ids
      : [];
  const rawSns = Array.isArray(body?.orderSns) ? body.orderSns : [];
  return [
    ...new Set(
      [...rawIds, ...rawSns].map((v) => String(v || '').trim()).filter(Boolean),
    ),
  ];
}

async function lookupOrder(backendUrl, req, orderKey) {
  const lookup = await fetchJson(backendUrl, req, `orders/${encodeURIComponent(orderKey)}`, {
    method: 'GET',
  }).catch(() => null);
  if (lookup?.ok && (lookup.data?.id || lookup.data?.orderSn || lookup.data?.order?.id)) {
    return lookup.data?.order || lookup.data;
  }
  const bySn = await fetchJson(backendUrl, req, 'orders/lookup', {
    method: 'GET',
    query: { code: orderKey },
  }).catch(() => null);
  return (
    bySn?.data?.order ||
    (bySn?.ok && bySn?.data?.id ? bySn.data : null) ||
    null
  );
}

async function patchOrderHandedOver(backendUrl, req, order) {
  const patch = buildHandedOverPatch();
  const patched = await fetchJson(backendUrl, req, `orders/${encodeURIComponent(order.id)}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  });
  if (!patched.ok) {
    const reason = patched.data?.message || patched.data?.error || 'PATCH thất bại';
    return { ok: false, error: reason, status: patched.status || 500 };
  }
  const saved = patched.data?.id ? patched.data : { ...order, ...patch };
  return { ok: true, order: saved };
}

async function handleBulkHandOver(req, res, backend) {
  const keys = extractBulkKeys(req.body || {});
  if (!keys.length) {
    return res.status(400).json({
      success: false,
      error: 'Thiếu danh sách đơn (orderIds / orderSns).',
      message: 'Thiếu danh sách đơn (orderIds / orderSns).',
    });
  }

  try {
    const direct = await fetchJson(backend.url, req, 'orders/hand-over-carrier/bulk', {
      method: 'POST',
      body: JSON.stringify(req.body || { orderIds: keys }),
    });
    if (direct.ok && direct.data?.success !== false) {
      return res.status(200).json({ success: true, ...direct.data });
    }
    const msg = String(direct.data?.message || direct.data?.error || '');
    if (direct.status !== 404 && !msg.includes('API không tồn tại')) {
      return res.status(direct.status || 500).json({
        success: false,
        message: msg || 'hand_over_bulk_failed',
        error: msg || 'hand_over_bulk_failed',
      });
    }
    console.warn('[Hand Over Carrier Bulk] cPanel chưa có route — fallback PATCH từng đơn');
  } catch (directErr) {
    console.warn(
      '[Hand Over Carrier Bulk] direct proxy failed, fallback:',
      directErr?.message || directErr,
    );
  }

  const updated = [];
  const failed = [];
  let skipped = 0;

  for (const key of keys) {
    try {
      const order = await lookupOrder(backend.url, req, key);
      if (!order?.id) {
        failed.push({ key, error: 'Không tìm thấy đơn hàng.' });
        continue;
      }
      const already =
        String(order.local_status || order.localStatus || '').toUpperCase() === 'HANDED_OVER' ||
        Boolean(order.isHandedOverToCarrier || order.is_handed_over_to_carrier);
      if (already) {
        skipped++;
        updated.push(order);
        continue;
      }
      const patched = await patchOrderHandedOver(backend.url, req, order);
      if (!patched.ok) {
        failed.push({ key, error: patched.error });
        continue;
      }
      updated.push(patched.order);
    } catch (err) {
      failed.push({ key, error: err?.message || 'patch_failed' });
    }
  }

  console.log(
    `[Hand Over Carrier Bulk] fallback keys=${keys.length} updated=${updated.length} skipped=${skipped} failed=${failed.length}`,
  );
  return res.status(200).json({
    success: true,
    updated: Math.max(0, updated.length - skipped),
    skipped,
    failed,
    orders: updated,
  });
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

    const pathId = String(orderIdFromPath || '').trim();
    if (pathId === 'bulk') {
      return handleBulkHandOver(req, res, backend);
    }

    const orderKey = resolveOrderKey(req, pathId);
    const code = String(req.body?.code || req.body?.scanCode || req.body?.q || '').trim();

    if (!orderKey && !code) {
      return res.status(400).json({
        success: false,
        error: 'Thiếu orderId hoặc mã quét (code).',
        message: 'Thiếu orderId hoặc mã quét (code).',
      });
    }

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

    let order = null;
    if (orderKey) {
      order = await lookupOrder(backend.url, req, orderKey);
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

    const patched = await patchOrderHandedOver(backend.url, req, order);
    if (!patched.ok) {
      return res.status(patched.status || 500).json({
        success: false,
        error: patched.error,
        message: patched.error,
      });
    }

    console.log(
      `[Hand Over Carrier] fallback PATCH đơn ${patched.order.orderSn || patched.order.id} → HANDED_OVER`,
    );
    return res.status(200).json({ success: true, order: patched.order });
  } catch (err) {
    console.error('[Hand Over Carrier]', err);
    return res.status(500).json({
      success: false,
      message: err?.message || 'Không thể ghi nhận bàn giao ĐVVC.',
      error: err?.message || 'hand_over_failed',
    });
  }
}
