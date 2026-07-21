/**
 * POST orders/:id/hand-over-carrier | orders/hand-over-carrier | orders/hand-over-carrier/bulk
 * Ghi nhận bàn giao ĐVVC (local_status = HANDED_OVER).
 * Ưu tiên proxy cPanel; fallback gọi hand-over từng đơn (không GET /orders/:id — route không tồn tại).
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
  const primary = rawIds.length ? rawIds : rawSns;
  return [...new Set(primary.map((v) => String(v || '').trim()).filter(Boolean))];
}

async function handOverOneOnCpanel(backendUrl, req, key) {
  // 1) POST orders/:id/hand-over-carrier
  try {
    const byPath = await fetchJson(
      backendUrl,
      req,
      `orders/${encodeURIComponent(key)}/hand-over-carrier`,
      {
        method: 'POST',
        body: JSON.stringify({ orderId: key, orderSn: key }),
      },
    );
    if (byPath.ok && byPath.data?.success !== false) {
      return { ok: true, order: byPath.data?.order || byPath.data, skipped: false };
    }
    if (byPath.status !== 404) {
      return {
        ok: false,
        error: byPath.data?.message || byPath.data?.error || `HTTP ${byPath.status}`,
      };
    }
  } catch {
    /* fallback */
  }

  // 2) POST orders/hand-over-carrier body
  try {
    const byBody = await fetchJson(backendUrl, req, 'orders/hand-over-carrier', {
      method: 'POST',
      body: JSON.stringify({ orderId: key, orderSn: key }),
    });
    if (byBody.ok && byBody.data?.success !== false) {
      return { ok: true, order: byBody.data?.order || byBody.data, skipped: false };
    }
    if (byBody.status !== 404) {
      return {
        ok: false,
        error: byBody.data?.message || byBody.data?.error || `HTTP ${byBody.status}`,
      };
    }
  } catch {
    /* fallback */
  }

  // 3) Lookup + PATCH local_status (cùng nguồn Tab đọc sau F5)
  let order = null;
  try {
    const bySn = await fetchJson(backendUrl, req, 'orders/lookup', {
      method: 'GET',
      query: { code: key },
    });
    order =
      bySn?.data?.order ||
      (bySn?.ok && bySn?.data?.id ? bySn.data : null) ||
      null;
  } catch {
    order = null;
  }

  if (!order?.id) {
    return { ok: false, error: 'Không tìm thấy đơn hàng.' };
  }

  const already =
    String(order.local_status || order.localStatus || '').toUpperCase() === 'HANDED_OVER' ||
    Boolean(order.isHandedOverToCarrier || order.is_handed_over_to_carrier);
  if (already) {
    return { ok: true, order, skipped: true };
  }

  const patch = buildHandedOverPatch();
  const patched = await fetchJson(backendUrl, req, `orders/${encodeURIComponent(order.id)}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  });
  if (!patched.ok) {
    return {
      ok: false,
      error: patched.data?.message || patched.data?.error || 'PATCH thất bại',
    };
  }
  const saved = patched.data?.id ? patched.data : { ...order, ...patch };
  return { ok: true, order: saved, skipped: false };
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
      const updated = Number(direct.data?.updated || 0);
      const skipped = Number(direct.data?.skipped || 0);
      if (updated === 0 && skipped === 0) {
        return res.status(400).json({
          success: false,
          ...direct.data,
          message: direct.data?.message || 'Không bàn giao được đơn nào.',
        });
      }
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
    console.warn('[Hand Over Carrier Bulk] cPanel chưa có route — fallback từng đơn');
  } catch (directErr) {
    console.warn(
      '[Hand Over Carrier Bulk] direct proxy failed, fallback:',
      directErr?.message || directErr,
    );
  }

  const updatedOrders = [];
  const failed = [];
  let skipped = 0;
  const seen = new Set();

  for (const key of keys) {
    const norm = String(key || '').trim().toUpperCase();
    if (seen.has(norm)) continue;
    seen.add(norm);
    try {
      const result = await handOverOneOnCpanel(backend.url, req, key);
      if (!result.ok) {
        failed.push({ key, error: result.error });
        continue;
      }
      if (result.skipped) skipped++;
      else updatedOrders.push(result.order);
    } catch (err) {
      failed.push({ key, error: err?.message || 'hand_over_failed' });
    }
  }

  console.log(
    `[Hand Over Carrier Bulk] fallback keys=${keys.length} updated=${updatedOrders.length} skipped=${skipped} failed=${failed.length}`,
  );

  if (updatedOrders.length === 0 && skipped === 0) {
    return res.status(400).json({
      success: false,
      updated: 0,
      skipped: 0,
      failed,
      orders: [],
      error: failed[0]?.error || 'Không bàn giao được đơn nào.',
      message: failed[0]?.error || 'Không bàn giao được đơn nào.',
    });
  }

  return res.status(200).json({
    success: true,
    updated: updatedOrders.length,
    skipped,
    failed,
    orders: updatedOrders,
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

    const key = orderKey || code;
    const result = await handOverOneOnCpanel(backend.url, req, key);
    if (!result.ok) {
      return res.status(result.error?.includes('Không tìm thấy') ? 404 : 500).json({
        success: false,
        error: result.error,
        message: result.error,
      });
    }
    return res.status(200).json({ success: true, order: result.order });
  } catch (err) {
    console.error('[Hand Over Carrier]', err);
    return res.status(500).json({
      success: false,
      message: err?.message || 'Không thể ghi nhận bàn giao ĐVVC.',
      error: err?.message || 'hand_over_failed',
    });
  }
}
