/**
 * Phân tích lỗi fetch/Node — trả về code, cause, gợi ý xử lý.
 */
const HINTS = {
  ENOTFOUND: 'Subdomain chưa có bản ghi DNS (NXDOMAIN). Vào cPanel → Zone Editor → thêm A record trỏ IP server hosting.',
  EAI_AGAIN: 'DNS tạm thời không phản hồi — thử lại sau hoặc kiểm tra nameserver.',
  ECONNREFUSED: 'DNS đúng nhưng không có dịch vụ lắng nghe cổng 443/80. Kiểm tra Node.js App / Passenger trên cPanel.',
  ECONNRESET: 'Kết nối bị server đóng đột ngột — có thể firewall hoặc Passenger crash.',
  ETIMEDOUT: 'Timeout — firewall chặn hoặc server không phản hồi.',
  CERT_HAS_EXPIRED: 'Chứng chỉ SSL đã hết hạn — cài lại AutoSSL/Let\'s Encrypt trên cPanel.',
  DEPTH_ZERO_SELF_SIGNED_CERT: 'Chứng chỉ SSL self-signed — cPanel cần cài SSL hợp lệ cho subdomain.',
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'Chuỗi chứng chỉ SSL không hợp lệ — kiểm tra SSL subdomain trên cPanel.',
  ERR_TLS_CERT_ALTNAME_INVALID: 'SSL không khớp hostname — cài cert cho đúng subdomain api.',
  AbortError: 'Request timeout — backend quá chậm hoặc bị chặn.',
  UND_ERR_CONNECT_TIMEOUT: 'Không kết nối được trong thời gian chờ — kiểm tra IP/firewall cPanel.',
  UND_ERR_SOCKET: 'Lỗi socket — thường do DNS sai hoặc server không chạy.',
};

function unwrapCause(err, depth = 0) {
  if (!err || depth > 5) return [];
  const list = [err];
  if (err.cause) list.push(...unwrapCause(err.cause, depth + 1));
  return list;
}

export function serializeFetchError(err) {
  const chain = unwrapCause(err instanceof Error ? err : new Error(String(err)));
  const primary = chain[0];
  const cause = chain.find((e) => e && (e.code || e.errno)) || chain[1] || null;

  const code =
    cause?.code ||
    cause?.errno ||
    (primary?.name === 'AbortError' ? 'AbortError' : null) ||
    null;

  const message = primary?.message || String(err);
  const hint = (code && HINTS[code]) || (primary?.name === 'AbortError' ? HINTS.AbortError : null) || null;

  return {
    message,
    name: primary?.name || 'Error',
    code: code ? String(code) : null,
    causeMessage: cause?.message || null,
    causeCode: cause?.code ? String(cause.code) : null,
    hint,
    chain: chain.map((e) => ({
      name: e?.name,
      message: e?.message,
      code: e?.code || null,
    })),
  };
}

/**
 * fetch với timeout + log lỗi chi tiết.
 */
export async function fetchWithDiagnostics(label, url, init = {}, timeoutMs = 10000) {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const upstream = await fetch(url, {
      ...init,
      signal: controller.signal,
    });
    clearTimeout(timer);
    return {
      ok: true,
      upstream,
      latencyMs: Date.now() - started,
      error: null,
    };
  } catch (err) {
    clearTimeout(timer);
    const diag = serializeFetchError(err);
    console.error(label, 'FETCH FAILED', JSON.stringify({ url, timeoutMs, latencyMs: Date.now() - started, ...diag }));
    return {
      ok: false,
      upstream: null,
      latencyMs: Date.now() - started,
      error: diag,
    };
  }
}
