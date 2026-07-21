/**
 * POST orders/scan-bulk-update — Vercel local handler.
 * Ưu tiên proxy cPanel (persist JSON+Mongo). Fallback: PATCH từng đơn với local_status.
 * KHÔNG gọi Shopee API.
 */
import { buildCpanelTarget } from '../cpanelProxy.js';
import { resolveCpanelBackend } from '../cpanelBackend.js';
import { fetchWithDiagnostics } from '../fetchDiagnostics.js';

function extractCodes(body) {
  const raw =
    (Array.isArray(body?.codes) && body.codes) ||
    (Array.isArray(body?.scannedCodes) && body.scannedCodes) ||
    (Array.isArray(body?.scanCodes) && body.scanCodes) ||
    [];
  return [...new Set(raw.map((c) => String(c || '').trim()).filter(Boolean))];
}

function resolveLocalStatus(order) {
  const raw = String(order?.local_status ?? order?.localStatus ?? '').toUpperCase();
  if (raw === 'HANDED_OVER' || raw === 'CANCELLED_STORED' || raw === 'RETURN_RECEIVED') return raw;
  if (order?.isHandedOverToCarrier || order?.is_handed_over_to_carrier) return 'HANDED_OVER';
  if (String(order?.status || '') === 'return_received') return 'RETURN_RECEIVED';
  return 'NONE';
}

function isAlreadyProcessed(order) {
  const local = resolveLocalStatus(order);
  return local === 'HANDED_OVER' || local === 'CANCELLED_STORED' || local === 'RETURN_RECEIVED';
}

function processedReason(order) {
  const local = resolveLocalStatus(order);
  if (local === 'HANDED_OVER') return 'Đơn đã được quét/bàn giao ĐVVC trước đó';
  if (local === 'CANCELLED_STORED') return 'Đơn hủy đã được phân loại trước đó';
  if (local === 'RETURN_RECEIVED') return 'Đơn đã nhận hàng hoàn trước đó';
  return 'Đơn đã được xử lý trước đó';
}

async function fetchJson(backendUrl, req, pathPart, init = {}, timeoutMs = 60000) {
  const target = buildCpanelTarget(backendUrl, pathPart, init.query || {});
  const headers = {
    Authorization: req.headers?.authorization || req.headers?.Authorization || '',
    'Content-Type': 'application/json',
    ...(init.headers || {}),
  };

  const result = await fetchWithDiagnostics('[Scan Bulk Update]', target, {
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

function buildLocalPatch(targetStatus) {
  const now = new Date().toISOString();
  if (targetStatus === 'HANDED_OVER') {
    return {
      local_status: 'HANDED_OVER',
      localStatus: 'HANDED_OVER',
      internal_status: 'HANDED_OVER',
      localStatusAt: now,
      local_status_updated_at: now,
      isHandedOverToCarrier: true,
      is_handed_over_to_carrier: true,
      is_handed_over_to_courier: true,
      handedOverAt: now,
    };
  }
  if (targetStatus === 'CANCELLED_STORED') {
    return {
      local_status: 'CANCELLED_STORED',
      localStatus: 'CANCELLED_STORED',
      localStatusAt: now,
      local_status_updated_at: now,
      is_local_return_archived: false,
    };
  }
  return {
    local_status: 'RETURN_RECEIVED',
    localStatus: 'RETURN_RECEIVED',
    localStatusAt: now,
    local_status_updated_at: now,
    is_local_return_archived: false,
    status: 'return_received',
  };
}

export async function handleScanBulkUpdate(req, res) {
  if (req.method !== 'POST') {
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

    const codes = extractCodes(req.body || {});
    if (!codes.length) {
      return res.status(400).json({
        success: false,
        error: 'Thiếu danh sách mã quét (codes).',
        message: 'Thiếu danh sách mã quét (codes / scannedCodes).',
      });
    }

    // 1) Proxy native cPanel (persist thật JSON + Mongo).
    try {
      const direct = await fetchJson(backend.url, req, 'orders/scan-bulk-update', {
        method: 'POST',
        body: JSON.stringify({
          codes,
          scannedCodes: codes,
          scanCodes: codes,
          ...(req.body || {}),
        }),
      });
      if (direct.ok && direct.data?.success !== false) {
        const summary = direct.data?.summary || {
          daXuatKho: Number(direct.data?.stats?.handedOver || 0),
          donHuy: Number(direct.data?.stats?.cancelled || 0),
          daNhanHoan: Number(direct.data?.stats?.returnReceived || 0),
        };
        const pc = Number(direct.data?.processedCount);
        const processedCount = Number.isFinite(pc)
          ? pc
          : Number(summary.daXuatKho || 0) +
            Number(summary.donHuy || 0) +
            Number(summary.daNhanHoan || 0);
        return res.status(200).json({
          ...direct.data,
          success: true,
          summary,
          processedCount,
        });
      }
      const msg = String(direct.data?.message || direct.data?.error || '');
      if (direct.status !== 404 && !msg.includes('API không tồn tại')) {
        return res.status(direct.status || 500).json({
          success: false,
          message: msg || 'scan_bulk_update_failed',
        });
      }
      console.warn('[Scan Bulk Update] cPanel chưa có route — fallback PATCH local_status');
    } catch (directErr) {
      console.warn('[Scan Bulk Update] direct proxy failed, fallback:', directErr?.message || directErr);
    }

    // 2) Fallback: lookup + PATCH local_status từng đơn (vẫn chỉ DB nội bộ).
    const toSet = (arr) =>
      new Set(
        (Array.isArray(arr) ? arr : [])
          .map((c) => String(c || '').trim().toUpperCase())
          .filter(Boolean),
      );
    const forceHandOver = toSet(req.body?.daXuatKhoCodes);
    const forceCancel = toSet(req.body?.donHuyCodes);
    const forceReturn = toSet(req.body?.daNhanHoanCodes);
    const norm = (c) => String(c || '').trim().toUpperCase();

    const results = [];
    const failed_scans = [];
    const updatedOrders = [];
    const summary = { daXuatKho: 0, donHuy: 0, daNhanHoan: 0 };

    for (const code of codes) {
      const codeKey = norm(code);
      const lookup = await fetchJson(backend.url, req, 'orders/lookup', {
        method: 'GET',
        query: { code },
      });
      const order =
        lookup.data?.order ||
        (lookup.ok && lookup.data?.id ? lookup.data : null) ||
        (Array.isArray(lookup.data) ? lookup.data[0] : null);

      if (!lookup.ok || !order?.id) {
        results.push({ code, action: 'not_found', message: `Không tìm thấy đơn với mã "${code}"` });
        failed_scans.push({ code, reason: 'Không tìm thấy đơn trong hệ thống' });
        continue;
      }

      if (isAlreadyProcessed(order)) {
        const reason = processedReason(order);
        results.push({
          code,
          action: 'duplicate',
          orderId: order.id,
          orderSn: order.orderSn,
          message: reason,
          local_status: resolveLocalStatus(order),
        });
        failed_scans.push({ code, orderId: order.id, orderSn: order.orderSn, reason });
        continue;
      }

      const status = String(order.status || '');
      let target = null;
      if (
        forceHandOver.has(codeKey) ||
        forceHandOver.has(norm(order.orderSn)) ||
        forceHandOver.has(norm(order.trackingNumber || order.tracking_no))
      ) {
        target = 'HANDED_OVER';
      } else if (forceCancel.has(codeKey) || forceCancel.has(norm(order.orderSn))) {
        target = 'CANCELLED_STORED';
      } else if (forceReturn.has(codeKey) || forceReturn.has(norm(order.orderSn))) {
        target = 'RETURN_RECEIVED';
      } else if (status === 'unprocessed' || status === 'processed') {
        target = 'HANDED_OVER';
      } else if (status === 'cancelled') {
        target = 'CANCELLED_STORED';
      } else if (status === 'return_pending' || status === 'return_received') {
        target = 'RETURN_RECEIVED';
      }

      if (!target) {
        results.push({
          code,
          action: 'skipped',
          orderId: order.id,
          orderSn: order.orderSn,
          message: `Đơn #${order.orderSn} trạng thái "${status}" — bỏ qua`,
        });
        failed_scans.push({
          code,
          orderId: order.id,
          orderSn: order.orderSn,
          reason: `Trạng thái "${status}" không thuộc quy tắc phân loại`,
        });
        continue;
      }

      const patched = await fetchJson(backend.url, req, `orders/${encodeURIComponent(order.id)}`, {
        method: 'PATCH',
        body: JSON.stringify(buildLocalPatch(target)),
      });

      if (!patched.ok) {
        const reason = patched.data?.message || patched.data?.error || 'PATCH thất bại';
        results.push({
          code,
          action: 'skipped',
          orderId: order.id,
          orderSn: order.orderSn,
          message: reason,
        });
        failed_scans.push({ code, orderId: order.id, orderSn: order.orderSn, reason });
        continue;
      }

      const saved = patched.data?.id ? patched.data : { ...order, ...buildLocalPatch(target) };
      updatedOrders.push(saved);
      if (target === 'HANDED_OVER') {
        summary.daXuatKho += 1;
        results.push({
          code,
          action: 'handed_over',
          orderId: order.id,
          orderSn: order.orderSn,
          message: `Đã bàn giao ĐVVC — đơn #${order.orderSn}`,
          local_status: 'HANDED_OVER',
        });
      } else if (target === 'CANCELLED_STORED') {
        summary.donHuy += 1;
        results.push({
          code,
          action: 'cancelled',
          orderId: order.id,
          orderSn: order.orderSn,
          message: `Đơn hủy #${order.orderSn} → CANCELLED_STORED`,
          local_status: 'CANCELLED_STORED',
        });
      } else {
        summary.daNhanHoan += 1;
        results.push({
          code,
          action: 'return_received',
          orderId: order.id,
          orderSn: order.orderSn,
          message: `Đã nhận hàng hoàn — đơn #${order.orderSn}`,
          local_status: 'RETURN_RECEIVED',
        });
      }
    }

    const processedCount = summary.daXuatKho + summary.donHuy + summary.daNhanHoan;
    console.log('[Scan Bulk Update] fallback persisted summary=', summary, 'failed=', failed_scans.length);

    return res.status(200).json({
      success: true,
      processedCount,
      persistedCount: updatedOrders.length,
      summary,
      stats: {
        handedOver: summary.daXuatKho,
        cancelled: summary.donHuy,
        returnReceived: summary.daNhanHoan,
        duplicates: results.filter((r) => r.action === 'duplicate').length,
        skipped: results.filter((r) => r.action === 'skipped').length,
      },
      results,
      failed_scans,
      orders: updatedOrders,
    });
  } catch (err) {
    console.error('[Scan Bulk Update]', err);
    return res.status(500).json({
      success: false,
      message: err?.message || 'Không thể cập nhật hàng loạt đơn đã quét.',
    });
  }
}
