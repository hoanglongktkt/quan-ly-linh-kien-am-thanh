/** Backend production (cPanel Node) — KHÔNG dùng domain frontend quanly (Vercel). */
export const PRODUCTION_API_BASE = 'https://api.linhkienamthanh.net';

/** Domain chính thức của ứng dụng (frontend). */
export const PRODUCTION_APP_ORIGIN = 'https://quanly.linhkienamthanh.net';

export function getPublicAppOrigin(): string {
  if (typeof window !== 'undefined') {
    return window.location.origin.replace(/\/$/, '');
  }
  return PRODUCTION_APP_ORIGIN;
}

function isLocalDevHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1';
}

function isVercelHost(hostname: string): boolean {
  return hostname.endsWith('.vercel.app') || hostname.includes('.vercel.app');
}

function isMainProductionHost(hostname: string): boolean {
  return hostname === 'quanly.linhkienamthanh.net' || hostname.endsWith('.linhkienamthanh.net');
}

/**
 * Base URL cho API (không có slash cuối).
 * - localhost / 127.0.0.1 → '' (relative `/api/...` cùng origin với `npm run dev`)
 * - quanly.linhkienamthanh.net / vercel.app → '' (relative — proxy/cPanel production)
 * - Chỉ dùng URL tuyệt đối khi set VITE_API_BASE_URL (cross-origin).
 *
 * CẢNH BÁO: relative trên domain production = lấy data server thật, không phải Mongo/JSON local.
 */
export function getApiBaseUrl(): string {
  if (typeof window !== 'undefined') {
    const hostname = window.location.hostname;

    // Local dev: LUÔN same-origin — tuyệt đối không fallback PRODUCTION_API_BASE.
    if (isLocalDevHost(hostname)) {
      return '';
    }

    // Vercel: thử relative trước (vercel.json edge rewrite). Nếu vẫn lỗi → fallback cross-origin.
    if (isVercelHost(hostname)) {
      return '';
    }

    if (isMainProductionHost(hostname)) {
      return '';
    }
  }

  const fromEnv = String(import.meta.env.VITE_API_BASE_URL || '').trim().replace(/\/$/, '');
  if (fromEnv) return fromEnv;
  // Ngoài browser (SSR/build) — không ép production URL vào localhost bundle.
  return '';
}

/**
 * URL mở file vận đơn PDF.
 * Vercel / quanly: relative `/labels/...` → vercel.json proxy `/api/labels/...` → cPanel (tránh 508 loop).
 * Khác origin: trỏ thẳng api.linhkienamthanh.net.
 */
export function resolveBackendFileUrl(path: string): string {
  return resolveLabelFetchUrl(path);
}

/** URL fetch PDF vận đơn — dùng /api/labels/ trực tiếp (tránh rewrite /labels 400). */
export function resolveLabelFetchUrl(path: string): string {
  const raw = String(path || '').trim();
  if (/^https?:\/\//i.test(raw)) return raw;

  let pathname = raw;
  if (!pathname.startsWith('/')) {
    pathname = `/${pathname}`;
  }

  const filename = decodeURIComponent(pathname.split('/').filter(Boolean).pop() || '');
  if (!filename || !/\.pdf$/i.test(filename)) {
    if (typeof window === 'undefined') return `${PRODUCTION_API_BASE}${pathname}`;
    const hostname = window.location.hostname;
    if (isLocalDevHost(hostname) || isVercelHost(hostname) || isMainProductionHost(hostname)) {
      return pathname.startsWith('/') ? pathname : `/${pathname}`;
    }
    return `${PRODUCTION_API_BASE}${pathname}`;
  }

  const encoded = encodeURIComponent(filename);
  if (typeof window === 'undefined') {
    return `${PRODUCTION_API_BASE}/api/public/labels/${encoded}`;
  }
  const hostname = window.location.hostname;
  if (isLocalDevHost(hostname) || isVercelHost(hostname) || isMainProductionHost(hostname)) {
    return `/api/labels/${encoded}`;
  }
  return `${PRODUCTION_API_BASE}/api/public/labels/${encoded}`;
}

/** Chuyển PDF base64 từ API stream → Blob in ngay (không fetch URL). */
export function base64ToPdfBlob(base64: string): Blob {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: 'application/pdf' });
}

/** Ghép path `/api/...` — relative khi base rỗng (cùng origin hoặc Vercel proxy). */
export function apiUrl(path: string): string {
  const normalized = path.startsWith('/') ? path : `/${path}`;
  const base = getApiBaseUrl();
  if (!base) return normalized;
  return `${base}${normalized}`;
}

export function apiFetch(input: string, init?: RequestInit): Promise<Response> {
  const url =
    input.startsWith('http://') || input.startsWith('https://')
      ? input
      : apiUrl(input);
  return fetch(url, init);
}

/** Trích thông báo lỗi từ body JSON (ưu tiên message/error từ server/Shopee). */
function extractApiErrorMessage(text: string, fallback: string): string {
  try {
    const parsed = JSON.parse(text) as { message?: string; error?: string; detail?: string };
    const parts = [parsed.message, parsed.error, parsed.detail].filter(Boolean).map(String);
    if (parts.length > 0) return parts.join(" — ");
  } catch {
    /* not JSON */
  }
  return fallback;
}

/** Parse JSON an toàn — báo lỗi rõ nếu server trả HTML (404/proxy/503/413). */
export async function parseJsonResponse<T = Record<string, unknown>>(
  response: Response,
): Promise<T> {
  const text = await response.text();
  const contentType = response.headers.get('content-type') || '';
  const trimmed = text.trimStart();

  if (trimmed.startsWith('<') || trimmed.startsWith('<!DOCTYPE')) {
    const htmlHint =
      response.status === 413
        ? `HTTP 413 Payload Too Large — dữ liệu quá lớn. Hãy dùng phân trang (offset/nextOffset).`
        : `Server trả về HTML thay vì JSON (HTTP ${response.status}) — backend có thể bị crash, timeout hoặc proxy lỗi.`;
    throw new Error(extractApiErrorMessage(text, htmlHint));
  }

  if (!response.ok) {
    const fallback =
      response.status === 413
        ? 'HTTP 413: Payload Too Large — hãy tải từng trang thay vì toàn bộ shop một lần.'
        : `HTTP ${response.status}: ${response.statusText || 'Lỗi API'}`;
    const msg = extractApiErrorMessage(text, fallback);
    throw new Error(msg);
  }

  if (
    !contentType.includes('application/json') &&
    (trimmed.includes('503 Service Unavailable') ||
      trimmed.includes('The page could not be found'))
  ) {
    throw new Error(extractApiErrorMessage(text, `Phản hồi không hợp lệ (HTTP ${response.status})`));
  }

  try {
    return (text ? JSON.parse(text) : {}) as T;
  } catch (parseErr) {
    const parseMsg = parseErr instanceof Error ? parseErr.message : String(parseErr);
    throw new Error(
      response.ok
        ? `Phản hồi API không hợp lệ: ${parseMsg} — ${text.slice(0, 120)}`
        : extractApiErrorMessage(text, `Phản hồi API không hợp lệ (HTTP ${response.status}): ${parseMsg}`),
    );
  }
}

/** Đọc JSON body kể cả khi HTTP lỗi — dùng cho luồng ship-order (503/500 vẫn có JSON). */
export async function readResponseJson<T = Record<string, unknown>>(response: Response): Promise<T> {
  const text = await response.text();
  const trimmed = text.trimStart();
  if (trimmed.startsWith('<') || trimmed.startsWith('<!DOCTYPE')) {
    throw new Error(
      `Server trả về HTML thay vì JSON (HTTP ${response.status}) — backend có thể bị crash, timeout hoặc proxy lỗi.`,
    );
  }
  try {
    return (text ? JSON.parse(text) : {}) as T;
  } catch {
    throw new Error(`HTTP ${response.status}: phản hồi không phải JSON hợp lệ`);
  }
}

/** Nhận diện lỗi Shopee item/model không tồn tại — dùng để skip thay vì crash luồng sync. */
export function isShopeeItemNotFoundMessage(text: string): boolean {
  const t = String(text || '').toLowerCase();
  return (
    t.includes('item_not_found') ||
    t.includes('error_item_not_found') ||
    t.includes('item_id is not found') ||
    t.includes('item is not found') ||
    t.includes('model_not_found') ||
    t.includes('is not found')
  );
}

export type ShopeeChannelFetchPageResult = {
  success: boolean;
  message?: string;
  shopId?: string;
  shopName?: string;
  offset?: number;
  nextOffset?: number | null;
  hasMore?: boolean;
  pageSize?: number;
  savedCount?: number;
  pageStats?: {
    itemsInPage?: number;
    rowsInPage?: number;
    variantItemCount?: number;
    skippedCount?: number;
  };
  skippedItems?: Array<{ itemId: string; reason: string }>;
  error?: string;
};

export type ShopeeChannelFetchAllResult = {
  success: boolean;
  totalSaved: number;
  totalPages: number;
  shopId?: string;
  shopName?: string;
  stats: {
    itemsInPage: number;
    rowsInPage: number;
    variantItemCount: number;
    skippedCount: number;
  };
  message?: string;
};

function buildAuthHeaders(token?: string | null): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const authToken =
    token ?? (typeof localStorage !== 'undefined' ? localStorage.getItem('admin_token') : null);
  if (authToken) headers.Authorization = `Bearer ${authToken}`;
  return headers;
}

/** Tải MỘT trang dữ liệu sàn Shopee — chỉ kéo + lưu DB, không auto-link. */
export async function fetchChannelProductsPage(
  shopId: string,
  offset = 0,
  opts?: { signal?: AbortSignal; token?: string | null },
): Promise<ShopeeChannelFetchPageResult> {
  const res = await apiFetch('/api/shopee/channel-products/fetch', {
    method: 'POST',
    headers: buildAuthHeaders(opts?.token),
    body: JSON.stringify({ shopId, offset }),
    signal: opts?.signal,
  });

  const data = await parseJsonResponse<ShopeeChannelFetchPageResult>(res);
  if (!res.ok || data.success === false) {
    throw new Error(data.message || data.error || `HTTP ${res.status}`);
  }
  return { ...data, success: true };
}

/**
 * Tải toàn bộ dữ liệu sàn theo phân trang — mỗi request chỉ xử lý 1 trang (page_size=20).
 * Không auto-link SKU; chỉ kéo dữ liệu thô và lưu Database.
 */
export async function fetchChannelProductsFromShopee(
  shopId: string,
  opts?: {
    signal?: AbortSignal;
    token?: string | null;
    onPage?: (page: ShopeeChannelFetchPageResult, pageNo: number) => void;
  },
): Promise<ShopeeChannelFetchAllResult> {
  let offset = 0;
  let hasMore = true;
  let pageNo = 0;
  let totalSaved = 0;
  const stats = { itemsInPage: 0, rowsInPage: 0, variantItemCount: 0, skippedCount: 0 };
  let shopName: string | undefined;
  let resolvedShopId = shopId;

  while (hasMore) {
    pageNo++;
    const page = await fetchChannelProductsPage(resolvedShopId, offset, {
      signal: opts?.signal,
      token: opts?.token,
    });

    opts?.onPage?.(page, pageNo);

    totalSaved += page.savedCount ?? 0;
    stats.itemsInPage += page.pageStats?.itemsInPage ?? 0;
    stats.rowsInPage += page.pageStats?.rowsInPage ?? 0;
    stats.variantItemCount += page.pageStats?.variantItemCount ?? 0;
    stats.skippedCount += page.pageStats?.skippedCount ?? 0;

    if (page.shopId) resolvedShopId = page.shopId;
    if (page.shopName) shopName = page.shopName;

    hasMore = !!page.hasMore;
    offset = page.nextOffset ?? offset + (page.pageSize ?? 20);

    if (!hasMore) break;
  }

  return {
    success: true,
    totalSaved,
    totalPages: pageNo,
    shopId: resolvedShopId,
    shopName,
    stats,
    message: `Đã tải ${totalSaved} dòng từ ${pageNo} trang Shopee (không auto-link).`,
  };
}

export type ShopeePullProductsResult = {
  success: boolean;
  productCount?: number;
  stats?: {
    itemCount?: number;
    rowCount?: number;
    variantItemCount?: number;
    skippedCount?: number;
    pageCount?: number;
  };
  shopId?: string;
  message?: string;
  error?: string;
  skippedItems?: Array<{ itemId: string; reason: string }>;
};

/** Đồng bộ kho chính từ Shopee — server xử lý phân trang nội bộ, response chỉ trả thống kê. */
export async function pullProducts(
  shopId: string,
  opts?: { signal?: AbortSignal; token?: string | null },
): Promise<ShopeePullProductsResult> {
  const res = await apiFetch('/api/shopee/products/sync', {
    method: 'POST',
    headers: buildAuthHeaders(opts?.token),
    body: JSON.stringify({ shopId }),
    signal: opts?.signal,
  });

  const data = await parseJsonResponse<ShopeePullProductsResult>(res);
  if (!res.ok) {
    const msg = data.message || data.error || `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return { ...data, success: true };
}

/** Nhóm flat SKU thành Parent + children_models theo shopeeItemId (client-side helper). */
export function nestProductsByItemId(
  products: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  const byItem = new Map<string, Array<Record<string, unknown>>>();
  const standalone: Array<Record<string, unknown>> = [];

  for (const p of products) {
    const itemId = String(p.shopeeItemId || '').trim();
    if (!itemId) {
      standalone.push(p);
      continue;
    }
    if (!byItem.has(itemId)) byItem.set(itemId, []);
    byItem.get(itemId)!.push(p);
  }

  const parents: Array<Record<string, unknown>> = [];
  for (const [itemId, rows] of byItem) {
    const children = rows.filter((r) => r.shopeeModelId);
    const parentRow = rows.find((r) => !r.shopeeModelId) || rows[0];
    if (children.length === 0) {
      parents.push({ ...parentRow, children_models: [] });
      continue;
    }
    const totalStock = children.reduce((s, c) => s + (Number(c.stock) || 0), 0);
    parents.push({
      ...parentRow,
      id: `shopee-item-${itemId}`,
      shopeeId: itemId,
      shopeeItemId: itemId,
      shopeeModelId: undefined,
      stock: totalStock,
      title: String(parentRow.title || '').split(' - ')[0] || parentRow.title,
      children_models: children,
    });
  }

  return [...parents, ...standalone];
}

/** Mọi `fetch('/api/...')` dùng apiUrl (relative trên Vercel + cPanel). */
export function installApiFetchInterceptor(): void {
  if (typeof window === 'undefined') return;
  const w = window as Window & { __apiFetchPatched?: boolean };
  if (w.__apiFetchPatched) return;

  const nativeFetch = window.fetch.bind(window);
  window.fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    if (typeof input === 'string' && input.startsWith('/api/')) {
      return nativeFetch(apiUrl(input), init);
    }
    if (input instanceof Request) {
      const reqUrl = input.url;
      const path = reqUrl.startsWith('http') ? new URL(reqUrl).pathname : reqUrl;
      if (path.startsWith('/api/')) {
        return nativeFetch(apiUrl(path), init);
      }
    }
    return nativeFetch(input, init);
  };
  w.__apiFetchPatched = true;
}
