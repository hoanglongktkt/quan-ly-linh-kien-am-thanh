import { buildCpanelTarget } from '../cpanelProxy.js';
import { resolveCpanelBackend } from '../cpanelBackend.js';
import { fetchWithDiagnostics } from '../fetchDiagnostics.js';

const SHOPEE_SYNC_SHOP_DISPLAY_NAMES = {
  '831052930': 'LK audio',
  '4127421': 'LK AT',
};

function resolveShopeeSyncShopName(shopId) {
  const id = String(shopId || '').trim();
  return SHOPEE_SYNC_SHOP_DISPLAY_NAMES[id] || `Shop ${id}`;
}

function stripShopeeSyncNoisePrefixes(text) {
  let t = String(text || '').trim();
  for (let i = 0; i < 12; i++) {
    const next = t
      .replace(/^(?:Lỗi đồng bộ Shopee|Lỗi từ Shopee|Shopee báo lỗi)\s*:\s*/i, '')
      .replace(/^[A-Za-z0-9][A-Za-z0-9._:-]*\s*:\s+/, '')
      .trim();
    if (next === t) break;
    t = next;
  }
  return t;
}

function applyShopeeErrorCodeHumanize(text) {
  let out = String(text || '');
  const rules = [
    {
      test: /error_update_price_fail/i,
      stripEn: /Update price failed(?:,?\s*please try later\.?)?/gi,
      stripCode: /(?:product\.)?error_update_price_fail/gi,
      vi: 'Không thể cập nhật giá do sản phẩm đang tham gia CTKM',
    },
    {
      test: /error_item_not_found/i,
      stripEn: /Item[_ ]?id is not found\.?/gi,
      stripCode: /(?:product\.)?error_item_not_found/gi,
      vi: 'Không tìm thấy sản phẩm tại shop',
    },
  ];
  for (const rule of rules) {
    if (!rule.test.test(out)) continue;
    out = out.replace(rule.stripEn, '').replace(rule.stripCode, rule.vi);
  }
  return out
    .replace(/\s*[—\-–:]\s*(?=[—\-–:]|$)/g, '')
    .replace(/^\s*[—\-–:]\s*/, '')
    .replace(/\s*[—\-–:]\s*$/, '')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

function formatOneShopeeSyncSegment(segment) {
  const raw = stripShopeeSyncNoisePrefixes(segment);
  if (!raw) return '';

  const shopMatch = raw.match(/\[(\d{4,})\]/);
  const shopId = shopMatch?.[1] || '';
  const shopName = shopId ? resolveShopeeSyncShopName(shopId) : '';

  const humanized = applyShopeeErrorCodeHumanize(raw);
  const probe = `${raw} ${humanized}`.toLowerCase();

  if (/error_item_not_found|item[_ ]?id is not found|không tìm thấy sản phẩm/.test(probe)) {
    return shopName
      ? `Không tìm thấy sản phẩm trên shop ${shopName}`
      : 'Không tìm thấy sản phẩm tại shop';
  }

  if (
    /error_update_price_fail|update price failed|không thể cập nhật giá|đang tham gia ctkm/.test(
      probe,
    )
  ) {
    return shopName
      ? `Không thể cập nhật giá do đang tham gia CTKM trên shop ${shopName}`
      : 'Không thể cập nhật giá do sản phẩm đang tham gia CTKM';
  }

  let cleaned = stripShopeeSyncNoisePrefixes(humanized)
    .replace(/\[\d{4,}\]\s*/g, '')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
  if (!cleaned) return raw;
  if (shopName && !cleaned.toLowerCase().includes(shopName.toLowerCase())) {
    return `${cleaned} (shop ${shopName})`;
  }
  return cleaned;
}

function formatShopeeSyncAlertLines(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return [];

  let parts = text
    .split(/\s*\|\s*|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);

  if (parts.length <= 1) {
    const bracketParts = text.match(/\[[\d]{4,}\][^[]*/g);
    if (bracketParts && bracketParts.length > 1) {
      parts = bracketParts.map((s) => s.trim()).filter(Boolean);
    }
  }

  const lines = parts.map(formatOneShopeeSyncSegment).filter(Boolean);
  const seen = new Set();
  const unique = [];
  for (const line of lines) {
    const key = line.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(line);
  }
  return unique;
}

/** Dịch/làm gọn lỗi Shopee — map shop, bỏ prefix, chống trùng. */
function humanizeShopeeErrorMessage(raw) {
  const lines = formatShopeeSyncAlertLines(raw);
  if (lines.length > 0) return lines.join(' | ');
  return String(raw ?? '').trim();
}

function pickShopeeErrorMessage(data, upstreamStatus) {
  const candidates = [
    data?.error,
    data?.message,
    data?.shopeeMessage,
    ...(Array.isArray(data?.results)
      ? data.results.filter((r) => !r?.success).map((r) => r?.message)
      : []),
    ...(Array.isArray(data?.logs)
      ? data.logs.filter((l) => !l?.success).map((l) => l?.message)
      : []),
  ]
    .map((v) => String(v ?? '').trim())
    .filter((v) => v && !/^HTTP\s+\d+$/i.test(v));

  if (candidates.length > 0) return humanizeShopeeErrorMessage(candidates[0]);
  if (upstreamStatus >= 400) return `Shopee API lỗi HTTP ${upstreamStatus}`;
  return 'Shopee từ chối cập nhật giá/tồn kho (thiếu chi tiết lỗi trong JSON).';
}

async function fetchJson(backendUrl, req, pathPart, body) {
  const target = buildCpanelTarget(backendUrl, pathPart, {});
  const result = await fetchWithDiagnostics(
    '[Product Sync Shopee]',
    target,
    {
      method: 'POST',
      headers: {
        Authorization: req.headers?.authorization || req.headers?.Authorization || '',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    },
    120000,
  );

  if (!result.ok) {
    throw new Error(result.error?.message || 'Không kết nối được backend cPanel.');
  }

  const text = await result.upstream.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`Backend trả phản hồi không hợp lệ cho ${pathPart}.`);
  }

  if (!result.upstream.ok || data?.success === false) {
    const error = new Error(pickShopeeErrorMessage(data, result.upstream.status));
    error.httpStatus =
      result.upstream.ok && data?.success === false ? 400 : result.upstream.status;
    throw error;
  }
  return data;
}

export async function handleProductSyncShopee(req, res) {
  console.log('Bắt đầu đồng bộ Shopee', req.body);
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Method Not Allowed' });
  }

  try {
    const requestedIds = Array.isArray(req.body?.productIds)
      ? req.body.productIds
      : [req.body?.id || req.body?.productId];
    const productIds = [
      ...new Set(requestedIds.map((id) => String(id || '').trim()).filter(Boolean)),
    ];
    if (productIds.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Thiếu id hoặc productIds.',
        message: 'Thiếu id hoặc productIds.',
      });
    }

    const backend = resolveCpanelBackend();
    if (!backend.ok) {
      return res.status(503).json({ success: false, error: backend.error, message: backend.error });
    }

    try {
      const direct = await fetchJson(
        backend.url,
        req,
        'products/sync-shopee',
        { productIds },
      );
      return res.status(200).json({
        ...direct,
        success: true,
        message: 'Đồng bộ thành công',
      });
    } catch (directError) {
      const message = String(directError?.message || '');
      const isMissingRoute =
        directError?.httpStatus === 404 ||
        message.includes('API không tồn tại') ||
        message.includes('HTTP 404');
      if (!isMissingRoute) throw directError;
    }

    // Tương thích tiến trình cPanel cũ chưa có products/sync-shopee.
    const fallback = await fetchJson(
      backend.url,
      req,
      'products/bulk-channel-sync',
      { productIds, channels: ['shopee'] },
    );
    const failedLogs = Array.isArray(fallback?.logs)
      ? fallback.logs.filter((log) => log?.success === false)
      : [];
    const successLogs = Array.isArray(fallback?.logs)
      ? fallback.logs.filter((log) => log?.success === true)
      : [];
    if (
      failedLogs.length > 0 ||
      fallback?.failCount > 0 ||
      successLogs.length === 0 ||
      fallback?.successCount === 0
    ) {
      const detail =
        failedLogs.map((log) => log?.message).filter(Boolean).join(' | ') ||
        'Shopee không xác nhận cập nhật giá/tồn kho.';
      const error = new Error(detail);
      error.httpStatus = 400;
      throw error;
    }

    return res.status(200).json({
      success: true,
      message: 'Đồng bộ thành công',
      results: fallback?.logs || [],
      fallback: true,
    });
  } catch (err) {
    console.error('[Product Sync Shopee]', err);
    const status = err?.httpStatus >= 400 ? err.httpStatus : 500;
    const detail = humanizeShopeeErrorMessage(
      String(err?.message || 'Đồng bộ Shopee thất bại.').replace(/^HTTP\s+\d+$/i, '').trim()
        || 'Shopee từ chối cập nhật giá/tồn kho.',
    );
    return res.status(status).json({
      success: false,
      message: status === 400 ? `Lỗi từ Shopee: ${detail}` : detail,
      error: status === 400 ? `Lỗi từ Shopee: ${detail}` : detail,
    });
  }
}
