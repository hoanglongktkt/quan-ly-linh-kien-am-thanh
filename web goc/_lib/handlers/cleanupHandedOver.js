/**
 * POST orders/cleanup-handed-over — Vercel local.
 * 1) Thử endpoint cPanel mới (deleteMany).
 * 2) Fallback: GET orders → lọc đúng điều kiện tab ĐVVC → xóa/gỡ cờ hàng loạt.
 */
import { buildCpanelTarget } from '../cpanelProxy.js';
import { resolveCpanelBackend } from '../cpanelBackend.js';
import { fetchWithDiagnostics } from '../fetchDiagnostics.js';

function truthyFlag(v) {
  return v === true || v === 1 || v === '1' || String(v).toLowerCase() === 'true';
}

function resolveLocalStatus(order) {
  const raw = String(order?.local_status ?? order?.localStatus ?? '').toUpperCase();
  if (raw === 'HANDED_OVER' || raw === 'CANCELLED_STORED' || raw === 'RETURN_RECEIVED') {
    return raw;
  }
  if (truthyFlag(order?.isHandedOverToCarrier) || truthyFlag(order?.is_handed_over_to_carrier)) {
    return 'HANDED_OVER';
  }
  return 'NONE';
}

/** State Machine: READY_TO_SHIP-like AND is_handed_over = true. */
export function matchesHandedOverCarrierTab(order) {
  if (!order || typeof order !== 'object') return false;
  const handed =
    resolveLocalStatus(order) === 'HANDED_OVER' ||
    truthyFlag(order.isHandedOverToCarrier) ||
    truthyFlag(order.is_handed_over_to_carrier) ||
    truthyFlag(order.is_handed_over_to_courier);
  if (!handed) return false;
  const raw = String(
    order.shopee_order_status || order.order_status || order.shopeeOrderStatus || '',
  ).toUpperCase();
  if (raw === 'SHIPPED' || raw === 'TO_CONFIRM_RECEIVE' || raw === 'COMPLETED') {
    return false;
  }
  if (raw === 'CANCELLED' || raw === 'IN_CANCEL' || raw === 'TO_RETURN') {
    return false;
  }
  if (raw !== 'READY_TO_SHIP' && raw !== 'RETRY_SHIP' && raw !== 'PROCESSED') {
    return false;
  }
  return true;
}

async function fetchJson(backendUrl, req, pathPart, init = {}, timeoutMs = 120000) {
  const target = buildCpanelTarget(backendUrl, pathPart, init.query || {});
  const headers = {
    Authorization: req.headers?.authorization || req.headers?.Authorization || '',
    'Content-Type': 'application/json',
    ...(init.headers || {}),
  };
  const result = await fetchWithDiagnostics(
    '[Cleanup HandedOver]',
    target,
    {
      method: init.method || 'GET',
      headers,
      body: init.body != null ? JSON.stringify(init.body) : undefined,
    },
    timeoutMs,
  );
  if (!result.ok) {
    throw new Error(result.error?.message || 'Không kết nối được backend cPanel.');
  }
  const text = await result.upstream.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text?.slice?.(0, 200) };
  }
  return { ok: result.upstream.ok, status: result.upstream.status, data };
}

export async function handleCleanupHandedOver(req, res) {
  // CẤM side-effect trên GET — chỉ POST mới được xóa/dọn.
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'method_not_allowed' });
  }

  try {
    const backend = resolveCpanelBackend();
    if (!backend?.url) {
      return res.status(500).json({ success: false, error: 'missing_cpanel_backend' });
    }

    // 1) Endpoint cPanel deleteMany (sau deploy).
    try {
      const direct = await fetchJson(backend.url, req, 'orders/cleanup-handed-over', {
        method: 'POST',
        body: {},
      });
      if (direct.ok && direct.data && direct.data.success !== false) {
        console.log(`Deleted count: ${direct.data.removed ?? 0}`);
        return res.status(direct.status).json(direct.data);
      }
      console.warn(
        '[Cleanup HandedOver] cPanel endpoint chưa sẵn sàng:',
        direct.status,
        direct.data?.message || direct.data?.error,
      );
    } catch (e) {
      console.warn('[Cleanup HandedOver] cPanel cleanup call failed:', e?.message || e);
    }

    // 2) Fallback: lọc đúng điều kiện tab + xóa/gỡ cờ từng đơn.
    const list = await fetchJson(backend.url, req, 'orders', { method: 'GET' });
    if (!list.ok) {
      return res.status(list.status || 502).json({
        success: false,
        error: 'Không tải được danh sách đơn từ cPanel.',
        details: list.data,
      });
    }
    const orders = Array.isArray(list.data)
      ? list.data
      : Array.isArray(list.data?.orders)
        ? list.data.orders
        : [];
    const garbage = orders.filter(matchesHandedOverCarrierTab);
    console.log(`[Cleanup HandedOver] matched tab ĐVVC: ${garbage.length}`);

    const deletedSns = [];
    const clearedSns = [];
    const errors = [];

    for (const order of garbage) {
      const id = String(order.id || '').trim();
      const sn = String(order.orderSn || order.id || '').trim();
      if (!id && !sn) continue;
      const key = id || `shopee-${sn}`;
      try {
        // Ưu tiên DELETE hẳn bản ghi.
        const del = await fetchJson(backend.url, req, `orders/${encodeURIComponent(key)}`, {
          method: 'DELETE',
        });
        if (del.ok) {
          deletedSns.push(sn);
          continue;
        }
        // Fallback: gỡ cờ → biến mất khỏi tab ĐVVC.
        const patch = await fetchJson(backend.url, req, `orders/${encodeURIComponent(key)}`, {
          method: 'PATCH',
          body: {
            local_status: 'NONE',
            localStatus: 'NONE',
            isHandedOverToCarrier: false,
            is_handed_over_to_carrier: false,
          },
        });
        if (patch.ok) {
          clearedSns.push(sn);
        } else {
          errors.push({ sn, error: patch.data?.error || `status_${patch.status}` });
        }
      } catch (err) {
        errors.push({ sn, error: err?.message || String(err) });
      }
    }

    const removed = deletedSns.length + clearedSns.length;
    console.log(`Deleted count: ${deletedSns.length}`);
    console.log(`Cleared count: ${clearedSns.length}`);
    console.log(`Deleted count (TOTAL): ${removed}`);

    return res.json({
      success: true,
      removed,
      deleted: deletedSns.length,
      cleared: clearedSns.length,
      orderSns: [...deletedSns, ...clearedSns],
      errors: errors.length ? errors : undefined,
      message:
        removed > 0
          ? `Đã dọn ${removed} đơn tab ĐÃ GIAO CHO ĐVVC (xóa ${deletedSns.length}, gỡ cờ ${clearedSns.length}).`
          : 'Không còn đơn HANDED_OVER để xóa.',
    });
  } catch (error) {
    console.error('[Cleanup HandedOver] error:', error);
    return res.status(500).json({
      success: false,
      error: error?.message || 'cleanup_failed',
    });
  }
}
