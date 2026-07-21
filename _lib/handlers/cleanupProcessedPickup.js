/**
 * POST orders/cleanup-processed-pickup — Vercel local.
 * Xóa HẾT đơn đang match tab "Chờ lấy hàng (Đã xử lý)".
 * Điều kiện = matchesProcessedPickupTab (copy — không sửa FE/tab).
 */
import { buildCpanelTarget } from '../cpanelProxy.js';
import { resolveCpanelBackend } from '../cpanelBackend.js';
import { fetchWithDiagnostics } from '../fetchDiagnostics.js';

function isShopeeInternalTrackingCode(code) {
  return /^0FG/i.test(String(code || '').trim());
}

function getShopeeOrderRawStatus(order) {
  return String(order?.shopee_order_status || '').toUpperCase();
}

function getOrderTrackingNo(order) {
  const candidates = [
    order?.trackingNumber,
    order?.tracking_no,
    order?.shopee_tracking_number,
  ];
  for (const c of candidates) {
    const tn = String(c || '').trim();
    if (!tn || tn === '0' || isShopeeInternalTrackingCode(tn)) continue;
    return tn;
  }
  return '';
}

function getOrderFulfillmentType(order) {
  const raw = String(
    order?.fulfillment_type ||
      order?.ship_method ||
      order?.shipping_method ||
      order?.fulfillmentType ||
      '',
  )
    .trim()
    .toLowerCase();
  if (raw === 'dropoff' || raw === 'drop_off' || raw === 'drop-off') return 'dropoff';
  if (raw === 'pickup' || raw === 'pick_up' || raw === 'pick-up') return 'pickup';
  return '';
}

function isProcessedCondition(order) {
  if (getOrderTrackingNo(order)) return true;
  const raw = getShopeeOrderRawStatus(order);
  if (raw === 'PROCESSED') return true;
  if (order?.status === 'processed') return true;
  if (getOrderFulfillmentType(order) === 'dropoff' && Boolean(order?.isPrepared)) return true;
  return false;
}

function truthyFlag(v) {
  return v === true || v === 1 || v === '1' || String(v).toLowerCase() === 'true';
}

function isOrderHandedOverToCarrier(order) {
  const local = String(
    order?.internal_status ?? order?.local_status ?? order?.localStatus ?? '',
  ).toUpperCase();
  return (
    local === 'HANDED_OVER' ||
    truthyFlag(order?.isHandedOverToCarrier) ||
    truthyFlag(order?.is_handed_over_to_carrier) ||
    truthyFlag(order?.is_handed_over_to_courier)
  );
}

function isShopeeShippingStatus(order) {
  const raw = getShopeeOrderRawStatus(order);
  return raw === 'SHIPPED' || raw === 'TO_CONFIRM_RECEIVE';
}

function isShopeeCompletedStatus(order) {
  return getShopeeOrderRawStatus(order) === 'COMPLETED';
}

function isShopeeCancelledLikeStatus(order) {
  const raw = getShopeeOrderRawStatus(order);
  if (raw === 'CANCELLED' || raw === 'IN_CANCEL' || raw === 'TO_RETURN') return true;
  return (
    order?.status === 'cancelled' ||
    order?.status === 'return_pending' ||
    order?.status === 'return_received'
  );
}

function isShopeeReadyToShipStatus(order) {
  const raw = getShopeeOrderRawStatus(order);
  return raw === 'READY_TO_SHIP' || raw === 'RETRY_SHIP' || raw === 'PROCESSED';
}

/** State Machine: READY_TO_SHIP-like AND is_handed_over = false AND đã xử lý. */
export function matchesProcessedPickupTab(order) {
  if (!order || typeof order !== 'object') return false;
  if (isOrderHandedOverToCarrier(order)) return false;
  if (isShopeeShippingStatus(order) || isShopeeCompletedStatus(order)) return false;
  if (isShopeeCancelledLikeStatus(order)) return false;
  if (!isShopeeReadyToShipStatus(order)) return false;
  return isProcessedCondition(order);
}

async function fetchJson(backendUrl, req, pathPart, init = {}, timeoutMs = 180000) {
  const target = buildCpanelTarget(backendUrl, pathPart, init.query || {});
  const headers = {
    Authorization: req.headers?.authorization || req.headers?.Authorization || '',
    'Content-Type': 'application/json',
    ...(init.headers || {}),
  };
  const result = await fetchWithDiagnostics(
    '[Cleanup Processed Pickup]',
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

export async function handleCleanupProcessedPickup(req, res) {
  if (req.method !== 'POST' && req.method !== 'GET') {
    return res.status(405).json({ success: false, error: 'method_not_allowed' });
  }

  try {
    const backend = resolveCpanelBackend();
    if (!backend?.url) {
      return res.status(500).json({ success: false, error: 'missing_cpanel_backend' });
    }

    // 1) Endpoint cPanel deleteMany (sau deploy).
    try {
      const direct = await fetchJson(backend.url, req, 'orders/cleanup-processed-pickup', {
        method: 'POST',
        body: {},
      });
      if (direct.ok && direct.data && direct.data.success !== false) {
        console.log(`Deleted count: ${direct.data.removed ?? 0}`);
        return res.status(direct.status).json(direct.data);
      }
      console.warn(
        '[Cleanup Processed Pickup] cPanel endpoint chưa sẵn sàng:',
        direct.status,
        direct.data?.message || direct.data?.error,
      );
    } catch (e) {
      console.warn('[Cleanup Processed Pickup] cPanel call failed:', e?.message || e);
    }

    // 2) Fallback: GET → lọc đúng tab → DELETE từng đơn.
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
    const garbage = orders.filter(matchesProcessedPickupTab);
    console.log(`[Cleanup Processed Pickup] matched tab Đã xử lý: ${garbage.length}`);

    const deletedSns = [];
    const errors = [];

    for (const order of garbage) {
      const id = String(order.id || '').trim();
      const sn = String(order.orderSn || order.id || '').trim();
      if (!id && !sn) continue;
      const key = id || `shopee-${sn}`;
      try {
        const del = await fetchJson(backend.url, req, `orders/${encodeURIComponent(key)}`, {
          method: 'DELETE',
        });
        if (del.ok) {
          deletedSns.push(sn);
          continue;
        }

        // Fallback cPanel cũ: vô hiệu hóa đơn (0đ + không items) rồi cleanup-mock deleteMany.
        const patch = await fetchJson(backend.url, req, `orders/${encodeURIComponent(key)}`, {
          method: 'PATCH',
          body: {
            items: [],
            totalAmount: 0,
            item_amount: 0,
            _cleanup_processed_pickup: true,
          },
        });
        if (patch.ok) {
          deletedSns.push(sn);
        } else {
          errors.push({ sn, error: patch.data?.error || `status_${patch.status}` });
        }
      } catch (err) {
        errors.push({ sn, error: err?.message || String(err) });
      }
    }

    let mockRemoved = 0;
    if (deletedSns.length > 0) {
      try {
        const mock = await fetchJson(backend.url, req, 'orders/cleanup-mock', {
          method: 'POST',
          body: {},
        });
        if (mock.ok) {
          mockRemoved = Number(mock.data?.removed || 0);
          console.log(`Deleted count (cleanup-mock): ${mockRemoved}`);
        }
      } catch (e) {
        console.warn('[Cleanup Processed Pickup] cleanup-mock failed:', e?.message || e);
      }
    }

    console.log(`Deleted count: ${deletedSns.length}`);
    return res.json({
      success: true,
      removed: deletedSns.length,
      matched: garbage.length,
      mockRemoved,
      orderSns: deletedSns,
      errors: errors.length ? errors : undefined,
      message:
        deletedSns.length > 0
          ? `Đã xóa ${deletedSns.length}/${garbage.length} đơn tab Chờ lấy hàng (Đã xử lý).`
          : garbage.length === 0
            ? 'Không còn đơn Đã xử lý để xóa.'
            : `Khớp ${garbage.length} đơn nhưng xóa thất bại.`,
    });
  } catch (error) {
    console.error('[Cleanup Processed Pickup] error:', error);
    return res.status(500).json({
      success: false,
      error: error?.message || 'cleanup_failed',
    });
  }
}
