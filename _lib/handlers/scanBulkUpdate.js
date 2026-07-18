/**
 * POST orders/scan-bulk-update — chạy trên Vercel khi cPanel chưa có route.
 * Ưu tiên proxy thẳng sang cPanel; nếu 404 thì tự phân loại qua lookup + hand-over + PATCH.
 */
import { buildCpanelTarget } from '../cpanelProxy.js';
import { resolveCpanelBackend } from '../cpanelBackend.js';
import { fetchWithDiagnostics } from '../fetchDiagnostics.js';

function isAwaitingPickup(status) {
  const s = String(status || '');
  return s === 'unprocessed' || s === 'processed';
}

function extractCodes(body) {
  const raw =
    (Array.isArray(body?.codes) && body.codes) ||
    (Array.isArray(body?.scannedCodes) && body.scannedCodes) ||
    (Array.isArray(body?.scanCodes) && body.scanCodes) ||
    [];
  return [...new Set(raw.map((c) => String(c || '').trim()).filter(Boolean))];
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

    // 1) Thử endpoint native trên cPanel (nếu đã deploy server.ts mới).
    try {
      const direct = await fetchJson(backend.url, req, 'orders/scan-bulk-update', {
        method: 'POST',
        body: JSON.stringify({ codes, scannedCodes: codes, scanCodes: codes }),
      });
      if (direct.ok && direct.data?.success !== false) {
        const handed = Number(direct.data?.summary?.daXuatKho ?? direct.data?.stats?.handedOver ?? 0);
        const cancelled = Number(direct.data?.summary?.donHuy ?? direct.data?.stats?.cancelled ?? 0);
        const returned = Number(direct.data?.summary?.daNhanHoan ?? direct.data?.stats?.returnReceived ?? 0);
        const processedCount =
          Number(direct.data?.processedCount) || handed + cancelled + returned || codes.length;
        return res.status(200).json({
          ...direct.data,
          success: true,
          processedCount,
          summary: {
            daXuatKho: handed,
            donHuy: cancelled,
            daNhanHoan: returned,
          },
        });
      }
      const msg = String(direct.data?.message || direct.data?.error || '');
      if (direct.status !== 404 && !msg.includes('API không tồn tại')) {
        return res.status(direct.status || 500).json({
          success: false,
          message: msg || 'scan_bulk_update_failed',
        });
      }
      console.warn('[Scan Bulk Update] cPanel chưa có route — fallback compose APIs');
    } catch (directErr) {
      const msg = String(directErr?.message || directErr || '');
      if (!msg.includes('API không tồn tại') && !msg.includes('404')) {
        console.warn('[Scan Bulk Update] direct proxy failed, trying fallback:', msg);
      }
    }

    // 2) Fallback: compose lookup + hand-over-carrier + PATCH status.
    const results = [];
    const updatedById = new Map();
    const stats = {
      handedOver: 0,
      cancelled: 0,
      returnReceived: 0,
      notFound: 0,
      skipped: 0,
    };

    for (const code of codes) {
      const lookup = await fetchJson(backend.url, req, 'orders/lookup', {
        method: 'GET',
        query: { code },
      });

      const order =
        lookup.data?.order ||
        (lookup.ok && lookup.data?.id ? lookup.data : null) ||
        (Array.isArray(lookup.data) ? lookup.data[0] : null);

      if (!lookup.ok || !order?.id) {
        stats.notFound += 1;
        results.push({
          code,
          action: 'not_found',
          message: `Không tìm thấy đơn với mã "${code}"`,
        });
        continue;
      }

      const status = String(order.status || '');

      if (isAwaitingPickup(status)) {
        const hand = await fetchJson(backend.url, req, 'orders/hand-over-carrier', {
          method: 'POST',
          body: JSON.stringify({ code, orderId: order.id }),
        });
        if (!hand.ok) {
          stats.skipped += 1;
          results.push({
            code,
            action: 'skipped',
            orderId: order.id,
            orderSn: order.orderSn,
            message: hand.data?.message || hand.data?.error || 'Không bàn giao được ĐVVC',
          });
          continue;
        }
        const saved = hand.data?.order || { ...order, isHandedOverToCarrier: true, is_handed_over_to_carrier: true };
        updatedById.set(saved.id || order.id, saved);
        stats.handedOver += 1;
        results.push({
          code,
          action: 'handed_over',
          orderId: order.id,
          orderSn: order.orderSn,
          message: `Đã bàn giao ĐVVC — đơn #${order.orderSn}`,
        });
        continue;
      }

      if (status === 'cancelled') {
        updatedById.set(order.id, order);
        stats.cancelled += 1;
        results.push({
          code,
          action: 'cancelled',
          orderId: order.id,
          orderSn: order.orderSn,
          message: `Đơn hủy #${order.orderSn} → tab Đơn hủy`,
        });
        continue;
      }

      if (status === 'return_pending') {
        const patched = await fetchJson(backend.url, req, `orders/${encodeURIComponent(order.id)}`, {
          method: 'PATCH',
          body: JSON.stringify({ status: 'return_received' }),
        });
        if (!patched.ok) {
          stats.skipped += 1;
          results.push({
            code,
            action: 'skipped',
            orderId: order.id,
            orderSn: order.orderSn,
            message: patched.data?.message || patched.data?.error || 'Không cập nhật nhận hoàn',
          });
          continue;
        }
        const saved = patched.data?.id ? patched.data : { ...order, status: 'return_received' };
        updatedById.set(saved.id || order.id, saved);
        stats.returnReceived += 1;
        results.push({
          code,
          action: 'return_received',
          orderId: order.id,
          orderSn: order.orderSn,
          message: `Đã nhận hàng hoàn — đơn #${order.orderSn}`,
        });
        continue;
      }

      stats.skipped += 1;
      results.push({
        code,
        action: 'skipped',
        orderId: order.id,
        orderSn: order.orderSn,
        message: `Đơn #${order.orderSn} trạng thái "${status}" — bỏ qua`,
      });
    }

    const processedCount = stats.handedOver + stats.cancelled + stats.returnReceived;
    const summary = {
      daXuatKho: stats.handedOver,
      donHuy: stats.cancelled,
      daNhanHoan: stats.returnReceived,
    };
    console.log(
      `[Scan Bulk Update] fallback codes=${codes.length} processed=${processedCount} summary=`,
      summary,
    );

    return res.status(200).json({
      success: true,
      processedCount,
      summary,
      stats,
      results,
      orders: [...updatedById.values()],
    });
  } catch (err) {
    console.error('[Scan Bulk Update]', err);
    return res.status(500).json({
      success: false,
      message: err?.message || 'Không thể cập nhật hàng loạt đơn đã quét.',
    });
  }
}
