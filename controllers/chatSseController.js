/**
 * Server-Sent Events cho tin nhắn chat real-time.
 * Tối ưu cho cPanel cấu hình thấp: giới hạn số kết nối đồng thời,
 * tự động đóng kết nối idle sau 5 phút, heartbeat 30s.
 */

const MAX_SSE_CONNECTIONS = 50;
const SSE_IDLE_TIMEOUT_MS = 300_000; // 5 phút
const SSE_HEARTBEAT_MS = 30_000; // 30 giây

/** Map<shop_id, Set<response>> — danh sách client đang lắng nghe mỗi shop. */
const sseClients = new Map();

/** Map<response, timeout> — timer để đóng kết nối idle. */
const sseTimeouts = new Map();

function logSse(label, ...args) {
  try {
    console.log(`[Chat SSE] ${label}`, ...args);
  } catch {
    /* EPIPE — không để log làm sập process */
  }
}

function getTotalConnections() {
  let total = 0;
  for (const clients of sseClients.values()) {
    total += clients.size;
  }
  return total;
}

function cleanupSseClient(res, shopId) {
  try {
    const clients = sseClients.get(shopId);
    if (clients) {
      clients.delete(res);
      if (clients.size === 0) sseClients.delete(shopId);
    }
    const timer = sseTimeouts.get(res);
    if (timer) {
      clearTimeout(timer);
      sseTimeouts.delete(res);
    }
  } catch (err) {
    logSse('cleanup error', err);
  }
}

function sendSseEvent(res, event, data) {
  try {
    if (res.writableEnded || res.destroyed) return false;
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
    return true;
  } catch {
    return false;
  }
}

function resetIdleTimeout(res, shopId) {
  const existing = sseTimeouts.get(res);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => {
    logSse('idle timeout', `shop_id=${shopId}`);
    cleanupSseClient(res, shopId);
    if (!res.writableEnded && !res.destroyed) {
      sendSseEvent(res, 'close', { reason: 'idle_timeout' });
      res.end();
    }
  }, SSE_IDLE_TIMEOUT_MS);
  sseTimeouts.set(res, timer);
}

/**
 * GET /api/chat/sse?shop_id=123&token=xxx
 * Mở kết nối SSE để nhận thông báo tin nhắn mới real-time.
 * Giới hạn tối đa 50 kết nối đồng thời để bảo vệ cPanel.
 *
 * Auth: token qua query string (EventSource không hỗ trợ headers).
 */
export function chatSseStream(req, res) {
  // Xác thực token từ query string
  const token = String(req.query?.token || '').trim();
  if (!token) {
    return res.status(401).json({ success: false, error: 'Thiếu token xác thực.' });
  }

  // Verify JWT token đơn giản (không async để SSE stream nhanh)
  try {
    const jwt = require('jsonwebtoken');
    const JWT_SECRET = process.env.JWT_SECRET;
    if (!JWT_SECRET) {
      logSse('JWT_SECRET not configured');
      return res.status(500).json({ success: false, error: 'Server chưa cấu hình.' });
    }
    jwt.verify(token, JWT_SECRET);
  } catch (err) {
    return res.status(401).json({ success: false, error: 'Token không hợp lệ hoặc đã hết hạn.' });
  }

  const shopIdRaw = String(req.query?.shop_id || '').trim();
  const shopId = shopIdRaw || 'all';

  if (getTotalConnections() >= MAX_SSE_CONNECTIONS) {
    return res.status(503).json({
      success: false,
      error: 'Server đang quá tải, vui lòng thử lại sau.',
    });
  }

  // Headers SSE chuẩn
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no', // Nginx
  });

  // Thêm client vào danh sách lắng nghe
  if (!sseClients.has(shopId)) {
    sseClients.set(shopId, new Set());
  }
  sseClients.get(shopId).add(res);
  resetIdleTimeout(res, shopId);

  logSse('client connected', `shop_id=${shopId} total=${getTotalConnections()}`);

  // Gửi event welcome
  sendSseEvent(res, 'connected', { shop_id: shopId, timestamp: Date.now() });

  // Heartbeat 30s — giữ kết nối sống và reset idle timer
  const heartbeatTimer = setInterval(() => {
    const sent = sendSseEvent(res, 'ping', { timestamp: Date.now() });
    if (sent) {
      resetIdleTimeout(res, shopId);
    } else {
      clearInterval(heartbeatTimer);
      cleanupSseClient(res, shopId);
    }
  }, SSE_HEARTBEAT_MS);

  // Cleanup khi client đóng kết nối
  req.on('close', () => {
    clearInterval(heartbeatTimer);
    cleanupSseClient(res, shopId);
    logSse('client disconnected', `shop_id=${shopId} total=${getTotalConnections()}`);
  });
}

/**
 * Broadcast tin nhắn mới tới tất cả client đang lắng nghe shop_id.
 * Được gọi từ webhook handler sau khi ghi tin nhắn vào MongoDB.
 */
export function broadcastNewMessage(shopId, conversationId, messageData) {
  const key = String(shopId || 'all').trim();
  const clients = sseClients.get(key);
  if (!clients || clients.size === 0) return;

  const event = {
    shop_id: shopId,
    conversation_id: conversationId,
    message_id: messageData?.message_id || messageData?.messageId,
    sender_type: messageData?.sender_type || messageData?.senderType,
    snippet: messageData?.snippet || '',
    timestamp: Date.now(),
  };

  let sent = 0;
  const dead = [];
  for (const res of clients) {
    const ok = sendSseEvent(res, 'new_message', event);
    if (ok) {
      sent += 1;
      resetIdleTimeout(res, key);
    } else {
      dead.push(res);
    }
  }

  // Xóa kết nối chết
  for (const res of dead) {
    cleanupSseClient(res, key);
  }

  if (sent > 0) {
    logSse('broadcast', `shop_id=${shopId} conversation=${conversationId} sent=${sent}`);
  }
}

/**
 * Broadcast khi có hội thoại được đánh dấu đã đọc.
 */
export function broadcastConversationRead(shopId, conversationId) {
  const key = String(shopId || 'all').trim();
  const clients = sseClients.get(key);
  if (!clients || clients.size === 0) return;

  const event = {
    shop_id: shopId,
    conversation_id: conversationId,
    unread_count: 0,
    timestamp: Date.now(),
  };

  for (const res of clients) {
    const ok = sendSseEvent(res, 'conversation_read', event);
    if (ok) resetIdleTimeout(res, key);
  }
}
