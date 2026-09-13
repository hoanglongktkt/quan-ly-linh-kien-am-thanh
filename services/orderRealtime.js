/**
 * SSE hub đơn mới — thay WebSocket (Passenger/cPanel không giữ WS ổn định).
 * Emit sau khi Mongo upsert thành công; frontend EventSource lắng nghe `new_order`.
 */
const MAX_SSE_CLIENTS = 20;
const HEARTBEAT_MS = 15_000;

/** @type {Set<import("express").Response>} */
const clients = new Set();

function pruneDeadClients() {
  for (const res of clients) {
    if (res.writableEnded || res.destroyed) {
      clients.delete(res);
    }
  }
}

/**
 * @param {{ orderSn?: string, orderSns?: string[], shopId?: string, shopIds?: string[], status?: string, count?: number }} payload
 */
function buildEventBody(payload) {
  const body = {
    orderSn: payload?.orderSn ? String(payload.orderSn) : "",
    orderSns: Array.isArray(payload?.orderSns)
      ? payload.orderSns.map((s) => String(s || "").trim()).filter(Boolean)
      : payload?.orderSn
        ? [String(payload.orderSn)]
        : [],
    shopId: payload?.shopId != null ? String(payload.shopId) : "",
    shopIds: Array.isArray(payload?.shopIds)
      ? payload.shopIds.map((s) => String(s || "").trim()).filter(Boolean)
      : payload?.shopId
        ? [String(payload.shopId)]
        : [],
    status: payload?.status ? String(payload.status) : "",
    count: Number(payload?.count) || 0,
    at: new Date().toISOString(),
  };
  if (!body.count) body.count = body.orderSns.length || (body.orderSn ? 1 : 0);
  return body;
}

function broadcast(eventName, body) {
  pruneDeadClients();
  if (clients.size === 0) return;
  const chunk = `event: ${eventName}\ndata: ${JSON.stringify(body)}\n\n`;
  for (const res of clients) {
    try {
      res.write(chunk);
    } catch {
      clients.delete(res);
    }
  }
}

/** Emit khi có đơn MỚI (INSERT) — frontend hiện toast + refetch (không silent). */
export function emitNewOrder(payload) {
  broadcast("new_order", buildEventBody(payload));
}

/**
 * Emit khi đơn ĐÃ TỒN TẠI được UPDATE trạng thái (quét xuất kho / bàn giao ĐVVC /
 * hủy / nhận hoàn...). Frontend lắng nghe để refetch NGẦM (silent), không toast,
 * không nháy màn hình — chỉ đồng bộ danh sách khi có thiết bị khác (điện thoại quét) ghi DB.
 * @param {{ orderSn?: string, orderSns?: string[], shopId?: string, shopIds?: string[], status?: string, count?: number }} payload
 */
export function emitOrderUpdated(payload) {
  broadcast("order_updated", buildEventBody(payload));
}

/** GET /api/orders/live — text/event-stream */
export function streamOrderLive(req, res) {
  pruneDeadClients();
  while (clients.size >= MAX_SSE_CLIENTS) {
    const oldest = clients.values().next().value;
    if (!oldest) break;
    clients.delete(oldest);
    try {
      oldest.end();
    } catch {
      /* ignore */
    }
  }

  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  if (typeof res.flushHeaders === "function") res.flushHeaders();

  res.write(`event: ping\ndata: ${JSON.stringify({ ok: true, at: Date.now() })}\n\n`);
  clients.add(res);

  const heartbeat = setInterval(() => {
    if (res.writableEnded || res.destroyed) {
      clearInterval(heartbeat);
      clients.delete(res);
      return;
    }
    try {
      res.write(`event: ping\ndata: ${JSON.stringify({ at: Date.now() })}\n\n`);
    } catch {
      clearInterval(heartbeat);
      clients.delete(res);
    }
  }, HEARTBEAT_MS);

  const onClose = () => {
    clearInterval(heartbeat);
    clients.delete(res);
  };
  req.on("close", onClose);
  req.on("aborted", onClose);
  res.on("close", onClose);
}
